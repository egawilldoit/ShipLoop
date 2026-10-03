/**
 * Candidate linking for the minimal MVP (SHARED.md, "Candidate" and "Evidence").
 *
 * ShipLoop v0.1 links the implementation someone else wrote to one exact GitHub pull
 * request and then verifies *that* code. Everything in this module exists because the
 * identity of that code has to survive a branch rename, an amend, a force push and a
 * second read an hour later, and because the previous read's results must stop counting
 * the moment the identity moves.
 *
 * Four rules are encoded here rather than left to a caller:
 *
 * 1. **Only a full commit SHA is identity.** `pullRequestNumber`, `headBranch` and an
 *    abbreviated SHA are all display or routing facts. `requireFullCommitSha` refuses
 *    them at the boundary, so a candidate cannot be recorded as "PR 7" or "task/x" and
 *    quietly inherit whatever the provider points at when it is next read.
 * 2. **A pull request URL is validated as a URL.** `parseGitHubPullRequestUrl` refuses a
 *    host that is not GitHub and a path that is not `owner/repo/pull/number`, so a
 *    GitLab or Bitbucket address pasted into a GitHub-only journey produces a stated
 *    refusal rather than a confident mis-parse (SHARED.md "GitLab" is out of scope).
 * 3. **A changed head invalidates the previous read.** `detectCandidateChange` returns
 *    the head the owner was looking at alongside the head the provider holds, and its
 *    `priorEvidenceStale` flag is the single place that decides old evidence no longer
 *    proves the current candidate. Nothing downstream has to recompute it, so a view
 *    cannot quietly keep a ready status across a force push.
 * 4. **Skipped is not passed.** `projectCandidateChecks` copies the domain's six-state
 *    `CheckResult` vocabulary through unchanged and `candidateChecksReady` reports a
 *    candidate ready only when every required check is `Passed` (or a `NotApplicable`
 *    a policy decision approved). `Missing`, `Waiting`, `Stale`, `NotApplicable` and
 *    `Failed` are all reported as not ready, and there is no branch anywhere in this
 *    file that maps an unknown provider conclusion onto `Passed`.
 */

import { fingerprint } from './fingerprint.ts';
import { err, invalid, ok } from './result.ts';
import type { DomainError, Result } from './result.ts';
import { isBlocking } from './evidence.ts';
import type { CheckResult } from './evidence.ts';
import { isCommitSha } from './ids.ts';
import type { CandidateId, CommitSha, Fingerprint, ProjectId } from './ids.ts';

/* -------------------------------------------------------------------------- */
/* Pull request identity                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The provider this MVP links candidates from.
 *
 * A literal rather than a free string, because "the provider is GitHub" is a validation
 * the product performs, not a value it stores and compares later. A GitLab or Bitbucket
 * address cannot be expressed here at all (SHARED.md, "Explicitly out of scope").
 */
export const CANDIDATE_PROVIDER = 'github';

/** Host GitHub serves pull request pages from, and the only host this MVP accepts. */
export const GITHUB_WEB_HOST = 'github.com';

/**
 * A pull request address, split into the parts identity needs.
 *
 * `number` and `url` are routing facts; `repository` is the fact that decides whether
 * the pull request belongs to this project at all. `fullName` is kept as the provider's
 * own `owner/repository` spelling because that is the string GitHub paths are built from.
 */
export interface ParsedPullRequestUrl {
  readonly provider: typeof CANDIDATE_PROVIDER;
  readonly host: string;
  /** `owner`, as GitHub spells it in a path. */
  readonly owner: string;
  /** `repository`, as GitHub spells it in a path. */
  readonly repository: string;
  /** `owner/repository`, the string every GitHub path is built from. */
  readonly fullName: string;
  readonly number: number;
  readonly url: string;
}

