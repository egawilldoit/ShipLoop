/**
 * What the handoff page says about the external tool, and what it must never say.
 *
 * The rule under test is that `Open T3` opens an address in a new tab and does nothing else. ShipLoop
 * holds no T3 session, no T3 API connection, and no observation of anything happening inside T3 — the
 * handoff route's own contract is that it "contacts nothing". So every word in the surrounding copy is
 * checked against a list of words that would each assert a fact this product does not have (mvp-spec
 * L02, L02-AC1, L02-AC3).
 *
 * The test reads the component's source rather than a rendered DOM because Node strips types but does
 * not transform JSX, so `node --test` cannot mount a component — and because the claim is about which
 * words were chosen, which is precisely a source-level fact (N03-AC1).
 *
 * A rendered-DOM assertion belongs in the browser suite. What is checked here is that no future edit
 * reintroduces a verb implying ShipLoop started or is watching an agent, which is a review-time check
 * made mechanical.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('./HandoffPage.tsx', import.meta.url));
const page = await readFile(PAGE, 'utf8');

/**
 * The copy a reader would take away.
 *
 * Comments are stripped because they *discuss* the forbidden words in order to forbid them — a test
 * scanning the whole file would fail on its own explanation. After the comments go, two more classes
 * of non-prose are stripped so a rule about wording cannot be tripped by a CSS class or a test hook:
 * `className`, `data-testid` and the import block. What remains is every string a browser renders as
 * text — JSX children and string literals alike — which is what an owner reads (mvp-spec L02, N03-AC1).
 *
 * This deliberately keeps JSX text children, which are *not* string literals. An earlier version of this
 * file collected only literals and therefore proved nothing at all about the sentences in the markup.
 */
const copy = page
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*import [^\n]*$/gm, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/className=(?:"[^"]*"|'[^']*'|\{`[^`]*`\})/g, ' ')
  .replace(/data-testid="[^"]*"/g, ' ')
  .replace(/aria-label="[^"]*"/g, ' ')
  .replace(/\sid="[^"]*"/g, ' ')
  .replace(/\s+/g, ' ');

/**
 * Words that assert ShipLoop began, holds or watches an external agent session.
 *
 * Each is listed with the claim it would make. None of these is ever true of this product: the handoff
 * route renders a document and contacts nothing, so there is no session, no connection and no progress
 * for ShipLoop to report (mvp-spec L02, L02-AC1).
 */
const FORBIDDEN: readonly { readonly word: RegExp; readonly claims: string }[] = [
  { word: /\bStarted\b/, claims: 'that ShipLoop started something in T3' },
  { word: /\bStarting\b/, claims: 'that ShipLoop is starting something in T3' },
  { word: /\bLaunching\b/, claims: 'that ShipLoop launched something in T3' },
  { word: /\bExecuting\b/, claims: 'that ShipLoop is executing work in T3' },
  { word: /\bConnected to\b/, claims: 'a live connection to T3' },
  { word: /\bMonitoring\b/, claims: 'that ShipLoop observes T3' },
  { word: /\bAgent session\b/i, claims: 'an agent session inside T3' },
  { word: /\bSession started\b/i, claims: 'that a T3 session began' },
  { word: /\bIn progress\b/i, claims: 'external implementation progress' },
  { word: /\bagent is\b/i, claims: 'an agent that ShipLoop observes' },
];

const visibleCopy = copy;

/**
 * The same source with only the comments removed, for claims about which module a call came from.
 *
 * `visibleCopy` also strips class names, test hooks and the import block, which is right for a rule
 * about wording and wrong for a rule about wiring — "does not import the local transport" is exactly
 * a statement about the import block (mvp-spec 3).
 */
const code = page
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/[^\n]*$/gm, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

test('the page names the revision it read and the fingerprint of the text that was approved', () => {
  // An approval seals one exact text, and the owner can only tell that it is the text they reviewed
  // if the page names it: the revision number, the approved text's `contentFingerprint`, and the
  // packet's own fingerprint. Two digests of two different things, which is why the copy labels them
  // rather than printing both as one value (mvp-spec 7, N02-AC2).
  assert.match(page, /getContract/);
  assert.match(visibleCopy, /Revision \$\{revision\}/);
  assert.match(visibleCopy, /content fingerprint \$\{contentFingerprint\}/i);
  assert.match(visibleCopy, /this packet has fingerprint/);
});

test('the packet is shown even when the approved text could not be read', () => {
  // Two facts, two reads. The content fingerprint is what ties the packet to the sealed text, but the
  // packet is the product: losing it because a second read failed would replace a usable handoff with
  // an error over a value the owner does not need in order to paste the document (L02-AC3).
  assert.match(
    visibleCopy,
    /The approved contract text could not be read/,
    'a failed content read must be stated, and the packet must still render',
  );
  assert.match(page, /contract\.ok \? contract\.value\.contentFingerprint : null/);
});

