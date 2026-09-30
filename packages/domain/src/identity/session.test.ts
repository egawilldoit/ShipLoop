import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ABSOLUTE_SESSION_TTL_SECONDS,
  SESSION_TOKEN_BYTES,
  authorizeSession,
  describeSessionRejection,
  evaluateIdleWindow,
  evaluateSession,
  generateSessionToken,
  hashSessionToken,
  lastActivityDeadline,
  sessionDeadlines,
  verifySessionToken,
  type SessionTokenDigest,
} from './session.ts';
import {
  SESSION_COOKIE_NAME,
  clearedSessionCookieAttributes,
  deriveCsrfToken,
  sessionCookieAttributes,
  verifyCsrfToken,
} from './csrf.ts';

const SESSION_ID = 'ses_01HQ8V6N4M2Z';
const SECRET = ['server', 'secret', 'material', '0123456789abcdef'].join('-');
const NOW = '2026-03-01T12:00:00.000Z';

test('session tokens are 256 bits of URL-safe entropy and never repeat', () => {
  const tokens = new Set(Array.from({ length: 64 }, () => generateSessionToken()));

  assert.equal(tokens.size, 64);
  for (const token of tokens) {
    assert.equal(Buffer.from(token, 'base64url').length, SESSION_TOKEN_BYTES);
    assert.equal(SESSION_TOKEN_BYTES, 32);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(token.includes('='), false, 'a token must not need percent-encoding in a cookie value');
  }
});

test('only a deterministic digest of a session token is stored', () => {
  const token = generateSessionToken();
  const digest = hashSessionToken(token);

  assert.equal(hashSessionToken(token), digest, 'the digest must be deterministic');
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest.includes(token), false);
  assert.equal(hashSessionToken(generateSessionToken()) === digest, false);
});

test('session token verification is constant time and fails closed', () => {
  const token = generateSessionToken();
  const digest = hashSessionToken(token);

  assert.equal(verifySessionToken(token, digest), true);
  assert.equal(verifySessionToken(token, digest.slice(0, 63)), false, 'a truncated digest must not verify');
  assert.equal(verifySessionToken(token, digest.toUpperCase()), false, 'a non-canonical digest must not verify');
  assert.equal(verifySessionToken(`${token}x`, digest), false);
  assert.equal(verifySessionToken('', digest), false);

  for (const corrupt of ['', 'not-a-digest', 'z'.repeat(64)]) {
    assert.doesNotThrow(() => verifySessionToken(token, corrupt));
    assert.equal(verifySessionToken(token, corrupt), false);
  }
  assert.equal(verifySessionToken(token, digest), true, 'a corrupt row must not disturb a good one');
});

