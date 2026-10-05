/**
 * The candidate: link a pull request, see what is on it, refresh it, and run verification against it
 * (mvp-spec F11-AC2, F11-AC3, F20-AC2, F20-AC3, F24-AC1, F24-AC3, F24-AC4, F24-AC5, F23-AC1,
 * F03-AC5, F02-AC2, N03-AC1, N03-AC3, N02-AC2).
 *
 * This is the fourth step of the MVP journey — `Request → Contract → External execution → GitHub
 * Candidate → Verification → Owner Decision` — and it is read-only towards the provider throughout.
 * The candidate route has no merge, close, approve, retarget or re-protect method, and every response
 * carries `providerWritePerformed: false` as a literal. Nothing on this page can change anything at
 * GitHub, and there is no control here that could (F03-AC5).
 *
 * ## What identity means on this page
 *
 * The owner pastes a pull request URL and nothing else. There is no field for a commit, a branch or a
 * pull request number, because none of those is the owner's to assert: the server reads them from the
 * provider, records the full SHA it found, and refuses anything that is not 40 characters before it
 * answers. The form's single input is therefore the whole of what this page contributes to identity,
 * and the response is the whole of what it renders (mvp-spec 3, F11-AC2, F11-AC3).
 *
 * The candidate card leads with the **full 40-character head SHA**, because that is the only value
 * that identifies the code under review. The branch name and the pull request number are shown too —
 * they are real routing facts the owner will recognise — but they are labelled as routing facts and
 * are never what the card identifies the code *as*. A force push changes the branch name's meaning
 * without changing the name, which is exactly why it cannot be the identity (SHARED.md "Candidate",
 * F24-AC4).
 *
 * ## Staleness is shown, not hidden
 *
 * `refreshCandidate` re-reads the provider and reports what moved. When the head moved,
 * `evidence.status` is `Stale`, `change.previousHeadSha` names the commit prior evidence is about,
 * and `priorReadinessPreserved` is the literal `false`. This page renders all of it: the previous
 * head, the new head, which facts changed, and the sentence saying that nothing carried forward
 * survived. A card that quietly kept its green state across a force push would be the exact defect
 * F24-AC4 exists to prevent, and the only way to avoid it is to render the movement rather than
 * suppress it.
 *
 * ## Verification reads its result back; it never states one
 *
 * `runVerification` sends `{ method: 'github_checks' }` and nothing else. The route's schema has one
 * optional member and refuses `result`, `outcome`, `checkId`, `criterionId` and `headSha` by name,
 * because every one of those would be a way for the browser to assert what a check concluded. So this
 * page states no verdict at all: it renders what the response said, one `ObservationRow` per
 * observation, and the rows distinguish a pass, a failure, a run still in progress, a gate nobody
 * exercised, and a result about a commit that has since moved (F20-AC2, F23-AC1).
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { formatTimestamp } from '../api-client.ts';
import { Field } from '../components/Field.tsx';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';
import { CommitSha } from './CommitSha.tsx';
import { ObservationRow } from './ObservationRow.tsx';
import {
  fetchCandidate,
  linkCandidate,
  refreshCandidate,
  runVerification,
  type CandidateCheck,
  type CandidateReport,
  type TransportOutcome,
  type VerificationReport,
} from './transport.ts';

export interface CandidatePageProps {
  readonly projectId: string | null;
  /** The request and approved contract revision this candidate implements. */
  readonly requestId: string | null;
  readonly contractId: string | null;
  readonly contractRevision: number | null;
  /** The candidate on screen, or null when none has been linked. */
  readonly candidateId: string | null;
  /** Reports the candidate this flow linked, so a parent can keep it selected. */
  readonly onCandidateLinked: (candidateId: string) => void;
  /** Bumped by the shell's retry control so this page refetches. */
  readonly epoch: number;
}

type ReadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly report: CandidateReport }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unreachable'; readonly reason: string };

