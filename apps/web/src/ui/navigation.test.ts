/**
 * What the owner shell promises about its own navigation, asserted without a browser.
 *
 * ## Why this is not a render test
 *
 * There is no DOM harness in this package — no jsdom, no testing library, and adding one would put
 * a new dependency in a lockfile the repository pins deliberately. So the assertions here are on the
 * shell's decisions, which is where the promise actually lives: the list of primary areas, the
 * default, the wording on Home, and where an entry leads. Whether those render is proven in a real
 * browser by `apps/web/e2e`, which is the only place a rendering claim can honestly be made.
 *
 * ## What each assertion removes
 *
 *   - **"exactly four, in this order"** removes a fifth tab appearing without anyone deciding to add
 *     one. The old shell offered nine; the product decision was four.
 *   - **the denylist** removes the failure this shape of test is prone to: "the list does not
 *     contain X" passes for every section nobody thought to name. Each entry is a section this shell
 *     really exposed, so a silent reintroduction is caught.
 *   - **`entryLabel`** removes an internal discriminator being rendered as if it were a product
 *     state, and pins the gap case to a visible refusal rather than a blank.
 *   - **the executor vocabulary** removes the one thing this screen must never claim. It is a
 *     negative assertion over every string the Home screen can show, because inventing "the agent is
 *     working" is a one-line change with no test to stop it (mvp-spec 3).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SECTION,
  PRIMARY_SECTIONS,
  RETIRED_FROM_PRIMARY_NAVIGATION,
} from './navigation.ts';
import { HOME_GROUPS, entryLabel, homeTargetOf } from './mvp/home-model.ts';

/** Every kind `HomeProjection` can carry, per `apps/web/src/ui/mvp-client/types.ts`. */
const EVERY_HOME_ENTRY_KIND = [
  'ContractNotWritten',
  'ContractAwaitingApproval',
  'CandidateNotLinked',
  'VerificationOutstanding',
  'VerificationFailed',
  'OwnerTestOutstanding',
  'DecisionAwaiting',
  'CandidateReadyForReview',
] as const;

test('primary navigation is exactly the four owner areas, in order', () => {
  assert.deepEqual(
    PRIMARY_SECTIONS.map((entry) => entry.id),
    ['home', 'request', 'review', 'settings'],
    'the four areas are the product promise; their order is what the owner meets',
  );
  assert.deepEqual(
    PRIMARY_SECTIONS.map((entry) => entry.label),
    ['Home', 'New Request', 'Review', 'Settings'],
    'and the labels are the owner\'s words, not section ids',
  );
  assert.equal(
    new Set(PRIMARY_SECTIONS.map((entry) => entry.id)).size,
    PRIMARY_SECTIONS.length,
    'no area is offered twice, which would render two identical tabs',
  );
});

test('the shell starts on Home', () => {
  assert.equal(DEFAULT_SECTION, 'home', 'the product opens on what needs attention');
  assert.ok(
    PRIMARY_SECTIONS.some((entry) => entry.id === DEFAULT_SECTION),
    'and the default is one of the four areas rather than a section that is not offered',
  );
});

test('no orchestration-heavy section is reachable from primary navigation', () => {
  const labels = PRIMARY_SECTIONS.map((entry) => entry.label);
  for (const retired of RETIRED_FROM_PRIMARY_NAVIGATION) {
    assert.ok(
      !labels.includes(retired),
      `"${retired}" was a real section of the old shell and must not come back silently: it addresses a coding agent ShipLoop does not run`,
    );
  }
});

test('every Home entry kind is given a word in the owner\'s language', () => {
  for (const kind of EVERY_HOME_ENTRY_KIND) {
    const label = entryLabel(kind);
    assert.notEqual(label, '', `${kind} must not render as an empty label`);
    assert.ok(
      !label.includes('_'),
      `${kind} renders as "${label}" — an internal discriminator with an underscore is not owner-facing`,
    );
    assert.ok(!label.includes(kind), `${kind} must not be shown back to the owner verbatim`);
  }
});

test('a kind this build has no word for says so rather than rendering the discriminator', () => {
  // The backend may grow a kind before this screen learns it. A blank, a guess, or the raw
  // discriminator would all read as a product state the owner would act on (F23-AC1).
  const label = entryLabel('SomeFutureState');
  assert.ok(label.includes('no word for yet'), `the gap must be visible: ${label}`);
  assert.ok(label.includes('SomeFutureState'), 'and it must name what it could not describe');
});

test('an entry leads to Review only when there is a candidate to judge', () => {
  assert.equal(
    homeTargetOf({ candidateId: null }),
    'request',
    'no candidate means the question is what was asked for, which is the New Request area',
  );
  assert.equal(
    homeTargetOf({ candidateId: 'cand-1' }),
    'review',
    'a candidate is code to judge, which is the Review area',
  );
});

test('Home groups are the three the owner asked for, and each says what it contains', () => {
  assert.deepEqual(
    HOME_GROUPS.map((group) => group.key),
    ['needsYou', 'inProgress', 'readyForReview'],
    'three groups, matching the three keys the backend projection answers',
  );
  for (const group of HOME_GROUPS) {
    assert.notEqual(group.description, '', `${group.key} must say what it contains`);
    assert.notEqual(group.empty, '', `${group.key} must say what its absence means`);
  }
});

test('nothing Home can say claims an executor is working', () => {
  // The single most important negative in this file. ShipLoop holds no integration with T3,
  // OpenCode, Codex or Claude, so no string it renders may assert one is running — an owner reading
  // that would wait for something the product cannot observe.
  const forbidden = [
    /agent/i,
    /\bT3\b/,
    /coding[- ]agent/i,
    /engine/i,
    /running/i,
    /executing/i,
    /in progress on the agent/i,
  ];

  const shown = [
    ...PRIMARY_SECTIONS.map((entry) => entry.label),
    ...HOME_GROUPS.flatMap((group) => [group.title, group.description, group.empty]),
    ...EVERY_HOME_ENTRY_KIND.map((kind) => entryLabel(kind)),
  ];

  for (const text of shown) {
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(text),
        `Home can render "${text}", which matches ${pattern} — ShipLoop cannot observe an executor, so it must not claim one`,
      );
    }
  }
});