test('revoked, expired, not-yet-issued and inconsistent sessions are invalid for distinct reasons', () => {
  const live = evaluateSession({
    issuedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-03-02T00:00:00.000Z',
    revokedAt: null,
    now: NOW,
  });
  assert.deepEqual(live, { valid: true, reason: null });

  const revoked = evaluateSession({
    issuedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-03-02T00:00:00.000Z',
    revokedAt: '2026-03-01T06:00:00.000Z',
    now: NOW,
  });
  const revokedAndExpired = evaluateSession({
    issuedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-03-01T06:00:00.000Z',
    revokedAt: '2026-03-01T07:00:00.000Z',
    now: NOW,
  });
  const expired = evaluateSession({
    issuedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-03-01T06:00:00.000Z',
    revokedAt: null,
    now: NOW,
  });
  const notYetValid = evaluateSession({
    issuedAt: '2026-03-01T18:00:00.000Z',
    expiresAt: '2026-03-02T00:00:00.000Z',
    revokedAt: null,
    now: NOW,
  });
  const zeroWindow = evaluateSession({
    issuedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-03-01T00:00:00.000Z',
    revokedAt: null,
    now: NOW,
  });
  const invertedWindow = evaluateSession({
    issuedAt: '2026-03-02T00:00:00.000Z',
    expiresAt: '2026-03-01T00:00:00.000Z',
    revokedAt: null,
    now: NOW,
  });
  const malformed = evaluateSession({
    issuedAt: 'yesterday',
    expiresAt: '2026-03-02T00:00:00.000Z',
    revokedAt: null,
    now: NOW,
  });
  const futureRevocation = evaluateSession({
    issuedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-03-02T00:00:00.000Z',
    revokedAt: '2026-03-01T20:00:00.000Z',
    now: NOW,
  });

  assert.deepEqual(revoked, { valid: false, reason: 'Revoked' });
  assert.deepEqual(revokedAndExpired, { valid: false, reason: 'Revoked' }, 'revocation must outrank expiry');
  assert.deepEqual(expired, { valid: false, reason: 'Expired' });
  assert.deepEqual(notYetValid, { valid: false, reason: 'NotYetValid' });
  assert.deepEqual(zeroWindow, { valid: false, reason: 'InvalidWindow' });
  assert.deepEqual(invertedWindow, { valid: false, reason: 'InvalidWindow' });
  assert.deepEqual(malformed, { valid: false, reason: 'Malformed' });
  assert.deepEqual(futureRevocation, { valid: true, reason: null }, 'a revocation that is not yet in force does not apply');

  const reasons = new Set(
    [revoked, expired, notYetValid, zeroWindow, malformed].map((evaluation) => evaluation.reason),
  );
  assert.equal(reasons.size, 5, 'each failure must be distinguishable');
  for (const reason of ['Revoked', 'Expired', 'NotYetValid', 'InvalidWindow', 'Malformed'] as const) {
    assert.notEqual(describeSessionRejection(reason), '');
  }
});

test('absolute and idle deadlines shorten a session and never extend it', () => {
  const deadlines = sessionDeadlines({ issuedAt: NOW });

  assert.equal(deadlines.issuedAt, NOW);
  assert.equal(deadlines.absoluteExpiresAt, '2026-03-01T20:00:00.000Z');
  assert.equal(deadlines.idleExpiresAt, '2026-03-01T13:00:00.000Z');
  assert.equal(deadlines.expiresAt, deadlines.idleExpiresAt, 'the effective expiry is the earlier bound');
  assert.equal(DEFAULT_ABSOLUTE_SESSION_TTL_SECONDS, 8 * 60 * 60);

  const longLived = sessionDeadlines({ issuedAt: NOW, idleTimeoutSeconds: 24 * 60 * 60 });
  assert.equal(longLived.expiresAt, longLived.absoluteExpiresAt, 'the absolute bound still wins');

  const absolute = sessionDeadlines({ issuedAt: new Date(NOW), absoluteTtlSeconds: 900 });
  assert.equal(absolute.absoluteExpiresAt, '2026-03-01T12:15:00.000Z');
  assert.equal(lastActivityDeadline(NOW, 1800), '2026-03-01T12:30:00.000Z');

  assert.throws(() => sessionDeadlines({ issuedAt: NOW, absoluteTtlSeconds: 0 }), RangeError);
  assert.throws(() => sessionDeadlines({ issuedAt: 'later', idleTimeoutSeconds: 60 }), RangeError);
});

test('idle expiry closes a quiet session independently of the absolute bound', () => {
  const active = evaluateIdleWindow({
    lastActivityAt: '2026-03-01T11:30:00.000Z',
    now: NOW,
    idleTimeoutSeconds: 3600,
  });
  const idle = evaluateIdleWindow({
    lastActivityAt: '2026-03-01T10:59:59.999Z',
    now: NOW,
    idleTimeoutSeconds: 3600,
  });

  assert.deepEqual(active, { valid: true, reason: null });
  assert.deepEqual(idle, { valid: false, reason: 'IdleExpired' });
});