export function CandidatePage({
  projectId,
  requestId,
  contractId,
  contractRevision,
  candidateId,
  onCandidateLinked,
  epoch,
}: CandidatePageProps): ReactElement {
  const [read, setRead] = useState<ReadState>({ kind: 'idle' });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string>('');
  const [verification, setVerification] = useState<VerificationReport | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyFailure, setVerifyFailure] = useState<string | null>(null);
  const [verifyUnreachable, setVerifyUnreachable] = useState(false);

  const linkable =
    projectId !== null &&
    requestId !== null &&
    contractId !== null &&
    contractRevision !== null &&
    contractRevision >= 1;

  const load = useCallback((): void => {
    if (projectId === null || candidateId === null) {
      setRead({ kind: 'idle' });
      return;
    }
    setRead({ kind: 'loading' });
    void fetchCandidate(projectId, candidateId).then(
      (outcome: TransportOutcome<CandidateReport>) => setRead(readOutcome(outcome)),
    );
  }, [projectId, candidateId]);

  useEffect(load, [load, epoch]);

  // A refresh produces a newer observation than the read on screen, so the read is replaced by the
  // refresh's own answer rather than merged into it. Two cards disagreeing about the head is the
  // failure F24-AC4 exists to prevent, and the route returns one complete report precisely so this
  // page does not have to combine two.
  const refresh = (): void => {
    if (projectId === null || candidateId === null || refreshing) return;
    setRefreshing(true);
    setRefreshNote('Re-reading the pull request from GitHub…');
    void refreshCandidate(projectId, candidateId).then((outcome) => {
      setRefreshing(false);
      if (!outcome.ok) {
        setRefreshNote(
          outcome.unreachable
            ? `The provider could not be read, so nothing was refreshed: ${outcome.failure.reason}`
            : `Nothing was refreshed: ${outcome.failure.reason}`,
        );
        return;
      }
      setRead(readOutcome(outcome));
      setRefreshNote(refreshNoteOf(outcome.value));
    });
  };

  const verify = (): void => {
    if (projectId === null || candidateId === null || verifying) return;
    setVerifying(true);
    setVerifyFailure(null);
    setVerifyUnreachable(false);
    // No result, no outcome, no check, no commit is sent. The server reads the provider and derives
    // every verdict; this call only asks it to (F20-AC2, F23-AC1).
    void runVerification(projectId, candidateId).then((outcome) => {
      setVerifying(false);
      if (!outcome.ok) {
        setVerification(null);
        setVerifyUnreachable(outcome.unreachable);
        setVerifyFailure(
          outcome.unreachable
            ? `The server could not be reached, so nothing was verified and nothing is claimed about the ` +
              `checks: ${outcome.failure.reason}`
            : `Nothing was recorded and nothing is claimed to have been verified: ${outcome.failure.reason}`,
        );
        return;
      }
      setVerification(outcome.value);
    });
  };

  return (
    <section className="page" aria-labelledby="candidate-heading">
      <header className="page__header">
        <h2 className="page__title" id="candidate-heading">
          Candidate
        </h2>
        <p className="panel__note">
          ShipLoop reads GitHub here and never writes to it. There is no merge, no close, no approval
          and no deployment on this page, and nothing here can change anything at the provider
          (mvp-spec F03-AC5).
        </p>
      </header>

      {linkable ? (
        <LinkForm
          onLink={async (pullRequestUrl) => {
            if (projectId === null || requestId === null || contractId === null || contractRevision === null) {
              return {
                kind: 'refused' as const,
                reason: 'The project or the contract left this page while it was being read.',
              };
            }
            const outcome = await linkCandidate(projectId, {
              requestId,
              contractId,
              contractRevision,
              pullRequestUrl,
            });
            // Refused and unreachable are reported apart. "GitHub could not be reached" and "this
            // pull request is not this project's" send the owner to completely different places, and
            // one message covering both would send them to neither (F11-AC3, N03-AC3).
            if (!outcome.ok) {
              return outcome.unreachable
                ? { kind: 'unreachable' as const, reason: outcome.failure.reason }
                : { kind: 'refused' as const, reason: outcome.failure.reason };
            }
            onCandidateLinked(outcome.value.candidate.candidateId);
            // The card is reloaded from the transport rather than assembled from the link's response.
            // A link response carries no readiness, no checks and no change report, so building a
            // card around it would give this page two sources for one card and let them disagree
            // (F24-AC2).
            load();
            return {
              kind: 'linked' as const,
              reason: outcome.value.alreadyRecorded
                ? 'This exact commit was already recorded for this project, so nothing new was written.'
                : 'The pull request was read and its commit recorded. Nothing was changed at GitHub.',
            };
          }}
        />
      ) : (
        <p className="state-line" role="status" data-state="empty">
          {projectId === null
            ? 'No project is selected, so there is no repository to link a candidate from.'
            : 'No approved contract revision is in view. A candidate is bound to the exact contract revision it implements, so approve a contract first.'}
        </p>
      )}

      {candidateId === null ? (
        <p className="state-line" role="status" data-state="empty" data-testid="no-candidate">
          No candidate is linked yet. Paste a pull request address above; ShipLoop reads the commit
          from GitHub and records the full SHA itself.
        </p>
      ) : (
        <>
          <div className="form__actions">
            <button
              className="button"
              type="button"
              onClick={refresh}
              disabled={refreshing}
              data-testid="refresh-candidate"
            >
              {refreshing ? 'Refreshing…' : 'Refresh from GitHub'}
            </button>
            <button className="button" type="button" onClick={verify} disabled={verifying} data-testid="verify-candidate">
              {verifying ? 'Verifying…' : 'Run verification'}
            </button>
          </div>
          <p className="state-line" role="status" aria-live="polite" data-testid="refresh-note">
            {refreshNote === ''
              ? 'Refresh re-reads the pull request from GitHub and reports what moved. Nothing is written at the provider.'
              : refreshNote}
          </p>
          {renderRead(read, load)}
          {renderVerification(verification, verifying, verifyFailure, verifyUnreachable)}
        </>
      )}
    </section>
  );
}

