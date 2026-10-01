/**
 * The attention dashboard (F31-AC1, F31-AC2, F31-AC3, F31-AC4, F31-AC5, N03-AC1, N03-AC3,
 * F01-AC3, N04-AC2).
 *
 * Four buckets, derived from durable state on every read: Working, Needs your input, Ready
 * for your test, and Ready for release. The page renders all four headings whatever the
 * server sent, because a bucket with nothing in it is information — "nothing is waiting on
 * you" is an answer, and hiding the section would leave the owner unable to tell it from a
 * view that had not loaded (F31-AC1).
 *
 * Three properties are the reason the page is shaped this way:
 *
 *   - **Every item carries its blocker and one next action (F31-AC2).** An item that says only
 *     "something needs you" makes the owner go and find out what; an item that names the
 *     blocker and the action is the dashboard's whole purpose.
 *   - **Acknowledging records attention and nothing else (F31-AC4).** The control is offered
 *     only for identities the server reported as having a durable row, because a derived
 *     run-progress item has a stable identity but nothing to record against, and a
 *     successful acknowledgement of nothing is indistinguishable from a recorded one
 *     (F31-AC3). The board is re-read afterwards, so what the page shows is the store's
 *     answer rather than an optimistic local edit.
 *   - **Age is shown as text (F31-AC1, N03-AC1).** Each item states when it was first seen
 *     and whether it has been acknowledged, so nothing depends on reading a colour.
 *   - **No control label carries a job identity (F01-AC3).** The acknowledge button is named
 *     "Acknowledge this item" rather than quoting the title, because a title embeds a 36-character
 *     job id that a button box cannot wrap: at 375px it pushed the page 49 pixels sideways. The
 *     item it belongs to is the list item the button sits in, and the item's own heading names it.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  acknowledgeAttentionItem,
  fetchAttentionBoard,
  formatRelativeTime,
  formatTimestamp,
  type ApiFailure,
  type AttentionBoard,
  type AttentionBucket,
  type AttentionItem,
} from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

export interface DashboardPageProps {
  readonly epoch: number;
}

type ViewState = 'loading' | 'empty' | 'ready' | 'error';

/**
 * The four buckets, in the order the product states them, with the question each answers
 * (F31-AC1).
 *
 * The server reports only the occupied ones, so this list is what makes an absent bucket
 * visible rather than missing.
 */
const BUCKETS: readonly { readonly id: AttentionBucket; readonly label: string; readonly meaning: string }[] = [
  {
    id: 'Working',
    label: 'Working',
    meaning: 'Runs in flight. Nothing is asked of you until one of them stops needing you.',
  },
  {
    id: 'NeedsYourInput',
    label: 'Needs your input',
    meaning: 'Blocked, waiting for a decision, or holding an unanswered question.',
  },
  {
    id: 'ReadyForYourTest',
    label: 'Ready for your test',
    meaning: 'A candidate exists and is waiting for you to try it.',
  },
  {
    id: 'ReadyForRelease',
    label: 'Ready for release',
    meaning: 'Accepted and past its checks. Delivery is still your separate decision.',
  },
];

const STATE_TONES: Readonly<Record<string, StatusTone>> = {
  Open: 'degraded',
  Acknowledged: 'pending',
  Resolved: 'healthy',
};

const STATE_MEANING: Readonly<Record<string, string>> = {
  Open: 'Not looked at yet. Nothing about the work has changed because it is here.',
  Acknowledged: 'You have seen this. The work behind it is unchanged.',
  Resolved: 'The condition that raised this is gone from the record.',
};

function stateTone(state: string): StatusTone {
  return STATE_TONES[state] ?? 'neutral';
}

function stateMeaning(state: string): string {
  return STATE_MEANING[state] ?? 'No state is recorded for this item.';
}

function orNone(value: string | null): string {
  return value === null || value === '' ? 'None recorded.' : value;
}

