/**
 * The restricted broker: the only path from a coding attempt to a remote write (F03-AC5, N02-AC3, F19-AC1).
 *
 * `docs/evidence/2026-10-01-credential-separation.md` concluded that a coding agent holding a
 * repository credential can bypass the capability boundary entirely, because a credential does not
 * consult one. This module is the other half of that conclusion: the engine reaches the remote
 * through a broker that holds the credential, asks for one specific action, and performs it itself.
 * The model therefore never holds anything a leak would be worth, and "may the engine merge?" is
 * answered by code rather than by the model's restraint (F13-AC3, N02-AC3).
 *
 * **Two code paths, two credential scopes, and the difference is structural.** Feature-branch
 * publication and privileged delivery are not one function with a parameter: they are separate
 * methods over separate ports, and the ports take credentials of *different types*. A
 * `FeatureBranchCredential` can only be handed to the publisher and a `PrivilegedCredential` only to
 * the privileged deliverer, so the engine path is not merely checked and allowed to continue — it
 * has nothing it could pass to the privileged call even if the check were removed. A single
 * credential type with a flag on the request would put the whole boundary in one boolean comparison,
 * and one comparison is one mistake away from being wrong.
 *
 * **The refusal comes before the credential is touched.** A privileged request naming the engine
 * principal is refused with a `Forbidden` error that names the remedy, and nothing is read from the
 * privileged deliverer: a refusal that had already loaded the credential would make the audit trail
 * of "the engine asked" indistinguishable from "the engine nearly had it".
 *
 * **The broker records who acted.** Every outcome carries the acting principal, so a delivery that
 * did happen can be read back as an engine-requested publication or an owner-authorized merge
 * without reconstructing it from logs.
 *
 * This module decides nothing about whether a candidate is good enough to merge — the required
 * checks and the owner's acceptance do that (F20-AC2, F24-AC3). It decides who may ask, and it
 * refuses a privileged ask from the engine principal without consulting the candidate at all.
 */

import { err, invalid, ok } from '@shiploop/domain';
import type { DomainError, Result } from '@shiploop/domain';

/* -------------------------------------------------------------------------- */
/* Principals and authorizations                                               */
/* -------------------------------------------------------------------------- */

/**
 * Who is asking the broker to act.
 *
 * `Engine` is the coding agent's own process, identified by the uid it actually runs as; the uid is
 * part of the request rather than something the broker looks up, because a broker that trusted a
 * caller's claim about itself would be trusting the thing it is meant to constrain. A caller that
 * claims `Engine` gets the engine's rights, which are the smaller set, so a false claim narrows the
 * requester's own authority instead of widening it.
 */
export type BrokerPrincipal =
  | { readonly kind: 'Engine'; readonly uid: number; readonly attemptId: string; readonly workspacePath: string }
  | { readonly kind: 'Controller'; readonly actorId: string; readonly actorRole: 'Controller' | 'Owner' };

/** The owner's authorization of one privileged action on one ref, or the absence of one. */
export interface OwnerAuthorization {
  readonly scope: 'Merge' | 'Release';
  readonly actorId: string;
  /** The ref the owner named, which must be the ref the request wants written. */
  readonly targetRef: string;
  readonly authorizedAt: string;
  readonly justification: string;
}

export function isEnginePrincipal(principal: BrokerPrincipal): boolean {
  return principal.kind === 'Engine';
}

/** The name of a principal for a refusal or an audit record. Never a credential. */
export function describePrincipal(principal: BrokerPrincipal): string {
  return principal.kind === 'Engine'
    ? `the coding engine as uid ${String(principal.uid)} for attempt ${principal.attemptId}`
    : `${principal.actorRole.toLowerCase()} ${principal.actorId}`;
}

/* -------------------------------------------------------------------------- */
/* Credentials and the ports that hold them                                    */
/* -------------------------------------------------------------------------- */

/**
 * A credential that may write a feature branch and nothing else.
 *
 * The `scope` literal is part of the type, so a credential of the privileged scope is not assignable
 * here, and the value is never logged, returned in an outcome or put in an error message.
 */
