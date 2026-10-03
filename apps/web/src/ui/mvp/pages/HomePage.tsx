/**
 * Home: the signed-in default surface, and the only place the MVP shows a portfolio.
 *
 * Three groups — **Needs you**, **In progress**, **Ready for review** — and the discipline that
 * governs this page is what may *not* go in them. External execution happens outside ShipLoop, so
 * this product observes nothing about whether an implementation is being worked on. There is
 * therefore no "agent is running" line, no percentage, no last-activity ticker, and no group that
 * would imply one exists. Every state rendered here is read from a record ShipLoop owns: a
 * contract revision and its status, a linked candidate and its commit, a recorded verification
 * completeness, a recorded owner decision.
 *
 * All three headings are always rendered, even when a group is empty. "Nothing is waiting on you"
 * is an answer, and hiding the section would make it indistinguishable from a view that had not
 * finished loading — which is the specific confusion the state lines exist to prevent.
 *
 * Settled work is counted rather than listed. A request that disappears from the board reads the
 * same as one that was never captured, so the page says how many were accepted and left out.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { formatRelativeTime, formatTimestamp } from '../../api-client.ts';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge.tsx';
import { fetchHome } from '../client.ts';
import { groupHomeItems, homeGroupReason, type HomeGroup } from '../home.ts';
import { Sha } from '../components/StateLine.tsx';
import { Panel, StateLine, type ViewState } from '../components/StateLine.tsx';
import type { ContractStatus, HomeItem } from '../wire.ts';

export interface HomePageProps {
  readonly projectId: string | null;
  readonly epoch: number;
  readonly onNewRequest: () => void;
  readonly onOpenContract: (contractId: string) => void;
  readonly onOpenReview: (candidateId: string) => void;
}

/** The state a contract revision reads as. Approval is the only one that is not editable. */
const CONTRACT_TONES: Readonly<Record<ContractStatus, StatusTone>> = {
  draft: 'pending',
  approved: 'healthy',
  stale: 'degraded',
};

function contractDetail(status: ContractStatus, revision: number): string {
  switch (status) {
    case 'draft':
      return `Revision ${String(revision)} is a draft. Nothing is agreed until you approve it.`;
    case 'approved':
      return `Revision ${String(revision)} was approved. Changing it afterwards records a new revision.`;
    case 'stale':
      return `Revision ${String(revision)} is stale: it no longer describes the work as it stands.`;
  }
}

function ItemActions({
  item,
  onOpenContract,
  onOpenReview,
}: {
  readonly item: HomeItem;
  readonly onOpenContract: (contractId: string) => void;
  readonly onOpenReview: (candidateId: string) => void;
}): ReactElement {
  return (
    <div className="form__actions">
      {item.contract === null ? null : (
        <button
          className="button button--secondary"
          type="button"
          data-testid={`open-contract-${item.requestId}`}
          onClick={() => onOpenContract(item.contract?.id ?? '')}
        >
          Open contract
        </button>
      )}
      {item.candidate === null ? null : (
        <button
          className="button"
          type="button"
          data-testid={`open-review-${item.requestId}`}
          onClick={() => onOpenReview(item.candidate?.id ?? '')}
        >
          Open review
        </button>
      )}
    </div>
  );
}

