/**
 * The owner flow: **New Request → Delivery Contract → Save Draft → Approve → Prepare
 * Implementation.**
 *
 * The whole flow is one page because it is one decision in four steps. An owner approving a
 * contract needs to see the request it answers, the contract text, and what approval will
 * seal — on one screen, at one moment. Split across routes, a tab ends up rendering one
 * revision and approving another.
 *
 * Five things this page is built not to do:
 *
 *   - **It never claims a write succeeded that the server refused.** A refusal is rendered
 *     beside what caused it, and the typed text stays exactly where it was, so the owner
 *     corrects and resubmits rather than retyping (F02-AC4, N03-AC3).
 *   - **It never approves text the owner did not read.** The approval carries the
 *     fingerprint from the revision read. On a 409 the page says the contract changed since
 *     it was loaded, offers to read the current version, and states plainly that nothing was
 *     approved — approving text you did not review is the failure this guard exists to stop
 *     (mvp-spec 7, F24-AC4).
 *   - **It never renders a stale fact as current.** The tokens a save and an approval are
 *     measured against come from the read that rendered the page, so the token and the text
 *     on screen describe the same moment by construction.
 *   - **It depends on no AI, Codex, OpenCode or Linear integration.** Every route here is
 *     project configuration and the owner's own text, so the flow works on a deployment that
 *     has configured none of them.
 *   - **It renders no merge, deploy or release control.** v0.1 ends at approval; the
 *     implementation happens in an external environment the owner brings (mvp-spec 7).
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { formatTimestamp, type ApiFieldError } from '../api-client.ts';
import {
  approveContractRevision,
  createRequest,
  draftContract,
  fetchContractRevision,
  fetchRequestDetail,
  fetchRequests,
  fetchVerificationChecks,
  saveContractDraft,
  updateRequest,
  type ContractApiFailure,
  type ContractView,
  type RequestDetailView,
  type RequestView,
  type VerificationCheckChoices,
} from '../contract-client.ts';
import {
  blankCriterion,
  contractState,
  criterionIdsInRefusal,
  draftContent,
  draftFromContract,
  draftFromRequest,
  draftProblems,
  isStaleRefusal,
  MAXIMUM_TITLE_LENGTH,
  verificationChoices,
  type ContractDraft,
  type ContractState,
  type DraftCriterion,
  type DraftProblem,
  type VerificationChoices,
} from '../contract-draft.ts';
import { CriterionEditor } from '../components/CriterionEditor.tsx';
import { useSession } from '../session.tsx';

/** What the page is doing, kept apart so a refusal is never read as progress. */
type Phase = 'loading' | 'ready' | 'error';

/**
 * What a refused call left behind.
 *
 * `fieldErrors` is held separately from the phase because a refusal that named a field is
 * *both* an error and a partly-useful answer: the owner has to be able to correct one input
 * without the page pretending nothing happened.
 */
interface Failure {
  readonly reason: string;
  readonly code: string;
  readonly fieldErrors: readonly ApiFieldError[];
  /**
   * True when the server refused because the text moved under the owner.
   *
   * Distinct from every other failure because the remedy differs: not "correct this input"
   * but "read the current text and decide again".
   */
  readonly stale: boolean;
  /** Both fingerprints, when the server named them, so the owner is not left guessing. */
  readonly expected: string | null;
  readonly actual: string | null;
}

/**
 * A refusal, in the terms this page acts on.
 *
 * `stale` is the one distinction the page cannot infer from a code alone, and it decides the
 * remedy — read the current version, or correct one input. The rule lives in
 * `isStaleRefusal` so it is tested once rather than re-guessed in a component, because
 * guessing it wrong would tell the owner to retype a value only the server can issue
 * (mvp-spec 7, F24-AC4).
 */
function failureOf(failure: ContractApiFailure): Failure {
  const paths = failure.fields.map((field) => field.path);
  const stale = isStaleRefusal(failure.code, paths);
  return {
    reason: failure.reason,
    code: failure.code,
    fieldErrors: failure.fields,
    stale,
    expected: failure.expected,
    actual: failure.actual,
  };
}

/** One request as the picker shows it. */
interface RequestChoice {
  readonly requestId: string;
  readonly title: string;
}

function choiceOf(request: RequestView): RequestChoice {
  return { requestId: request.requestId, title: request.title };
}

export interface ContractPageProps {
  /**
   * Bumped by the shell's retry control so every mounted page refetches.
   *
   * A reload is also the remedy the 409 path offers, which is why it is a prop rather than
   * something the page owns: the page cannot bump its own epoch, and the shell's retry is
   * the same "read again" the connection banner already uses.
   */
  readonly epoch: number;
  /**
   * Hands the approved contract to the implementation surface.
   *
   * Nullable rather than an optional prop: the caller always passes something — a callback
   * or `undefined` — so the page has one honest value to check instead of two ways of
   * meaning the same thing. The destination belongs to another agent, so this page emits the
   * action and the identity it carries and navigates nowhere itself. Nothing here implies
   * ShipLoop will implement the work (mvp-spec 7).
   */
  readonly onPrepareImplementation: ((contract: ContractView) => void) | undefined;
}

