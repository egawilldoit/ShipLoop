/**
 * Proof for the MVP candidate-link table, against a real migrated database file.
 *
 * A file rather than `:memory:`, because the properties under test are the ones a memory
 * database cannot have: the schema arrived through the migration runner, the foreign key to
 * the project is enforced by SQLite, and the append-only triggers are installed by the
 * migration rather than by this file's discipline.
 *
 * What each case proves:
 *
 *   - a candidate's head and base SHAs survive a round trip at full length, and the schema
 *     refuses an abbreviated one at the column;
 *   - re-recording the same `(contract, revision, head)` is idempotent and reports that
 *     nothing was appended, so a retry cannot present a re-read as a new candidate;
 *   - a changed head appends a row rather than editing the old one, `currentForRequest`
 *     returns only the newest, and the older row is still readable — which is what keeps
 *     evidence collected for the old commit meaningful as evidence about the old commit;
 *   - two refreshes inside the same millisecond still produce one current candidate;
 *   - an UPDATE or DELETE on the table aborts, so history cannot be rewritten;
 *   - the identity fingerprint stored is the one derived from the row's own columns.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { candidateBindingFingerprint } from '@shiploop/domain';
import type { CommitSha, DomainError, ProjectId, Result } from '@shiploop/domain';

import { openDatabase, type Database } from '../db.ts';
import { LATEST_SCHEMA_VERSION, migrate } from '../migrations.ts';
import {
  DeliveryCandidateRepository,
  type DeliveryCandidateRecord,
  type RecordDeliveryCandidateInput,
} from './candidate-link.ts';

const PROJECT = 'project-candidate-01';
const OTHER_PROJECT = 'project-candidate-02';
const HEAD = '1f0c2a9d3b6e4c8a7d5f1e3b9c2a6d4e8f0a1b3c' as CommitSha;
const NEXT_HEAD = '7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a3' as CommitSha;
const BASE = '0b9d8c7b6a5948372615e4d3c2b1a09f8e7d6c5b' as CommitSha;
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T00:05:00.000Z';

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) assert.fail(`expected success, received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function expectRefusal<T>(result: Result<T, DomainError>, code: DomainError['code']): DomainError {
  if (result.ok) assert.fail(`expected a ${code} refusal, but the call succeeded`);
  assert.equal(result.error.code, code);
  return result.error;
}

let candidateCounter = 0;
function nextCandidateId(): string {
  candidateCounter += 1;
  return `candidate-${candidateCounter.toString().padStart(4, '0')}`;
}

function candidateInput(overrides: Partial<RecordDeliveryCandidateInput> = {}): RecordDeliveryCandidateInput {
  return {
    candidateId: nextCandidateId() as RecordDeliveryCandidateInput['candidateId'],
    projectId: PROJECT as ProjectId,
    requestId: 'request-01',
    contractId: 'contract-01',
    contractRevision: 1,
    provider: 'github',
    repository: 'egawilldoit/ShipLoop',
    pullRequestNumber: 7,
    pullRequestUrl: 'https://github.com/egawilldoit/ShipLoop/pull/7',
    baseBranch: 'main',
    baseSha: BASE,
    headBranch: 'task/mvp-candidate',
    headSha: HEAD,
    headRepository: 'egawilldoit/ShipLoop',
    pullRequestState: 'Open',
    draft: false,
    observedAt: T0,
    correlationId: 'corr-candidate-01',
    ...overrides,
  };
}

/** Opens a temporary file, migrates it, seeds the project parent rows, runs `body`. */
async function withDatabase(run: (db: Database, store: DeliveryCandidateRepository) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-candidate-'));
  const opened = openDatabase(join(directory, 'storage.sqlite'));
  assert.ok(opened.ok, `the database could not be opened: ${opened.ok ? '' : opened.error.reason}`);
  const db = opened.value;
  try {
    expectOk(migrate(db));
    db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(PROJECT, 'Candidate project');
    db.prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)').run(OTHER_PROJECT, 'Other project');
    run(db, new DeliveryCandidateRepository(db));
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function recordOf(store: DeliveryCandidateRepository, requestId = 'request-01'): DeliveryCandidateRecord | null {
  return expectOk(store.currentForRequest(requestId));
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

test('a recorded candidate keeps both commit SHAs at full length and a full set of facts', async () => {
  await withDatabase((_db, store) => {
    const recorded = expectOk(store.record(candidateInput()));
    assert.equal(recorded.alreadyRecorded, false);
    const row = recorded.candidate;
    assert.equal(row.headSha, HEAD);
    assert.equal(row.baseSha, BASE);
    assert.equal(row.headSha.length, 40);
    assert.equal(row.baseSha.length, 40);
    assert.equal(row.repository, 'egawilldoit/ShipLoop');
    assert.equal(row.pullRequestNumber, 7);
    assert.equal(row.pullRequestUrl, 'https://github.com/egawilldoit/ShipLoop/pull/7');
    assert.equal(row.baseBranch, 'main');
    assert.equal(row.headBranch, 'task/mvp-candidate');
    assert.equal(row.pullRequestState, 'Open');
    assert.equal(row.draft, false);
    assert.equal(row.headRepository, 'egawilldoit/ShipLoop');
    assert.equal(row.observationSequence, 1);
    assert.equal(row.observedAt, T0);
    assert.equal(row.contractId, 'contract-01');
    assert.equal(row.contractRevision, 1);

    // The read-back path agrees with the write path, byte for byte.
    assert.deepEqual(expectOk(store.get(row.candidateId)), row);
    assert.deepEqual(recordOf(store), row);
    assert.deepEqual(expectOk(store.findByBinding('contract-01', 1, HEAD)), row);
  });
});

test('the stored binding fingerprint is derived from the row, not from the caller', async () => {
  await withDatabase((_db, store) => {
    const row = expectOk(store.record(candidateInput())).candidate;
    assert.equal(
      row.bindingFingerprint,
      candidateBindingFingerprint({ contractId: 'contract-01', contractRevision: 1, headSha: HEAD }),
    );
    const next = expectOk(store.record(candidateInput({ headSha: NEXT_HEAD, candidateId: nextCandidateId() as RecordDeliveryCandidateInput['candidateId'] })))
      .candidate;
    assert.notEqual(next.bindingFingerprint, row.bindingFingerprint);
  });
});

test('the schema refuses an abbreviated commit SHA, so no candidate can be stored as a prefix', async () => {
  await withDatabase((db, _store) => {
    // Written directly, because the repository's input type makes this unrepresentable and
    // the column CHECK is the second, independent line of defence.
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO delivery_candidates (candidate_id, project_id, request_id, contract_id, contract_revision,
             observation_sequence, provider, repository, pull_request_number, pull_request_url, base_branch,
             base_sha, head_branch, head_sha, pull_request_state, binding_fingerprint, observed_at)
           VALUES ('candidate-short', ?, 'request-short', 'contract-01', 1, 1, 'github', 'o/r', 7,
             'https://github.com/o/r/pull/7', 'main', ?, 'task/x', ?, 'Open', ?, ?)`,
        )
        .run(
          PROJECT,
          BASE,
          '1f0c2a9d3b6',
          candidateBindingFingerprint({ contractId: 'contract-01', contractRevision: 1, headSha: HEAD }),
          T0,
        ),
    );
  });
});

test('the schema refuses a provider or a pull request state the product has no vocabulary for', async () => {
  await withDatabase((db, _store) => {
    const insert = (provider: string, state: string): void => {
      db.prepare(
        `INSERT INTO delivery_candidates (candidate_id, project_id, request_id, contract_id, contract_revision,
           observation_sequence, provider, repository, pull_request_number, pull_request_url, base_branch,
           base_sha, head_branch, head_sha, pull_request_state, binding_fingerprint, observed_at)
         VALUES (?, ?, ?, 'contract-vocab', 1, 1, ?, 'o/r', 7, 'https://github.com/o/r/pull/7', 'main', ?, 'task/x', ?, ?, ?, ?)`,
      ).run(
        `candidate-vocab-${provider}-${state}`,
        PROJECT,
        `request-${provider}-${state}`,
        provider,
        BASE,
        HEAD,
        state,
        candidateBindingFingerprint({ contractId: 'contract-vocab', contractRevision: 1, headSha: HEAD }),
        T0,
      );
    };
    assert.throws(() => insert('gitlab', 'Open'));
    assert.throws(() => insert('github', 'Draft'));
  });
});

test('a candidate cannot be recorded for a project that does not exist', async () => {
  await withDatabase((_db, store) => {
    const refusal = expectRefusal(
      store.record(candidateInput({ projectId: 'project-absent' as ProjectId })),
      'Unavailable',
    );
    assert.match(refusal.reason, /foreign key|record the candidate link/);
    assert.equal(recordOf(store), null, 'a refused write must leave no candidate behind');
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotency and change                                                      */
/* -------------------------------------------------------------------------- */

test('re-recording the same observation is idempotent and reports that nothing was appended', async () => {
  await withDatabase((_db, store) => {
    const first = expectOk(store.record(candidateInput()));
    // A different minted id and a different read instant: the retry a controller performs
    // after a timeout, not a second belief about the commit.
    const second = expectOk(
      store.record(candidateInput({ candidateId: nextCandidateId() as RecordDeliveryCandidateInput['candidateId'], observedAt: T1 })),
    );
    assert.equal(second.alreadyRecorded, true);
    assert.equal(second.candidate.candidateId, first.candidate.candidateId);
    assert.equal(second.candidate.observedAt, T0, 'the stored observation is the first one, not the retry');
    assert.equal(expectOk(store.historyForRequest('request-01')).length, 1);
  });
});

test('a pull request whose head did not move but which closed is a new observation', async () => {
  await withDatabase((_db, store) => {
    const open = expectOk(store.record(candidateInput())).candidate;
    const closed = expectOk(store.record(candidateInput({ pullRequestState: 'Closed', observedAt: T1 }))).candidate;
    // Keying idempotency on the commit alone would make this observation unrepresentable, and
    // a closed pull request would keep reading as the candidate that was linked while open.
    assert.notEqual(closed.candidateId, open.candidateId);
    assert.equal(closed.headSha, open.headSha, 'the commit did not move');
    assert.equal(closed.pullRequestState, 'Closed');
    assert.equal(closed.observationSequence, 2);
    assert.equal(recordOf(store)?.candidateId, closed.candidateId);
    // The earlier observation is untouched and still says Open.
    assert.equal(expectOk(store.get(open.candidateId)).pullRequestState, 'Open');
  });
});

test('a retargeted base branch and a renamed head branch are new observations too', async () => {
  await withDatabase((_db, store) => {
    const original = expectOk(store.record(candidateInput())).candidate;
    const retargeted = expectOk(
      store.record(candidateInput({ baseBranch: 'release', headBranch: 'task/renamed', observedAt: T1 })),
    ).candidate;
    assert.notEqual(retargeted.candidateId, original.candidateId);
    assert.equal(retargeted.baseBranch, 'release');
    assert.equal(retargeted.headBranch, 'task/renamed');
    assert.equal(recordOf(store)?.candidateId, retargeted.candidateId);
  });
});

test('a draft flag flip is recorded, because a draft is not reviewable and Open is not enough', async () => {
  await withDatabase((_db, store) => {
    const plain = expectOk(store.record(candidateInput())).candidate;
    const draft = expectOk(store.record(candidateInput({ draft: true, observedAt: T1 }))).candidate;
    assert.notEqual(draft.candidateId, plain.candidateId);
    assert.equal(draft.draft, true);
    assert.equal(recordOf(store)?.draft, true);
  });
});

test('a changed head appends a candidate, and the old one is still readable as history', async () => {
  await withDatabase((_db, store) => {
    const first = expectOk(store.record(candidateInput())).candidate;
    const second = expectOk(store.record(candidateInput({ headSha: NEXT_HEAD, observedAt: T1 }))).candidate;

    assert.notEqual(second.candidateId, first.candidateId);
    assert.equal(second.headSha, NEXT_HEAD);
    assert.equal(second.observationSequence, 2);

    // Only one candidate is current, and it is the new head.
    assert.equal(recordOf(store)?.candidateId, second.candidateId);
    assert.equal(recordOf(store)?.headSha, NEXT_HEAD);

    // The superseded row was not edited or deleted: evidence recorded for it still means
    // something, and `get` can still name exactly which commit that was.
    const superseded = expectOk(store.get(first.candidateId));
    assert.equal(superseded.headSha, HEAD);
    assert.equal(superseded.observationSequence, 1);
    const history = expectOk(store.historyForRequest('request-01'));
    assert.deepEqual(history.map((row) => row.headSha), [HEAD, NEXT_HEAD]);
  });
});

test('two refreshes in the same millisecond still leave exactly one current candidate', async () => {
  await withDatabase((_db, store) => {
    expectOk(store.record(candidateInput()));
    const second = expectOk(store.record(candidateInput({ headSha: NEXT_HEAD, observedAt: T0 }))).candidate;
    const current = recordOf(store);
    // The tie is broken by the sequence, not by a timestamp two readers could order
    // differently — which is what an outdated review card looks like when it is not.
    assert.equal(current?.candidateId, second.candidateId);
    assert.equal(current?.observationSequence, 2);
  });
});

test('requests keep independent sequences, so one request cannot become another request candidate', async () => {
  await withDatabase((_db, store) => {
    expectOk(store.record(candidateInput({ requestId: 'request-01' })));
    const other = expectOk(store.record(candidateInput({ requestId: 'request-02', headSha: NEXT_HEAD }))).candidate;
    assert.equal(other.observationSequence, 1);
    assert.equal(recordOf(store, 'request-01')?.headSha, HEAD);
    assert.equal(recordOf(store, 'request-02')?.headSha, NEXT_HEAD);
  });
});

test('the same head under a different contract revision is a different candidate', async () => {
  await withDatabase((_db, store) => {
    const first = expectOk(store.record(candidateInput())).candidate;
    const revised = expectOk(store.record(candidateInput({ contractRevision: 2 }))).candidate;
    assert.notEqual(revised.candidateId, first.candidateId);
    assert.equal(revised.headSha, first.headSha, 'the code is the same; what it is bound to is not');
    assert.notEqual(revised.bindingFingerprint, first.bindingFingerprint);
    assert.equal(recordOf(store)?.candidateId, revised.candidateId);
  });
});
test('a closed pull request is recorded as Closed rather than Open', async () => {
  await withDatabase((_db, store) => {
    const row = expectOk(store.record(candidateInput({ pullRequestState: 'Closed' }))).candidate;
    assert.equal(row.pullRequestState, 'Closed');
    assert.equal(row.headSha, HEAD, 'closing a pull request does not change the commit it held');
  });
});

/* -------------------------------------------------------------------------- */
/* Immutability                                                                */
/* -------------------------------------------------------------------------- */

test('updating a candidate row aborts, so a recorded identity cannot be rewritten', async () => {
  await withDatabase((db, store) => {
    const row = expectOk(store.record(candidateInput())).candidate;
    assert.throws(
      () =>
        db
          .prepare('UPDATE delivery_candidates SET head_sha = ? WHERE candidate_id = ?')
          .run(NEXT_HEAD, row.candidateId),
      /append-only/,
    );
    // The row still names the commit it was recorded for.
    assert.equal(expectOk(store.get(row.candidateId)).headSha, HEAD);
  });
});

test('deleting a candidate row aborts, because the head evidence was collected for is a fact', async () => {
  await withDatabase((db, store) => {
    const row = expectOk(store.record(candidateInput())).candidate;
    assert.throws(() => db.prepare('DELETE FROM delivery_candidates WHERE candidate_id = ?').run(row.candidateId), /retained/);
    assert.deepEqual(recordOf(store), row);
  });
});

test('the migration that owns this table is the one the build declares', async () => {
  assert.equal(LATEST_SCHEMA_VERSION, 13, 'the MVP candidate link arrived as migration 13');
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

test('an input that could not produce a candidate is refused with the field path an owner needs', async () => {
  await withDatabase((_db, store) => {
    const refusal = expectRefusal(
      store.record(
        candidateInput({
          requestId: '  ',
          contractRevision: 0,
          pullRequestNumber: 0,
          provider: 'gitlab',
          pullRequestState: 'Draft' as RecordDeliveryCandidateInput['pullRequestState'],
        }),
      ),
      'Invalid',
    );
    assert.equal(refusal.code, 'Invalid');
    if (refusal.code !== 'Invalid') return;
    assert.deepEqual(
      refusal.fields.map((field) => field.path).sort(),
      ['contractRevision', 'provider', 'pullRequestNumber', 'pullRequestState', 'requestId'],
    );
    assert.equal(recordOf(store), null);
  });
});

test('an unknown candidate id is NotFound rather than an empty candidate', async () => {
  await withDatabase((_db, store) => {
    const refusal = expectRefusal(store.get('candidate-nope' as RecordDeliveryCandidateInput['candidateId']), 'NotFound');
    assert.match(refusal.reason, /candidate-nope/);
    assert.equal(expectOk(store.currentForRequest('request-with-no-candidate')), null);
  });
});