/**
 * GitHub's owner and repository name grammar.
 *
 * Enforced because both segments become URL path segments when the pull request is read
 * from the provider: an unvalidated `../` here would address a different resource with a
 * request the owner never named.
 */
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Parses a pasted pull request URL into provider identity.
 *
 * Accepts the two shapes a person actually pastes — a browser address such as
 * `https://github.com/o/r/pull/7` and the path a CLI prints such as
 * `github.com/o/r/pull/7` — plus a trailing `/files`, `/commits` or fragment, because
 * those are what a copied browser URL contains. Anything else is a stated refusal rather
 * than a guess, and the refusal names what was expected.
 *
 * The comparison of the owner and repository is case-insensitive, because GitHub treats
 * them that way: refusing `Shiploop` because the owner typed a different case would make
 * a correct link impossible while still saying nothing about a genuinely different repo.
 */
export function parseGitHubPullRequestUrl(input: string): Result<ParsedPullRequestUrl, DomainError> {
  const fields: { path: string; message: string }[] = [];
  const raw = input.trim();
  if (raw.length === 0) {
    return err(
      invalid('A pull request link needs a URL.', [
        {
          path: 'pullRequestUrl',
          message:
            'Paste the pull request address from the browser, for example https://github.com/owner/repository/pull/1. A branch name or a pull request number alone is not a link, and neither is a candidate identity.',
        },
      ]),
    );
  }

  // A copied browser address carries whatever GitHub put in it — a fragment naming a
  // comment, a query naming a diff width — and none of that changes which pull request it
  // is. Both are stripped rather than refused, because refusing them would make the normal
  // way a person shares a link look like an error.
  const withoutScheme = raw.replace(/^https:\/\//i, '').replace(/^http:\/\//i, '');
  const [authorityAndPath = ''] = withoutScheme.split('#');
  const [pathPart = ''] = authorityAndPath.split('?');

  const segments = pathPart.split('/').filter((segment) => segment.length > 0);
  const host = (segments.shift() ?? '').toLowerCase();
  if (host !== GITHUB_WEB_HOST) {
    return err(
      invalid('This MVP links GitHub pull requests, and the address is not one.', [
        {
          path: 'pullRequestUrl',
          message: `"${host.length === 0 ? raw.slice(0, 80) : host}" is not github.com. ShipLoop v0.1 links GitHub pull requests only, so an address at another provider is refused rather than read (SHARED.md, out of scope).`,
        },
      ]),
    );
  }

  const [owner, repository, kind, rawNumber, ...extra] = segments;
  if (owner === undefined || repository === undefined || kind !== 'pull') {
    return err(
      invalid('That address is not a pull request.', [
        {
          path: 'pullRequestUrl',
          message: `"${raw.slice(0, 120)}" is not a github.com/owner/repository/pull/number address.`,
        },
      ]),
    );
  }
  if (rawNumber === undefined || !/^[0-9]+$/.test(rawNumber)) {
    return err(
      invalid('That pull request address names no number.', [
        {
          path: 'pullRequestUrl',
          message: `"${rawNumber ?? ''}" is not a pull request number. A pull request number alone is not a candidate identity, so it cannot stand in for the address of a pull request that exists.`,
        },
      ]),
    );
  }
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repository)) {
    fields.push({
      path: 'pullRequestUrl',
      message: `"${raw.slice(0, 120)}" contains a character GitHub does not accept in an owner or repository name.`,
    });
  }
  // `/pull/7/files`, `/pull/7/commits` and friends are the same pull request. A deeper
  // path that is not one of those views is refused rather than truncated, because
  // truncating would link a different resource than the owner named.
  if (extra.length > 0 && !['files', 'commits', 'checks'].includes(extra[0] ?? '')) {
    fields.push({
      path: 'pullRequestUrl',
      message: `"${extra.join('/')}" is not a view of a pull request.`,
    });
  }
  if (fields.length > 0) return err(invalid('That pull request address cannot be read.', fields));

  const number = Number.parseInt(rawNumber, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return err(
      invalid('That pull request number is not a number GitHub issues.', [
        { path: 'pullRequestUrl', message: `"${rawNumber}" is not a positive pull request number.` },
      ]),
    );
  }
  return ok({
    provider: CANDIDATE_PROVIDER,
    host: GITHUB_WEB_HOST,
    owner,
    repository,
    fullName: `${owner}/${repository}`,
    number,
    url: `https://${GITHUB_WEB_HOST}/${owner}/${repository}/pull/${number}`,
  });
}

