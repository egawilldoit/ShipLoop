/**
 * Behavioural proof for the MVP review store.
 *
 * Runs against the REAL migrated schema, like `core.test.ts`: a temporary SQLite file is
 * migrated by `migrate` and the store is driven against it. A test that proved this
 * store against a schema it invented would prove nothing, and the whole point of the
 * store is that the *schema* refuses a short SHA and an unattributable owner test.
 *
 * A file rather than `:memory:` because one property under test is durability: a decision
 * must still read back, with its owner and its exact SHA, after the connection is closed
 * and reopened.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { asCommitSha, recordMvpEvidence, recordMvpOwnerDecision } from '@shiploop/domain';
import type {
  CommitSha,
  DomainError,
  MvpEvidenceObservation,
  MvpOwnerActor,
  MvpOwnerDecision,
  MvpRecordedEvidence,
  Result,
} from '@shiploop/domain';
import { openDatabase } from '../db.ts';
import type { Database } from '../db.ts';
import { migrate } from '../migrations.ts';
import { SqliteMvpReviewStore } from './mvp-review.ts';

const HEAD = asCommitSha('a1b2c3d4'.repeat(5));
const NEXT_HEAD = asCommitSha('f0e1d2c3'.repeat(5));
const OWNER_ID = 'owner-0000-4000-8000-00000000000c' as MvpOwnerActor['ownerId'];
const OWNER: MvpOwnerActor = { role: 'owner', ownerId: OWNER_ID };
const T1 = '2026-10-03T09:30:00Z';

function expectOk<T>(result: Result<T, DomainError>): T {
  if (!result.ok) assert.fail(`expected success but received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

function expectErr<T>(result: Result<T, DomainError>): DomainError {
  if (result.ok) assert.fail('expected a refusal');
  return result.error;
}

async function withStore(run: (store: SqliteMvpReviewStore, db: Database, path: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-mvp-review-'));
  const path = join(directory, 'review.sqlite');
  try {
    const opened = openDatabase(path);
    assert.ok(opened.ok, `the database opened: ${opened.ok ? '' : opened.error.reason}`);
    const db = opened.value;
    expectOk(migrate(db));
    await run(new SqliteMvpReviewStore(db), db, path);
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function evidence(
  overrides: {
    evidenceId?: string;
    subject?: { kind: 'criterion'; criterionId: string } | { kind: 'check'; checkId: string };
    method?: MvpRecordedEvidence['method'];
    observation?: MvpEvidenceObservation;
    observedHeadSha?: string | null;
    observedContractRevision?: number | null;
    observedAt?: string | null;
    outcomeSource?: MvpRecordedEvidence['source'];
  } = {},
): MvpRecordedEvidence {
  const source = overrides.outcomeSource ?? 'project_command';
  const observation = overrides.observation ?? (
    source === 'owner_test'
      ? ({ kind: 'owner_test', outcome: 'passed', actor: OWNER } as MvpEvidenceObservation)
      : ({ kind: 'command', outcome: 'passed' } as MvpEvidenceObservation)
  );
  const recorded = recordMvpEvidence({
    evidenceId: overrides.evidenceId ?? 'evid-1',
    contractId: 'contract-1',
    candidateId: 'cand-1',
    subject: overrides.subject ?? { kind: 'check', checkId: 'unit' },
    method: overrides.method ?? { kind: 'AutomatedCheck', checkId: 'unit' },
    observation,
    observedHeadSha: overrides.observedHeadSha === undefined ? HEAD : overrides.observedHeadSha,
    observedContractRevision: overrides.observedContractRevision === undefined ? 2 : overrides.observedContractRevision,
    observedAt: overrides.observedAt === undefined ? T1 : overrides.observedAt,
    detail: null,
    artifactRef: null,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) throw new Error('fixture must be valid evidence');
  return recorded.value;
}

function evidenceInput(value: MvpRecordedEvidence, owner: MvpOwnerActor | null = null) {
  return {
    evidence: value,
    projectId: 'proj-1',
    requestId: 'req-1',
    candidateId: 'cand-1',
    candidateHeadSha: HEAD,
    contractId: 'contract-1',
    contractRevision: 2,
    recordedAt: T1,
    correlationId: 'corr-1',
    owner,
  };
}

function decision(kind: 'accepted' | 'changes_requested', overrides: { id?: string; headSha?: CommitSha; revision?: number; at?: string } = {}): MvpOwnerDecision {
  const recorded = recordMvpOwnerDecision({
    decisionId: overrides.id ?? `dec-${kind}`,
    kind,
    actor: OWNER,
    projectId: 'proj-1',
    requestId: 'req-1',
    contractId: 'contract-1',
    contractRevision: overrides.revision ?? 2,
    candidateId: 'cand-1',
    candidateHeadSha: overrides.headSha ?? HEAD,
    decidedAt: overrides.at ?? T1,
    feedback: kind === 'changes_requested' ? 'the label is wrong' : null,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) throw new Error('fixture must be a valid decision');
  return recorded.value;
}

const PROJECTION = { candidateId: 'cand-1', candidateHeadSha: HEAD, contractId: 'contract-1', contractRevision: 2 };

test('recorded evidence reads back with its SHA, revision, method and time intact', async () => {
  await withStore((store) => {
    expectOk(store.recordEvidence(evidenceInput(evidence())));
    const projection = expectOk(store.readProjection(PROJECTION));
    assert.equal(projection.evidence.length, 1);
    const row = projection.evidence[0];
    assert.equal(row?.binding?.candidateHeadSha, HEAD);
    assert.equal(row?.binding?.contractRevision, 2);
    assert.equal(row?.binding?.observedAt, T1);
    assert.equal(row?.outcome, 'passed');
    assert.equal(row?.method.kind, 'AutomatedCheck');
  });
});

test('an owner test row round-trips the owner identity that ran it', async () => {
  await withStore((store) => {
    const ownerEvidence = evidence({
      evidenceId: 'evid-owner',
      subject: { kind: 'criterion', criterionId: 'c-owner' },
      method: { kind: 'OwnerTest', instructions: 'sign in' },
      outcomeSource: 'owner_test',
      observation: { kind: 'owner_test', outcome: 'passed', actor: OWNER },
    });
    expectOk(store.recordEvidence(evidenceInput(ownerEvidence, OWNER)));
    const projection = expectOk(store.readProjection(PROJECTION));
    assert.equal(projection.evidence[0]?.source, 'owner_test');
    assert.equal(projection.evidence[0]?.outcome, 'passed');
    assert.equal(projection.evidence[0]?.subject.kind, 'criterion');
  });
});

test('an owner test row without an owner identity is refused before it is written', async () => {
  await withStore((store) => {
    const ownerEvidence = evidence({
      evidenceId: 'evid-owner',
      subject: { kind: 'criterion', criterionId: 'c-owner' },
      method: { kind: 'OwnerTest', instructions: 'sign in' },
      outcomeSource: 'owner_test',
      observation: { kind: 'owner_test', outcome: 'passed', actor: OWNER },
    });
    const error = expectErr(store.recordEvidence(evidenceInput(ownerEvidence, null)));
    assert.equal(error.code, 'Invalid');
    assert.match(error.reason, /unattributable/);
    assert.equal(expectOk(store.readProjection(PROJECTION)).evidence.length, 0);
  });
});

test('the schema refuses an abbreviated candidate SHA on an evidence row', async () => {
  await withStore((store, db) => {
    expectOk(store.recordEvidence(evidenceInput(evidence())));
    assert.throws(() => {
      db.prepare(
        `INSERT INTO mvp_review_evidence (evidence_id, project_id, request_id, contract_id, contract_revision,
           candidate_id, candidate_head_sha, subject_kind, subject_id, method_kind, method_detail, source, outcome,
           observed_head_sha, observed_contract_revision, observed_at, recorded_at, correlation_id)
         VALUES ('evid-short', 'p', 'r', 'contract-1', 2, 'cand-1', 'abc1234', 'check', 'unit',
                 'AutomatedCheck', 'unit', 'project_command', 'passed', ?, 2, ?, ?, 'c')`,
      ).run(HEAD, T1, T1, T1);
    });
  });
});

test('the schema refuses an abbreviated candidate SHA on a decision row', async () => {
  await withStore((_store, db) => {
    assert.throws(() => {
      db.prepare(
        `INSERT INTO mvp_owner_decisions (decision_id, project_id, request_id, contract_id, contract_revision,
           candidate_id, candidate_head_sha, kind, owner_id, decided_at, correlation_id)
         VALUES ('dec-short', 'p', 'r', 'contract-1', 2, 'cand-1', 'main', 'accepted', ?, ?, 'c')`,
      ).run(OWNER_ID, T1);
    });
  });
});

test('a change request with no feedback is refused by the schema', async () => {
  await withStore((_store, db) => {
    assert.throws(() => {
      db.prepare(
        `INSERT INTO mvp_owner_decisions (decision_id, project_id, request_id, contract_id, contract_revision,
           candidate_id, candidate_head_sha, kind, owner_id, decided_at, correlation_id)
         VALUES ('dec-no-feedback', 'p', 'r', 'contract-1', 2, 'cand-1', ?, 'changes_requested', ?, ?, 'c')`,
      ).run(HEAD, OWNER_ID, T1);
    });
  });
});

test('evidence recorded against an older SHA is returned and still names that SHA', async () => {
  await withStore((store) => {
    const older = '2026-10-03T09:00:00Z';
    const newer = '2026-10-03T10:00:00Z';
    expectOk(store.recordEvidence(evidenceInput(evidence({ evidenceId: 'evid-old', observedHeadSha: NEXT_HEAD, observedAt: older }))));
    expectOk(store.recordEvidence(evidenceInput(evidence({ evidenceId: 'evid-new', observedAt: newer }))));
    const projection = expectOk(store.readProjection(PROJECTION));
    // Newest first, so the projection can pick the latest observation without depending on
    // the order a repository happened to list the rows in.
    assert.deepEqual(projection.evidence.map((row) => row.evidenceId), ['evid-new', 'evid-old']);
    const old = projection.evidence.find((row) => row.evidenceId === 'evid-old');
    assert.equal(old?.observedHeadSha, NEXT_HEAD);
    assert.notEqual(old?.binding?.candidateHeadSha, HEAD);
  });
});

test('an unattributed observation is storable and reads back unbound', async () => {
  await withStore((store) => {
    expectOk(store.recordEvidence(evidenceInput(evidence({ observedHeadSha: null, observedContractRevision: null }))));
    const projection = expectOk(store.readProjection(PROJECTION));
    assert.equal(projection.evidence[0]?.binding, null);
    assert.equal(projection.evidence[0]?.observedHeadSha, null);
    assert.equal(projection.evidence[0]?.outcome, 'passed');
  });
});

test('a decision survives a close and reopen with its owner, revision and SHA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-mvp-review-persist-'));
  const path = join(directory, 'review.sqlite');
  try {
    const opened = openDatabase(path);
    assert.ok(opened.ok);
    const store = new SqliteMvpReviewStore(opened.value);
    expectOk(migrate(opened.value));
    expectOk(store.recordDecision({ decision: decision('accepted'), correlationId: 'corr-1' }));
    opened.value.close();

    const reopened = openDatabase(path);
    assert.ok(reopened.ok);
    const reread = expectOk(new SqliteMvpReviewStore(reopened.value).readProjection(PROJECTION));
    assert.equal(reread.decisions.length, 1);
    assert.equal(reread.decisions[0]?.kind, 'accepted');
    assert.equal(reread.decisions[0]?.ownerId, OWNER_ID);
    assert.equal(reread.decisions[0]?.candidateHeadSha, HEAD);
    assert.equal(reread.decisions[0]?.contractRevision, 2);
    reopened.value.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a change request keeps its feedback across the round trip', async () => {
  await withStore((store) => {
    expectOk(store.recordDecision({ decision: decision('changes_requested'), correlationId: 'corr-1' }));
    const projection = expectOk(store.readProjection(PROJECTION));
    assert.equal(projection.decisions[0]?.kind, 'changes_requested');
    assert.equal(projection.decisions[0]?.feedback, 'the label is wrong');
  });
});

test('a decision recorded for an older SHA keeps that SHA so it can read as stale', async () => {
  await withStore((store) => {
    expectOk(store.recordDecision({ decision: decision('accepted', { id: 'dec-old', headSha: NEXT_HEAD }), correlationId: 'corr-1' }));
    const projection = expectOk(store.readProjection(PROJECTION));
    assert.equal(projection.decisions[0]?.candidateHeadSha, NEXT_HEAD);
  });
});

test('a repeated write of the same evidence identity does not create a second row', async () => {
  await withStore((store) => {
    const value = evidence();
    expectOk(store.recordEvidence(evidenceInput(value)));
    expectOk(store.recordEvidence(evidenceInput(value)));
    assert.equal(expectOk(store.readProjection(PROJECTION)).evidence.length, 1);
  });
});

test('a decision row is append-only: it cannot be updated or deleted', async () => {
  await withStore((store, db) => {
    expectOk(store.recordDecision({ decision: decision('accepted'), correlationId: 'corr-1' }));
    assert.throws(() => db.prepare('UPDATE mvp_owner_decisions SET kind = ? WHERE decision_id = ?').run('changes_requested', 'dec-accepted'));
    assert.throws(() => db.prepare('DELETE FROM mvp_owner_decisions WHERE decision_id = ?').run('dec-accepted'));
  });
});

test('an evidence row is append-only: it cannot be updated or deleted', async () => {
  await withStore((store, db) => {
    expectOk(store.recordEvidence(evidenceInput(evidence())));
    assert.throws(() => db.prepare('UPDATE mvp_review_evidence SET outcome = ? WHERE evidence_id = ?').run('failed', 'evid-1'));
    assert.throws(() => db.prepare('DELETE FROM mvp_review_evidence WHERE evidence_id = ?').run('evid-1'));
  });
});

test('a projection for a different contract revision reads nothing', async () => {
  await withStore((store) => {
    expectOk(store.recordEvidence(evidenceInput(evidence())));
    expectOk(store.recordDecision({ decision: decision('accepted'), correlationId: 'corr-1' }));
    const other = expectOk(store.readProjection({ ...PROJECTION, contractRevision: 3 }));
    assert.equal(other.evidence.length, 0);
    assert.equal(other.decisions.length, 0);
  });
});