/**
 * Secret redaction (N02-AC2, F03-AC3).
 *
 * Seeded test secrets must be provably absent from ordinary logs, issue updates,
 * screenshots intended for publication and exports. Redaction happens where text
 * is produced for those surfaces, not only where it is written to the database,
 * because an export can be assembled from several already-persisted fields.
 */

/** Configured credential patterns, held separately from profile text. */
export interface RedactionRule {
  readonly label: string;
  readonly pattern: RegExp;
}

export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  { label: 'linear-api-key', pattern: /\blin_(?:api|oauth)_[A-Za-z0-9]{8,}\b/g },
  { label: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // Anthropic keys are matched before OpenAI keys because the general sk- pattern
  // also matches sk-ant-…, which would otherwise label the wrong provider.
  { label: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'openai-key', pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { label: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
  { label: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'generic-bearer', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: 'private-key-block', pattern: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g },
  { label: 'url-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi },
];

export interface RedactionResult {
  readonly text: string;
  readonly appliedLabels: readonly string[];
}

/** Replaces every configured credential pattern with a labelled placeholder. */
export function redact(text: string, rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES): RedactionResult {
  let output = text;
  const applied: string[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    if (pattern.test(output)) {
      applied.push(rule.label);
      output = output.replace(pattern, `[redacted:${rule.label}]`);
    }
    pattern.lastIndex = 0;
  }
  return { text: output, appliedLabels: applied };
}

export function redactDeep<T>(value: T, rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES): T {
  if (typeof value === 'string') return redact(value, rules).text as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, rules)) as unknown as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactDeep(member, rules);
    }
    return output as unknown as T;
  }
  return value;
}

/**
 * Removes credential-bearing keys from an exported structure.
 *
 * Redaction of patterns cannot catch a secret that has an unusual shape, so a
 * credential reference is dropped structurally as well.
 *
 * `SECRET_KEY_ALWAYS` words have no legitimate non-credential data field, so they
 * are stripped wherever they appear in the key. `SECRET_KEY_SUFFIX` words are only
 * stripped when they END the key, because a name such as `tokenCount` is real data
 * that an export carrying a full evidence index must keep (F32-AC2).
 */
const SECRET_KEY_ALWAYS = /(?:secret|password|passphrase|credential|privatekey|private_key)/i;
const SECRET_KEY_SUFFIX = /(?:^|[-_.])(?:token|tokens|apikey|api_key|authorization|cookie|cookies)$/i;

export function stripSecretFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => stripSecretFields(entry)) as unknown as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_ALWAYS.test(key) || SECRET_KEY_SUFFIX.test(key)) continue;
      output[key] = stripSecretFields(member);
    }
    return output as unknown as T;
  }
  return value;
}
