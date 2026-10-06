/**
 * Delivery Contract: write the agreement, and approve exactly the text that was read.
 *
 * This is the second step of `Request → Contract → Handoff`. The agreement has five editable parts and
 * one rule that shapes the whole screen:
 *
 *   - **Outcome, scope, out of scope, acceptance criteria and each criterion's verification type** are
 *     the content `routes/contracts.ts` accepts, on create, on edit and on revise alike. The editor
 *     here is `CriterionEditor`, wrapped rather than rewritten so the criteria rules stay in one place.
 *   - **An automated criterion binds to one of the project's own configured checks.** The choices come
 *     from `readVerificationCheckNames`, which is the only readable source of the names
 *     `verificationCheckId` must carry, and they are shown as the names they are — `pnpm test`, not an
 *     opaque id. There is no free-text field: a criterion bound to a check nobody runs could only ever
 *     read unverified, and approval refuses it anyway, so a text box would collect a value that cannot
 *     become one (F23-AC1, F24-AC3).
 *
 * ## The fingerprint is what makes this screen honest
 *
 * `contract-agreement.ts` binds every save and every approval to the `contentFingerprint` of the read
 * that rendered this screen, and the screen never holds a fingerprint of its own. That is what turns a
 * second tab — or this tab reloading behind the owner's back — into a `Conflict` the owner is told
 * about, rather than a silent overwrite of text somebody else wrote (mvp-spec 3, mvp-spec 7, F24-AC4).
 *
 * On a `Conflict` this screen: never reports success, keeps every typed character, names both values
 * the server compared, and offers a reload rather than a retry — retrying would submit the same stale
 * reference and be refused again.
 *
 * ## Approval shows what was sealed
 *
 * After an approval the screen renders the revision number and the content fingerprint that were
 * approved, so "the approved text is exactly what I reviewed" is checkable rather than asserted
 * (N02-AC2).
 *
 * Reload re-reads from the server. Unsaved edits are not kept across a reload, and the screen says so
 * rather than implying they survived.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { CriterionEditor } from '../components/CriterionEditor.tsx';
import type {
  ContractDraft,
  DraftCriterion,
  DraftProblem,
  VerificationChoices,
} from '../contract-draft.ts';
import {
  approveContractText,
  conflictReport,
  hasUnsavedChanges,
  problemsOf,
  readContractForEditing,
  reviseContractText,
  saveContractDraft,
  withAddedStatement,
  withCriterion,
  withNewCriterion,
  withStatement,
  withoutCriterion,
  withoutStatement,
  type ContractRead,
  type ContractSaveOutcome,
} from './contract-agreement.ts';
import { NoProjectSelected, ScreenEmpty, ScreenFailure, ScreenLoading } from './screen.tsx';
import { HandoffPage } from './HandoffPage.tsx';
import type { ScreenProps } from './screen.tsx';
import { readProjectRequests } from './request-intake.ts';
import type {
  ContractView,
  MvpFieldError,
  MvpFailure,
  ProjectScope,
  RequestView,
} from '../mvp-client/index.ts';

/** What this screen is showing. Each state is a different fact for the owner (N03-AC1). */
type ViewState =
  | { readonly kind: 'no-request' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly read: ContractRead }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/** The request picker above the editor, which is a read in its own right. */
type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly requests: readonly RequestView[] }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/** The outcome of the last write, kept beside the form so a refusal never costs the text. */
type WriteState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly contract: ContractView }
  | { readonly kind: 'contract-changed'; readonly report: ReturnType<typeof conflictReport> }
  | { readonly kind: 'refused'; readonly failure: MvpFailure; readonly didSave: boolean };