test('a revoked session cannot be used by a privileged request even with a correct token', () => {
  const token = generateSessionToken();
  const storedDigest = hashSessionToken(token);
  const live = {
    sessionId: SESSION_ID,
    token,
    storedDigest,
    issuedAt: '2026-03-01T00:00:00.000Z',
    expiresAt: '2026-03-02T00:00:00.000Z',
    lastActivityAt: '2026-03-01T11:59:00.000Z',
    now: NOW,
  } as const;

  const authorized = authorizeSession({ ...live, revokedAt: null });
  assert.equal(authorized.ok, true);
  if (!authorized.ok) throw new Error('unreachable');
  assert.equal(authorized.value.sessionId, SESSION_ID);
  assert.equal(authorized.value.revokedAt, null);

  const afterSignOut = authorizeSession({ ...live, revokedAt: '2026-03-01T11:00:00.000Z' });
  assert.equal(afterSignOut.ok, false);
  if (afterSignOut.ok) throw new Error('unreachable');
  assert.equal(afterSignOut.error, 'Revoked');

  const wrongToken = authorizeSession({ ...live, revokedAt: null, token: generateSessionToken() });
  assert.equal(wrongToken.ok, false);
  if (wrongToken.ok) throw new Error('unreachable');
  assert.equal(wrongToken.error, 'TokenMismatch');

  const corruptRow = authorizeSession({ ...live, revokedAt: null, storedDigest: 'corrupt' as SessionTokenDigest });
  assert.equal(corruptRow.ok, false);
  if (corruptRow.ok) throw new Error('unreachable');
  assert.equal(corruptRow.error, 'TokenMismatch');

  const idle = authorizeSession({
    ...live,
    revokedAt: null,
    lastActivityAt: '2026-03-01T09:00:00.000Z',
    idleTimeoutSeconds: 3600,
  });
  assert.equal(idle.ok, false);
  if (idle.ok) throw new Error('unreachable');
  assert.equal(idle.error, 'IdleExpired');
});

test('a CSRF token is deterministic for a session and unverifiable without the server secret', () => {
  const token = deriveCsrfToken(SESSION_ID, SECRET);

  assert.equal(deriveCsrfToken(SESSION_ID, SECRET), token, 'the server must be able to re-derive the token');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(deriveCsrfToken(SESSION_ID, `${SECRET}x`), token);
  assert.notEqual(deriveCsrfToken(`${SESSION_ID}x`, SECRET), token);
  assert.equal(token.includes(SECRET), false);
});

test('every state-changing method needs a token and is accepted with one', () => {
  const token = deriveCsrfToken(SESSION_ID, SECRET);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'PROPFIND', 'CONNECT']) {
    const missing = verifyCsrfToken({ sessionId: SESSION_ID, secret: SECRET, submitted: '', method });
    const present = verifyCsrfToken({ sessionId: SESSION_ID, secret: SECRET, submitted: token, method });
    const safe = ['HEAD', 'OPTIONS', 'TRACE'].includes(method);

    assert.equal(missing.valid, safe, `${method} without a token`);
    assert.deepEqual(present, { valid: true, reason: null }, `${method} with a token`);
    if (!safe) {
      assert.equal(missing.reason, 'MissingToken');
    }
  }
});

test('a safe method needs no token but a wrong one is still refused', () => {
  assert.deepEqual(verifyCsrfToken({ sessionId: SESSION_ID, secret: SECRET, submitted: '', method: 'GET' }), {
    valid: true,
    reason: null,
  });
  assert.deepEqual(
    verifyCsrfToken({ sessionId: SESSION_ID, secret: SECRET, submitted: deriveCsrfToken(SESSION_ID, SECRET), method: 'GET' }),
    { valid: true, reason: null },
  );
  assert.equal(
    verifyCsrfToken({ sessionId: SESSION_ID, secret: SECRET, submitted: 'x'.repeat(43), method: 'GET' }).reason,
    'TokenMismatch',
  );
  assert.equal(
    verifyCsrfToken({ sessionId: SESSION_ID, secret: SECRET, submitted: 'not-a-token', method: 'GET' }).reason,
    'MalformedToken',
  );
});