export interface FeatureBranchCredential {
  readonly scope: 'FeatureBranchWrite';
  readonly secret: string;
}

/** A credential that may merge or deploy, which the engine principal never holds. */
export interface PrivilegedCredential {
  readonly scope: 'PrivilegedDelivery';
  readonly secret: string;
}

export interface BrokerRepository {
  readonly provider: 'github';
  readonly fullName: string;
  readonly defaultBranch: string;
}

export interface PushReceipt {
  readonly repository: string;
  readonly branch: string;
  readonly headSha: string;
  readonly remoteRef: string;
  readonly pushedAt: string;
}

export interface MergeReceipt {
  readonly repository: string;
  readonly branch: string;
  readonly mergedSha: string;
  readonly mergedAt: string;
}

export interface ReleaseReceipt {
  readonly repository: string;
  readonly environment: string;
  readonly releasedSha: string;
  readonly releasedAt: string;
  readonly receiptId: string;
}

/**
 * Publication: the one remote write the engine path may cause.
 *
 * It is a separate port from {@link PrivilegedDeliverer} on purpose. A combined port would let a
 * caller that reached the publisher reach the privileged half by naming a different action.
 */
export interface FeatureBranchPublisher {
  publish(request: {
    readonly repository: BrokerRepository;
    readonly branch: string;
    readonly headSha: string;
    readonly worktreePath: string;
    readonly credential: FeatureBranchCredential;
  }): Promise<Result<PushReceipt, DomainError>>;
}

