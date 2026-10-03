/**
 * Address parsing, which is what keeps the retired surfaces out of the product's navigation while
 * leaving them provable.
 *
 * The claims under test are that an unaddressable identity falls back to Home rather than to a
 * screen showing nothing, that the primary set is exactly four entries, and that an unknown
 * address cannot smuggle a retired surface into the header.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrimary, LEGACY_SECTIONS, parseRoute, PRIMARY_SURFACES, primaryHash, routeHash } from './navigation.ts';

// The MVP navigation is four surfaces. This is the claim the whole wave rests on.
test('primary navigation is exactly Home, New Request, Review and Settings', () => {
  assert.deepEqual(PRIMARY_SURFACES.map((surface) => surface.label), ['Home', 'New Request', 'Review', 'Settings']);
});

test('an empty address lands on Home rather than on a blank screen', () => {
  assert.deepEqual(parseRoute(''), { kind: 'home' });
  assert.deepEqual(parseRoute('#'), { kind: 'home' });
  assert.deepEqual(parseRoute('#/'), { kind: 'home' });
});

test('the four primary addresses parse to their own surfaces', () => {
  assert.deepEqual(parseRoute('#/home'), { kind: 'home' });
  assert.deepEqual(parseRoute('#/new-request'), { kind: 'new-request' });
  assert.deepEqual(parseRoute('#/settings'), { kind: 'settings' });
  assert.deepEqual(parseRoute('#/review'), { kind: 'review', candidateId: null });
  assert.deepEqual(parseRoute('#/review/cnd_7'), { kind: 'review', candidateId: 'cnd_7' });
});

test('a contract or handoff address carries its identity, and one without falls back to Home', () => {
  assert.deepEqual(parseRoute('#/contracts/ctc_3'), { kind: 'contract', contractId: 'ctc_3' });
  assert.deepEqual(parseRoute('#/handoff/ctc_3'), { kind: 'handoff', contractId: 'ctc_3' });
  assert.deepEqual(parseRoute('#/contracts/'), { kind: 'home' });
  assert.deepEqual(parseRoute('#/handoff'), { kind: 'home' });
});

// An identity that needs encoding must survive the round trip, or a deep link into a contract
// whose id contains a slash or a space silently opens Home.
test('identities are percent-decoded on the way in and encoded on the way out', () => {
  const route = { kind: 'contract', contractId: 'ctc/with space' } as const;
  assert.deepEqual(parseRoute(routeHash(route)), route);
});

test('every address round-trips through its own hash', () => {
  for (const hash of ['#/home', '#/new-request', '#/settings', '#/review', '#/review/cnd_1', '#/contracts/ctc_1', '#/handoff/ctc_1', '#/legacy/runs']) {
    assert.equal(routeHash(parseRoute(hash)), hash, hash);
  }
});

test('every retired surface is addressable, and none of them is a primary surface', () => {
  for (const section of LEGACY_SECTIONS) {
    const route = parseRoute(`#/legacy/${section}`);
    assert.deepEqual(route, { kind: 'legacy', section });
    assert.equal(primaryHash(section), null, `${section} must not be in primary navigation`);
  }
});

test('a legacy address whose section does not exist falls back rather than rendering nothing', () => {
  assert.deepEqual(parseRoute('#/legacy/retired-later'), { kind: 'home' });
  assert.deepEqual(parseRoute('#/nonsense'), { kind: 'home' });
});

test('no tab marks itself current while a retired surface is on screen', () => {
  const legacy = parseRoute('#/legacy/runs');
  for (const surface of PRIMARY_SURFACES) {
    assert.equal(isPrimary(legacy, surface.id), false, surface.label);
  }
});

test('the current tab matches the address, including the review sub-address', () => {
  assert.equal(isPrimary(parseRoute('#/home'), 'home'), true);
  assert.equal(isPrimary(parseRoute('#/review/cnd_1'), 'review'), true);
  assert.equal(isPrimary(parseRoute('#/review/cnd_1'), 'home'), false);
  assert.equal(isPrimary(parseRoute('#/contracts/ctc_1'), 'new-request'), false);
});