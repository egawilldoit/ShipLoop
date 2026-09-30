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
 * The decision is whether the credential noun is the key's TRAILING word, not
 * whether the key merely contains one. `tokenCount`, `cookiePolicy` and
 * `credentialStatus` are real data an export carrying a full evidence index must
 * keep (F32-AC2), while `apiToken`, `secretValue` and `credentials` must not
 * survive. `credential` therefore cannot be an always-match word, because
 * `credentialStatus` is a legitimate state field.
 *
 * The trailing rule tolerates every spelling a field name is written in, so
 * `apiKey`, `api_key` and `api-key` are all stripped, as are `apiToken`,
 * `accessToken` and `apiTokens`. It errs towards stripping: a field whose name
 * happens to end in a credential noun is dropped, which costs an export a
 * column, whereas a missed spelling leaks the credential itself.
 *
 * This is a structural backstop, not the primary control: `redact` on the values
 * is what removes an actual credential, and it recognises value shapes this key
 * rule cannot. The known residual gap is a credential noun that is neither
 * trailing nor one of the always-match words, such as `tokenValue` or
 * `credentialsSnapshot`, which are kept. Closing it would need a blocklist of
 * descriptive suffixes (count, policy, status, index) that rots as fields are
 * added, so the gap is recorded here rather than papered over.
 */
const SECRET_KEY_ALWAYS = /(?:secret|password|passphrase|private[-_]?key)/i;
const SECRET_KEY_TRAILING =
  /(?:^|[-_.]|[a-z0-9])(?:api)?[-_]?(?:keys?|tokens?|authorization|cookies?|credentials?)$/i;

export function stripSecretFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => stripSecretFields(entry)) as unknown as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_ALWAYS.test(key) || SECRET_KEY_TRAILING.test(key)) continue;
      output[key] = stripSecretFields(member);
    }
    return output as unknown as T;
  }
  return value;
}
