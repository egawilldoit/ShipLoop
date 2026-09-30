import type { Fingerprint } from './ids.ts';
import { fingerprint } from './fingerprint.ts';

/**
 * Owner authorization (F26, F27).
 *
 * Acceptance and authorization are different permissions. Accepting says the
 * product behaviour is correct. Authorizing says "perform this exact external
 * action against this exact identity".
 *
 * An authorization is therefore bound to a fingerprint that includes the action,
 * the destination and the candidate. Changing the candidate, the destination or
 * the policy invalidates an unconsumed approval, so an old decision can never
 * authorize a different release (F27-AC3).
 */

export type DeliveryAction =
  | { readonly kind: 'Merge'; readonly mergeMethod: 'Squash' | 'Merge' | 'Rebase' }
  | { readonly kind: 'Release'; readonly destination: string }
  | { readonly kind: 'MergeAndRelease'; readonly mergeMethod: 'Squash' | 'Merge' | 'Rebase'; readonly destination: string }
  | { readonly kind: 'RecoveryRedeploy'; readonly destination: string };

export interface AuthorizationSubject {
  readonly action: DeliveryAction;
  readonly destination: string;
  /** Pull request / merge request identity from the Git provider. */
  readonly pullRequestId: string | null;
  /** Exact head and target the owner is authorizing against. */
  readonly headSha: string;
  readonly targetBranch: string;
  readonly candidateFingerprint: Fingerprint;
  readonly componentDeployments: readonly { readonly component: string; readonly deploymentId: string | null }[];
}

export type AuthorizationState = 'Authorized' | 'Consumed' | 'Invalidated' | 'Expired';

export interface OwnerAuthorization {
  readonly authorizationId: string;
  readonly ownerId: string;
  readonly issuedAt: string;
  /** Instant after which the authorization may no longer be consumed. */
  readonly expiresAt: string;
  readonly subject: AuthorizationSubject;
  readonly subjectFingerprint: Fingerprint;
  readonly state: AuthorizationState;
  readonly consumedAt: string | null;
  readonly invalidatedReason: string | null;
  /** Authorization is bound to a single use of a single action. */
  readonly singleUse: true;
}

export type AuthorizationRejection =
  | 'SubjectChanged'
  | 'AlreadyConsumed'
  | 'Expired'
  | 'OwnerMismatch';

export type AuthorizationCheck =
  | { readonly valid: true; readonly authorization: OwnerAuthorization }
  | { readonly valid: false; readonly rejection: AuthorizationRejection; readonly reason: string };

/**
 * Verifies an authorization against the action about to be performed.
 *
 * Called immediately before the privileged write, against freshly read provider
 * state, not against cached webhook data (F26-AC2). A consumed authorization is
 * refused so a replayed request cannot merge twice, and an authorization issued
 * to a different owner is refused so attribution cannot be forged.
 */
export function checkAuthorization(input: {
  readonly authorization: OwnerAuthorization;
  readonly ownerId: string;
  readonly proposed: AuthorizationSubject;
  readonly now: string;
}): AuthorizationCheck {
  const { authorization, proposed } = input;
  if (authorization.ownerId !== input.ownerId) {
    return { valid: false, rejection: 'OwnerMismatch', reason: 'Authorization belongs to a different owner.' };
  }
  if (authorization.state === 'Consumed') {
    return {
      valid: false,
      rejection: 'AlreadyConsumed',
      reason: 'This authorization was already used for its single permitted action.',
    };
  }
  if (authorization.state === 'Invalidated') {
    return {
      valid: false,
      rejection: 'SubjectChanged',
      reason: authorization.invalidatedReason ?? 'Authorization was invalidated.',
    };
  }
  if (authorization.state === 'Expired') {
    return { valid: false, rejection: 'Expired', reason: 'Authorization expired before it was used.' };
  }
  if (input.now >= authorization.expiresAt) {
    return {
      valid: false,
      rejection: 'Expired',
      reason: `Authorization expired at ${authorization.expiresAt}; it is now ${input.now}.`,
    };
  }
  if (authorization.subjectFingerprint !== subjectFingerprint(proposed)) {
    return {
      valid: false,
      rejection: 'SubjectChanged',
      reason:
        'The authorized action no longer matches: candidate, destination, target or components changed since approval.',
    };
  }
  return { valid: true, authorization };
}

/**
 * Records the single permitted use of an authorization.
 *
 * Enforcing the Authorized -> Consumed flip here, rather than leaving it to each
 * caller's memory, is what makes the single-use promise hold even when a delivery
 * path forgets to set it.
 */
export function consumeAuthorization(
  authorization: OwnerAuthorization,
  consumedAt: string,
): OwnerAuthorization {
  if (authorization.state !== 'Authorized') return authorization;
  return { ...authorization, state: 'Consumed', consumedAt };
}

export function subjectFingerprint(subject: AuthorizationSubject): Fingerprint {
  const components = [...subject.componentDeployments].sort((left, right) =>
    left.component < right.component ? -1 : left.component > right.component ? 1 : 0,
  );
  return fingerprint({
    action: subject.action,
    destination: subject.destination,
    pullRequestId: subject.pullRequestId,
    headSha: subject.headSha,
    targetBranch: subject.targetBranch,
    candidateFingerprint: subject.candidateFingerprint,
    componentDeployments: components,
  });
}
