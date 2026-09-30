import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalize, fingerprint } from './fingerprint.ts';
import { isFingerprint } from './ids.ts';

/**
 * Canonicalisation is what makes a fingerprint comparable across processes and
 * restarts, so these tests pin the three properties the comparison depends on:
 * key order is irrelevant, absence is not null, and array order is meaningful.
 */

describe('canonicalize', () => {
  test('sorts object keys so insertion order cannot change the canonical string', () => {
    const first = { alpha: 1, beta: 2, gamma: 3 };
    const second = { gamma: 3, beta: 2, alpha: 1 };

    assert.equal(canonicalize(first), canonicalize(second));
    assert.equal(canonicalize(first), '{"alpha":1,"beta":2,"gamma":3}');
  });

  test('sorts object keys at every depth of a nested structure', () => {
    const left = { outer: { zulu: 1, alpha: 2 }, other: [{ second: 'b', first: 'a' }] };
    const right = { other: [{ first: 'a', second: 'b' }], outer: { alpha: 2, zulu: 1 } };

    assert.equal(canonicalize(left), canonicalize(right));
  });

  test('drops undefined members rather than emitting them', () => {
    assert.equal(canonicalize({ kept: 'yes', dropped: undefined }), '{"kept":"yes"}');
    assert.equal(canonicalize({ kept: 'yes', dropped: undefined }), canonicalize({ kept: 'yes' }));
  });

  test('distinguishes an explicit null member from an absent member', () => {
    assert.equal(canonicalize({ a: 1, b: null }), '{"a":1,"b":null}');
    assert.notEqual(canonicalize({ a: 1, b: null }), canonicalize({ a: 1 }));
  });

  test('preserves array order because order is meaningful', () => {
    assert.equal(canonicalize(['first', 'second', 'third']), '["first","second","third"]');
    assert.notEqual(canonicalize(['first', 'second', 'third']), canonicalize(['third', 'second', 'first']));
  });

  test('throws for a non-finite number instead of silently canonicalizing it as null', () => {
    assert.throws(() => canonicalize(Number.NaN), /Non-finite number/);
    assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), /Non-finite number/);
    assert.throws(() => canonicalize(Number.NEGATIVE_INFINITY), /Non-finite number/);
    assert.throws(() => canonicalize({ nested: Number.NaN }), /Non-finite number/);
    assert.throws(() => canonicalize(['fine', Number.POSITIVE_INFINITY]), /Non-finite number/);
    assert.throws(() => fingerprint({ nested: Number.NEGATIVE_INFINITY }), /Non-finite number/);
  });

  test('rejects a value it cannot represent rather than emitting undefined', () => {
    assert.throws(() => canonicalize(() => 'not canonicalizable'), /Unsupported value in canonical form/);
  });
});

describe('fingerprint', () => {
  test('is deterministic, prefixed fp_, 35 characters long and hex only', () => {
    const value = { candidate: 'cand_1', checks: ['check', 'lint'] };
    const first = fingerprint(value);

    assert.equal(first, fingerprint(value));
    assert.equal(first.length, 35);
    assert.ok(first.startsWith('fp_'), 'fingerprint must carry the fp_ prefix');
    assert.match(first, /^fp_[0-9a-f]{32}$/);
    assert.ok(isFingerprint(first));
  });

  test('hashes structurally equal objects identically regardless of key insertion order', () => {
    assert.equal(
      fingerprint({ a: 1, b: { c: 2, d: [3, 4] } }),
      fingerprint({ b: { d: [3, 4], c: 2 }, a: 1 }),
    );
  });

  test('hashes nested objects and arrays stably across repeated calls and re-parsed copies', () => {
    const nested = { level1: { level2: [{ id: 'x', tags: ['t1', 't2'] }] } };
    const expected = fingerprint(nested);
    const rehydrated: typeof nested = JSON.parse(JSON.stringify(nested)) as typeof nested;

    assert.equal(expected, fingerprint(nested));
    assert.equal(expected, fingerprint(rehydrated));
  });

  test('changes when a single character of a nested value changes', () => {
    const base = fingerprint({ note: 'candidate-alpha' });

    assert.notEqual(base, fingerprint({ note: 'candidate-alphb' }));
    assert.notEqual(base, fingerprint({ note: 'candidate-alph' }));
    assert.notEqual(base, fingerprint({ note: 'Candidate-alpha' }));
  });

  test('changes when array element order changes, because order is meaningful', () => {
    assert.notEqual(fingerprint({ order: [1, 2, 3] }), fingerprint({ order: [3, 2, 1] }));
  });
});