test('the page reads the packet through the shared typed client, not a second transport', () => {
  // Two fetchers for one route is how two answers to one question come to exist. The typed client owns
  // the URL, the CSRF header and the refusal envelope; this page must add no path of its own
  // (mvp-spec 3, F02-AC2).
  assert.match(page, /from '\.\.\/mvp-client\/index\.ts'/);
  assert.doesNotMatch(code, /from '\.\/transport\.ts'/);
  assert.doesNotMatch(code, /\/api\/projects/, 'no page may assemble a project-scoped URL itself (F02-AC2)');
  assert.doesNotMatch(code, /\bfetch\(/, 'no page may call fetch directly (mvp-spec 3)');
});

test('no piece of copy claims ShipLoop started, connected to, or is watching anything in T3', () => {
  for (const { word, claims } of FORBIDDEN) {
    assert.equal(
      word.test(visibleCopy),
      false,
      `the handoff page's copy must not say ${claims}; T3 is external and ShipLoop contacts nothing (mvp-spec L02, L02-AC1)`,
    );
  }
});

test('the copy says plainly that ShipLoop does not start or watch anything in T3', () => {
  // The positive half of the same rule. A button that is merely silent lets the owner assume the tool is
  // being driven, which is the assumption this sentence exists to remove (L02-AC1).
  assert.match(visibleCopy, /does not start, watch or follow anything inside it/i);
});

test('the copy states what the control actually does', () => {
  // An anchor that opens a new tab is a smaller claim than a button that starts a job, and the copy has
  // to match what the code does or it is a lie in the other direction (mvp-spec 3).
  assert.match(visibleCopy, /opens its address in a new tab/i);
});

test('the open control is an anchor with a new tab and no opener handle, not a button that posts', () => {
  // Checked on the source because the security properties live on the element: `target="_blank"`
  // without `rel="noopener"` hands the opened document a handle on this window (F01-AC4).
  assert.match(page, /target="_blank"/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(page, /data-testid="open-external-tool"/);
});

test('the copy names the packet as complete without the external tool', () => {
  // With no tool configured the packet must remain the product. A page that treated the tool as a
  // prerequisite would make the whole journey depend on an integration this product does not require
  // (L02-AC3).
  assert.match(visibleCopy, /implementation packet above is complete without it/i);
});

test('the unconfigured state offers a way forward rather than a dead end', () => {
  // A disabled `Open T3` would be a control that looks like a feature and does nothing. The alternative
  // is a pointer at the place the address is configured (L02-AC3).
  assert.match(page, /data-testid="open-settings"/);
  assert.match(visibleCopy, /Set the T3 address in Settings/);
});

test('the copy control is present regardless of the external tool state', () => {
  // Structural: the copy button lives in `PacketPanel`, which renders independently of `tool`, so it
  // cannot be gated on the tool existing (L02-AC3).
  const copyButton = page.indexOf('data-testid="copy-packet"');
  const notConfigured = page.indexOf('data-testid="external-tool-not-configured"');
  assert.ok(copyButton !== -1, 'the packet copy control must exist');
  assert.ok(notConfigured !== -1, 'the not-configured state must exist');
  assert.ok(
    copyButton < notConfigured,
    'the copy control is declared in the packet panel, which renders before and independently of the external tool',
  );
});

test('the packet is both copied and shown as selectable text', () => {
  // The clipboard can be refused — absent on an insecure origin, or denied without a gesture. A control
  // whose only fallback is an error message would leave the owner with no way to take the document
  // anywhere, which is the whole point of a handoff (L02-AC3, N03-AC3).
  assert.match(page, /data-testid="packet-markdown"/);
  assert.match(page, /tabIndex=\{0\}/);
  assert.match(copyToClipboardBody(), /select it and copy it by hand/);
});

/** The clipboard helper's body, so the fallback wording is checked where it is written. */
function copyToClipboardBody(): string {
  const start = page.indexOf('export async function copyToClipboard');
  assert.notEqual(start, -1, 'the clipboard helper must exist');
  return page.slice(start);
}

test('a copy that did not happen is never reported as a copy', () => {
  // The failure mode this control exists to avoid: the browser refuses the clipboard, the handler
  // optimistically says "Copied", and the owner pastes stale text into the next tool believing the
  // product handed it over (N03-AC3).
  const body = copyToClipboardBody();
  assert.match(body, /\{ ok: true \}/);
  assert.match(body, /\{ ok: false; reason: string \}/);
  // The success wording is only reachable behind `result.ok`, which is set by the same helper.
  assert.match(page, /if \(result\.ok\) \{/);
});