/** Merge and deployment, with the credential only this port's methods accept. */
export interface PrivilegedDeliverer {
  merge(request: {
    readonly repository: BrokerRepository;
    readonly branch: string;
    readonly headSha: string;
    readonly authorization: OwnerAuthorization;
    readonly credential: PrivilegedCredential;
  }): Promise<Result<MergeReceipt, DomainError>>;
  release(request: {
    readonly repository: BrokerRepository;
    readonly environment: string;
    readonly ref: string;
    readonly authorization: OwnerAuthorization;
    readonly credential: PrivilegedCredential;
  }): Promise<Result<ReleaseReceipt, DomainError>>;
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                    */
/* -------------------------------------------------------------------------- */

export type BrokerOutcome =
  | { readonly action: 'PublishFeatureBranch'; readonly performedBy: BrokerPrincipal; readonly receipt: PushReceipt }
  | { readonly action: 'MergeCandidate'; readonly performedBy: BrokerPrincipal; readonly receipt: MergeReceipt }
  | { readonly action: 'ReleaseDeployment'; readonly performedBy: BrokerPrincipal; readonly receipt: ReleaseReceipt };

export interface BrokerSettings {
  /** The controller-held credential that may write feature branches. */
  readonly featureBranchCredential: FeatureBranchCredential;
  /** The controller-held privileged credential, or null where no such credential exists. */
  readonly privilegedCredential: PrivilegedCredential | null;
  readonly publisher: FeatureBranchPublisher;
  readonly deliverer: PrivilegedDeliverer;
  now(): string;
}

/* -------------------------------------------------------------------------- */
/* The broker                                                                  */
/* -------------------------------------------------------------------------- */

export interface PublishFeatureBranchRequest {
  readonly principal: BrokerPrincipal;
  readonly repository: BrokerRepository;
  readonly branch: string;
  readonly headSha: string;
  /** The checkout the publication runs in, so the broker reaches the attempt's own worktree. */
  readonly worktreePath: string;
}

export interface MergeCandidateRequest {
  readonly principal: BrokerPrincipal;
  readonly repository: BrokerRepository;
  readonly branch: string;
  readonly headSha: string;
  readonly authorization: OwnerAuthorization | null;
}

export interface ReleaseDeploymentRequest {
  readonly principal: BrokerPrincipal;
  readonly repository: BrokerRepository;
  readonly environment: string;
  readonly ref: string;
  readonly authorization: OwnerAuthorization | null;
}

/**
 * The broker itself (F03-AC5, N02-AC3).
 *
 * Three methods, and the difference between them is the credential each one is allowed to touch:
 * publication holds the feature-branch credential and refuses the base branch even for the
 * controller; merge and release hold nothing and refuse the engine principal before reading their
 * own settings.
 */
export function createRestrictedBroker(settings: BrokerSettings): Broker {
  const publish = async (request: PublishFeatureBranchRequest): Promise<Result<BrokerOutcome, DomainError>> => {
    const refused = refusePublication(request);
    if (refused !== null) return err(refused);
    const pushed = await settings.publisher.publish({
      repository: request.repository,
      branch: request.branch,
      headSha: request.headSha,
      worktreePath: request.worktreePath,
      credential: settings.featureBranchCredential,
    });
    if (!pushed.ok) return err(pushed.error);
    return ok({ action: 'PublishFeatureBranch', performedBy: request.principal, receipt: pushed.value });
  };

  const merge = async (request: MergeCandidateRequest): Promise<Result<BrokerOutcome, DomainError>> => {
    const refused = refusePrivileged(request.principal, 'Merge', request.branch, request.authorization);
    if (refused !== null) return err(refused);
    const credential = settings.privilegedCredential;
    if (credential === null) return err(noPrivilegedCredential('merge'));
    if (request.authorization === null) return err(noOwnerAuthorization('Merge', request.branch));
    const merged = await settings.deliverer.merge({
      repository: request.repository,
      branch: request.branch,
      headSha: request.headSha,
      authorization: request.authorization,
      credential,
    });
    if (!merged.ok) return err(merged.error);
    return ok({ action: 'MergeCandidate', performedBy: request.principal, receipt: merged.value });
  };

  const release = async (request: ReleaseDeploymentRequest): Promise<Result<BrokerOutcome, DomainError>> => {
    const refused = refusePrivileged(request.principal, 'Release', request.ref, request.authorization);
    if (refused !== null) return err(refused);
    const credential = settings.privilegedCredential;
    if (credential === null) return err(noPrivilegedCredential('release'));
    if (request.authorization === null) return err(noOwnerAuthorization('Release', request.ref));
    const released = await settings.deliverer.release({
      repository: request.repository,
      environment: request.environment,
      ref: request.ref,
      authorization: request.authorization,
      credential,
    });
    if (!released.ok) return err(released.error);
    return ok({ action: 'ReleaseDeployment', performedBy: request.principal, receipt: released.value });
  };

  return { publishFeatureBranch: publish, mergeCandidate: merge, releaseDeployment: release };
}

export interface Broker {
  /** Push a task branch and open nothing else. Reachable from the engine principal. */
  publishFeatureBranch(request: PublishFeatureBranchRequest): Promise<Result<BrokerOutcome, DomainError>>;
  /** Merge a candidate. Never reachable from the engine principal. */
  mergeCandidate(request: MergeCandidateRequest): Promise<Result<BrokerOutcome, DomainError>>;
  /** Deploy a ref. Never reachable from the engine principal, and a separate call from merge. */
  releaseDeployment(request: ReleaseDeploymentRequest): Promise<Result<BrokerOutcome, DomainError>>;
}

/**
 * What publication refuses, before any credential is read (F19-AC1).
 *
 * The base branch is refused for every principal including the controller: this method is the
 * feature-branch path, and a write to the branch a release is made from is a privileged write by
 * another name. `refs/` and `..` are refused because a branch name reaches `git push` as an
 * argument, and a name that can name a different ref is a name that can publish somewhere else.
 */
export function refusePublication(request: PublishFeatureBranchRequest): DomainError | null {
  const branch = request.branch.trim();
  if (branch === '' || branch.startsWith('-') || branch.includes('..') || branch.startsWith('refs/')) {
    return invalid('The branch to publish is not a feature-branch name.', [
      {
        path: 'branch',
        message: 'Expected a plain branch name. A name starting with a dash, containing "..", or naming a ref directly would make the pushed ref something other than the branch the attempt worked on (F19-AC1).',
      },
    ]);
  }
  if (branch === request.repository.defaultBranch) {
    return {
      code: 'Forbidden',
      reason: `The branch ${branch} is the base branch of ${request.repository.fullName}, so publishing to it is a privileged write and is not this path. Feature-branch publication writes the attempt's own branch; a merge or a release is the controller's to authorize (F03-AC5, N02-AC3).`,
    };
  }
  if (request.headSha.trim() === '') {
    return invalid('The commit to publish is not named.', [
      { path: 'headSha', message: 'A push without a named commit publishes whatever the branch happens to point at, which is not the work this attempt did (F19-AC1).' },
    ]);
  }
  return null;
}

/**
 * What privileged delivery refuses, before any credential is read (F03-AC5, N02-AC3).
 *
 * The engine principal is refused outright and unconditionally: a coding attempt that asks to merge
 * or deploy is refused whether or not the candidate passed its checks, because the answer to "may
 * the agent merge?" is never "yes, if it asks nicely". The owner's authorization is then checked
 * against the ref actually named, so an authorization for one branch cannot be replayed onto
 * another.
 */
export function refusePrivileged(
  principal: BrokerPrincipal,
  scope: 'Merge' | 'Release',
  targetRef: string,
  authorization: OwnerAuthorization | null,
): DomainError | null {
  if (isEnginePrincipal(principal)) {
    return {
      code: 'Forbidden',
      reason: `${describePrincipal(principal)} may not ${scope.toLowerCase()} ${targetRef}. A coding attempt is not an owner: privileged delivery is performed by the broker on the owner's authorization, and no credential that could perform it exists on the engine's side of this boundary (F03-AC3, N02-AC3). Record the required checks, present the review card, and have the owner authorize the delivery.`,
    };
  }
  if (authorization === null) {
    return noOwnerAuthorization(scope, targetRef);
  }
  if (authorization.scope !== scope) {
    return {
      code: 'Forbidden',
      reason: `The owner authorized ${authorization.scope.toLowerCase()} on ${authorization.targetRef}, which is not this ${scope.toLowerCase()} of ${targetRef}. An authorization for one action is not an authorization for another (F03-AC3, N02-AC3).`,
    };
  }
  if (authorization.targetRef !== targetRef) {
    return {
      code: 'Forbidden',
      reason: `The owner authorized ${scope.toLowerCase()} of ${authorization.targetRef}, not ${targetRef}. An authorization names one ref and is not transferable to another (F03-AC3, N02-AC3).`,
    };
  }
  return null;
}

function noOwnerAuthorization(scope: 'Merge' | 'Release', targetRef: string): DomainError {
  return {
    code: 'Forbidden',
    reason: `${scope === 'Merge' ? 'Merging' : 'Releasing'} ${targetRef} requires an owner authorization for that ref, and none was presented. The broker performs a privileged write only against a named owner decision (F13-AC3, N02-AC3).`,
  };
}

function noPrivilegedCredential(action: 'merge' | 'release'): DomainError {
  return {
    code: 'Unavailable',
    reason: `This process holds no privileged delivery credential, so it cannot ${action} anything. Privileged delivery belongs to the controller's delivery path with its own credential; a worker that cannot ${action} is a worker that cannot ${action} by accident (F03-AC5, N02-AC3).`,
  };
}

/**
 * A privileged deliverer that can do nothing (F03-AC5).
 *
 * The worker process wires this in place of a real one, so the merge and release paths are present,
 * typed and reachable only through their refusals. That is the point: a worker that has never held a
 * privileged credential cannot leak one, and a privileged path that does not exist cannot be reached
 * by a request that should not have been allowed anyway.
 */
export function refusePrivilegedDelivery(reason: string): PrivilegedDeliverer {
  const refuse = async <T>(): Promise<Result<T, DomainError>> => err({ code: 'Forbidden', reason });
  return {
    merge: async (): Promise<Result<MergeReceipt, DomainError>> => refuse(),
    release: async (): Promise<Result<ReleaseReceipt, DomainError>> => refuse(),
  };
}

/**
 * The principal a worker uses when it asks the broker to publish.
 *
 * A worker knows the uid its engine ran as because it configured it, and it names itself as the
 * controller because that is what it is: the worker performs the publication on the attempt's behalf
 * while the engine stays the party that caused it. Both facts are recorded in the outcome.
 */
export function controllerPrincipal(actorId: string): BrokerPrincipal {
  return { kind: 'Controller', actorId, actorRole: 'Controller' };
}