function GroupSection({
  group,
  nowMs,
  onOpenContract,
  onOpenReview,
}: {
  readonly group: HomeGroup;
  readonly nowMs: number;
  readonly onOpenContract: (contractId: string) => void;
  readonly onOpenReview: (candidateId: string) => void;
}): ReactElement {
  return (
    <section className="panel" aria-labelledby={`home-${group.id}`} data-testid={`home-group-${group.id}`}>
      <h3 className="panel__title" id={`home-${group.id}`}>
        {group.label}
      </h3>
      <p className="panel__note">{group.meaning}</p>
      <StateLine
        view={group.items.length === 0 ? 'empty' : 'ready'}
        message={
          group.items.length === 0
            ? `Nothing in ${group.label.toLowerCase()}.`
            : `${String(group.items.length)} ${group.items.length === 1 ? 'request' : 'requests'} in ${group.label.toLowerCase()}.`
        }
        testId={`home-group-state-${group.id}`}
      />
      {group.items.length === 0 ? null : (
        <ul className="profile-list">
          {group.items.map((item) => (
            <li className="profile-list__item" key={item.requestId} data-testid="home-item">
              <span className="profile-list__name">{item.title}</span>
              <span className="profile-list__detail">
                <time dateTime={item.updatedAt}>{formatRelativeTime(item.updatedAt, nowMs)}</time>
                {` (${formatTimestamp(item.updatedAt)})`}
              </span>
              <p className="connector__problem-line" data-testid="home-item-reason">
                {homeGroupReason(item)}
              </p>
              {item.contract === null ? null : (
                <StatusBadge
                  tone={CONTRACT_TONES[item.contract.status]}
                  label={`Contract revision ${String(item.contract.revision)}: ${item.contract.status}`}
                  detail={contractDetail(item.contract.status, item.contract.revision)}
                />
              )}
              {item.candidate === null ? null : (
                <div className="detail-list">
                  <div className="detail-list__row">
                    <dt>Candidate commit</dt>
                    <dd>
                      <Sha value={item.candidate.headSha} testId="home-item-sha" />
                    </dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Pull request</dt>
                    <dd data-testid="home-item-pr">
                      {item.candidate.pullRequestUrl === null
                        ? item.candidate.pullRequestNumber === null
                          ? 'No pull request has been linked for this request yet.'
                          : `#${String(item.candidate.pullRequestNumber)}, with no address to open.`
                        : item.candidate.pullRequestUrl}
                    </dd>
                  </div>
                </div>
              )}
              <p className="panel__note" data-testid="home-item-next-action">
                {`Next: ${item.nextAction}`}
              </p>
              <ItemActions item={item} onOpenContract={onOpenContract} onOpenReview={onOpenReview} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomePage({
  projectId,
  epoch,
  onNewRequest,
  onOpenContract,
  onOpenReview,
}: HomePageProps): ReactElement {
  const [items, setItems] = useState<readonly HomeItem[]>([]);
  const [boardProjectId, setBoardProjectId] = useState<string | null>(null);
  const [collectedAt, setCollectedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const nowMs = Date.now();

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void fetchHome(projectId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setItems([]);
        setBoardProjectId(null);
        setCollectedAt(null);
        setError(result.error.reason);
        setLoading(false);
        return;
      }
      setItems(result.value.home.items);
      setBoardProjectId(result.value.home.projectId);
      setCollectedAt(result.value.home.collectedAt);
      setError(null);
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [projectId, epoch, reload]);

  const grouped = groupHomeItems(items);
  const view: ViewState = error !== null ? 'error' : loading ? 'loading' : boardProjectId === null ? 'empty' : 'ready';
  const viewMessage =
    view === 'error'
      ? `Your requests could not be read: ${error ?? 'unknown reason'}`
      : view === 'loading'
        ? 'Reading your requests…'
        : view === 'empty'
          ? 'No project is selected yet, so there are no requests to show. Choose or create one in Settings.'
          : `${String(items.length)} ${items.length === 1 ? 'request is' : 'requests are'} recorded, read at ${collectedAt === null ? 'an unknown time' : formatTimestamp(collectedAt)}.`;

  return (
    <section className="page" aria-labelledby="home-title">
      <div className="page__header">
        <h2 className="page__title" id="home-title">
          Home
        </h2>
        <button className="button" type="button" data-testid="new-request-cta" onClick={onNewRequest}>
          New request
        </button>
      </div>
      <p className="panel__note">
        Everything here is read from the record. ShipLoop does not run your implementation, so nothing on
        this page reports progress being made somewhere else — it reports the requests you have, and what
        each one is waiting for.
      </p>
      <StateLine view={view} message={viewMessage} testId="home-state" />
      {view === 'error' ? (
        <div className="form__actions">
          <button className="button button--secondary" type="button" data-testid="home-retry" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}
      {grouped.settledCount > 0 ? (
        <StateLine
          view="ready"
          message={`${String(grouped.settledCount)} ${grouped.settledCount === 1 ? 'request has' : 'requests have'} been accepted and ${grouped.settledCount === 1 ? 'is' : 'are'} no longer listed, because accepted work is not waiting on anything.`}
          testId="home-settled"
        />
      ) : null}

      {view === 'error' || view === 'loading' ? null : (
        <>
          {grouped.groups.map((group) => (
            <GroupSection
              key={group.id}
              group={group}
              nowMs={nowMs}
              onOpenContract={onOpenContract}
              onOpenReview={onOpenReview}
            />
          ))}
          <Panel
            id="home-no-runner"
            title="What ShipLoop will not do"
            note="No agent, no queue, no automatic pull request. Implementation happens in a coding environment you choose, and ShipLoop's job is to hold the contract, identify the exact commit, and check that commit against the criteria you wrote."
          />
        </>
      )}
    </section>
  );
}