export function ContractScreen({ scope, epoch }: ScreenProps): ReactElement {
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  // `refused` is kept apart from `loading` on purpose: a nullable list would render "Reading…" for a
  // read that failed and never came back, which is the one thing a screen must not do with a refusal
  // (N03-AC1, N03-AC3).
  const [requests, setRequests] = useState<ListState>({ kind: 'loading' });
  const [selectedRequestId, setSelectedRequestId] = useState<string>('');
  const [draft, setDraft] = useState<ContractDraft | null>(null);
  const [write, setWrite] = useState<WriteState>({ kind: 'idle' });

  /**
   * Re-reads the contract from the server.
   *
   * The draft is re-seeded from whatever comes back, which is the point: a durable revision is read,
   * not remembered, and after a reload the editor shows the server's text. Unsaved typing is
   * deliberately not restored — the screen says so rather than pretending otherwise.
   */
  const load = useCallback((): void => {
    if (scope === null) {
      setView({ kind: 'no-request' });
      return;
    }
    if (selectedRequestId === '') {
      setView({ kind: 'no-request' });
      setRequests({ kind: 'loading' });
      void readProjectRequests(scope).then((result) => {
        setRequests(
          result.ok ? { kind: 'ready', requests: result.value } : { kind: 'refused', failure: result.failure },
        );
      });
      return;
    }
    setView({ kind: 'loading' });
    void readContractForEditing(scope, selectedRequestId).then((outcome) => {
      if (outcome.kind === 'refused') {
        setView({ kind: 'refused', failure: outcome.failure });
        return;
      }
      setView({ kind: 'ready', read: outcome.read });
      setDraft(outcome.read.draft);
    });
  }, [scope, selectedRequestId]);

  useEffect(load, [load, epoch]);

  if (scope === null) {
    return (
      <section className="page" aria-labelledby="contract-heading" data-testid="contract-screen">
        <h2 className="page__title" id="contract-heading">
          Delivery contract
        </h2>
        <NoProjectSelected />
      </section>
    );
  }

  return (
    <section className="page" aria-labelledby="contract-heading" data-testid="contract-screen">
      <header className="page__header">
        <h2 className="page__title" id="contract-heading">
          Delivery contract
        </h2>
        <p className="panel__note">
          The agreement about what a successful change looks like: the outcome, what is in and out of
          scope, and the criteria that decide whether it worked. Approving it seals this exact text —
          revision and content fingerprint — as the thing an implementation is measured against.
        </p>
      </header>

      <RequestPicker
        list={requests}
        selectedRequestId={selectedRequestId}
        onSelect={(requestId) => {
          setSelectedRequestId(requestId);
          setDraft(null);
          setWrite({ kind: 'idle' });
        }}
      />

      {view.kind === 'no-request' ? (
        <ScreenEmpty>
          Choose a request above. A delivery contract answers one request, so there is nothing to write
          until one is chosen — this screen will not pick one for you.
        </ScreenEmpty>
      ) : null}

      {view.kind === 'loading' ? <ScreenLoading what="Reading the request and its contract…" /> : null}
      {view.kind === 'refused' ? (
        <>
          <ScreenFailure failure={view.failure} />
          <ReloadControl onReload={load} />
        </>
      ) : null}

      {view.kind === 'ready' && draft !== null ? (
        <ContractEditor
          read={view.read}
          draft={draft}
          write={write}
          scope={scope}
          onDraft={setDraft}
          onWrite={setWrite}
          onReload={load}
        />
      ) : null}
    </section>
  );
}

/**
 * The explicit reload a refusal or a conflict offers.
 *
 * Offered rather than performed: a screen that silently re-read after a refusal would replace what the
 * owner is looking at, and a screen that silently re-read after a conflict would throw away the typed
 * text that is the only copy of it (N03-AC3, F24-AC4).
 */
function ReloadControl({ onReload }: { readonly onReload: () => void }): ReactElement {
  return (
    <div className="form__actions">
      <button className="button" type="button" onClick={onReload} data-testid="contract-reload">
        Read the contract again
      </button>
    </div>
  );
}