test('a whitespace-mutated token is rejected rather than silently accepted', () => {
  const token = deriveCsrfToken(SESSION_ID, SECRET);
  const mutations = [
    `${token} `,
    ` ${token}`,
    `\n${token}`,
    `${token}\n`,
    `${token}\r\n`,
    `${token.slice(0, 21)} ${token.slice(21)}`,
  ];

  for (const submitted of mutations) {
    const evaluation = verifyCsrfToken({ sessionId: SESSION_ID, secret: SECRET, submitted, method: 'POST' });
    assert.equal(evaluation.valid, false, `${JSON.stringify(submitted)} must not be accepted`);
    assert.equal(evaluation.reason, 'MalformedToken');
  }
});

test('a token derived with a different secret or session is refused', () => {
  const otherSessionId = `${SESSION_ID}-other`;
  const foreign = deriveCsrfToken(SESSION_ID, 'a-different-server-secret');

  const otherSecret = verifyCsrfToken({ sessionId: SESSION_ID, secret: SECRET, submitted: foreign, method: 'POST' });
  const otherSession = verifyCsrfToken({
    sessionId: otherSessionId,
    secret: SECRET,
    submitted: deriveCsrfToken(SESSION_ID, SECRET),
    method: 'POST',
  });

  assert.deepEqual(otherSecret, { valid: false, reason: 'TokenMismatch' });
  assert.deepEqual(otherSession, { valid: false, reason: 'TokenMismatch' });
});

test('session cookie attributes always carry HttpOnly and a restrictive SameSite', () => {
  const secure = sessionCookieAttributes({ maxAgeSeconds: 3600 });
  const explicitSecure = sessionCookieAttributes({ secure: true, sameSite: 'Lax', path: '/', maxAgeSeconds: 60 });
  const insecureDevelopment = sessionCookieAttributes({ secure: false, maxAgeSeconds: 60 });

  for (const attributes of [secure, explicitSecure, insecureDevelopment]) {
    assert.equal(attributes.name, SESSION_COOKIE_NAME);
    assert.equal(attributes.httpOnly, true);
    assert.match(attributes.attributes, /HttpOnly/);
    assert.match(attributes.attributes, /Path=\//);
    assert.match(attributes.attributes, /Max-Age=\d+/);
    assert.match(attributes.attributes, /SameSite=(Strict|Lax)/);
    assert.equal(attributes.attributes.includes('SameSite=None'), false);
  }

  assert.equal(secure.secure, true, 'a cookie is secure unless a caller says otherwise');
  assert.match(secure.attributes, /Secure/);
  assert.match(secure.attributes, /SameSite=Strict/, 'the default must be the most restrictive');
  assert.match(secure.attributes, /Max-Age=3600/);
  assert.equal(explicitSecure.sameSite, 'Lax');
  assert.match(explicitSecure.attributes, /SameSite=Lax/);
  assert.equal(insecureDevelopment.attributes.includes('Secure'), false);
  assert.match(insecureDevelopment.attributes, /HttpOnly/, 'HttpOnly is not negotiable');

  assert.throws(() => sessionCookieAttributes({ maxAgeSeconds: 0 }), RangeError);
  assert.throws(() => sessionCookieAttributes({ maxAgeSeconds: Number.NaN }), RangeError);
  assert.throws(() => sessionCookieAttributes({ maxAgeSeconds: 60, path: '/; SameSite=None' }), RangeError);
});

test('signing out clears the cookie without weakening its flags', () => {
  const cleared = clearedSessionCookieAttributes();

  assert.equal(cleared.name, SESSION_COOKIE_NAME);
  assert.equal(cleared.maxAgeSeconds, 0);
  assert.match(cleared.attributes, /Max-Age=0/);
  assert.match(cleared.attributes, /HttpOnly/);
  assert.match(cleared.attributes, /Secure/);
  assert.match(cleared.attributes, /SameSite=Strict/);
  assert.match(cleared.attributes, /Path=\//);
});