function readOutcome(outcome: TransportOutcome<CandidateReport>): ReadState {
  if (outcome.ok) return { kind: 'ready', report: outcome.value };
  if (outcome.unreachable) return { kind: 'unreachable', reason: outcome.failure.reason };
  return { kind: 'refused', reason: outcome.failure.reason };
}

/**
 * What a refresh established, said so the owner can tell a moved head from a still one.
 *
 * Both branches are sentences rather than a badge, because "nothing material moved" and "the head
 * moved, so previous evidence is stale" are the difference between a card that may still be trusted
 * and one that may not, and the second has to be unmissable (F24-AC4).
 */
function refreshNoteOf(report: CandidateReport): string {
  if (report.evidence.status === 'Stale') {
    const from = report.change.previousHeadSha ?? 'an earlier commit';
    return (
      `The head moved: it is now ${report.change.currentHeadSha}, and the evidence recorded against ${from} is ` +
      `stale. ${report.evidence.detail} Nothing carried forward from the earlier head survives, including any ` +
      `readiness it had (F24-AC4, F25-C3).`
    );
  }
  return `Re-read from GitHub at ${formatTimestamp(report.observedAt)}. ${report.evidence.detail}`;
}

function renderRead(read: ReadState, reload: () => void): ReactElement {
  switch (read.kind) {
    case 'idle':
      return (
        <p className="state-line" role="status" data-state="empty">
          Nothing to read.
        </p>
      );
    case 'loading':
      return (
        <p className="state-line" role="status" aria-live="polite" data-state="loading">
          Reading the pull request from GitHub…
        </p>
      );
    case 'unreachable':
      return (
        <div className="connector__problem" role="alert" data-state="disconnected">
          <p className="connector__problem-line">
            {`The server could not be reached, so no candidate is shown: ${read.reason}`}
          </p>
          <p className="connector__problem-line">
            This says nothing about the pull request. ShipLoop is not showing a stale card in place of a
            live one, because a card that agreed with the last read would present withdrawn work as
            current (F24-AC4).
          </p>
          <div className="connector__actions">
            <button className="button" type="button" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      );
    case 'refused':
      return (
        <div className="connector__problem" role="alert" data-state="failed">
          <p className="connector__problem-line">{`No candidate is shown: ${read.reason}`}</p>
          <div className="connector__actions">
            <button className="button" type="button" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      );
    case 'ready':
      return <CandidateCard report={read.report} />;
  }
}

/* -------------------------------------------------------------------------- */
/* The link form                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What one attempt to link a pull request produced.
 *
 * A discriminated union with three members rather than a message string, because the three send the
 * owner to different places and a screen rendering them as one sentence would send them to none of
 * them: a refusal means the address is wrong, an unreachable means nothing is known yet, and a
 * success says what was and was not written at the provider (F11-AC3, N03-AC3).
 */