function RequestPicker({
  list,
  selectedRequestId,
  onSelect,
}: {
  readonly list: ListState;
  readonly selectedRequestId: string;
  readonly onSelect: (requestId: string) => void;
}): ReactElement {
  return (
    <section className="panel" aria-labelledby="contract-request-picker">
      <h3 className="panel__title" id="contract-request-picker">
        Which request
      </h3>
      {list.kind === 'loading' ? <ScreenLoading what="Reading this project's requests…" /> : null}
      {list.kind === 'refused' ? <ScreenFailure failure={list.failure} /> : null}
      {list.kind === 'ready' && list.requests.length === 0 ? (
        <ScreenEmpty>
          This project has no requests yet, so there is no contract to write. Create one first.
        </ScreenEmpty>
      ) : null}
      {list.kind === 'ready' && list.requests.length > 0 ? (
        <ul className="capability-list">
          {list.requests.map((request) => (
            <li className="capability-list__item" key={request.requestId}>
              <span className="profile-list__name">{request.title}</span>
              <span className="profile-list__detail">{request.description}</span>
              <div className="form__actions">
                <button
                  className="button"
                  type="button"
                  aria-current={request.requestId === selectedRequestId ? 'true' : undefined}
                  data-testid={`pick-request-${request.requestId}`}
                  onClick={() => onSelect(request.requestId)}
                >
                  {request.requestId === selectedRequestId ? 'Writing this contract' : 'Write its contract'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface ContractEditorProps {
  readonly read: ContractRead;
  readonly draft: ContractDraft;
  readonly write: WriteState;
  readonly scope: ProjectScope;
  readonly onDraft: (draft: ContractDraft) => void;
  readonly onWrite: (write: WriteState) => void;
  readonly onReload: () => void;
}

function ContractEditor({
  read,
  draft,
  write,
  scope,
  onDraft,
  onWrite,
  onReload,
}: ContractEditorProps): ReactElement {
  const revision = read.revisionInView;
  const problems = problemsOf(draft);
  const busy = write.kind === 'saving';
  const dirty = hasUnsavedChanges(read, draft);
  const editable = revision === null || revision.status === 'draft';
  const serverProblems = write.kind === 'refused' ? write.failure.fields : [];

  /**
   * A successful write is followed by a re-read.
   *
   * The write's own response is rendered as the outcome — it is the server's answer about what it
   * did — but the *read* is refreshed too, because the read is what every later save and approval is
   * bound to, and its fingerprint moved. Continuing with the stale read would make the owner's very
   * next approve a guaranteed 409 against text they had just saved themselves.
   *
   * Nothing is re-read after a refusal or a conflict: that would replace the typed text with the
   * server's and throw away the only copy of the owner's words (F24-AC2, N03-AC3).
   */
  const afterWrite = (outcome: WriteState): void => {
    onWrite(outcome);
    if (outcome.kind === 'saved') onReload();
  };

  const save = (): void => {
    if (busy) return;
    onWrite({ kind: 'saving' });
    void saveContractDraft(scope, read, draft).then((outcome) => afterWrite(readWriteOutcome(outcome)));
  };

  const approve = (): void => {
    if (busy) return;
    onWrite({ kind: 'saving' });
    void approveContractText(scope, read).then((outcome) => {
      if (outcome.kind === 'approved') {
        afterWrite({ kind: 'saved', contract: outcome.contract });
        return;
      }
      if (outcome.kind === 'contract-changed') {
        // No re-read: the conflict panel has to name the fingerprint the owner was looking at, and a
        // reload would replace both the typed text and the comparison with the server's current state.
        onWrite({ kind: 'contract-changed', report: conflictReport({ ...outcome, didSave: false }) });
        return;
      }
      onWrite({ kind: 'refused', failure: outcome.failure, didSave: false });
    });
  };

  const revise = (): void => {
    if (busy) return;
    onWrite({ kind: 'saving' });
    void reviseContractText(scope, read, draft).then((outcome) => afterWrite(readWriteOutcome(outcome)));
  };

  return (
    <div data-testid="contract-editor">
      <RevisionStatus read={read} />

      {write.kind === 'contract-changed' ? (
        <section className="panel" role="alert" data-testid="contract-conflict" aria-labelledby="conflict-heading">
          <h3 className="panel__title" id="conflict-heading">
            {write.report.heading}
          </h3>
          <ul className="screen-failure__list">
            {write.report.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="form__actions">
            <button className="button" type="button" onClick={onReload} data-testid="contract-conflict-reload">
              Reload the contract and reconcile
            </button>
          </div>
          <p className="panel__note">
            A retry against the same fingerprint would be refused again, so it is not offered. Reloading
            replaces what is on screen with what the server holds; copy anything you typed here first if
            you want to compare the two.
          </p>
        </section>
      ) : null}

      {write.kind === 'saved' ? (
        <section className="panel" data-testid="contract-saved" aria-labelledby="saved-heading">
          <h3 className="panel__title" id="saved-heading">
            {write.contract.status === 'approved'
              ? `Approved revision ${write.contract.revision}`
              : `Saved revision ${write.contract.revision}`}
          </h3>
          <p className="panel__note" data-testid="saved-fingerprint">
            {`Content fingerprint ${write.contract.contentFingerprint}. That is the value any further edit or ` +
              'approval of this revision must send back, and it changed because the text did.'}
          </p>
          {write.contract.status === 'approved' ? (
            <ApprovedReport contract={write.contract} scope={scope} />
          ) : (
            <p className="panel__note">
              Nothing is agreed until you approve it. The text above is now what the server holds.
            </p>
          )}
        </section>
      ) : null}

      {write.kind === 'refused' ? <ScreenFailure failure={write.failure} /> : null}

      <fieldset className="panel" disabled={!editable || busy}>
        <legend className="panel__title">What a successful change looks like</legend>

        <label className="field__label" htmlFor="contract-outcome">
          Outcome
        </label>
        <textarea
          id="contract-outcome"
          className="field__input"
          rows={3}
          value={draft.outcome}
          aria-invalid={problems.outcome.length > 0 || undefined}
          data-testid="contract-outcome"
          onChange={(event) => onDraft({ ...draft, outcome: event.target.value })}
        />
        {problems.outcome.map((problem) => (
          <p className="field__error" key={problem.key}>
            {problem.message}
          </p>
        ))}

        <StatementList
          listKey="scope"
          title="In scope"
          entries={draft.scope}
          problems={problems.scope}
          onEdit={(index, value) => onDraft(withStatement(draft, 'scope', index, value))}
          onAdd={() => onDraft(withAddedStatement(draft, 'scope'))}
          onRemove={(index) => onDraft(withoutStatement(draft, 'scope', index))}
        />
        <StatementList
          listKey="outOfScope"
          title="Out of scope"
          entries={draft.outOfScope}
          problems={problems.outOfScope}
          onEdit={(index, value) => onDraft(withStatement(draft, 'outOfScope', index, value))}
          onAdd={() => onDraft(withAddedStatement(draft, 'outOfScope'))}
          onRemove={(index) => onDraft(withoutStatement(draft, 'outOfScope', index))}
        />

        <h3 className="panel__title">Acceptance criteria</h3>
        {read.checks.noProfileReason !== null ? (
          <p className="state-line state-line--error" role="alert" data-testid="contract-no-profile">
            {`No check can be offered: ${read.checks.noProfileReason} Until this project has a saved profile, an ` +
              'automated criterion cannot be bound to a check, and approval refuses one that names none. Mark ' +
              'those criteria as tests you run yourself, or save a profile for this project first.'}
          </p>
        ) : null}

        {draft.acceptanceCriteria.map((criterion, index) => (
          <CriterionRow
            key={criterion.key}
            criterion={criterion}
            index={index}
            choices={read.checks.choices}
            ownProblems={problems.criteria[criterion.key] ?? []}
            bindingProblems={problems.bindings[criterion.key] ?? []}
            serverProblems={serverProblemsFor(serverProblems, criterion.id)}
            canRemove={draft.acceptanceCriteria.length > 1}
            onChange={(next) => onDraft(withCriterion(draft, next))}
            onRemove={() => onDraft(withoutCriterion(draft, criterion.key))}
          />
        ))}

        <div className="form__actions">
          <button
            className="button button--secondary"
            type="button"
            onClick={() => onDraft(withNewCriterion(draft))}
            data-testid="contract-add-criterion"
          >
            Add an acceptance criterion
          </button>
        </div>
      </fieldset>

      <div className="form__actions">
        <button className="button" type="button" disabled={busy} onClick={save} data-testid="contract-save">
          {revision === null ? 'Save the first revision' : 'Save this revision'}
        </button>

        {revision !== null && revision.status === 'draft' ? (
          <button
            className="button"
            type="button"
            disabled={busy || dirty}
            onClick={approve}
            data-testid="contract-approve"
          >
            {`Approve revision ${revision.revision}`}
          </button>
        ) : null}

        {revision !== null && revision.status !== 'draft' ? (
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={revise}
            data-testid="contract-revise"
          >
            {`Start revision ${revision.revision + 1} from this text`}
          </button>
        ) : null}
      </div>

      {revision !== null && revision.status === 'draft' && dirty ? (
        <p className="state-line" role="status" data-testid="contract-dirty">
          You have changes that are not saved. Save them before approving — an approval seals what the
          server holds, not what is only on screen.
        </p>
      ) : null}

      {editable ? null : (
        <p className="state-line" data-state="empty" data-testid="contract-readonly">
          {`Revision ${revision?.revision ?? 0} is ${revision?.status ?? 'not editable'}, so its text is shown rather ` +
            'than edited. Changing an agreed contract means starting the next revision.'}
        </p>
      )}

      <p className="field__hint" data-testid="contract-reload-note">
        Reloading reads the contract from the server again. Anything typed but not saved is lost on reload —
        save first if you want to keep it.
      </p>
    </div>
  );
}

/** What the server reports about the revision in view. Every word here came from the server (F24-AC2). */
function RevisionStatus({ read }: { readonly read: ContractRead }): ReactElement {
  const revision = read.revisionInView;
  if (revision === null) {
    return (
      <section className="panel" aria-labelledby="revision-status-heading">
        <h3 className="panel__title" id="revision-status-heading">
          No revision yet
        </h3>
        <p className="panel__note">
          This request has no delivery contract. What you write below is drafted as revision 1, and nothing
          is agreed until you approve it.
        </p>
      </section>
    );
  }
  return (
    <section className="panel" aria-labelledby="revision-status-heading" data-testid="contract-revision">
      <h3 className="panel__title" id="revision-status-heading">
        {`Revision ${revision.revision} — ${revision.status}`}
      </h3>
      <p className="panel__note" data-testid="contract-fingerprint">
        {`Content fingerprint ${revision.contentFingerprint}. Every save and every approval from this screen is ` +
          'bound to this value, which is what stops a stale tab overwriting text somebody else wrote.'}
      </p>
      {revision.answersCurrentRequest ? null : (
        <p className="state-line state-line--error" role="alert" data-testid="contract-answers-stale-request">
          The server reports that this revision no longer answers the request as it reads now. Approving it
          would agree something the request no longer says.
        </p>
      )}
      {revision.blockedBecause !== null ? (
        <p className="state-line state-line--error" role="alert" data-testid="contract-blocked">
          {revision.blockedBecause}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The approved revision, named as the owner sealed it, and the packet for exactly that revision.
 *
 * ## Why the handoff lives here and not on a separate screen
 *
 * `HandoffPage` is addressed by a contract and a revision, and the only revision this screen can
 * name truthfully is the one the server just sealed. A separate handoff step would have to be
 * *told* which revision to show, and a shell that went looking for "the approved contract" could
 * land the owner on a packet for an approval they did not just make — so the packet is rendered by
 * the screen that performed the approval, for the identity the approval returned (F24-AC4).
 *
 * This also keeps `ScreenProps` the one screen seam: no second exported props shape, because the
 * screen needs nothing its `ScreenProps` does not already carry.
 *
 * Nothing here starts or sends anything. Approving sealed text; the packet below is what the owner
 * may copy and hand to whatever executes the work, and this product does not observe that tool
 * (mvp-spec 3).
 */
function ApprovedReport({
  contract,
  scope,
}: {
  readonly contract: ContractView;
  readonly scope: ProjectScope;
}): ReactElement {
  // Owned here rather than lifted: a screen cannot switch the shell's primary area without a second
  // seam, so the honest thing the "configure the address" control can do is name where the setting
  // lives (L02-AC3).
  const [settingsNotice, setSettingsNotice] = useState(false);
  return (
    <>
      <p data-testid="contract-approved-revision">
        {`Approved revision ${contract.revision}. This is the exact text you approved; nothing else was sealed.`}
      </p>
      <p data-testid="contract-approved-fingerprint">{`Content fingerprint ${contract.contentFingerprint}.`}</p>
      <p className="panel__note">
        Approving sealed this text. Nothing was started or sent anywhere by doing so.
      </p>
      <section className="panel" aria-labelledby="contract-handoff-heading">
        <h3 className="panel__title" id="contract-handoff-heading">
          Implementation handoff
        </h3>
        <HandoffPage
          projectId={scope.kind === 'project' ? scope.projectId : null}
          contractId={contract.contractId}
          contractRevision={contract.revision}
          scope={scope}
          onOpenSettings={() => {
            // The handoff's own "configure the address" control, rendered inside a screen that has
            // no way to switch the shell's primary area, therefore says where the setting lives
            // rather than pretending to take the owner there (L02-AC3).
            setSettingsNotice(true);
          }}
        />
        {settingsNotice && (
          <p className="state-line" data-testid="handoff-settings-pointer">
            The external tool's address is a project setting. Open Settings in the navigation beside
            this area to set it; Copy works without one.
          </p>
        )}
      </section>
    </>
  );
}

function readWriteOutcome(outcome: ContractSaveOutcome): WriteState {
  if (outcome.kind === 'saved') return { kind: 'saved', contract: outcome.contract };
  if (outcome.kind === 'contract-changed') {
    return { kind: 'contract-changed', report: conflictReport({ ...outcome, didSave: true }) };
  }
  return { kind: 'refused', failure: outcome.failure, didSave: true };
}

interface CriterionRowProps {
  readonly criterion: DraftCriterion;
  readonly index: number;
  readonly choices: VerificationChoices;
  readonly ownProblems: readonly DraftProblem[];
  readonly bindingProblems: readonly DraftProblem[];
  readonly serverProblems: readonly MvpFieldError[];
  readonly canRemove: boolean;
  readonly onChange: (criterion: DraftCriterion) => void;
  readonly onRemove: () => void;
}

/**
 * The server's messages about one criterion, matched by its id.
 *
 * The approval refusal keys its paths by criterion **id** — `acceptanceCriteria.AC1.verificationCheckId`
 * — so a substring test on the whole path would put a message about `AC1` on the row for `AC10` once a
 * contract has ten criteria. A message that lands on the wrong criterion is worse than no message, so
 * the id is compared as a whole path segment (F02-AC4, F23-AC1).
 */
function serverProblemsFor(
  fields: readonly MvpFieldError[],
  criterionId: string,
): readonly MvpFieldError[] {
  const mine = new Set([
    `acceptanceCriteria.${criterionId}`,
    `acceptanceCriteria.${criterionId}.verificationCheckId`,
    `acceptanceCriteria.${criterionId}.description`,
  ]);
  return fields.filter((field) => mine.has(field.path));
}

/**
 * One criterion, through the shared editor.
 *
 * Wrapped rather than reimplemented so the rules about who settles a criterion and which check settles
 * an automated one live in one component. The wrapper's whole job is to mark the refusal paths the
 * server named against the row they belong to — the refusal keys a message by criterion **id**, so
 * attaching it by position would put a message about a missing binding on the wrong criterion after a
 * reorder (F02-AC4, F23-AC1).
 */
function CriterionRow({
  criterion,
  index,
  choices,
  ownProblems,
  bindingProblems,
  serverProblems,
  canRemove,
  onChange,
  onRemove,
}: CriterionRowProps): ReactElement {
  return (
    <CriterionEditor
      criterion={criterion}
      index={index}
      choices={choices}
      ownProblems={[...ownProblems, ...bindingProblems]}
      serverProblems={serverProblems}
      disabled={false}
      canRemove={canRemove}
      onChange={onChange}
      onRemove={onRemove}
    />
  );
}

/**
 * One statement list: entries that may be edited and removed, and one that may be added.
 *
 * The three operations are three callbacks rather than one indexed one, because "add" and "remove" do
 * not name an entry and encoding them as an index would mean a magic `-1` reaching a pure function —
 * which is how a remove ends up writing `''` into the last row instead (F02-AC4).
 */
function StatementList({
  listKey,
  title,
  entries,
  problems,
  onEdit,
  onAdd,
  onRemove,
}: {
  readonly listKey: string;
  readonly title: string;
  readonly entries: readonly string[];
  readonly problems: readonly DraftProblem[];
  readonly onEdit: (index: number, value: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}): ReactElement {
  return (
    <fieldset className="panel">
      <legend className="panel__title">{title}</legend>
      {entries.length === 0 ? (
        <p className="field__hint">
          Nothing listed. An empty list is allowed; an empty <em>entry</em> is refused, because it says
          nothing.
        </p>
      ) : null}
      {entries.map((entry, index) => (
        <div key={`${listKey}-${index}`}>
          <label className="field__label" htmlFor={`contract-${listKey}-${index}`}>
            {`${title} ${index + 1}`}
          </label>
          <input
            id={`contract-${listKey}-${index}`}
            className="field__input"
            value={entry}
            data-testid={`contract-${listKey}-${index}`}
            onChange={(event) => onEdit(index, event.target.value)}
          />
          {problems
            .filter((problem) => problem.key === `${listKey}-${index}`)
            .map((problem) => (
              <p className="field__error" key={problem.key}>
                {problem.message}
              </p>
            ))}
          <div className="form__actions">
            <button
              className="button button--secondary"
              type="button"
              data-testid={`contract-remove-${listKey}-${index}`}
              onClick={() => onRemove(index)}
            >
              {`Remove this ${title.toLowerCase()} line`}
            </button>
          </div>
        </div>
      ))}
      <div className="form__actions">
        <button
          className="button button--secondary"
          type="button"
          data-testid={`contract-add-${listKey}`}
          onClick={onAdd}
        >
          {`Add a line to ${title.toLowerCase()}`}
        </button>
      </div>
    </fieldset>
  );
}
