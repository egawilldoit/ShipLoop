/**
 * The Delivery Contract: one page holding every part of the versioned agreement, and the three
 * actions that move it.
 *
 * Outcome, Scope, Out of scope, Acceptance criteria, Verification method, Revision and State are
 * on one page because they are one thing. Splitting them across screens would make the owner
 * assemble an agreement out of fragments, and an agreement assembled from fragments is not an
 * agreement anyone can be held to.
 *
 * Two properties carry the product here:
 *
 *   - **An approved contract never silently mutates.** Saving changed text against a revision that
 *     was approved records a *new* revision, and the page says so before the save, naming the
 *     reason. The approval stands against the text it was given for; it does not follow the text.
 *   - **Approval is the owner's, and only the owner's.** The control is rendered from the server's
 *     state and every refusal is written out. Nothing on this page infers that a contract is
 *     approved, and no draft, no suggestion and no later step sets that state.
 *
 * Verification method is not a seventh field. It is part of each acceptance criterion, because a
 * requirement and the way it will be judged are the same sentence about the same thing, and a
 * criterion whose method lives somewhere else is a criterion that can be judged without one.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { formatTimestamp } from '../../api-client.ts';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge.tsx';
import { approveContract, fetchContract, saveContract } from '../client.ts';
import {
  approvalRefusals,
  draftFromContract,
  draftProblemsByPath,
  isDraftDirty,
  ownerTestCount,
  saveIntent,
  saveBody,
  validateContractDraft,
  type ContractDraft,
} from '../contract.ts';
import { CriteriaEditor, OutOfScopeEditor } from '../components/ContractEditors.tsx';
import { Panel, StateLine, type ViewState } from '../components/StateLine.tsx';
import type { ContractStatus, DeliveryContract, RequestRecord } from '../wire.ts';

export interface ContractPageProps {
  readonly contractId: string;
  readonly epoch: number;
  readonly onPrepareImplementation: (contractId: string) => void;
}

const CONTRACT_TONES: Readonly<Record<ContractStatus, StatusTone>> = {
  draft: 'pending',
  approved: 'healthy',
  stale: 'degraded',
};

const CONTRACT_MEANING: Readonly<Record<ContractStatus, string>> = {
  draft: 'Nothing is agreed yet. Only you can approve it.',
  approved: 'You approved this revision. Changing it afterwards records a new revision.',
  stale: 'This revision no longer describes the work as it stands. Edit it and approve it again.',
};

function FieldErrors({ errors, testId }: { readonly errors: Readonly<Record<string, string>>; readonly testId: string }): ReactElement | null {
  const entries = Object.entries(errors);
  if (entries.length === 0) return null;
  return (
    <ul className="connector-list" data-testid={testId}>
      {entries.map(([path, message]) => (
        <li className="connector__problem" key={path}>
          {message}
        </li>
      ))}
    </ul>
  );
}

export function ContractPage({ contractId, epoch, onPrepareImplementation }: ContractPageProps): ReactElement {
  const [contract, setContract] = useState<DeliveryContract | null>(null);
  const [request, setRequest] = useState<RequestRecord | null>(null);
  const [saved, setSaved] = useState<ContractDraft | null>(null);
  const [draft, setDraft] = useState<ContractDraft | null>(null);
  const [serverProblems, setServerProblems] = useState<Readonly<Record<string, string>>>({});
  const [view, setView] = useState<ViewState>('loading');
  const [viewMessage, setViewMessage] = useState('Reading the contract…');
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    setView('loading');
    void fetchContract(contractId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setContract(null);
        setRequest(null);
        setDraft(null);
        setSaved(null);
        setViewMessage(`The contract could not be read: ${result.error.reason}`);
        setView(result.error.code === 'NotFound' ? 'empty' : 'error');
        return;
      }
      const next = draftFromContract(result.value.contract);
      setContract(result.value.contract);
      setRequest(result.value.request);
      setDraft(next);
      setSaved(next);
      setServerProblems({});
      setView('ready');
      setViewMessage(
        `Revision ${String(result.value.contract.revision)} of the Delivery Contract for "${result.value.request.title}".`,
      );
    });
    return () => {
      current = false;
    };
  }, [contractId, epoch, reload]);

  const problems = useMemo(() => (draft === null ? [] : validateContractDraft(draft)), [draft]);
  const errors = useMemo<Readonly<Record<string, string>>>(
    () => ({ ...draftProblemsByPath(problems), ...serverProblems }),
    [problems, serverProblems],
  );
  const dirty = draft !== null && saved !== null && isDraftDirty(draft, saved);
  const intent = contract !== null && draft !== null && saved !== null ? saveIntent(draft, saved, contract.status) : null;
  const refusals = draft !== null && contract !== null ? approvalRefusals(draft, contract.status, problems) : [];
  /**
   * Whether the agreement is being shown rather than written.
   *
   * An approved revision is read-only until the owner says they are changing it. That toggle is
   * explicit rather than automatic because "the contract stops being editable the moment it is
   * approved" is a rule with no visible cause, and a form whose inputs silently go dead looks
   * broken. Enabling it makes dirty true, and a dirty approved revision is exactly the case
   * `saveIntent` turns into a new revision.
   */
  const readOnly = contract !== null && contract.status === 'approved' && !editing;
  const busy = saving || approving;

  const patch = (changes: Partial<ContractDraft>): void => {
    setDraft((current) => (current === null ? current : { ...current, ...changes }));
  };

  const submitSave = async (): Promise<void> => {
    if (draft === null || busy) return;
    const problemsNow = validateContractDraft(draft);
    if (problemsNow.length > 0) {
      setServerProblems({});
      setActionFailure(
        'This draft is not complete yet, so it was not saved. Each reason below is beside the field it belongs to.',
      );
      return;
    }
    setSaving(true);
    setActionMessage(null);
    setActionFailure(null);
    const result = await saveContract(contractId, saveBody(draft));
    setSaving(false);
    if (!result.ok) {
      setServerProblems(draftProblemsByPath(result.error.fields.map((field) => ({ path: field.path, message: field.message }))));
      setActionFailure(`The draft was not saved: ${result.error.reason}`);
      return;
    }
    const next = draftFromContract(result.value.contract);
    setContract(result.value.contract);
    setDraft(next);
    setSaved(next);
    setEditing(false);
    setActionMessage(
      `Saved as revision ${String(result.value.contract.revision)}. ${
        result.value.contract.status === 'approved'
          ? 'It is still approved, because nothing about the approved text changed.'
          : 'It is still a draft and is not agreed until you approve it.'
      }`,
    );
  };

  const submitApprove = async (): Promise<void> => {
    if (contract === null || busy) return;
    if (dirty) {
      setActionFailure(
        'There are unsaved changes. Save them first: approving text the server has not recorded would approve something that is not the contract.',
      );
      return;
    }
    if (refusals.length > 0) {
      setActionFailure(`This contract cannot be approved yet: ${refusals[0] ?? ''}`);
      return;
    }
    setApproving(true);
    setActionMessage(null);
    setActionFailure(null);
    const result = await approveContract(contractId);
    setApproving(false);
    if (!result.ok) {
      setActionFailure(`This contract was not approved: ${result.error.reason}`);
      return;
    }
    setContract(result.value.contract);
    const next = draftFromContract(result.value.contract);
    setDraft(next);
    setSaved(next);
    setEditing(false);
    setActionMessage(
      `Approved as revision ${String(result.value.contract.revision)} at ${formatTimestamp(result.value.contract.approvedAt ?? '')}. This is your agreement, not a suggestion, and it will not change underneath you.`,
    );
  };

  const ownerTests = draft === null ? 0 : ownerTestCount(draft);

  return (
    <section className="page" aria-labelledby="contract-title">
      <h2 className="page__title" id="contract-title">
        Delivery contract
      </h2>
      <p className="panel__note">
        The versioned agreement describing what successful implementation means. Approving it is your
        decision and nothing else approves it.
      </p>

      <StateLine
        view={view}
        message={
          view === 'error'
            ? viewMessage
            : view === 'empty'
              ? 'No contract was found at this address. It may have been recorded against another request.'
              : view === 'loading'
                ? viewMessage
                : `${viewMessage}${ownerTests > 0 ? ` ${String(ownerTests)} ${ownerTests === 1 ? 'criterion waits' : 'criteria wait'} on your own test, which ShipLoop never decides for you.` : ''}`
        }
        testId="contract-state"
      />

      {contract === null || draft === null || request === null ? (
        <div className="form__actions">
          <button className="button button--secondary" type="button" data-testid="contract-retry" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <Panel id="contract-identity" title="This agreement">
            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Request</dt>
                <dd data-testid="contract-request-title">{request.title}</dd>
              </div>
              <div className="detail-list__row">
                <dt>What was asked for</dt>
                <dd data-testid="contract-request-description">{request.description}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Revision</dt>
                <dd data-testid="contract-revision">{String(contract.revision)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>State</dt>
                <dd data-testid="contract-status">
                  <StatusBadge
                    tone={CONTRACT_TONES[contract.status]}
                    label={`Contract: ${contract.status}`}
                    detail={CONTRACT_MEANING[contract.status]}
                  />
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Approved</dt>
                <dd data-testid="contract-approved-at">
                  {contract.approvedAt === null ? 'Not approved yet.' : formatTimestamp(contract.approvedAt)}
                </dd>
              </div>
            </dl>
          </Panel>

          <form
            className="form form--grid"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSave();
            }}
            noValidate
          >
            <div className="field">
              <label className="field__label" htmlFor="contract-outcome">
                Outcome
              </label>
              <textarea
                className="field__input field__input--area"
                id="contract-outcome"
                value={draft.outcome}
                disabled={readOnly || busy}
                aria-required="true"
                aria-invalid={errors['outcome'] === undefined ? undefined : 'true'}
                onChange={(event) => patch({ outcome: event.target.value })}
              />
              <p className="field__hint">
                One sentence that is true when this work is done. If it cannot be true or false, it is not an
                outcome yet.
              </p>
              {errors['outcome'] === undefined ? null : (
                <p className="field__error" data-testid="contract-outcome-error">
                  <span className="field__error-mark" aria-hidden="true" />
                  Error: {errors['outcome']}
                </p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="contract-scope">
                Scope
              </label>
              <textarea
                className="field__input field__input--area"
                id="contract-scope"
                value={draft.scope}
                disabled={readOnly || busy}
                aria-required="true"
                aria-invalid={errors['scope'] === undefined ? undefined : 'true'}
                onChange={(event) => patch({ scope: event.target.value })}
              />
              <p className="field__hint">
                What this change touches. Scope is what makes a request reviewable: it is the edge an
                implementer works to.
              </p>
              {errors['scope'] === undefined ? null : (
                <p className="field__error" data-testid="contract-scope-error">
                  <span className="field__error-mark" aria-hidden="true" />
                  Error: {errors['scope']}
                </p>
              )}
            </div>

            <OutOfScopeEditor
              rows={draft.outOfScope}
              errors={errors}
              disabled={readOnly || busy}
              onChange={(rows) => patch({ outOfScope: rows })}
            />

            <CriteriaEditor
              criteria={draft.acceptanceCriteria}
              errors={errors}
              disabled={readOnly || busy}
              onChange={(criteria) => patch({ acceptanceCriteria: criteria })}
            />

            <FieldErrors errors={errors} testId="contract-problems" />

            <p
              className="state-line"
              role="status"
              data-state={dirty ? 'stale' : 'ready'}
              data-testid="contract-dirty"
            >
              {intent === null
                ? 'Reading the contract…'
                : `${dirty ? 'Unsaved changes.' : 'No unsaved changes.'} ${intent.explanation}`}
            </p>

            {actionFailure === null ? null : (
              <p className="state-line state-line--error" role="alert" data-state="error" data-testid="contract-failure">
                {actionFailure}
              </p>
            )}
            {actionMessage === null ? null : (
              <p className="state-line" role="status" data-state="ready" data-testid="contract-message">
                {actionMessage}
              </p>
            )}

            <div className="form__actions">
              <button
                className="button"
                type="submit"
                disabled={readOnly || busy || !dirty}
                data-testid="save-contract"
              >
                {saving ? 'Saving…' : intent?.createsNewRevision === true ? 'Save as a new revision' : 'Save draft'}
              </button>
              <button
                className="button"
                type="button"
                disabled={busy || contract.status === 'approved'}
                data-testid="approve-contract"
                onClick={() => void submitApprove()}
              >
                {approving ? 'Approving…' : 'Approve contract'}
              </button>
              {contract.status === 'approved' ? (
                <>
                  <button
                    className="button"
                    type="button"
                    data-testid="prepare-implementation"
                    onClick={() => onPrepareImplementation(contract.id)}
                  >
                    Prepare implementation
                  </button>
                  {editing ? null : (
                    <button
                      className="button button--secondary"
                      type="button"
                      data-testid="revise-contract"
                      onClick={() => setEditing(true)}
                    >
                      Change this contract
                    </button>
                  )}
                </>
              ) : null}
            </div>

            {refusals.length === 0 ? null : (
              <ul className="connector-list" data-testid="contract-approval-refusals">
                {refusals.map((reason) => (
                  <li className="connector__problem" key={reason}>
                    {reason}
                  </li>
                ))}
              </ul>
            )}
          </form>
        </>
      )}
    </section>
  );
}