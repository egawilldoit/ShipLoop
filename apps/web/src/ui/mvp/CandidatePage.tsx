/**
 * The candidate: link a pull request, see what is on it, refresh it, and run verification
 * against it (mvp-spec F11-AC2, F11-AC3, F20-AC2, F20-AC3, F24-AC1, F24-AC3, F24-AC4, F24-AC5,
 * F23-AC1, F03-AC5, F02-AC2, N03-AC1, N03-AC3, N02-AC2).
 *
 * This is the fourth step of the MVP journey — `Request → Contract → External execution → GitHub
 * Candidate → Verification → Owner Decision` — and it is read-only towards the provider throughout.
 * The candidate route has no merge, close, approve, retarget or re-protect method, and every
 * response carries `providerWritePerformed: false` as a literal. Nothing on this page can change
 * anything at GitHub, and there is no control here that could (F03-AC5).
 *
 * ## What identity means on this page
 *
 * The owner pastes a pull request URL and nothing else. There is no field for a commit, a branch
 * or a pull request number, because none of those is the owner's to assert: the server reads them
 * from the provider, records the full SHA it found, and refuses anything that is not 40
 * characters before it answers. The form's single input is therefore the whole of what this page
 * contributes to identity, and the response is the whole of what it renders (mvp-spec 3, F11-AC2,
 * F11-AC3).
 *
 * The card leads with the **full 40-character head SHA** through the shared `CommitSha`
 * component, because that is the only value that identifies the code under review. The branch
 * name and the pull request number are shown too — they are real routing facts the owner will
 * recognise — but they are labelled as routing facts and are never what the card identifies the
 * code *as*. A force push changes the branch name's meaning without changing the name, which is
 * exactly why it cannot be the identity (SHARED.md "Candidate", F24-AC4).
 *
 * ## Staleness is shown, not hidden
 *
 * `refreshCandidate` re-reads the provider and reports what moved. When the head moved,
 * `evidence.status` is `Stale`, `change.previousHeadSha` names the commit prior evidence is about,
 * and `priorReadinessPreserved` is the literal `false`. This page renders all of it: the previous
 * head, the new head, which facts changed, and the sentence saying that nothing carried forward
 * survived. A card that quietly kept its green state across a force push would be the exact
 * defect F24-AC4 exists to prevent, and the only way to avoid it is to render the movement rather
 * than suppress it.
 *
 * ## Verification reads its result back; it never states one
 *
 * `verifyCandidate` is called with **no body at all**. The route's schema has one optional
 * member and refuses `result`, `outcome`, `checkId`, `criterionId` and `headSha` by name, because
 * every one of those would be a way for the browser to assert what a check concluded. So this page
 * states no verdict: it renders what the response said, one row per observation, and the rows
 * distinguish a pass, a failure, a run still in progress, a gate nobody exercised, a result about
 * a commit that has since moved, and a word this build has no name for (F20-AC2, F23-AC1).
 *
 * Every judgement about what those words mean lives in `review-model.ts`, not here, so the rules
 * that keep a stale pass out of a success colour are testable without a browser (F20-AC3, F24-AC3).
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import {
  fetchHome,
  linkCandidate,
  readCandidate,
  refreshCandidate,
  verifyCandidate,
  type CandidateReport,
  type HomeEntry,
  type HomeProjection,
  type MvpFailure,
  type VerificationReportView,
} from '../mvp-client/index.ts';
import { Field } from '../components/Field.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { formatTimestamp } from '../api-client.ts';
import { CommitSha } from './CommitSha.tsx';
import {
  readCandidateCheck,
  readProviderState,
  readVerifyObservation,
} from './review-model.ts';
import { NoProjectSelected, ScreenEmpty, ScreenFailure, ScreenLoading, type ScreenProps } from './screen.tsx';

/**
 * The board entry this page is working on.
 *
 * The home projection is where a project says which requests have work outstanding, and it names
 * the candidate each one has. A candidate is therefore discovered rather than passed in: there is
 * no URL or prop through which this page could be pointed at a candidate belonging to another
 * project (F02-AC2).
 */
interface WorkItem {
  readonly key: string;
  readonly entry: HomeEntry;
}

type ReadState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly report: CandidateReport }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

type ActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly what: 'link' | 'refresh' | 'verify' }
  | { readonly kind: 'note'; readonly what: 'link' | 'refresh' | 'verify'; readonly note: string }
  | { readonly kind: 'refused'; readonly what: 'link' | 'refresh' | 'verify'; readonly failure: MvpFailure };

export function CandidatePage(props: ScreenProps): ReactElement {
  const { scope, epoch } = props;
  const [home, setHome] = useState<HomeProjection | null>(null);
  const [homeFailure, setHomeFailure] = useState<MvpFailure | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [read, setRead] = useState<ReadState>({ kind: 'none' });
  const [action, setAction] = useState<ActionState>({ kind: 'idle' });
  const [verification, setVerification] = useState<VerificationReportView | null>(null);

  /**
   * Reads the board, which is how this page learns which candidates exist.
   *
   * Three independent lists rather than a partition, and they are deduplicated by request: a
   * candidate with current automated evidence and an unrun owner test is truthfully in two groups,
   * and showing it twice would suggest two pieces of work where there is one (F24-AC3).
   */
  const loadHome = useCallback(async (): Promise<void> => {
    if (scope === null || scope.kind !== 'project') return;
    const result = await fetchHome(scope);
    if (!result.ok) {
      setHomeFailure(result.failure);
      return;
    }
    setHomeFailure(null);
    setHome(result.value);
  }, [scope]);

  useEffect(() => {
    void loadHome();
  }, [loadHome, epoch]);

  const items = useMemo(() => workItemsOf(home), [home]);

  // The selection is the first item with a candidate when there is one, so mounting this screen
  // on a project that has a candidate shows that candidate rather than a request that needs a link
  // pasted into it. An owner with several requests picks from the list above the card.
  useEffect(() => {
    if (items.length === 0) {
      setSelectedKey(null);
      return;
    }
    setSelectedKey((current) => {
      if (current !== null && items.some((item) => item.key === current)) return current;
      const withCandidate = items.find((item) => item.entry.candidateId !== null);
      return withCandidate?.key ?? items[0]?.key ?? null;
    });
  }, [items]);

  const selected = items.find((item) => item.key === selectedKey) ?? null;
  const candidateId = selected?.entry.candidateId ?? null;

  /**
   * Reads the candidate live from the provider.
   *
   * On mount, on a change of candidate, and on an epoch bump. This is a `GET` that still talks to
   * GitHub on purpose: the card an owner is looking at must be an observation, and a card served
   * from a cache that agreed with the last read would present withdrawn work as current
   * (F24-AC4).
   */
  const loadCandidate = useCallback(async (): Promise<void> => {
    if (scope === null || scope.kind !== 'project' || candidateId === null) {
      setRead({ kind: 'none' });
      return;
    }
    setRead({ kind: 'loading' });
    const result = await readCandidate(scope, candidateId);
    if (!result.ok) {
      setRead({ kind: 'refused', failure: result.failure });
      return;
    }
    setRead({ kind: 'ready', report: result.value });
  }, [candidateId, scope]);

  useEffect(() => {
    setVerification(null);
    setAction({ kind: 'idle' });
    void loadCandidate();
  }, [loadCandidate]);

  const link = async (pullRequestUrl: string): Promise<void> => {
    if (scope === null || scope.kind !== 'project' || selected === null) return;
    const entry = selected.entry;
    if (entry.contractId === null || entry.contractRevision === null) {
      setAction({
        kind: 'refused',
        what: 'link',
        failure: {
          code: 'NotFound',
          status: 0,
          reason:
            'This request has no approved contract revision, and a candidate is bound to the exact revision it implements. Approve a contract first.',
          fields: [],
          prerequisites: [],
          expected: null,
          actual: null,
        },
      });
      return;
    }
    setAction({ kind: 'running', what: 'link' });
    const result = await linkCandidate(scope, {
      requestId: entry.requestId,
      contractId: entry.contractId,
      contractRevision: entry.contractRevision,
      pullRequestUrl,
    });
    if (!result.ok) {
      // A refusal is shown with the server's own words and the address left in the field, because
      // a wrong mapping is the owner's to correct and not something to retype from memory. An
      // unreachable answer is reported apart from a refusal: "GitHub could not be reached" and
      // "this is not this project's pull request" send the owner to different places (F11-AC3).
      setAction({ kind: 'refused', what: 'link', failure: result.failure });
      return;
    }
    setAction({
      kind: 'note',
      what: 'link',
      note: result.value.alreadyRecorded
        ? 'This exact commit was already recorded for this project, so nothing new was written.'
        : 'The pull request was read from GitHub and its commit recorded. Nothing was changed at GitHub.',
    });
    // The board is re-read rather than patched: the linked candidate is a fact about the project
    // that the projection computes, and a local edit would be a second opinion about which
    // candidate is current (F24-AC2).
    await loadHome();
  };

  const refresh = async (): Promise<void> => {
    if (scope === null || scope.kind !== 'project' || candidateId === null) return;
    setAction({ kind: 'running', what: 'refresh' });
    const result = await refreshCandidate(scope, candidateId);
    if (!result.ok) {
      setAction({ kind: 'refused', what: 'refresh', failure: result.failure });
      return;
    }
    setRead({ kind: 'ready', report: result.value });
    setAction({
      kind: 'note',
      what: 'refresh',
      note: refreshNoteOf(result.value),
    });
  };

  const verify = async (): Promise<void> => {
    if (scope === null || scope.kind !== 'project' || candidateId === null) return;
    setAction({ kind: 'running', what: 'verify' });
    // No options, so no body: this call states no method, no result, no check and no commit. The
    // server reads the provider and derives every outcome below (F20-AC2, F23-AC1).
    const outcome = await verifyCandidate(scope, candidateId);
    if (outcome.kind === 'refused') {
      // A provider that could not be read records nothing. Reporting that as an empty set of
      // observations would be the one reading this control must never allow (F03-AC2, F20-AC2).
      setVerification(null);
      setAction({ kind: 'refused', what: 'verify', failure: outcome.failure });
      return;
    }
    setVerification(outcome.report);
    setAction({ kind: 'note', what: 'verify', note: verifyNoteOf(outcome.report) });
  };

  const busy = action.kind === 'running' ? action.what : null;

  return (
    <section className="page" aria-labelledby="candidate-heading" data-testid="candidate-page">
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

      {scope === null ? <NoProjectSelected /> : null}

      {homeFailure !== null ? <ScreenFailure failure={homeFailure} /> : null}

      {home === null && homeFailure === null && scope !== null ? (
        <ScreenLoading what="Reading this project's board…" />
      ) : null}

      {home !== null ? (
        <WorkItemPicker
          items={items}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
      ) : null}

      {selected !== null ? (
        <LinkForm
          entry={selected.entry}
          busy={busy === 'link'}
          onLink={link}
        />
      ) : null}

      {action.kind === 'refused' ? <ActionRefusal action={action} /> : null}
      {action.kind === 'note' ? (
        <p className="state-line" role="status" aria-live="polite" data-testid="action-note" data-what={action.what}>
          {action.note}
        </p>
      ) : null}

      {selected === null ? (
        <ScreenEmpty>
          This project has no request with work outstanding, so there is nothing to link a candidate
          to. A candidate is bound to one request and one approved contract revision.
        </ScreenEmpty>
      ) : null}

      {selected !== null && candidateId === null ? (
        <ScreenEmpty>
          No candidate is linked to {selected.entry.requestId} yet. Paste a pull request address
          above; ShipLoop reads the commit from GitHub and records the full SHA itself.
        </ScreenEmpty>
      ) : null}

      {selected !== null && candidateId !== null ? (
        <>
          <div className="form__actions">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void refresh()}
              disabled={busy !== null}
              data-testid="refresh-candidate"
            >
              {busy === 'refresh' ? 'Refreshing…' : 'Refresh from GitHub'}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => void verify()}
              disabled={busy !== null}
              data-testid="verify-candidate"
            >
              {busy === 'verify' ? 'Verifying…' : 'Verify'}
            </button>
          </div>
          <p className="state-line" role="status" aria-live="polite" data-testid="refresh-note">
            {busy === 'refresh'
              ? 'Re-reading the pull request from GitHub…'
              : 'Refresh re-reads the pull request from GitHub and reports what moved. Verify asks the server to record what the provider reports. Neither states a result, and neither writes anything at the provider.'}
          </p>
        </>
      ) : null}

      {renderRead(read)}

      {verification === null ? null : (
        <VerificationPanel report={verification} />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Work items                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The board's entries, deduplicated by request.
 *
 * The three lists are independent by design, so the same request may appear twice; showing it
 * twice would read as two pieces of work. `readyForReview` wins a tie, because that is the state
 * the owner most often came here to act on (F24-AC3).
 */
function workItemsOf(home: HomeProjection | null): readonly WorkItem[] {
  if (home === null) return [];
  const byRequest = new Map<string, HomeEntry>();
  for (const entry of [...home.readyForReview, ...home.needsYou, ...home.inProgress]) {
    if (!byRequest.has(entry.requestId)) byRequest.set(entry.requestId, entry);
  }
  return [...byRequest.entries()].map(([requestId, entry]) => ({
    key: `${requestId}:${entry.contractId ?? ''}:${entry.contractRevision ?? 0}`,
    entry,
  }));
}

/** Which request this page is acting on, as a list of choices. */
function WorkItemPicker({
  items,
  selectedKey,
  onSelect,
}: {
  readonly items: readonly WorkItem[];
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
}): ReactElement | null {
  if (items.length <= 1) return null;
  return (
    <section className="panel" aria-labelledby="candidate-picker-heading">
      <h3 className="panel__title" id="candidate-picker-heading">
        Which request
      </h3>
      <ul className="capability-list">
        {items.map((item) => {
          const chosen = item.key === selectedKey;
          return (
            <li className="capability-list__item" key={item.key}>
              <button
                className={chosen ? 'button' : 'button button--secondary'}
                type="button"
                aria-pressed={chosen}
                onClick={() => onSelect(item.key)}
                data-testid="work-item"
                data-request-id={item.entry.requestId}
              >
                {`${item.entry.title} — ${item.entry.requestId}`}
              </button>
              <p className="panel__note">{item.entry.nextAction}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The link form                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One field: the pull request address.
 *
 * A single input is the honest shape here. Every other fact about the candidate — repository,
 * base branch, state, draft flag, and both commit SHAs — is read from the provider by the server,
 * and a field for any of them would ask the owner to assert something the server is about to
 * check anyway. The route would refuse such a body by name if it arrived (mvp-spec 3, F11-AC2).
 *
 * The address stays in the field after a refusal. A refusal is something the owner corrects, and
 * clearing their input would make them retype it from memory to see the same message (N03-AC3).
 */
function LinkForm({
  entry,
  busy,
  onLink,
}: {
  readonly entry: HomeEntry;
  readonly busy: boolean;
  readonly onLink: (pullRequestUrl: string) => Promise<void>;
}): ReactElement {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    const trimmed = url.trim();
    if (trimmed === '') {
      setError('Paste the pull request address from the browser.');
      return;
    }
    setError(undefined);
    void onLink(trimmed);
  };

  const approved = entry.contractId !== null && entry.contractRevision !== null;

  return (
    <section className="panel" aria-labelledby="link-heading">
      <h3 className="panel__title" id="link-heading">
        Link the pull request
      </h3>
      <p className="panel__note">
        Paste the address from the browser. ShipLoop reads the repository, the base branch, the
        state and the full head commit from GitHub and records those; you supply none of them, and
        the link is refused rather than guessed if the repository is not this project's (mvp-spec
        F11-AC2, F11-AC3).
      </p>
      {!approved ? (
        <ScreenEmpty>
          This request has no approved contract revision, so there is nothing to bind a candidate
          to. A candidate is bound to the exact contract revision it implements.
        </ScreenEmpty>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          <Field
            id="pull-request-url"
            label="Pull request address"
            type="url"
            value={url}
            onChange={setUrl}
            hint="For example https://github.com/owner/repo/pull/7"
            error={error}
            disabled={busy}
          />
          <div className="form__actions">
            <button className="button" type="submit" disabled={busy} data-testid="link-candidate">
              {busy ? 'Reading from GitHub…' : 'Link this pull request'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** A refused write, rendered as what it is, beside the control that caused it. */
function ActionRefusal({ action }: { readonly action: Extract<ActionState, { readonly kind: 'refused' }> }): ReactElement {
  return (
    <div data-testid="action-failure" data-what={action.what}>
      <ScreenFailure failure={action.failure} />
      <p className="state-line" role="status" data-state="empty">
        {action.what === 'link'
          ? 'Nothing was recorded. Your address is still in the field above — ShipLoop never picks a similarly named repository for you, so a wrong mapping is yours to correct (F11-AC3).'
          : action.what === 'verify'
            ? 'Nothing was recorded and nothing is claimed to have been verified. A provider that could not be read is not a set of checks that came back clean (F03-AC2, F20-AC2).'
            : 'Nothing was refreshed. A card is never served from the stored row after the provider stopped answering, because that would present withdrawn work as current (F24-AC4).'}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The candidate card                                                          */
/* -------------------------------------------------------------------------- */

function renderRead(read: ReadState): ReactElement | null {
  if (read.kind === 'none' || read.kind === 'loading') {
    return read.kind === 'loading' ? <ScreenLoading what="Reading the pull request from GitHub…" /> : null;
  }
  if (read.kind === 'refused') {
    return (
      <div data-testid="candidate-read-refusal">
        <ScreenFailure failure={read.failure} />
        <p className="state-line" role="status" data-state="empty">
          This says nothing about the pull request. ShipLoop is not showing a stale card in place of a
          live one (F24-AC4).
        </p>
      </div>
    );
  }
  return <CandidateCard report={read.report} />;
}

/**
 * One candidate, read live from the provider.
 *
 * The order is the order of the argument the owner needs: what the code *is* (the full head SHA
 * first), then where it came from, then what the provider currently says about it, then what has
 * been checked, and only then whether it can be decided on. The readiness line is last because it
 * is the only line here that is a judgement rather than a fact (F24-AC1, F24-AC3).
 */
function CandidateCard({ report }: { readonly report: CandidateReport }): ReactElement {
  const recorded = report.candidate;
  const state = readProviderState(recorded.pullRequestState);

  return (
    <section className="panel" aria-labelledby="candidate-card-heading" data-testid="candidate-card">
      <h3 className="panel__title" id="candidate-card-heading">
        {`Pull request #${String(recorded.pullRequestNumber)}`}
      </h3>

      <dl className="detail-list">
        <CommitSha sha={recorded.headSha} label="Code under review" />
        <div className="detail-list__row">
          <dt>Repository</dt>
          <dd data-testid="repository">{recorded.repository}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Pull request</dt>
          <dd data-testid="pull-request">
            {`#${String(recorded.pullRequestNumber)} — `}
            <a href={recorded.pullRequestUrl} target="_blank" rel="noopener noreferrer">
              open at the provider (opens in a new tab)
            </a>
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Base</dt>
          <dd data-testid="base">
            {`${recorded.baseBranch} — a routing fact: the branch this would land on. It is not the identity of the ` +
              'code under review, and it does not change when the head is force-pushed.'}
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Head branch</dt>
          <dd data-testid="head-branch">
            {`${recorded.headBranch} — a routing fact too. The commit above is what identifies the code.`}
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Provider state</dt>
          <dd data-testid="provider-state" data-recognised={String(state.recognised)}>
            <StatusBadge tone={state.tone} label={`${state.label}${recorded.draft ? ' (draft)' : ''}`} detail={state.standing} />
            <span className="panel__note">
              {`Reported by ${recorded.provider} at ${formatTimestamp(recorded.observedAt)}. This is the provider's own ` +
                'spelling, not ShipLoop\'s conclusion, and ShipLoop read it without changing anything there (mvp-spec 3, F03-AC5).'}
            </span>
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Contract binding</dt>
          <dd data-testid="binding">
            {`Contract ${recorded.contractId} revision ${String(recorded.contractRevision)}, bound to the commit above ` +
              `(fingerprint ${report.bindingFingerprint}). Every piece of evidence for this candidate names that commit, so ` +
              'nothing recorded against another build counts for it (F20-AC3, F24-AC4).'}
          </dd>
        </div>
      </dl>

      <EvidenceStanding report={report} />

      {/*
        The checks the provider reported right now, whether or not ShipLoop has recorded evidence
        from them. A required check nobody ran appears with the result it has rather than being
        absent — an omitted gate and a green one look the same in a list missing an entry (F20-AC2).
      */}
      <h4 className="panel__title">Checks reported by the provider</h4>
      {report.checks.length === 0 ? (
        <ScreenEmpty>
          The provider reported no checks for this pull request. Nothing is claimed either way: no
          check appearing is not the same as every check passing (F20-AC2).
        </ScreenEmpty>
      ) : (
        <ul className="capability-list">
          {report.checks.map((check) => (
            <CheckRow key={check.name} check={check} headSha={recorded.headSha} />
          ))}
        </ul>
      )}

      {/*
        Readiness last, and as the server's own answer. This page never recomputes it from the rows
        above, because a card that looks complete to a reader and a candidate the domain will
        accept must not be able to drift apart (F24-AC3).
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
 * One provider check, read through the display model.
 *
 * The model decides the label, the tone and whether this row counts for the commit on screen, so
 * a `Passed` attributed to another commit cannot reach this component as a green badge (F20-AC3).
 */
function CheckRow({
  check,
  headSha,
}: {
  readonly check: CandidateReport['checks'][number];
  readonly headSha: string;
}): ReactElement {
  const reading = readCandidateCheck(check, headSha);
  return (
    <li
      className="capability-list__item"
      data-testid="candidate-check"
      data-check-name={check.name}
      data-result={check.result}
      data-blocking={String(check.blocking)}
      data-counts={String(reading.countsForCandidate)}
    >
      <span className="profile-list__name">{check.name}</span>
      <StatusBadge tone={reading.tone} label={reading.label} detail={reading.standing} />
      <p className="panel__note">
        {check.required ? 'Required by this project.' : 'Not required by this project.'}{' '}
        {check.blocking
          ? 'It blocks until it passes.'
          : 'It does not block.'}{' '}
        {check.notApplicableApprovedByPolicy
          ? 'Policy approved this check as not applicable; that is a policy decision and not a pass (F20-AC5).'
          : ''}
        {check.detail !== null && check.detail !== '' ? ` ${check.detail}` : ''}
      </p>
    </li>
  );
}

/**
 * Whether evidence from an earlier head still describes this one.
 *
 * Both states are rendered, and the stale one names the commit the old evidence is about. A card
 * that showed only "current" would be indistinguishable from one that had just been refreshed, so
 * an owner could not tell whether they were looking at a live read or a remembered one (F24-AC4).
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
          ? `During this read, ${report.change.changed.length === 1 ? 'one fact changed' : `${String(report.change.changed.length)} facts changed`}: ${report.change.changed.join(', ')}. ${report.change.detail}`
          : `Nothing material moved during this read. ${report.change.detail}`}
      </p>
      <p className="connector__problem-line">
        {`Readiness carried forward from an earlier commit: ${report.evidence.priorReadinessPreserved ? 'yes' : 'no'}. ` +
          'ShipLoop holds no stored readiness to carry across a force push, so a green card cannot survive one (F24-AC4, F25-AC3).'}
      </p>
      {report.supersededCandidateIds.length === 0 ? null : (
        <p className="connector__problem-line" data-testid="superseded">
          {`Superseded candidates: ${report.supersededCandidateIds.join(', ')}. Their evidence is about their own ` +
            'commits and does not count for this one (F24-AC4).'}
        </p>
      )}
    </section>
  );
}

/**
 * What a refresh established, said so the owner can tell a moved head from a still one.
 *
 * Both branches are sentences rather than a badge, because "nothing material moved" and "the head
 * moved, so previous evidence is stale" are the difference between a card that may still be trusted
 * and one that may not (F24-AC4).
 */
function refreshNoteOf(report: CandidateReport): string {
  if (report.evidence.status === 'Stale') {
    const from = report.change.previousHeadSha ?? 'an earlier commit';
    return (
      `The head moved: it is now ${report.change.currentHeadSha}, and the evidence recorded against ${from} is ` +
      `stale. ${report.evidence.detail} Nothing carried forward from the earlier head survives, including any ` +
      'readiness it had (F24-AC4, F25-AC3).'
    );
  }
  return `Re-read from the provider at ${formatTimestamp(report.observedAt)}. ${report.evidence.detail}`;
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/** What one verification pass established, in one sentence. */
function verifyNoteOf(report: VerificationReportView): string {
  if (report.recorded.length === 0) {
    return 'The server read the provider and recorded no observations. That is not a pass, and it is not evidence that every check succeeded — nothing was observed, so nothing is concluded (F20-AC2).';
  }
  return `The server recorded ${String(report.recorded.length)} observation${report.recorded.length === 1 ? '' : 's'} from the provider at ${formatTimestamp(report.observedAt)}. Each one is rendered below as what it means for the commit on screen.`;
}

/**
 * What one automated verification pass observed.
 *
 * The report is the only source of any verdict on this page. It leads with the two commits and
 * their difference, because after a push that difference *is* the finding: every check the provider
 * attributed to the newer commit lands unbound and proves nothing about the candidate under review
 * (F20-AC3, F24-AC4). Then each observation, through the display model, and then a summary of the
 * card the pass produced — summarised rather than re-rendered, so there is one owner of the review
 * card's layout (F24-AC2).
 */
function VerificationPanel({ report }: { readonly report: VerificationReportView }): ReactElement {
  const headsAgree = report.candidateHeadSha === report.providerHeadSha;

  return (
    <section className="panel" aria-labelledby="verification-heading" data-testid="verification-report">
      <h3 className="panel__title" id="verification-heading">
        Verification
      </h3>
      <p className="panel__note">
        {`Read from ${report.method} at ${formatTimestamp(report.observedAt)}, against contract revision ` +
          `${String(report.contractRevision)}. The server read the provider and derived every outcome below; this page ` +
          'sent none of them (F20-AC2, F23-AC1).'}
      </p>

      <dl className="detail-list">
        <CommitSha sha={report.candidateHeadSha} label="Candidate this pass is bound to" />
        <CommitSha sha={report.providerHeadSha} label="Commit the provider currently reports" current={headsAgree} />
      </dl>

      {/*
        The disagreement, stated as the finding it is. Silently reporting the candidate's commit
        here would be the single easiest way to make a post-push run read as a clean pass on the
        new code (F20-AC3, F24-AC4).
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
        <ScreenEmpty>
          This pass recorded no observations at all. That is not the same as a pass, and it is not
          evidence that every check succeeded — nothing was observed, so nothing is concluded
          (F20-AC2).
        </ScreenEmpty>
      ) : (
        <ul className="capability-list">
          {report.recorded.map((observation) => (
            <ObservationLine
              key={observation.evidenceId}
              observation={observation}
              candidateHeadSha={report.candidateHeadSha}
            />
          ))}
        </ul>
      )}

      <p className="connector__problem-line" data-testid="verification-card">
        {`The card this pass produced was collected at ${formatTimestamp(report.review.collectedAt)} and covers candidate ` +
          `${report.review.candidate.candidateId} at ${report.review.candidate.headSha}. It carries ` +
          `${String(report.review.checks.length)} check ${report.review.checks.length === 1 ? 'line' : 'lines'} and ` +
          `${String(report.review.evidence.length)} evidence ${report.review.evidence.length === 1 ? 'row' : 'rows'}. ` +
          'Owner tests, the owner decision and the remaining gates live on the review screen rather than here (F24-AC2, F25-AC1).'}
      </p>
    </section>
  );
}

/**
 * One recorded observation, as what it means for the commit on screen.
 *
 * Both halves are shown and they are never merged: what counts now, and what the source said at
 * the time. Deleting the second would be the tempting simplification and the wrong one — an owner
 * watching a check go stale needs to know what the source *did* say, or "stale" reads as "we lost
 * the result" rather than "that result is about a commit that is no longer on screen" (F20-AC3,
 * F24-AC4).
 */
function ObservationLine({
  observation,
  candidateHeadSha,
}: {
  readonly observation: VerificationReportView['recorded'][number];
  readonly candidateHeadSha: string;
}): ReactElement {
  const reading = readVerifyObservation(observation, candidateHeadSha);
  return (
    <li
      className="capability-list__item"
      data-testid="observation"
      data-check-id={observation.checkId}
      data-standing={reading.key}
      data-counts={String(reading.countsForCandidate)}
      data-recorded-outcome={observation.recordedOutcome}
      data-current-outcome={observation.currentOutcome}
    >
      <span className="profile-list__name">{observation.checkId}</span>
      <StatusBadge tone={reading.tone} label={reading.label} />
      <p className="connector__problem-line" data-testid="observation-standing">
        {reading.standing}
      </p>
      <p className="connector__problem-line" data-testid="observation-history">
        {`What the source said at the time: “${observation.recordedOutcome}”. That is history; it is not a verdict on ` +
          'the commit on screen, and it is never counted as one (F20-AC3).'}
      </p>
      {observation.observedHeadSha === null ? null : (
        <CommitSha
          sha={observation.observedHeadSha}
          label="Commit the source attributed this run to"
          current={reading.countsForCandidate}
        />
      )}
    </li>
  );
}