export type LinkOutcome =
  | { readonly kind: 'linked'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unreachable'; readonly reason: string };

/**
 * One field: the pull request address.
 *
 * A single input is the honest shape here. Every other fact about the candidate — repository, base
 * branch, state, draft flag, and both commit SHAs — is read from the provider by the server, and
 * adding a field for any of them would be asking the owner to assert something the server is about to
 * check anyway. The route would refuse such a body by name if it arrived (mvp-spec 3, F11-AC2).
 *
 * A refusal keeps the typed address. An owner who pasted a pull request from a fork and was told the
 * fork is not this project's repository needs to correct that address, not retype it from memory
 * (N03-AC3).
 */
function LinkForm({
  onLink,
}: {
  readonly onLink: (pullRequestUrl: string) => Promise<LinkOutcome>;
}): ReactElement {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [failureKind, setFailureKind] = useState<'refused' | 'unreachable'>('refused');
  const [note, setNote] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const trimmed = url.trim();
    if (trimmed === '') {
      setUrlError('Paste the pull request address from the browser.');
      return;
    }
    setUrlError(undefined);
    setFailure(null);
    setNote('');
    setSubmitting(true);
    const outcome = await onLink(trimmed);
    // The field is left exactly as typed either way. A refusal is something the owner corrects and
    // resubmits, and clearing their input would make them retype an address from memory to see the
    // same message (N03-AC3).
    setSubmitting(false);
    if (outcome.kind === 'linked') {
      setFailure(null);
      setNote(outcome.reason);
      return;
    }
    setFailure(outcome.reason);
    setFailureKind(outcome.kind);
  };

  return (
    <section className="panel" aria-labelledby="link-heading">
      <h3 className="panel__title" id="link-heading">
        Link the pull request
      </h3>
      <p className="panel__note">
        Paste the address from the browser. ShipLoop reads the repository, the base branch, the state
        and the full head commit from GitHub and records those; you supply none of them, and the link
        is refused rather than guessed if the repository is not this project's (mvp-spec F11-AC2,
        F11-AC3).
      </p>
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="pull-request-url"
          label="Pull request address"
          type="url"
          value={url}
          onChange={setUrl}
          hint="For example https://github.com/owner/repo/pull/7"
          error={urlError}
          disabled={submitting}
        />
        <div className="form__actions">
          <button className="button" type="submit" disabled={submitting} data-testid="link-candidate">
            {submitting ? 'Reading from GitHub…' : 'Link this pull request'}
          </button>
        </div>
      </form>
      {failure === null ? null : (
        <div
          className="connector__problem"
          role="alert"
          data-state={failureKind === 'unreachable' ? 'disconnected' : 'failed'}
          data-testid="link-failure"
        >
          <p className="connector__problem-line">
            {failureKind === 'unreachable'
              ? `Nothing was recorded and nothing was read from GitHub: ${failure}`
              : `The link was refused, so no candidate was recorded: ${failure}`}
          </p>
          <p className="connector__problem-line">
            Your address is still in the field above. Correct it and submit again — ShipLoop never picks
            a similarly named repository for you, so a wrong mapping is yours to fix, not something it
            resolves by guessing (F11-AC3).
          </p>
        </div>
      )}
      <p className="state-line" role="status" aria-live="polite" data-testid="link-note">
        {note === '' ? 'Nothing has been linked from this form yet.' : note}
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The candidate card                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How each provider check result reads.
 *
 * The domain's own six words, kept in their own spelling: the candidate route reports
 * `Passed`/`Failed`/`Missing`/`Waiting`/`Stale`/`NotApplicable` while the review card reports the
 * same ideas lowercased with extra members. Translating one into the other here would make this file
 * the second place the vocabulary is stated, and the two spellings exist for a reason (F20-AC2).
 */
const CHECK_TONES: Readonly<Record<string, StatusTone>> = {
  Passed: 'healthy',
  Failed: 'revoked',
  Waiting: 'pending',
  Missing: 'degraded',
  Stale: 'degraded',
  NotApplicable: 'unconfigured',
};

function checkLabel(check: CandidateCheck): string {
  switch (check.result) {
    case 'Passed':
      return 'Passed';
    case 'Failed':
      return 'Failed';
    case 'Waiting':
      return 'Still running — nothing concluded';
    case 'Missing':
      return 'Never ran — proves nothing';
    case 'Stale':
      return 'Stale — about another commit';
    case 'NotApplicable':
      return 'Not applicable';
    default:
      return `Unread: ${truncateWord(check.result)}`;
  }
}

/**
 * What one provider check line has to say beyond its result.
 *
 * The commit matters more than the result here. A provider that reports `Passed` for a commit other
 * than the candidate's head has proved something, just not about this candidate, so the line names the
 * commit it was attributed to and says plainly that it is not about the code on screen (F20-AC3,
 * F24-AC3).
 */
function checkDetail(check: CandidateCheck, headSha: string): string {
  const parts = [check.required ? 'Required by this project.' : 'Not required by this project.'];
  parts.push(check.blocking ? 'It blocks until it passes.' : 'It does not block.');
  if (check.observedHeadSha === null) {
    parts.push('The provider attributed this run to no commit, so it is evidence for no candidate (F20-AC3).');
  } else if (check.observedHeadSha !== headSha) {
    parts.push(
      `The provider attributed this run to ${check.observedHeadSha}, which is not the commit on screen, so it ` +
        `proves nothing about this candidate even though its result reads ${check.result} (F20-AC3, F24-AC3).`,
    );
  } else {
    parts.push('The provider attributed this run to the commit on screen, so it is about that code.');
  }
  if (check.notApplicableApprovedByPolicy) {
    parts.push(
      'Policy approved this check as not applicable; that is a policy decision and not a pass (F20-AC5).',
    );
  }
  if (check.detail !== null && check.detail !== '') parts.push(check.detail);
  return parts.join(' ');
}

/**
 * One candidate, read live from the provider.
 *
 * The order is the order of the argument the owner needs: what the code *is* (the full head SHA
 * first), then where it came from, then what the provider currently says about it, then what has been
 * checked, and only then whether it can be decided on. The readiness line is last because it is the
 * only line here that is a judgement rather than a fact, and it must not sit above the facts it
 * summarises (F24-AC1, F24-AC3).
 */
function CandidateCard({ report }: { readonly report: CandidateReport }): ReactElement {
  const recorded = report.candidate;
  const live = report.live;
  return (
    <section className="panel" aria-labelledby="candidate-card-heading" data-testid="candidate-card">
      <h3 className="panel__title" id="candidate-card-heading">
        {`Pull request #${recorded.pullRequestNumber}`}
      </h3>

      <dl className="detail-list">
        {/*
          The identity first, in full, and nothing above it. Every other value here — the branch, the
          pull request number, the URL — can be true of two different commits over time; this one cannot
          (SHARED.md "Candidate", mvp-spec 3).
        */}
        <CommitSha sha={recorded.headSha} label="Code under review" />
        <dt>Provider state</dt>
        <dd data-testid="provider-state">
          {`${live.pullRequestState}${live.draft ? ' (draft)' : ''} — reported by ${live.provider} at ` +
            `${formatTimestamp(live.observedAt)}. This is the provider's own spelling, not ShipLoop's conclusion, ` +
            `and ShipLoop read it without changing anything there (mvp-spec 3, F03-AC5).`}
        </dd>
        <dt>Repository</dt>
        <dd data-testid="repository">{live.repository}</dd>
        <dt>Pull request</dt>
        <dd data-testid="pull-request">
          {`#${recorded.pullRequestNumber} — `}
          <a href={recorded.pullRequestUrl} target="_blank" rel="noopener noreferrer">
            {`open at ${live.provider} (opens in a new tab)`}
          </a>
        </dd>
        <dt>Base</dt>
        <dd data-testid="base">
          {`${recorded.baseBranch} — a routing fact: the branch this would land on. It is not the identity of the ` +
            `code under review, and it does not change when the head is force-pushed.`}
        </dd>
        <dt>Head branch</dt>
        <dd data-testid="head-branch">
          {`${recorded.headBranch} — a routing fact too. The commit above is what identifies the code.`}
        </dd>
        <dt>Contract binding</dt>
        <dd data-testid="binding">
          {`Contract ${recorded.contractId} revision ${recorded.contractRevision}, bound to the commit above ` +
            `(fingerprint ${report.bindingFingerprint}). Every piece of evidence for this candidate names that ` +
            `commit, so nothing recorded against another build counts for it (F20-AC3, F24-AC4).`}
        </dd>
      </dl>

      <EvidenceStanding report={report} />

      {/*
        The checks GitHub reported right now, whether or not ShipLoop has recorded evidence from them. A
        required check nobody ran appears with the result it has rather than being absent — an omitted
        gate and a green one look the same in a list that is missing an entry (F20-AC2).
      */}
      <h4 className="panel__title">Checks reported by the provider</h4>
      {report.checks.length === 0 ? (
        <p className="state-line" role="status" data-state="empty" data-testid="checks-empty">
          The provider reported no checks for this pull request. Nothing is claimed either way: no check
          appearing is not the same as every check passing (F20-AC2).
        </p>
      ) : (
        <ul className="capability-list">
          {report.checks.map((check) => (
            <li
              className="capability-list__item"
              key={check.name}
              data-testid="candidate-check"
              data-check-name={check.name}
              data-result={check.result}
              data-blocking={String(check.blocking)}
            >
              <span className="profile-list__name">{check.name}</span>
              <StatusBadge
                tone={CHECK_TONES[check.result] ?? 'neutral'}
                label={checkLabel(check)}
                detail={checkDetail(check, live.headSha)}
              />
            </li>
          ))}
        </ul>
      )}

      {/*
        Readiness last, and as the server's own answer. This page never recomputes it from the rows
        above, because a card that looks complete to a reader and a candidate the domain will accept
        must not be able to drift apart (F24-AC3).
      */}
      <h4 className="panel__title">Whether this can be decided on</h4>
      <p
        className={report.reviewReadiness.ready ? 'state-line' : 'state-line state-line--error'}
        role="status"
        data-state={report.reviewReadiness.ready ? 'ready' : 'blocked'}
        data-testid="readiness"
      >
        {report.reviewReadiness.ready
          ? 'The provider read supports deciding on this candidate. That is not an acceptance: only the owner makes one, and nothing on this page does (F25-AC1).'
          : `This candidate cannot be decided on yet, for these reasons: ${report.reviewReadiness.reasons.join(' ')} It stays inspectable with its reasons rather than disappearing (F24-AC3).`}
      </p>
    </section>
  );
}

/**
 * Whether evidence from an earlier head still describes this one.
 *
 * Both states are rendered, and the stale one names the commit the old evidence is about. A card that
 * showed only "current" would be indistinguishable from one that had just been refreshed, so an owner
 * could not tell whether they were looking at a live read or a remembered one (F24-AC4).
 */
function EvidenceStanding({ report }: { readonly report: CandidateReport }): ReactElement {
  const stale = report.evidence.status === 'Stale';
  return (
    <section
      className="panel"
      aria-labelledby="evidence-standing-heading"
      data-stale={String(stale)}
      data-testid="evidence-standing"
    >
      <h4 className="panel__title" id="evidence-standing-heading">
        Whether earlier evidence still applies
      </h4>
      <p className="connector__problem-line">
        <StatusBadge
          tone={stale ? 'degraded' : 'healthy'}
          label={stale ? 'Earlier evidence is stale' : 'Earlier evidence still describes this commit'}
          detail={report.evidence.detail}
        />
      </p>
      {report.change.previousHeadSha === null ? null : (
        <CommitSha
          sha={report.change.previousHeadSha}
          label="Commit the earlier evidence was recorded against"
          current={false}
        />
      )}
      <p className="connector__problem-line" data-testid="change-detail">
        {report.change.changedAnything
          ? `During this read, ${report.change.changed.length === 1 ? 'one fact changed' : `${report.change.changed.length} facts changed`}: ${report.change.changed.join(', ')}. ${report.change.detail}`
          : `Nothing material moved during this read. ${report.change.detail}`}
      </p>
      <p className="connector__problem-line">
        {`Readiness carried forward from an earlier commit: ${report.evidence.priorReadinessPreserved ? 'yes' : 'no'}. ` +
          `ShipLoop holds no stored readiness to carry across a force push, so a green card cannot survive one ` +
          `(F24-AC4, F25-AC3).`}
      </p>
      {report.supersededCandidateIds.length === 0 ? null : (
        <p className="connector__problem-line" data-testid="superseded">
          {`Superseded candidates: ${report.supersededCandidateIds.join(', ')}. Their evidence is about their own ` +
            `commits and does not count for this one (F24-AC4).`}
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What one verification pass observed.
 *
 * The report is the only source of any verdict on this page. It leads with the two commits and their
 * difference, because after a push that difference *is* the finding: every check the provider
 * attributed to the newer commit lands unbound and proves nothing about the candidate under review
 * (F20-AC3, F24-AC4). Then each observation, distinguished as its own standing, and then a summary of
 * the card the pass produced — that card is another surface's read model and is summarised here rather
 * than re-rendered, so there is one owner of the review card's layout.
 */
function renderVerification(
  report: VerificationReport | null,
  running: boolean,
  failure: string | null,
  unreachable: boolean,
): ReactElement | null {
  if (failure !== null) {
    return (
      <div
        className="connector__problem"
        role="alert"
        data-state={unreachable ? 'disconnected' : 'failed'}
        data-testid="verification-failure"
      >
        <p className="connector__problem-line">{failure}</p>
        <p className="connector__problem-line">
          {unreachable
            ? 'This says nothing about the checks. Nothing is shown in place of a result, because an empty pass would read as "nothing failed" — which is the one thing it must never mean (F03-AC2, F20-AC2).'
            : 'A refusal records nothing. The provider read that failed is not the same as a set of checks that came back clean, and it is not shown as one (F20-AC2).'}
        </p>
      </div>
    );
  }

  if (running) {
    return (
      <p className="state-line" role="status" aria-live="polite" data-state="loading" data-testid="verification-running">
        Reading the provider's checks and recording what it said. Nothing is concluded until the response
        arrives, and this page states no result of its own (F20-AC2).
      </p>
    );
  }

  if (report === null) return null;

  const headsAgree = report.candidateHeadSha === report.providerHeadSha;
  return (
    <section className="panel" aria-labelledby="verification-heading" data-testid="verification-report">
      <h3 className="panel__title" id="verification-heading">
        Verification
      </h3>
      <p className="panel__note">
        {`Read from ${report.method} at ${formatTimestamp(report.observedAt)}, against contract revision ` +
          `${report.contractRevision}. The server read the provider and derived every outcome below; this page ` +
          `sent none of them (F20-AC2, F23-AC1).`}
      </p>

      <dl className="detail-list">
        <CommitSha sha={report.candidateHeadSha} label="Candidate this pass is bound to" />
        <CommitSha sha={report.providerHeadSha} label="Commit the provider currently reports" current={headsAgree} />
      </dl>
      {/*
        The disagreement, stated as the finding it is. Silently reporting the candidate's commit here
        would be the single easiest way to make a post-push run read as a clean pass on the new code
        (F20-AC3, F24-AC4).
      */}
      <p
        className={headsAgree ? 'connector__problem-line' : 'state-line state-line--error'}
        role={headsAgree ? undefined : 'alert'}
        data-state={headsAgree ? 'ready' : 'stale'}
        data-testid="head-agreement"
      >
        {headsAgree
          ? 'The provider reports the same commit this pass is bound to, so the observations below are about the code on screen.'
          : `The provider has moved on: the candidate under review is ${report.candidateHeadSha} and the provider's head is now ${report.providerHeadSha}. Every check attributed to the newer commit is about different code, and none of them counts for this candidate (F20-AC3, F24-AC4).`}
      </p>

      <h4 className="panel__title">What was recorded</h4>
      {report.recorded.length === 0 ? (
        <p className="state-line" role="status" data-state="empty" data-testid="verification-empty">
          This pass recorded no observations at all. That is not the same as a pass, and it is not
          evidence that every check succeeded — nothing was observed, so nothing is concluded (F20-AC2).
        </p>
      ) : (
        <ul className="capability-list">
          {report.recorded.map((observation) => (
            <ObservationRow
              key={observation.evidenceId}
              observation={observation}
              candidateHeadSha={report.candidateHeadSha}
            />
          ))}
        </ul>
      )}

      <p className="connector__problem-line" data-testid="verification-card">
        {`The card this pass produced was collected at ${formatTimestamp(report.review.collectedAt)} and covers ` +
          `candidate ${report.review.candidate.candidateId} at ${report.review.candidate.headSha}. It carries ` +
          `${report.review.checks.length} check ${report.review.checks.length === 1 ? 'line' : 'lines'} and ` +
          `${report.review.evidence.length} evidence ${report.review.evidence.length === 1 ? 'row' : 'rows'}. ` +
          `Owner tests, the owner decision and the remaining gates live on the review card rather than here ` +
          `(F24-AC2, F25-AC1).`}
      </p>
    </section>
  );
}

/** Bounds a value quoted from a result this build has no word for (N02-AC2). */
function truncateWord(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}