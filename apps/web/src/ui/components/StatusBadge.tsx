import type { ReactElement } from 'react';

export type StatusTone = 'healthy' | 'degraded' | 'revoked' | 'unconfigured' | 'pending' | 'neutral';

const TONE_WORDS: Readonly<Record<StatusTone, string>> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  revoked: 'Revoked',
  unconfigured: 'Unconfigured',
  pending: 'Pending',
  neutral: 'No state recorded',
};

/** Tones whose meaning the owner must not have to guess from a colour (N03-AC1). */
export function toneLabel(tone: StatusTone): string {
  return TONE_WORDS[tone];
}

export interface StatusBadgeProps {
  readonly tone: StatusTone;
  readonly label: string;
  readonly detail?: string;
}

/**
 * Renders a state as a word, a shape and a border pattern, never as a colour alone.
 *
 * A connector in `Degraded` and one in `Revoked` are decisions the owner has to make, and a
 * reader who cannot separate red from amber, or who reads the page in monochrome, must
 * still be able to tell them apart (N03-AC1). The tone drives a CSS-drawn mark and border
 * style as well as a colour, so the badge survives greyscale and colour-blindness.
 */
export function StatusBadge({ tone, label, detail }: StatusBadgeProps): ReactElement {
  return (
    <span className="badge" data-tone={tone}>
      <span className="badge__mark" aria-hidden="true" />
      <span className="badge__label">{label}</span>
      {detail === undefined ? null : <span className="badge__detail">{detail}</span>}
    </span>
  );
}