/**
 * Whether two GitHub repository names address the same repository.
 *
 * Case-insensitive, because GitHub is. A repository whose owner differs is a different
 * repository: that is the whole point of the check, and it is the failure a paste from a
 * fork or a similarly named project would otherwise slip past.
 */
export function sameGitHubRepository(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* The candidate                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where a pull request stands at the provider, as of one read.
 *
 * `state` distinguishes `Closed` from `Merged` because they mean different things to an
 * owner: a closed pull request was withdrawn, a merged one landed. Both stop the
 * candidate from being new work, and neither is silently reported as open.
 */
export const PULL_REQUEST_STATES = ['Open', 'Closed', 'Merged'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * The exact implementation under review.
 *
 * The shape the MVP binds to. `headSha` is a full 40-character commit SHA and is the only
 * field that identifies code: `pullRequestNumber` and `headBranch` are here because an
 * owner needs to recognise the pull request, not because either can stand in for the
 * commit. `baseSha` is carried with the same weight as `headSha` because a review that
 * compares a diff needs the revision the change was measured against.
 */
export interface DeliveryCandidate {
  readonly candidateId: CandidateId;
  readonly projectId: ProjectId;
  /** The owner's request this candidate answers. */
  readonly requestId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly provider: typeof CANDIDATE_PROVIDER;
  /** `owner/repository`, as the provider spells it. */
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly baseSha: CommitSha;
  readonly headBranch: string;
  /** Full 40-character commit SHA. The candidate's identity. */
  readonly headSha: CommitSha;
  readonly pullRequestState: PullRequestState;
  readonly draft: boolean;
  /** When these facts were read from the provider. */
  readonly observedAt: string;
  /** When ShipLoop first linked this exact identity. */
  readonly linkedAt: string;
}

/**
 * Refuses anything that is not a full commit SHA.
 *
 * This is the boundary that makes "PR 7" and "task/x" unusable as identity: an
 * abbreviation is refused rather than resolved, because the commit an abbreviation names
 * can change between the read and the evidence, and a resolved abbreviation would look
 * exactly like a confirmed commit.
 */
export function requireFullCommitSha(value: string, field: string): Result<CommitSha, DomainError> {
  if (isCommitSha(value)) return ok(value);
  return err(
    invalid('Candidate identity must be a full commit SHA.', [
      {
        path: field,
        message: `"${value.slice(0, 12)}" is not a full 40-character commit SHA. A branch name, an abbreviated SHA and a pull request number are routing facts, not identity; refusing is what keeps a superseded candidate from inheriting a newer commit's evidence.`,
      },
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* Binding                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What every piece of evidence must name to prove a candidate.
 *
 * Two facts and no more: the contract revision that was approved, and the full head SHA
 * that was tested. `projectId`, `requestId` and the repository are deliberately absent —
 * they scope the binding rather than identify the code, and including display facts would
 * make a fingerprint change when a repository was merely renamed.
 */
export interface CandidateBinding {
  readonly contractId: string;
  readonly contractRevision: number;
  readonly headSha: CommitSha;
}

/** Projects a candidate into the binding its evidence must carry. */
export function candidateBindingOf(candidate: DeliveryCandidate): CandidateBinding {
  return {
    contractId: candidate.contractId,
    contractRevision: candidate.contractRevision,
    headSha: candidate.headSha,
  };
}

/**
 * A stable value for one exact `(contract revision, head SHA)` pair.
 *
 * Useful as a map key and as a column value, and comparable with `===`. It is derived
 * from the binding and nothing else, so it cannot change while the code under review
 * stays the same.
 */
export function candidateBindingFingerprint(binding: CandidateBinding): Fingerprint {
  return fingerprint({
    contractId: binding.contractId,
    contractRevision: binding.contractRevision,
    headSha: binding.headSha,
  });
}

/**
 * Why recorded evidence does not prove the candidate in front of the owner.
 *
 * `HeadSuperseded` is the one that matters for the MVP: the evidence names a commit that
 * is no longer the head, so it describes code the owner is not being asked about. It is
 * reported as a distinct reason rather than folded into "not verified", because the fix
 * differs: re-running the check is right for `HeadSuperseded` and wrong for
 * `ContractSuperseded`.
 */
export type EvidenceBindingVerdict =
  | { readonly stale: false; readonly exact: true; readonly reasons: readonly [] }
  | {
      readonly stale: true;
      readonly exact: false;
      readonly reasons: readonly ('HeadSuperseded' | 'ContractSuperseded')[];
    };

/**
 * Decides whether recorded evidence proves the candidate now in front of the owner.
 *
 * The rule is an inequality on the full head SHA. There is no tolerance for a
 * "close enough" match, no acceptance of a prefix, and no path where a different commit
 * and a matching revision combine into a pass — which is exactly the collapse SHARED.md
 * forbids ("candidate-bound evidence for SHA A can never prove SHA B").
 */
export function evidenceBindingVerdict(
  evidence: { readonly contractId: string; readonly contractRevision: number; readonly headSha: string },
  current: CandidateBinding,
): EvidenceBindingVerdict {
  const reasons: ('HeadSuperseded' | 'ContractSuperseded')[] = [];
  if (evidence.contractId !== current.contractId || evidence.contractRevision !== current.contractRevision) {
    reasons.push('ContractSuperseded');
  }
  if (!isCommitSha(evidence.headSha) || evidence.headSha !== current.headSha) {
    reasons.push('HeadSuperseded');
  }
  if (reasons.length === 0) return { stale: false, exact: true, reasons: [] };
  return { stale: true, exact: false, reasons };
}

/* -------------------------------------------------------------------------- */
/* Change detection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One way a candidate can stop being the candidate that was recorded.
 *
 * Ordered by how much it invalidates. `HeadChanged` comes first because a new head
 * invalidates every check result, a decision and every review the owner already saw;
 * the rest change what the candidate *is* without invalidating a green result on the
 * same commit.
 */
export const CANDIDATE_CHANGE_KINDS = [
  'HeadChanged',
  'BaseChanged',
  'BaseBranchChanged',
  'HeadBranchChanged',
  'StateChanged',
  'DraftChanged',
  'PullRequestChanged',
  'RepositoryChanged',
] as const;
export type CandidateChangeKind = (typeof CANDIDATE_CHANGE_KINDS)[number];

/** The material facts a refresh compares. */
export interface CandidateFacts {
  readonly provider: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly baseBranch: string;
  readonly baseSha: CommitSha;
  readonly headBranch: string;
  readonly headSha: CommitSha;
  readonly pullRequestState: PullRequestState;
  readonly draft: boolean;
}

/**
 * What a refresh observed about the difference between the record and the provider.
 *
 * `kind` is the single most material difference, and `changed` is every one of them, so
 * a caller can render a headline and a list from one read instead of re-deriving either.
 * `priorEvidenceStale` is the flag the verification layer consumes: when it is `true`,
 * nothing recorded against `previousHeadSha` can prove `currentHeadSha`.
 */
export interface CandidateChange {
  readonly kind: CandidateChangeKind | 'Unchanged';
  readonly changed: readonly CandidateChangeKind[];
  readonly changedAnything: boolean;
  readonly previousHeadSha: CommitSha | null;
  readonly currentHeadSha: CommitSha;
  /**
   * True whenever a material fact moved.
   *
   * Deliberately not "only when the head moved": a pull request that was closed and a base
   * branch that was retargeted both change what the owner would be approving, and a view
   * that kept a ready status across either of them would be presenting a stale card as a
   * current one (mvp-spec F24-AC4).
   */
  readonly priorEvidenceStale: boolean;
  readonly detail: string;
}

/**
 * Compares a recorded candidate against the provider's current facts.
 *
 * Every difference is returned rather than the first one, because an owner looking at a
 * pull request that changed its head *and* went closed needs to see both: one of them
 * invalidates the evidence and the other removes the candidate from review entirely.
 */
export function detectCandidateChange(
  previous: CandidateFacts | null,
  current: CandidateFacts,
): CandidateChange {
  const changed: CandidateChangeKind[] = [];
  if (previous !== null) {
    if (previous.headSha !== current.headSha) changed.push('HeadChanged');
    if (previous.baseSha !== current.baseSha) changed.push('BaseChanged');
    if (previous.baseBranch !== current.baseBranch) changed.push('BaseBranchChanged');
    if (previous.headBranch !== current.headBranch) changed.push('HeadBranchChanged');
    if (previous.pullRequestState !== current.pullRequestState) changed.push('StateChanged');
    if (previous.draft !== current.draft) changed.push('DraftChanged');
    if (previous.pullRequestNumber !== current.pullRequestNumber) changed.push('PullRequestChanged');
    if (!sameGitHubRepository(previous.repository, current.repository)) changed.push('RepositoryChanged');
  }
  if (changed.length === 0) {
    return {
      kind: 'Unchanged',
      changed: [],
      changedAnything: false,
      previousHeadSha: previous?.headSha ?? null,
      currentHeadSha: current.headSha,
      priorEvidenceStale: false,
      detail:
        previous === null
          ? `The pull request head is ${short(current.headSha)} and no earlier candidate was recorded for it, so nothing can be stale yet.`
          : `The pull request still holds head ${short(current.headSha)} on base ${current.baseBranch}, so the recorded candidate is current.`,
    };
  }
  const kind = changed[0] ?? 'HeadChanged';
  return {
    kind,
    changed,
    changedAnything: true,
    previousHeadSha: previous?.headSha ?? null,
    currentHeadSha: current.headSha,
    priorEvidenceStale: true,
    detail: describe(changed, previous, current),
  };
}

function describe(
  changed: readonly CandidateChangeKind[],
  previous: CandidateFacts | null,
  current: CandidateFacts,
): string {
  const parts = changed.map((kind) => CHANGE_PHRASES[kind]);
  const from = previous === null ? 'nothing' : `head ${short(previous.headSha)}`;
  return `GitHub now reports ${parts.join(' and ')} for ${current.repository}#${current.pullRequestNumber}: ${from} became head ${short(current.headSha)} on ${current.pullRequestState}. Everything recorded before this read describes the earlier candidate and cannot prove this one.`;
}

const CHANGE_PHRASES: Readonly<Record<CandidateChangeKind, string>> = {
  HeadChanged: 'a different head commit',
  BaseChanged: 'a different base commit',
  BaseBranchChanged: 'a different base branch',
  HeadBranchChanged: 'a renamed head branch',
  StateChanged: 'a different pull request state',
  DraftChanged: 'a different draft flag',
  PullRequestChanged: 'a different pull request',
  RepositoryChanged: 'a different repository',
};

function short(sha: CommitSha): string {
  return sha.slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One check as the candidate view presents it.
 *
 * `result` is the domain's own six-state vocabulary, copied through from the provider
 * observation without reinterpreting it. `required` is the project profile's judgement,
 * not the provider's, and `notApplicableApprovedByPolicy` is a policy decision rather than
 * anything a check or a model can set.
 */
export interface CandidateCheckStatus {
  readonly name: string;
  readonly result: CheckResult;
  readonly required: boolean;
  readonly notApplicableApprovedByPolicy: boolean;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly artifactUrl: string | null;
  /** Sanitized text. Never a raw provider body (N02-AC2). */
  readonly detail: string | null;
  /**
   * The full head SHA this observation belongs to, or null when the provider did not say.
   *
   * Carried per check rather than once per read so a check reported against another commit
   * can be shown as `Stale` beside the ones that match, instead of one boolean that hides
   * which result is which.
   */
  readonly observedHeadSha: CommitSha | null;
}

/** The provider observation a candidate view projects. */
export interface ProviderCheckFact {
  readonly name: string;
  readonly result: CheckResult;
  readonly required: boolean;
  readonly observedHeadSha: CommitSha | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly artifactUrl: string | null;
  readonly detail: string | null;
  readonly notApplicableApprovedByPolicy?: boolean;
}

/**
 * Projects provider observations into the candidate's check list.
 *
 * `currentHeadSha` is the commit the caller asked the provider about, and it is required
 * rather than inferred, because an observation the provider attributed to a *different*
 * commit has to be demoted here and this function is the only place that knows both
 * values. An observation whose `observedHeadSha` is a different full SHA becomes `Stale`;
 * one that is null keeps its result, because the read was already addressed to this head
 * and a missing attribution is not evidence of a different commit.
 *
 * A required check the provider did not report at all is added as `Missing`, so it
 * appears in the list rather than being absent from it. An absent check and a satisfied
 * check look identical in a table that only lists what ran, which is precisely how a
 * required gate gets dropped without anyone deciding to drop it (mvp-spec F20-AC2).
 *
 * When the same check name appears twice the later observation wins. Freshness is the
 * property that matters: a check that passed and was then re-run is `Waiting` now, and
 * reporting the earlier `Passed` would be reporting history as the current state. Note
 * the direction of that rule — it lets a real downgrade win, and no branch anywhere in
 * this function converts a non-`Passed` result into `Passed`.
 */
export function projectCandidateChecks(
  facts: readonly ProviderCheckFact[],
  currentHeadSha: CommitSha,
  requiredCheckNames: readonly string[] = [],
): readonly CandidateCheckStatus[] {
  const byName = new Map<string, CandidateCheckStatus>();
  const required = new Set(requiredCheckNames);
  for (const fact of facts) {
    const superseded = fact.observedHeadSha !== null && fact.observedHeadSha !== currentHeadSha;
    const status: CandidateCheckStatus = {
      name: fact.name,
      result: superseded ? 'Stale' : fact.result,
      required: fact.required || required.has(fact.name),
      notApplicableApprovedByPolicy: fact.notApplicableApprovedByPolicy ?? false,
      startedAt: fact.startedAt,
      endedAt: fact.endedAt,
      artifactUrl: fact.artifactUrl,
      detail: superseded
        ? `${fact.detail ?? 'The provider reported this check.'} It was reported against ${
            fact.observedHeadSha === null ? 'another commit' : fact.observedHeadSha.slice(0, 12)
          } rather than candidate head ${currentHeadSha.slice(0, 12)}, so it cannot prove this candidate.`
        : fact.detail,
      observedHeadSha: fact.observedHeadSha,
    };
    byName.set(fact.name.toLowerCase(), status);
  }
  for (const name of requiredCheckNames) {
    if (byName.has(name.toLowerCase())) continue;
    byName.set(name.toLowerCase(), {
      name,
      result: 'Missing',
      required: true,
      notApplicableApprovedByPolicy: false,
      startedAt: null,
      endedAt: null,
      artifactUrl: null,
      detail: `The project requires "${name}" and the provider reported no run for it on head ${currentHeadSha.slice(0, 12)}. A check that never ran is not a pass.`,
      observedHeadSha: null,
    });
  }
  return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Whether a candidate's required checks are all satisfied.
 *
 * `Passed` and a policy-approved `NotApplicable` are the only accepting results, which
 * is the domain's own `isBlocking` applied to the required subset. `Missing`, `Waiting`,
 * `Stale` and `Failed` all block, and `NotApplicable` without a policy decision blocks
 * too (mvp-spec F20-AC2). A required check that was never reported reaches this function
 * as `Missing` from `projectCandidateChecks`, so an empty required set here genuinely
 * means the profile requires nothing.
 */
export function candidateChecksReady(checks: readonly CandidateCheckStatus[]): boolean {
  return checks
    .filter((check) => check.required)
    .every(
      (check) => !isBlocking(check.result, check.notApplicableApprovedByPolicy),
    );
}

/**
 * The required checks that are blocking, named for the owner.
 *
 * Returned rather than a bare boolean so a review card can say which check is missing
 * instead of "not ready", and so a caller cannot present readiness without the reason.
 */
export function blockingRequiredChecks(checks: readonly CandidateCheckStatus[]): readonly string[] {
  return checks
    .filter((check) => check.required && isBlocking(check.result, check.notApplicableApprovedByPolicy))
    .map((check) => `${check.name} is ${check.result}`);
}
