import { createHash } from 'node:crypto';
import { asFingerprint, type Fingerprint } from './ids.ts';

/**
 * Canonical serialisation used for semantic fingerprints.
 *
 * Object keys are sorted, `undefined` members are dropped, and arrays keep their
 * order, so two structurally equal inputs always produce the same string. This is
 * what lets a scope revision be compared across processes and restarts without
 * persisting a second copy of the content.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('Non-finite number is not canonicalizable');
    return JSON.stringify(value);
  }
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'undefined') return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalize(member)}`).join(',')}}`;
  }
  throw new Error(`Unsupported value in canonical form: ${type}`);
}

/** Stable 128-bit fingerprint of any canonicalizable input. */
export function fingerprint(value: unknown): Fingerprint {
  return asFingerprint(`fp_${createHash('sha256').update(canonicalize(value)).digest('hex').slice(0, 32)}`);
}
