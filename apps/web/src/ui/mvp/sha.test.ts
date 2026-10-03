/**
 * The commit-identity rules the UI enforces at its own input boundary.
 *
 * The claims under test are that an abbreviated SHA is refused *by name* (an owner who pasted a
 * branch needs to be told that, not that "the SHA is wrong") and that a refusal never turns into a
 * silent acceptance, since a candidate recorded against a short SHA cannot be shown stale later.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FULL_SHA_LENGTH, isFullCommitSha, sameCommit, shaProblem, SHA_IDENTITY_NOTE } from './sha.ts';

const FULL = '0123456789abcdef0123456789abcdef01234567';

test('a full 40-character SHA is accepted', () => {
  assert.equal(FULL.length, FULL_SHA_LENGTH);
  assert.equal(isFullCommitSha(FULL), true);
  assert.equal(shaProblem(FULL), null);
});

test('uppercase hex is the same commit as lowercase', () => {
  assert.equal(isFullCommitSha(FULL.toUpperCase()), true);
  assert.equal(sameCommit(FULL, FULL.toUpperCase()), true);
});

test('surrounding whitespace from a paste is tolerated', () => {
  assert.equal(isFullCommitSha(`  ${FULL}\n`), true);
  assert.equal(shaProblem(`  ${FULL}\n`), null);
});

// The mistake everyone actually makes, and the one that silently destroys candidate identity.
test('an abbreviated SHA is refused with a sentence about abbreviation', () => {
  const problem = shaProblem('0123456');
  assert.notEqual(problem, null);
  assert.match(problem ?? '', /abbreviated SHA/i);
  assert.match(problem ?? '', /40/);
});

test('a branch name is refused as not being a commit identity at all', () => {
  const problem = shaProblem('feature/search-box');
  assert.match(problem ?? '', /not a commit SHA/i);
});

test('a pull request URL is refused as not being a commit identity at all', () => {
  assert.match(shaProblem('https://github.invalid/owner/name/pull/7') ?? '', /not a commit SHA/i);
});

test('an empty field is refused without being called malformed', () => {
  assert.match(shaProblem('') ?? '', /Enter the full commit SHA/);
  assert.match(shaProblem('    ') ?? '', /Enter the full commit SHA/);
});

test('a 41-character value is refused, because extra characters are not a longer SHA', () => {
  assert.equal(isFullCommitSha(`${FULL}0`), false);
});

test('a non-hex character inside a 40-character value is refused', () => {
  assert.equal(isFullCommitSha(`${FULL.slice(0, 39)}z`), false);
});

// Two values only compare when both are real identities. Otherwise `sameCommit('', '')` would be
// true and a page could claim evidence matched a commit that was never named.
test('two values compare only when both are full commit identities', () => {
  assert.equal(sameCommit('', ''), false);
  assert.equal(sameCommit('abc1234', 'abc1234'), false);
  assert.equal(sameCommit(FULL, 'f'.repeat(40)), false);
  assert.equal(sameCommit(FULL, FULL), true);
});

test('the identity rule is stated in the sentence surfaces show beside a candidate', () => {
  assert.match(SHA_IDENTITY_NOTE, /40/);
  assert.match(SHA_IDENTITY_NOTE, /branch name/i);
});