export function DashboardPage({ epoch }: DashboardPageProps): ReactElement {
  const [board, setBoard] = useState<AttentionBoard | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageState, setMessageState] = useState<'idle' | 'done' | 'refused'>('idle');

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    void fetchAttentionBoard().then((result) => {
      if (!current) return;
      if (!result.ok) {
        setBoard(null);
        setBoardError(result.error.reason);
        return;
      }
      setBoard(result.value.board);
      setBoardError(null);
    });
    return () => {
      current = false;
    };
  }, [epoch, reload]);

  const acknowledge = async (item: AttentionItem): Promise<void> => {
    if (busyItemId !== null) return;
    setBusyItemId(item.attentionItemId);
    setMessage(null);
    const result = await acknowledgeAttentionItem(item.attentionItemId);
    setBusyItemId(null);
    if (!result.ok) {
      const failure: ApiFailure = result.error;
      setMessage(`Acknowledging "${item.title}" was not recorded: ${failure.reason}`);
      setMessageState('refused');
      return;
    }
    setMessage(
      `Acknowledged "${result.value.item.title}". Only your attention was recorded: no run, acceptance or release fact changed (F31-AC4).`,
    );
    setMessageState('done');
    refresh();
  };

  const nowMs = Date.now();
  const items = board?.items ?? [];
  const view: ViewState =
    boardError !== null
      ? 'error'
      : board === null
        ? 'loading'
        : board.projectId === null
          ? 'empty'
          : 'ready';

  const viewText =
    view === 'error'
      ? `The board could not be collected: ${boardError ?? 'unknown reason'}`
      : view === 'loading'
        ? 'Collecting what needs you…'
        : view === 'empty'
          ? 'No work has been recorded yet, so there is nothing to show. Start a run or publish work and this board will fill in.'
          : `${items.length} ${items.length === 1 ? 'item is' : 'items are'} on the board for project ${board?.projectId ?? ''}, collected ${formatTimestamp(board?.collectedAt ?? '')}.`;

  return (
    <section className="page" aria-labelledby="dashboard-title">
      <h2 className="page__title" id="dashboard-title">
        Needs you
      </h2>
      <p className="panel__note">
        Everything here is derived from the record on each read. Nothing on this board is a task you can edit, and
        acknowledging an item changes nothing except that you have seen it.
      </p>
      <p
        className={view === 'error' ? 'state-line state-line--error' : 'state-line'}
        role={view === 'error' ? 'alert' : 'status'}
        aria-live={view === 'error' ? 'assertive' : 'polite'}
        data-state={view}
      >
        {viewText}
      </p>
      <p
        className={messageState === 'refused' ? 'state-line state-line--error' : 'state-line'}
        role={messageState === 'refused' ? 'alert' : 'status'}
        aria-live={messageState === 'refused' ? 'assertive' : 'polite'}
        data-state={messageState}
      >
        {message ?? 'Nothing has been acknowledged from this board.'}
      </p>

      {BUCKETS.map((bucket) => {
        const group = board?.groups.find((entry) => entry.bucket === bucket.id);
        const bucketItems = group?.items ?? [];
        return (
          <section className="panel" key={bucket.id} aria-labelledby={`bucket-${bucket.id}`}>
            <h3 className="panel__title" id={`bucket-${bucket.id}`}>
              {bucket.label}
            </h3>
            <p className="panel__note">{bucket.meaning}</p>
            <p className="state-line" role="status" data-state={bucketItems.length === 0 ? 'empty' : 'ready'}>
              {bucketItems.length === 0
                ? `Nothing in ${bucket.label.toLowerCase()}.`
                : `${bucketItems.length} ${bucketItems.length === 1 ? 'item' : 'items'} in ${bucket.label.toLowerCase()}.`}
            </p>
            {bucketItems.length === 0 ? null : (
              <ul className="profile-list">
                {bucketItems.map((item) => {
                  const acknowledgeable = (board?.persistedItemIds ?? []).includes(item.attentionItemId);
                  return (
                    <li className="profile-list__item" key={item.attentionItemId}>
                      <span className="profile-list__name">{item.title}</span>
                      <span className="profile-list__detail">
                        {item.kind}, first seen{' '}
                        <time dateTime={item.createdAt}>{formatRelativeTime(item.createdAt, nowMs)}</time>
                        {` (${formatTimestamp(item.createdAt)})`}
                        {item.issueIdentifier === null ? '' : ` for ${item.issueIdentifier}`}
                      </span>
                      <StatusBadge tone={stateTone(item.state)} label={`Item state: ${item.state}`} detail={stateMeaning(item.state)} />
                      <div className="detail-list">
                        <div className="detail-list__row">
                          <dt>Blocker</dt>
                          <dd>{orNone(item.blocker)}</dd>
                        </div>
                        <div className="detail-list__row">
                          <dt>Next action</dt>
                          <dd>{item.nextAction}</dd>
                        </div>
                        <div className="detail-list__row">
                          <dt>Acknowledged</dt>
                          <dd>
                            {item.acknowledgedAt === null
                              ? 'Not acknowledged.'
                              : `By ${item.acknowledgedBy ?? 'an owner'} at ${formatTimestamp(item.acknowledgedAt)}.`}
                          </dd>
                        </div>
                      </div>
                      <div className="form__actions">
                        {acknowledgeable ? (
                          <button
                            className="button button--secondary"
                            type="button"
                            disabled={busyItemId !== null}
                            onClick={() => void acknowledge(item)}
                          >
                            {busyItemId === item.attentionItemId ? 'Acknowledging…' : 'Acknowledge this item'}
                          </button>
                        ) : (
                          <p className="state-line" role="status" data-state="empty">
                            This item is derived from the run record, so there is nothing to acknowledge: no owner
                            attention is stored against it (F31-AC3).
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}
