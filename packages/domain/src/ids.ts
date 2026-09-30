/**
 * Branded identifier types.
 *
 * Provider names, issue titles and branch names are display fields, never identity
 * keys (mvp-spec 7). Identity is an opaque provider ID or a full commit SHA, so the
 * two are represented by different brands and cannot be interchanged by accident.
 */

declare const brand: unique symbol;

/** An opaque ShipLoop identifier for a locally owned entity. */
export type ShipLoopId<K extends string> = string & { readonly [brand]: K };

/** A full 40/64 character Git commit SHA. Never an abbreviation. */
export type CommitSha = string & { readonly [brand]: 'CommitSha' };

/** An opaque provider-side identifier (Linear issue id, deployment id, session id). */
export type ProviderId = string & { readonly [brand]: 'ProviderId' };

export type ProjectId = ShipLoopId<'ProjectId'>;
export type ProfileVersionId = ShipLoopId<'ProfileVersionId'>;
export type WorkItemId = ShipLoopId<'WorkItemId'>;
export type ScopeSnapshotId = ShipLoopId<'ScopeSnapshotId'>;
export type AttemptId = ShipLoopId<'AttemptId'>;
export type CandidateId = ShipLoopId<'CandidateId'>;
export type JobId = ShipLoopId<'JobId'>;
export type OwnerId = ShipLoopId<'OwnerId'>;
export type ConnectorId = ShipLoopId<'ConnectorId'>;
export type ProcedureVersionId = ShipLoopId<'ProcedureVersionId'>;
export type DecisionId = ShipLoopId<'DecisionId'>;
export type EvidenceId = ShipLoopId<'EvidenceId'>;
export type OperationId = ShipLoopId<'OperationId'>;
export type ReceiptId = ShipLoopId<'ReceiptId'>;
export type AttentionItemId = ShipLoopId<'AttentionItemId'>;
export type IdeaId = ShipLoopId<'IdeaId'>;

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

/** True when the value is a full commit SHA rather than an abbreviation or ref name. */
export function isCommitSha(value: string): value is CommitSha {
  return SHA40.test(value) || SHA64.test(value);
}

export function asCommitSha(value: string): CommitSha {
  if (!isCommitSha(value)) {
    throw new Error(`Not a full commit SHA: ${value.slice(0, 12)}`);
  }
  return value;
}

/** A semantic fingerprint of a set of inputs. Stable across runs, unlike an object hash. */
export type Fingerprint = string & { readonly [brand]: 'Fingerprint' };

const FINGERPRINT = /^fp_[0-9a-f]{32}$/;

export function isFingerprint(value: string): value is Fingerprint {
  return FINGERPRINT.test(value);
}

export function asFingerprint(value: string): Fingerprint {
  if (!isFingerprint(value)) throw new Error(`Malformed fingerprint: ${value}`);
  return value;
}
