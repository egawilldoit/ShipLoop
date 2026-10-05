/**
 * The gate between an operator-supplied address and a browser navigation.
 *
 * Almost every test here is an input the gate must refuse, because a refusal is the interesting case:
 * the value came from outside this browser, and everything the owner trusts about the button labelled
 * "Open T3" rests on it not being something else (L02-AC2, N02-AC2).
 *
 * The positive cases exist to prove the gate is not simply refusing everything. A check that rejected
 * every URL would leave the owner with no way to open the tool they configured, which is a dead end —
 * and L02-AC3 is precisely about not shipping a dead end.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHttpUrl } from './external-url.ts';

/* -------------------------------------------------------------------------- */
/* Schemes                                                                     */
/* -------------------------------------------------------------------------- */

test('an ordinary https deployment address is openable', () => {
  assert.equal(isHttpUrl('https://t3.example.invalid'), true);
  assert.equal(isHttpUrl('http://localhost:3000'), true);
  assert.equal(isHttpUrl('https://t3.example.invalid/path?q=1#frag'), true);
});

test('surrounding whitespace is tolerated rather than treated as part of the address', () => {
  // An owner pasting from a browser gets a clean string; an owner pasting from a config file gets a
  // trailing newline. Both name the same address, and refusing the second would be a gate that punishes
  // a different habit rather than a different risk.
  assert.equal(isHttpUrl('  https://t3.example.invalid  '), true);
  assert.equal(isHttpUrl('\nhttps://t3.example.invalid\n'), true);
});

test('a javascript: address is refused', () => {
  // Script execution with the owner's click behind it, behind a button labelled "Open T3" (N02-AC2).
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('JavaScript:alert(1)'), false);
});

test('the other dangerous schemes are refused', () => {
  for (const url of [
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'blob:https://example.invalid/abc',
  ]) {
    assert.equal(isHttpUrl(url), false, `${url} must not be rendered as a link`);
  }
});

test('a scheme-relative address is refused rather than resolved against this origin', () => {
  // `//evil.example` inherits the page's scheme and lands on another host. An operator who meant a
  // relative path is told so instead of being sent somewhere they did not name (N02-AC2).
  assert.equal(isHttpUrl('//evil.example/path'), false);
});

test('a relative address is refused', () => {
  assert.equal(isHttpUrl('/settings'), false);
  assert.equal(isHttpUrl('settings'), false);
});

test('an address with no host is refused', () => {
  // WHATWG parsing refuses these outright, so the gate never gets to decide: a link with no destination
  // is not a link (N02-AC2).
  assert.equal(isHttpUrl('https://'), false);
  assert.equal(isHttpUrl('http://:80/x'), false);
});

test('a hostless address whose first segment is treated as a host is the parser, not this gate', () => {
  // `https:///path` does not mean what it looks like: WHATWG normalises the empty authority away and
  // reads `path` as the host. The gate therefore opens it, because refusing it would mean the gate held
  // a second, disagreeing opinion about URL syntax — and the operator's configured address is read
  // through the same parser the browser will use to navigate it. Asserted here so the behaviour is on
  // record rather than discovered later (N02-AC2).
  assert.equal(new URL('https:///path').host, 'path');
  assert.equal(isHttpUrl('https:///path'), true);
});

test('an unparseable address is refused rather than thrown', () => {
  // Every caller has the same answer for a malformed address, and one that threw would force each
  // caller to write its own catch — which is how one of them ends up not catching it.
  assert.equal(isHttpUrl('not a url at all'), false);
  assert.equal(isHttpUrl('http://[unclosed'), false);
  assert.equal(isHttpUrl(''), false);
  assert.equal(isHttpUrl('   '), false);
});

/* -------------------------------------------------------------------------- */
/* Credentials in the address                                                  */
/* -------------------------------------------------------------------------- */

test('an address carrying a username and password is refused', () => {
  // `routes/settings.ts` refuses a credential-bearing URL before storing it, so reaching one here means
  // that refusal moved. Rendering it would put a secret in the DOM, in the browser history, and in
  // anything that reads the page (L02-AC2, N02-AC2).
  assert.equal(isHttpUrl('https://user:token@t3.example.invalid'), false);
  assert.equal(isHttpUrl('https://user@t3.example.invalid'), false);
  assert.equal(isHttpUrl('https://:token@t3.example.invalid'), false);
});

/* -------------------------------------------------------------------------- */
/* Control characters                                                          */
/* -------------------------------------------------------------------------- */

test('an address carrying a control character is refused', () => {
  // A newline is how a stored `https://good.example` becomes a header with something after it. The
  // value is refused here so it never reaches a header, a log line, or the DOM (N02-AC2).
  assert.equal(isHttpUrl('https://t3.example.invalid\njavascript:alert(1)'), false);
  assert.equal(isHttpUrl('https://t3.example.invalid\r\nSet-Cookie: a=b'), false);
  assert.equal(isHttpUrl(`https://t3.example.invalid${String.fromCharCode(0)}`), false);
  assert.equal(isHttpUrl(`https://t3.example.invalid${String.fromCharCode(0x7f)}`), false);
});

test('a tab inside an address is refused', () => {
  // Browsers strip tabs and newlines from a URL before navigating, so an address containing one can read
  // on screen as one thing and navigate to another (N02-AC2).
  assert.equal(isHttpUrl('https://t3.exa\tmple.invalid'), false);
});