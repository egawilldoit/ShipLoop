import { useEffect, useState, type ReactElement } from 'react';
import { formatRelativeTime, formatTimestamp } from '../api-client.ts';
import type { MvpConnectionState } from '../mvp-client/index.ts';

export interface ConnectionBannerProps {
  readonly connection: MvpConnectionState;
  readonly onRetry: () => void;
}

const RELATIVE_TICK_MS = 5000;

/**
 * States plainly whether the view is current, and says when it last was (N04-AC2).
 *
 * A client that has silently stopped hearing from the server looks identical to a client
 * whose work is progressing, so the banner appears on any failed request as well as on an
 * unreachable server, and states the last successful update as both a relative and an
 * absolute time. The relative figure alone drifts out of date while the owner reads it, so
 * the absolute figure is what makes the claim checkable.
 *
 * Status is a word, not a colour, and the region is a live region so a disconnect is
 * announced rather than only displayed (N03-AC1).
 */
export function ConnectionBanner({ connection, onRetry }: ConnectionBannerProps): ReactElement {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), RELATIVE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const updated = connection.lastSuccessAt;
  const lastUpdate =
    updated === null ? (
      'No successful update has been received yet.'
    ) : (
      <>
        {'Last updated '}
        <time dateTime={updated}>{formatRelativeTime(updated, nowMs)}</time>
        {` (${formatTimestamp(updated)}).`}
      </>
    );

  return (
    <section
      className={connection.connected ? 'banner banner--ok' : 'banner banner--warn'}
      role="status"
      aria-live="polite"
      data-connected={connection.connected ? 'true' : 'false'}
    >
      <p className="banner__text">
        <strong className="banner__state">{connection.connected ? 'Connected' : 'Disconnected'}</strong>
        {connection.connected ? '. ' : `. ${connection.lastFailureReason ?? 'A request failed.'} `}
        {lastUpdate}
      </p>
      <button className="button button--secondary" type="button" onClick={onRetry}>
        Retry now
      </button>
    </section>
  );
}
