import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REDACTION_RULES } from '../redaction.ts';
import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  hashPassword,
  secretFreeReason,
  verifyPassword,
  type PasswordHash,
} from './password.ts';

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'correct horse battery stapl';

function hashed(plaintext: string): PasswordHash {
  const result = hashPassword(plaintext);
  assert.equal(result.ok, true, `expected ${plaintext.length} characters to be hashable`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function encodedFields(encoded: PasswordHash): string[] {
  return encoded.split('$');
}

test('the same password hashes differently and both hashes verify', () => {
  const first = hashed(PASSWORD);
  const second = hashed(PASSWORD);

  assert.notEqual(first, second, 'a random salt must make two hashes of one password differ');
  assert.equal(verifyPassword(PASSWORD, first), true);
  assert.equal(verifyPassword(PASSWORD, second), true);
});

test('the encoding records the algorithm, cost, salt and digest', () => {
  const encoded = hashed(PASSWORD);
  const [algorithm, version, costN, costR, costP, keyLength, saltLength, salt, digest] = encodedFields(encoded);

  assert.equal(algorithm, 'scrypt');
  assert.equal(version, 'v1');
  assert.deepEqual([costN, costR, costP, keyLength, saltLength], ['16384', '8', '1', '64', '16']);
  assert.equal(Buffer.from(salt ?? '', 'base64url').length, 16);
  assert.equal(Buffer.from(digest ?? '', 'base64url').length, 64);
  assert.equal(encoded.includes(PASSWORD), false, 'the encoding must not carry the plaintext');
});

test('a wrong password fails verification', () => {
  const encoded = hashed(PASSWORD);

  assert.equal(verifyPassword(OTHER_PASSWORD, encoded), false);
  assert.equal(verifyPassword('', encoded), false);
  assert.equal(verifyPassword(`${PASSWORD} `, encoded), false);
});

test('a malformed stored value fails without throwing', () => {
  const encoded = hashed(PASSWORD);
  const fields = encodedFields(encoded);
  const salt = fields[7] ?? '';

  const malformed: readonly string[] = [
    '',
    'scrypt',
    'not-a-hash-at-all',
    `${PASSWORD}`,
    fields.slice(0, -1).join('$'),
    [...fields, 'extra'].join('$'),
    ['bcrypt', 'v1', '16384', '8', '1', '64', '16', salt, fields[8] ?? ''].join('$'),
    ['scrypt', 'v2', '16384', '8', '1', '64', '16', salt, fields[8] ?? ''].join('$'),
    ['scrypt', 'v1', 'x', '8', '1', '64', '16', salt, fields[8] ?? ''].join('$'),
    ['scrypt', 'v1', '1024', '8', '1', '64', '16', salt, fields[8] ?? ''].join('$'),
    ['scrypt', 'v1', '16777216', '8', '1', '64', '16', salt, fields[8] ?? ''].join('$'),
    ['scrypt', 'v1', '16384', '8', '1', '64', '16', 'not base64!', fields[8] ?? ''].join('$'),
    ['scrypt', 'v1', '16384', '8', '1', '8', '16', salt, fields[8] ?? ''].join('$'),
    ['scrypt', 'v1', '16384', '8', '1', '64', '8', salt, fields[8] ?? ''].join('$'),
    ['scrypt', 'v1', '16384', '8', '1', '64', '16', salt.slice(0, 4), fields[8] ?? ''].join('$'),
  ];

  for (const stored of malformed) {
    assert.doesNotThrow(() => verifyPassword(PASSWORD, stored), `verifying ${JSON.stringify(stored)} must not throw`);
    assert.equal(verifyPassword(PASSWORD, stored), false, `${JSON.stringify(stored)} must not verify`);
  }
  assert.equal(verifyPassword(PASSWORD, encoded), true, 'a rejected row must not disturb a good one');
});

test('verification does not short-circuit on a matching prefix', () => {
  const encoded = hashed(PASSWORD);
  const fields = encodedFields(encoded);

  assert.equal(verifyPassword(PASSWORD, encoded), true);
  assert.equal(verifyPassword(PASSWORD.slice(0, 12), encoded), false, 'a matching prefix must not verify');
  assert.equal(verifyPassword(`${PASSWORD}x`, encoded), false, 'a matching prefix must not verify');

  const digest = Buffer.from(fields[8] ?? '', 'base64url');
  const half = Math.floor(digest.length / 2);
  const wrongPrefixRightSuffix = Buffer.from(digest);
  wrongPrefixRightSuffix.fill(0, 0, half);

  const mutated =
    [...fields.slice(0, 8), wrongPrefixRightSuffix.toString('base64url')].join('$') as PasswordHash;
  assert.equal(verifyPassword(PASSWORD, mutated), false, 'a correct digest suffix must not carry a wrong prefix');
  assert.equal(verifyPassword(PASSWORD, encoded), true, 'the untouched encoding must still verify');
});

test('a trivially short password is refused with a typed reason', () => {
  const result = hashPassword('short');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.error.code, 'Invalid');
  assert.equal(result.error.policyCode, 'TooShort');
  assert.equal(result.error.fields[0]?.path, 'password');
  assert.equal(result.error.reason.includes(String(MINIMUM_PASSWORD_LENGTH)), true, 'the reason states the bound');
  assert.equal(result.error.reason.includes('short'), false, 'the submitted value must not be echoed');

  const tooLong = hashPassword('x'.repeat(MAXIMUM_PASSWORD_LENGTH + 1));
  assert.equal(tooLong.ok, false);
  if (tooLong.ok) throw new Error('unreachable');
  assert.equal(tooLong.error.policyCode, 'TooLong');
});

test('an unsupported cost is refused instead of attempted', () => {
  const result = hashPassword(PASSWORD, { N: 3 });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.error.policyCode, 'InvalidParameters');

  const unbounded = hashPassword(PASSWORD, { N: 1 << 24, r: 8 });
  assert.equal(unbounded.ok, false);
  if (unbounded.ok) throw new Error('unreachable');
  assert.equal(unbounded.error.policyCode, 'InvalidParameters');
});

test('no returned reason contains the submitted secret', () => {
  const secret = ['sk-', 'proj-', 'A'.repeat(24)].join('');
  const tooShort = hashPassword(secret.slice(0, 8));
  const tooLong = hashPassword(secret.repeat(200));

  for (const result of [tooShort, tooLong]) {
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.error.reason.includes(secret), false, 'the secret must not appear in the reason');
    assert.equal(result.error.fields[0]?.message.includes(secret), false, 'the secret must not appear in the field message');
    assert.equal(secretFreeReason(result.error.reason).includes(secret), false);
  }

  assert.equal(
    DEFAULT_REDACTION_RULES.some((rule) => new RegExp(rule.pattern.source).test(secret)),
    true,
    'the fixture must be credential-shaped, or the assertion above would be vacuous',
  );
});

test('reason text is scrubbed before it can leave the module', () => {
  const credential = ['gh', 'p_', 'B'.repeat(30)].join('');

  const scrubbed = secretFreeReason(`sign-in failed for ${credential}`);

  assert.equal(scrubbed.includes(credential), false);
  assert.match(scrubbed, /\[redacted:github-token\]/);
  assert.equal(secretFreeReason('nothing sensitive here'), 'nothing sensitive here');
});