export function ContractPage({ epoch, onPrepareImplementation }: ContractPageProps): ReactElement {
  const { selectedProjectId, connection } = useSession();

  /** Which request is being worked on. Null until one is chosen. */
  const [requestId, setRequestId] = useState<string | null>(null);
  const [requests, setRequests] = useState<readonly RequestChoice[]>([]);
  const [detail, setDetail] = useState<RequestDetailView | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadFailure, setLoadFailure] = useState<Failure | null>(null);

  /** The revision on screen, and the tokens that describe exactly that text. */
  const [contract, setContract] = useState<ContractView | null>(null);
  const [draft, setDraft] = useState<ContractDraft | null>(null);
  const [checks, setChecks] = useState<VerificationCheckChoices | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<Failure | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveFailure, setApproveFailure] = useState<Failure | null>(null);

  /**
   * The request the owner is writing, held here rather than in the form.
   *
   * So a refusal — or a 409 on the contract after it — cannot cost the owner their
   * description. This is the difference between correcting one field and retyping a
   * paragraph.
   */
  const [newRequest, setNewRequest] = useState({ title: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<Failure | null>(null);

  /** Bumped to force a re-read, the remedy the owner is offered after a 409. */
  const [reloadEpoch, setReloadEpoch] = useState(0);

  /** Announced in a live region, so the outcome of a write is heard as well as seen. */
  const [outcome, setOutcome] = useState<string | null>(null);
  const announce = useCallback((message: string) => setOutcome(message), []);

  /* -------------------------------------------------------------------------- */
  /* Loading                                                                     */
  /* -------------------------------------------------------------------------- */

  // The project's requests. A project with none is an empty state the owner acts on, not a
  // failure, and the two must not render the same way.
  useEffect(() => {
    if (selectedProjectId === null) {
      setRequests([]);
      setPhase('ready');
      return;
    }
    let current = true;
    setPhase('loading');
    setLoadFailure(null);
    void fetchRequests(selectedProjectId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setLoadFailure(failureOf(result.error));
        setPhase('error');
        return;
      }
      setRequests(result.value.requests.map(choiceOf));
      setPhase('ready');
    });
    return () => {
      current = false;
    };
  }, [selectedProjectId, epoch]);

  // One request and the contract state that answers it, so which revision is approved and
  // which is being edited are known together. Two round trips would leave a window in which
  // the two answers describe different moments (mvp-spec 3).
  useEffect(() => {
    if (selectedProjectId === null || requestId === null) {
      setDetail(null);
      return;
    }
    let current = true;
    void fetchRequestDetail(selectedProjectId, requestId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setLoadFailure(failureOf(result.error));
        setPhase('error');
        return;
      }
      setDetail(result.value);
      setLoadFailure(null);
      setPhase('ready');
    });
    return () => {
      current = false;
    };
  }, [selectedProjectId, requestId, epoch]);

  /**
   * The revision the editor shows, read by its own number.
   *
   * Deliberately a separate read from the request detail. The approval token is the
   * `contentFingerprint` of *this* read and the save token is this `updatedAt`, so the token
   * provably describes the text that is on screen — an approval must be a statement about
   * text somebody read.
   */
  useEffect(() => {
    if (selectedProjectId === null || detail === null) {
      setContract(null);
      setDraft(null);
      return;
    }
    const target = detail.latestRevision;
    if (target === null) {
      // No revision yet: the draft is seeded from the request the owner already wrote, so the
      // outcome is not retyped.
      setContract(null);
      setDraft(draftFromRequest(detail.request));
      setApproveFailure(null);
      setSaveFailure(null);
      return;
    }
    let current = true;
    void fetchContractRevision(selectedProjectId, target.contractId, target.revision).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setLoadFailure(failureOf(result.error));
        setPhase('error');
        return;
      }
      setContract(result.value.contract);
      // A reload replaces the editor with what is stored now. That is the whole point of the
      // remedy offered on a 409 — but it only happens when the owner asks for it, and the
      // notice says plainly that unsaved edits are replaced.
      setDraft(draftFromContract(result.value.contract));
      setApproveFailure(null);
      setSaveFailure(null);
    });
    return () => {
      current = false;
    };
    // `reloadEpoch` is a dependency because it is the owner's request to re-read after a
    // refusal, and it has to reach this effect to do anything.
  }, [selectedProjectId, detail, reloadEpoch]);

  // The project's configured check names — the only checks an automated criterion may bind
  // to. Read once per project rather than per keystroke.
  useEffect(() => {
    if (selectedProjectId === null) {
      setChecks(null);
      return;
    }
    let current = true;
    void fetchVerificationChecks(selectedProjectId).then((result) => {
      if (!current) return;
      setChecks(result);
    });
    return () => {
      current = false;
    };
  }, [selectedProjectId]);

  /* -------------------------------------------------------------------------- */
  /* Derived                                                                     */
  /* -------------------------------------------------------------------------- */

  const problems = useMemo(() => (draft === null ? null : draftProblems(draft)), [draft]);
  const choices = useMemo<VerificationChoices>(
    () => (checks === null || draft === null ? { kind: 'unreadable', reason: 'The configured checks have not been read yet.' } : verificationChoices(checks, draft)),
    [checks, draft],
  );
  const state: ContractState | null = contract === null ? null : contractState(contract);

  /** True when this revision is agreed, so its text must not change under it. */
  const readOnly = state?.kind === 'approved' || state?.kind === 'superseded';

  /* -------------------------------------------------------------------------- */
  /* Writes                                                                      */
  /* -------------------------------------------------------------------------- */

  const submitNewRequest = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selectedProjectId === null || creating) return;
    setCreating(true);
    setCreateFailure(null);
    void createRequest(selectedProjectId, {
      title: newRequest.title.trim(),
      description: newRequest.description.trim(),
    }).then((result) => {
      setCreating(false);
      if (!result.ok) {
        // The typed request stays in the form. A refusal must cost a correction, never a
        // retype (F02-AC4).
        setCreateFailure(failureOf(result.error));
        return;
      }
      setNewRequest({ title: '', description: '' });
      setRequestId(result.value.request.requestId);
      announce('Request created. Write the delivery contract that answers it.');
    });
  };

  const saveDraft = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selectedProjectId === null || draft === null || detail === null || saving) return;
    // Refuse to send a contract this page already knows is not approvable. The server would
    // say so too; saying it here keeps the owner's text where it is.
    if (problems !== null && !problems.approvable) {
      setSaveFailure({
        reason: 'This contract is not complete yet, so it was not saved. Nothing you typed has been changed.',
        code: 'Invalid',
        fieldErrors: [],
        stale: false,
        expected: null,
        actual: null,
      });
      announce('Not saved: this contract still has an unresolved problem.');
      return;
    }
    setSaving(true);
    setSaveFailure(null);

    const content = draftContent(draft);
    const write =
      contract === null
        ? // Revision 1 is a create rather than an edit, and needs no compare-and-set instant:
          // there is no text yet to be stale against.
          draftContract(selectedProjectId, detail.request.requestId, content)
        : saveContractDraft(selectedProjectId, contract.contractId, contract.revision, {
            ...content,
            expectedUpdatedAt: contract.updatedAt,
          });

    void write.then((result) => {
      setSaving(false);
      if (!result.ok) {
        setSaveFailure(failureOf(result.error));
        announce('The draft was not saved. What you typed is still here.');
        return;
      }
      setContract(result.value.contract);
      setDraft(draftFromContract(result.value.contract));
      announce(`Draft saved as revision ${result.value.contract.revision}. Nothing is approved yet.`);
    });
  };

  /**
   * Approves the revision on screen, naming the text it approves.
   *
   * The fingerprint is the one from the read that rendered this page, sent back unchanged.
   * That is the entire compare-and-set: two tabs on one draft both address the same
   * revision, so the fingerprint is the only thing separating "I approve what I read" from
   * "I approve what another tab wrote" — and nothing afterwards could detect the difference,
   * because a frozen revision reports itself as approved (mvp-spec 3, mvp-spec 7).
   */
  const approve = (): void => {
    if (selectedProjectId === null || contract === null || approving) return;
    if (problems !== null && !problems.approvable) {
      setApproveFailure({
        reason: 'This contract is not complete yet, so it was not approved. Nothing you typed has been changed.',
        code: 'Invalid',
        fieldErrors: [],
        stale: false,
        expected: null,
        actual: null,
      });
      announce('Not approved: this contract still has an unresolved problem.');
      return;
    }
    setApproving(true);
    setApproveFailure(null);
    void approveContractRevision(
      selectedProjectId,
      contract.contractId,
      contract.revision,
      contract.contentFingerprint,
    ).then((result) => {
      setApproving(false);
      if (!result.ok) {
        const failure = failureOf(result.error);
        setApproveFailure(failure);
        announce(
          failure.stale
            ? 'Not approved: this contract changed after you loaded it, so approving it now would seal text you did not review. Nothing has been approved.'
            : 'The contract was not approved. What you typed is still here.',
        );
        return;
      }
      setContract(result.value.contract);
      setApproveFailure(null);
      announce(
        `Approved revision ${result.value.contract.revision}. This text is now the agreement; changing it needs a new revision.`,
      );
    });
  };

  /** The owner's remedy after a 409: read the current text and decide again. */
  const reloadCurrent = (): void => {
    setSaveFailure(null);
    setApproveFailure(null);
    setReloadEpoch((previous) => previous + 1);
    announce('Reloading the current version of this contract…');
  };

  const saveRequestEdits = (title: string, description: string): void => {
    if (selectedProjectId === null || detail === null) return;
    void updateRequest(selectedProjectId, detail.request.requestId, {
      ...(title.trim() === '' ? {} : { title: title.trim() }),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      expectedUpdatedAt: detail.request.updatedAt,
    }).then((result) => {
      if (!result.ok) {
        setSaveFailure(failureOf(result.error));
        announce('The request was not updated. What you typed is still here.');
        return;
      }
      announce('The request was updated.');
      setReloadEpoch((previous) => previous + 1);
    });
  };

  /* -------------------------------------------------------------------------- */
  /* Rendering                                                                   */
  /* -------------------------------------------------------------------------- */

  // The project is chosen in the session, not here. There is no placeholder project and no
  // default id, so a page without one says so rather than addressing a project named
  // "undefined" (F02-AC1).
  if (selectedProjectId === null) {
    return (
      <section className="page" aria-labelledby="contract-title">
        <h2 className="page__title" id="contract-title">
          Delivery contract
        </h2>
        <p className="state-line" data-state="empty">
          No project is selected. Choose a project in the header before writing a request — every request and
          contract belongs to one project, so there is nothing to show until one is selected.
        </p>
      </section>
    );
  }

  if (phase === 'loading') {
    return (
      <section className="page" aria-labelledby="contract-title">
        <h2 className="page__title" id="contract-title">
          Delivery contract
        </h2>
        <p className="state-line" role="status" aria-live="polite" data-state="loading">
          Loading this project&rsquo;s requests…
        </p>
      </section>
    );
  }

  const requestFailed = phase === 'error' && loadFailure !== null && detail === null;

  return (
    <section className="page" aria-labelledby="contract-title">
      <div className="page__header">
        <h2 className="page__title" id="contract-title">
          Delivery contract
        </h2>
        <p className="page__note">
          A request says what should change. A delivery contract says what a successful implementation looks
          like, in a numbered revision you can approve and change by approving a new one.
        </p>
      </div>

      {/*
        Disconnected is its own state, distinct from an error. An unreachable server and a
        refused write are different facts: the first means nothing is known right now, the
        second means the server answered and declined. The banner renders the first; this
        keeps it visible on this page too (N03-AC1).
      */}
      {!connection.connected ? (
        <p className="state-line state-line--error" role="alert" data-state="disconnected">
          Not connected to the server. What is shown may not be current, and nothing can be saved until the
          connection returns.
        </p>
      ) : null}

      <p className="state-line" role="status" aria-live="polite" data-state="notice">
        {outcome}
      </p>

      <NewRequestForm
        value={newRequest}
        creating={creating}
        failure={createFailure}
        onChange={setNewRequest}
        onSubmit={submitNewRequest}
      />

      {requests.length === 0 ? (
        <p className="state-line" data-state="empty">
          This project has no requests yet. The one above will be its first.
        </p>
      ) : (
        <RequestPicker requests={requests} selectedRequestId={requestId} onSelect={setRequestId} />
      )}

      {requestFailed && loadFailure !== null ? (
        <p className="state-line state-line--error" role="alert" data-state="failed">
          This project&rsquo;s requests could not be read: {loadFailure.reason}
        </p>
      ) : null}

      {detail === null ? null : (
        <ContractWorkbench
          detail={detail}
          contract={contract}
          draft={draft}
          state={state}
          choices={choices}
          problems={problems}
          readOnly={readOnly}
          saving={saving}
          approving={approving}
          saveFailure={saveFailure}
          approveFailure={approveFailure}
          onChangeDraft={setDraft}
          onSave={saveDraft}
          onApprove={approve}
          onReload={reloadCurrent}
          onSaveRequest={saveRequestEdits}
          onPrepareImplementation={onPrepareImplementation}
        />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* New request                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Creating a request.
 *
 * No engine, connector or ticket provider is consulted, which is deliberate: a request must
 * be creatable on a deployment that has configured none of them.
 */
function NewRequestForm({
  value,
  creating,
  failure,
  onChange,
  onSubmit,
}: {
  readonly value: { readonly title: string; readonly description: string };
  readonly creating: boolean;
  readonly failure: Failure | null;
  readonly onChange: (next: { readonly title: string; readonly description: string }) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactElement {
  const titleId = 'new-request-title';
  const descriptionId = 'new-request-description';

  const titleError = failure?.fieldErrors.find((field) => field.path === 'title');
  const descriptionError = failure?.fieldErrors.find((field) => field.path === 'description');

  return (
    <form className="form" onSubmit={onSubmit} noValidate>
      <h3 className="panel__title">New request</h3>

      <label className="field__label" htmlFor={titleId}>
        What should change
      </label>
      <input
        id={titleId}
        className="field__input"
        value={value.title}
        maxLength={MAXIMUM_TITLE_LENGTH}
        disabled={creating}
        aria-invalid={titleError !== undefined || undefined}
        aria-describedby={titleError !== undefined ? `${titleId}-error` : undefined}
        onChange={(event) => onChange({ ...value, title: event.target.value })}
      />
      {titleError !== undefined ? (
        <p className="field__error" id={`${titleId}-error`}>
          {titleError.message}
        </p>
      ) : null}

      <label className="field__label" htmlFor={descriptionId}>
        Describe the change
      </label>
      <textarea
        id={descriptionId}
        className="field__input"
        rows={4}
        value={value.description}
        disabled={creating}
        aria-invalid={descriptionError !== undefined || undefined}
        aria-describedby={descriptionError !== undefined ? `${descriptionId}-error` : undefined}
        onChange={(event) => onChange({ ...value, description: event.target.value })}
      />
      {descriptionError !== undefined ? (
        <p className="field__error" id={`${descriptionId}-error`}>
          {descriptionError.message}
        </p>
      ) : null}

      {failure !== null && failure.fieldErrors.length === 0 ? (
        <p className="state-line state-line--error" role="alert" data-state="failed">
          The request was not created: {failure.reason} What you typed is still here.
        </p>
      ) : null}

      <div className="form__actions">
        <button className="button" type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'Create request'}
        </button>
      </div>
    </form>
  );
}

/** Which request to work on. */
function RequestPicker({
  requests,
  selectedRequestId: selected,
  onSelect,
}: {
  readonly requests: readonly RequestChoice[];
  readonly selectedRequestId: string | null;
  readonly onSelect: (requestId: string) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor="request-picker">
        Request
      </label>
      <select
        id="request-picker"
        className="field__input"
        value={selected ?? ''}
        onChange={(event) => {
          if (event.target.value !== '') onSelect(event.target.value);
        }}
      >
        <option value="">Choose a request</option>
        {requests.map((request) => (
          <option key={request.requestId} value={request.requestId}>
            {request.title}
          </option>
        ))}
      </select>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The contract itself                                                         */
/* -------------------------------------------------------------------------- */

interface WorkbenchProps {
  readonly detail: RequestDetailView;
  readonly contract: ContractView | null;
  readonly draft: ContractDraft | null;
  readonly state: ContractState | null;
  readonly choices: VerificationChoices;
  readonly problems: ReturnType<typeof draftProblems> | null;
  readonly readOnly: boolean;
  readonly saving: boolean;
  readonly approving: boolean;
  readonly saveFailure: Failure | null;
  readonly approveFailure: Failure | null;
  readonly onChangeDraft: (draft: ContractDraft) => void;
  readonly onSave: (event: FormEvent<HTMLFormElement>) => void;
  readonly onApprove: () => void;
  readonly onReload: () => void;
  readonly onSaveRequest: (title: string, description: string) => void;
  readonly onPrepareImplementation: ((contract: ContractView) => void) | undefined;
}

/**
 * The contract, its state, and the two actions that end the flow.
 *
 * The state line comes first and reads from the server's own fields. A revision that is
 * `approved` but no longer answers the request says so here rather than reading as a current
 * agreement, because `answersCurrentRequest` is the layer's report that the request has moved
 * on — and whether that invalidates the agreement is the owner's call, not this page's.
 */
function ContractWorkbench(props: WorkbenchProps): ReactElement {
  const {
    detail,
    contract,
    draft,
    state,
    choices,
    problems,
    readOnly,
    saving,
    approving,
    saveFailure,
    approveFailure,
    onChangeDraft,
    onSave,
    onApprove,
    onReload,
    onSaveRequest,
    onPrepareImplementation,
  } = props;

  if (draft === null) return <p className="state-line">Loading this contract…</p>;

  const updateCriterion = (next: DraftCriterion): void => {
    onChangeDraft({
      ...draft,
      acceptanceCriteria: draft.acceptanceCriteria.map((criterion) =>
        criterion.key === next.key ? next : criterion,
      ),
    });
  };

  const removeCriterion = (key: string): void => {
    onChangeDraft({ ...draft, acceptanceCriteria: draft.acceptanceCriteria.filter((c) => c.key !== key) });
  };

  const addCriterion = (): void => {
    const used = draft.acceptanceCriteria.map((criterion) => criterion.id);
    onChangeDraft({
      ...draft,
      // The key carries the row's position so it is unique and stable for this render pass;
      // the id is generated so the owner never has to invent one.
      acceptanceCriteria: [...draft.acceptanceCriteria, blankCriterion(used, `criterion-${used.length + 1}`)],
    });
  };

  const setList = (key: 'scope' | 'outOfScope', entries: readonly string[]): void =>
    onChangeDraft({ ...draft, [key]: entries });

  /**
   * Server-named problems for one criterion, matched by **id**.
   *
   * The domain builds `acceptanceCriteria.<criterionId>.verificationCheckId`. Matching by
   * position would point the message at whichever row happens to sit there after a reorder —
   * the wrong criterion, and the worst possible place for a message about a missing binding.
   */
  const serverProblemsFor = (criterion: DraftCriterion): readonly ApiFieldError[] => {
    const named = criterionIdsInRefusal(
      [...(saveFailure?.fieldErrors ?? []), ...(approveFailure?.fieldErrors ?? [])].map((field) => field.path),
    );
    if (!named.some((entry) => entry.criterionId === criterion.id)) return [];
    return [...(saveFailure?.fieldErrors ?? []), ...(approveFailure?.fieldErrors ?? [])].filter((field) =>
      criterionIdsInRefusal([field.path]).some((entry) => entry.criterionId === criterion.id),
    );
  };

  /** Refusal messages that could not be attributed to a row, so none is ever dropped. */
  const unattributed = [...(saveFailure?.fieldErrors ?? []), ...(approveFailure?.fieldErrors ?? [])].filter(
    (field) => !criterionIdsInRefusal([field.path]).some((entry) => draft.acceptanceCriteria.some((c) => c.id === entry.criterionId)),
  );

  const ownerTestCount = draft.acceptanceCriteria.filter((criterion) => criterion.verificationType === 'owner_test').length;

  return (
    <>
      <RequestSummary detail={detail} onSave={onSaveRequest} />

      <div className="panel">
        <h3 className="panel__title">Contract state</h3>
        <ContractStateLine contract={contract} state={state} />
      </div>

      {approveFailure !== null ? <ApprovalRefusal failure={approveFailure} onReload={onReload} /> : null}
      {saveFailure !== null ? <SaveRefusal failure={saveFailure} onReload={onReload} /> : null}

      {unattributed.length > 0 ? (
        <ul className="field__error" aria-live="polite">
          {unattributed.map((field) => (
            <li key={`${field.path}:${field.message}`}>
              <strong>{field.path}</strong>: {field.message}
            </li>
          ))}
        </ul>
      ) : null}

      <form className="form" onSubmit={onSave} noValidate>
        <h3 className="panel__title">The agreement</h3>

        <label className="field__label" htmlFor="contract-outcome">
          Outcome this contract promises
        </label>
        <textarea
          id="contract-outcome"
          className="field__input"
          rows={3}
          value={draft.outcome}
          disabled={readOnly}
          aria-invalid={(problems?.outcome.length ?? 0) > 0 || undefined}
          onChange={(event) => onChangeDraft({ ...draft, outcome: event.target.value })}
        />
        <ProblemList problems={problems?.outcome ?? []} />

        <StatementList
          legend="In scope"
          entries={draft.scope}
          problems={problems?.scope ?? []}
          disabled={readOnly}
          onChange={(index, value) =>
            setList('scope', draft.scope.map((entry, position) => (position === index ? value : entry)))
          }
          onAdd={() => setList('scope', [...draft.scope, ''])}
          onRemove={(index) => setList('scope', draft.scope.filter((_, position) => position !== index))}
        />

        <StatementList
          legend="Out of scope"
          entries={draft.outOfScope}
          problems={problems?.outOfScope ?? []}
          disabled={readOnly}
          onChange={(index, value) =>
            setList('outOfScope', draft.outOfScope.map((entry, position) => (position === index ? value : entry)))
          }
          onAdd={() => setList('outOfScope', [...draft.outOfScope, ''])}
          onRemove={(index) => setList('outOfScope', draft.outOfScope.filter((_, position) => position !== index))}
        />

        <fieldset className="panel">
          <legend className="panel__title">Acceptance criteria</legend>
          <p className="panel__note">
            Each criterion says what must be true and who settles it. An automated criterion names the check that
            verifies it, so a verdict is filed against one known run rather than against whichever check happened
            to be green.
          </p>

          {draft.acceptanceCriteria.map((criterion, index) => (
            <CriterionEditor
              key={criterion.key}
              criterion={criterion}
              index={index}
              choices={choices}
              ownProblems={ownProblemsFor(criterion)}
              serverProblems={serverProblemsFor(criterion)}
              disabled={readOnly}
              canRemove={draft.acceptanceCriteria.length > 1}
              onChange={updateCriterion}
              onRemove={() => removeCriterion(criterion.key)}
            />
          ))}

          <ProblemList problems={problems?.criteria['criteria-region'] ?? []} />

          <button className="button button--secondary" type="button" disabled={readOnly} onClick={addCriterion}>
            Add criterion
          </button>
        </fieldset>

        {ownerTestCount > 0 ? (
          <p className="field__hint" data-testid="owner-test-count">
            {ownerTestCount} of {draft.acceptanceCriteria.length} criteria are settled by you acting on them.
            Those stay yours until you record what you saw; no check can discharge them.
          </p>
        ) : null}

        <div className="form__actions">
          <button className="button" type="submit" disabled={readOnly || saving}>
            {saving ? 'Saving…' : contract === null ? 'Save draft as revision 1' : `Save revision ${contract.revision}`}
          </button>
          {readOnly ? (
            <p className="field__hint">
              This revision is agreed. Its text cannot be edited — a change needs a new revision, which is a
              separate decision.
            </p>
          ) : null}
        </div>
      </form>

      <ApprovalControls
        state={state}
        contract={contract}
        approvable={problems === null || problems.approvable}
        readOnly={readOnly}
        approving={approving}
        onApprove={onApprove}
        onReload={onReload}
        onPrepareImplementation={onPrepareImplementation}
      />
    </>
  );
}

/**
 * This row's own validation problems.
 *
 * Derived by validating a one-criterion draft, so a row and the whole-contract check can
 * never disagree about whether a criterion is complete — one implementation of the rules,
 * called twice. The outcome is a placeholder that is never inspected: `draftProblems` is being
 * asked about one criterion, not about a whole contract.
 */
function ownProblemsFor(criterion: DraftCriterion): readonly DraftProblem[] {
  const single = draftProblems({ outcome: 'a placeholder outcome', scope: [], outOfScope: [], acceptanceCriteria: [criterion] });
  return [...(single.criteria[criterion.key] ?? []), ...(single.bindings[criterion.key] ?? [])];
}

/** The request being answered, with its own edits. */
function RequestSummary({
  detail,
  onSave,
}: {
  readonly detail: RequestDetailView;
  readonly onSave: (title: string, description: string) => void;
}): ReactElement {
  const [title, setTitle] = useState(detail.request.title);
  const [description, setDescription] = useState(detail.request.description);
  const [editing, setEditing] = useState(false);

  // Re-seed when the stored request changes underneath the editor — after a save, or after a
  // reload — so the fields do not keep showing text that is no longer stored.
  useEffect(() => {
    setTitle(detail.request.title);
    setDescription(detail.request.description);
  }, [detail.request.title, detail.request.description]);

  if (!editing) {
    return (
      <div className="panel">
        <h3 className="panel__title">The request this answers</h3>
        <p className="profile-list__name">{detail.request.title}</p>
        <p className="profile-list__detail">{detail.request.description}</p>
        <p className="field__hint">Last changed {formatTimestamp(detail.request.updatedAt)}.</p>
        <button className="button button--secondary" type="button" onClick={() => setEditing(true)}>
          Edit the request
        </button>
      </div>
    );
  }

  return (
    <form
      className="form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSave(title, description);
        setEditing(false);
      }}
    >
      <h3 className="panel__title">The request this answers</h3>
      <label className="field__label" htmlFor="request-title">
        Title
      </label>
      <input
        id="request-title"
        className="field__input"
        value={title}
        maxLength={MAXIMUM_TITLE_LENGTH}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label className="field__label" htmlFor="request-description">
        What should change
      </label>
      <textarea
        id="request-description"
        className="field__input"
        rows={4}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <p className="field__hint">
        The request and the contract are separate. Changing the request does not change an approved contract —
        whether that invalidates the agreement is your call.
      </p>
      <div className="form__actions">
        <button className="button" type="submit">
          Save the request
        </button>
        <button className="button button--secondary" type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The revision and what state it is in, in words that do not overclaim.
 *
 * `blockedBecause` is read from the server rather than recomputed. It is the layer's report of
 * why a revision may not be measured against a candidate, and a second opinion computed here
 * would be a third answer to the same question.
 */
function ContractStateLine({
  contract,
  state,
}: {
  readonly contract: ContractView | null;
  readonly state: ContractState | null;
}): ReactElement {
  if (contract === null || state === null) {
    return (
      <p className="state-line" data-state="empty">
        No contract has been written for this request yet. The draft below becomes revision 1.
      </p>
    );
  }

  const revision = (
    <p className="connector__subtitle" data-testid="contract-revision">
      Revision {contract.revision}
    </p>
  );

  if (state.kind === 'approved') {
    return (
      <div data-state="approved" data-testid="contract-state">
        {revision}
        <p className="state-line">
          Approved{state.approvedAt === '' ? '' : ` ${formatTimestamp(state.approvedAt)}`}. This text is the
          agreement, and it cannot be edited in place — a change needs a new revision.
        </p>
        {/*
          Shown, not hidden. An agreement the request has moved past is still approved; whether
          that matters is the owner's decision, and the only way to change the text is a new
          revision. Rendering this as a current agreement would be the false reading.
        */}
        {state.answersCurrentRequest ? null : (
          <p className="state-line state-line--error" role="alert" data-state="stale">
            The request has changed since this revision was approved, so this agreement no longer describes the
            request as it now stands. It is still approved — re-approving a new revision is how you change it.
          </p>
        )}
      </div>
    );
  }

  if (state.kind === 'stale') {
    return (
      <div data-state="stale" data-testid="contract-state">
        {revision}
        <p className="state-line state-line--error" role="alert">
          This approval is no longer current: {state.reason} It is not an agreement anything may be implemented
          against.
        </p>
      </div>
    );
  }

  if (state.kind === 'superseded') {
    return (
      <div data-state="superseded" data-testid="contract-state">
        {revision}
        <p className="state-line">
          Superseded by revision {state.byRevision}. This text is kept for the record and is not the current
          agreement.
        </p>
      </div>
    );
  }

  return (
    <div data-state="draft" data-testid="contract-state">
      {revision}
      <p className="state-line">
        A draft. Nothing is agreed yet, so this text can still be changed freely. It becomes an agreement only
        when you approve it.
      </p>
      {contract.blockedBecause !== null ? (
        <p className="state-line state-line--error" role="alert">
          This revision may not be measured against a candidate: {contract.blockedBecause}
        </p>
      ) : null}
    </div>
  );
}

/** A statement list the owner adds lines to. */
function StatementList({
  legend,
  entries,
  problems,
  disabled,
  onChange,
  onAdd,
  onRemove,
}: {
  readonly legend: string;
  readonly entries: readonly string[];
  readonly problems: readonly DraftProblem[];
  readonly disabled: boolean;
  readonly onChange: (index: number, value: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}): ReactElement {
  const listKey = legend === 'In scope' ? 'scope' : 'outOfScope';
  const noun = legend.toLowerCase();
  return (
    <fieldset className="panel">
      <legend className="panel__title">{legend}</legend>
      {entries.length === 0 ? <p className="field__hint">Nothing listed. That is a statement too.</p> : null}
      {entries.map((entry, index) => {
        const entryId = `${listKey}-${index}`;
        const problem = problems.find((candidate) => candidate.key === entryId);
        return (
          <div className="field" key={entryId}>
            <label className="field__label" htmlFor={entryId}>
              {legend} {index + 1}
            </label>
            <input
              id={entryId}
              className="field__input"
              value={entry}
              disabled={disabled}
              aria-invalid={problem !== undefined || undefined}
              aria-describedby={problem !== undefined ? `${entryId}-error` : undefined}
              onChange={(event) => onChange(index, event.target.value)}
            />
            {problem !== undefined ? (
              <p className="field__error" id={`${entryId}-error`}>
                {problem.message}
              </p>
            ) : null}
            <button className="button button--secondary" type="button" disabled={disabled} onClick={() => onRemove(index)}>
              Remove {noun} {index + 1}
            </button>
          </div>
        );
      })}
      {/* A list-level bound has no row to sit on, so it is rendered here rather than per entry. */}
      <ProblemList problems={problems.filter((problem) => problem.key === listKey)} />
      <button className="button button--secondary" type="button" disabled={disabled} onClick={onAdd}>
        Add to {noun}
      </button>
    </fieldset>
  );
}

function ProblemList({ problems }: { readonly problems: readonly DraftProblem[] }): ReactElement | null {
  if (problems.length === 0) return null;
  return (
    <ul className="field__error" aria-live="polite">
      {problems.map((problem) => (
        <li key={problem.message}>{problem.message}</li>
      ))}
    </ul>
  );
}

/**
 * The approval control, and what follows it.
 *
 * Approving is offered whenever there is a draft to approve. The button is not disabled on an
 * incomplete contract: a disabled control with no explanation is a dead end, so the problems
 * are listed beside it and the click states that nothing was sent.
 *
 * After a successful approval, `Prepare implementation` hands the approved revision to
 * whoever owns that surface. This page neither navigates nor starts anything: the
 * implementation happens in an external environment the owner brings, and no part of this
 * flow claims ShipLoop began or observes any of it (mvp-spec 7).
 */
function ApprovalControls({
  state,
  contract,
  approvable,
  readOnly,
  approving,
  onApprove,
  onReload,
  onPrepareImplementation,
}: {
  readonly state: ContractState | null;
  readonly contract: ContractView | null;
  readonly approvable: boolean;
  readonly readOnly: boolean;
  readonly approving: boolean;
  readonly onApprove: () => void;
  readonly onReload: () => void;
  readonly onPrepareImplementation: ((contract: ContractView) => void) | undefined;
}): ReactElement {
  if (contract === null) {
    return (
      <div className="panel">
        <h3 className="panel__title">Approval</h3>
        <p className="state-line" data-state="empty">
          Save a draft first. There is nothing to approve until this contract exists as a numbered revision.
        </p>
      </div>
    );
  }

  if (state?.kind === 'approved') {
    return (
      <div className="panel" data-testid="approved-actions">
        <h3 className="panel__title">Approved</h3>
        <p className="state-line">
          Revision {contract.revision} is approved. This exact text is now the agreement.
        </p>
        {onPrepareImplementation !== undefined ? (
          <button
            className="button"
            type="button"
            data-testid="prepare-implementation"
            onClick={() => onPrepareImplementation(contract)}
          >
            Prepare implementation
          </button>
        ) : (
          <p className="field__hint">
            The approved revision is {contract.revision}. Take it to your external environment to implement —
            ShipLoop does not run the implementation itself.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="panel">
      <h3 className="panel__title">Approval</h3>
      <p className="panel__note">
        Approving seals this exact text as the agreement for revision {contract.revision}. It records what you
        read: if the text has changed since this page loaded it, the approval is refused rather than sealing
        something you did not review.
      </p>

      {approvable ? null : (
        <p className="state-line state-line--error" role="alert" data-state="incomplete">
          This contract cannot be approved yet — the problems are listed above. Nothing has been sent and
          nothing you typed has changed.
        </p>
      )}

      {readOnly ? (
        <p className="state-line">
          This revision is no longer a draft, so there is nothing here to approve.
        </p>
      ) : (
        <div className="form__actions">
          <button
            className="button"
            type="button"
            data-testid="approve-contract"
            disabled={approving}
            onClick={onApprove}
          >
            {approving ? 'Approving…' : `Approve revision ${contract.revision}`}
          </button>
          <button className="button button--secondary" type="button" onClick={onReload}>
            Reload the current version
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * An approval that was refused.
 *
 * The three things it must do, none optional: say the contract changed since it was loaded,
 * offer to read the current version, and never imply anything was approved. It also leaves
 * the owner's text alone — reloading is a choice they make, not something that happened to
 * them (mvp-spec 7, F24-AC4).
 */
function ApprovalRefusal({ failure, onReload }: { readonly failure: Failure; readonly onReload: () => void }): ReactElement {
  if (!failure.stale) {
    return (
      <div className="panel" role="alert" data-state="failed" data-testid="approval-refusal">
        <h3 className="panel__title">Not approved</h3>
        <p className="state-line state-line--error">
          {failure.reason} <strong>Nothing was approved.</strong> What you typed is still here.
        </p>
      </div>
    );
  }
  return (
    <StaleNotice
      what="This contract"
      reason={failure.reason}
      expected={failure.expected}
      actual={failure.actual}
      onReload={onReload}
    />
  );
}

/** A save that failed, for a stale editor or any other reason. */
function SaveRefusal({ failure, onReload }: { readonly failure: Failure; readonly onReload: () => void }): ReactElement {
  if (failure.stale) {
    return (
      <StaleNotice
        what="This draft"
        reason={failure.reason}
        expected={failure.expected}
        actual={failure.actual}
        onReload={onReload}
      />
    );
  }
  return (
    <div className="panel" role="alert" data-state="failed" data-testid="save-refusal">
      <h3 className="panel__title">Not saved</h3>
      <p className="state-line state-line--error">
        {failure.reason} What you typed is still here — correct it and save again.
      </p>
    </div>
  );
}

/**
 * The stale-text state, for both a save and an approval.
 *
 * The fingerprints are shown when the server named them. They are the difference between
 * "this changed" and "this is what changed", and an owner deciding whether to re-approve
 * deserves both (mvp-spec 7, F24-AC4).
 */
function StaleNotice({
  what,
  reason,
  expected,
  actual,
  onReload,
}: {
  readonly what: string;
  readonly reason: string;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly onReload: () => void;
}): ReactElement {
  return (
    <div className="panel" role="alert" data-state="stale" data-testid="stale-notice">
      <h3 className="panel__title">{what} changed since you loaded it</h3>
      <p className="state-line state-line--error">
        {reason} <strong>Nothing was approved or saved.</strong> Read the current version before deciding again —
        approving text you did not review is what this check exists to prevent.
      </p>
      {expected !== null || actual !== null ? (
        <ul className="connector__capabilities" data-testid="stale-fingerprints">
          <li className="connector__capability">
            You reviewed: <code>{expected ?? 'unknown'}</code>
          </li>
          <li className="connector__capability">
            Stored now: <code>{actual ?? 'unknown'}</code>
          </li>
        </ul>
      ) : null}
      <p className="panel__note">
        Reloading replaces this page&rsquo;s text with what is stored now. Anything typed and not saved is
        replaced — copy it first if you want to keep it.
      </p>
      <div className="form__actions">
        <button className="button" type="button" onClick={onReload} data-testid="reload-current">
          Reload the current version
        </button>
      </div>
    </div>
  );
}