/**
 * The one derivation the New Request screen makes on the owner's behalf: the request title.
 *
 * The preview line and the submitted value both read this function, and that is the point being
 * tested — a derivation the owner cannot see is a derivation the owner cannot correct, and a
 * request whose title was quietly truncated is one they find in a list later rather than here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveTitle, TITLE_LIMIT } from './request.ts';

test('an empty description produces no title, so the form can refuse before it sends anything', () => {
  assert.deepEqual(deriveTitle(''), { title: '', shortened: false });
  assert.deepEqual(deriveTitle('   \n  \n'), { title: '', shortened: false });
});

test('the first non-empty line becomes the title, and later lines do not leak into it', () => {
  const derived = deriveTitle('Add a search box to the runs list\n\nIt should match the run name.');
  assert.equal(derived.title, 'Add a search box to the runs list');
  assert.equal(derived.shortened, false);
});

test('leading blank lines are skipped rather than producing an empty title', () => {
  assert.equal(deriveTitle('\n\n  First real line  \nsecond').title, 'First real line');
});

test('a long first line is shortened, and the shortening is reported rather than silent', () => {
  const derived = deriveTitle('x'.repeat(400));
  assert.equal(derived.title.length, TITLE_LIMIT);
  assert.equal(derived.shortened, true);
});

test('a first line of exactly the limit is not reported as shortened', () => {
  const derived = deriveTitle('x'.repeat(TITLE_LIMIT));
  assert.equal(derived.shortened, false);
  assert.equal(derived.title.length, TITLE_LIMIT);
});

// Nothing in the derivation mutates the description the page sends, which is what lets a request
// keep text its title could not hold.
test('the whole description is still submitted; only the title is bounded', () => {
  const description = `${'x'.repeat(400)}\nsecond line`;
  assert.equal(deriveTitle(description).shortened, true);
  assert.equal(description.length, 400 + 1 + 'second line'.length);
});