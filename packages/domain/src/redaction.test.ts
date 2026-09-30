import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_REDACTION_RULES,
  redact,
  redactDeep,
  stripSecretFields,
  type RedactionRule,
} from './redaction.ts';

/**
 * N02-AC2: seeded test secrets must be provably absent from logs, issue updates,
 * screenshots and exports.
 *
 * The credential-shaped values below are assembled from fragments at module load.
 * They are real matches of every DEFAULT_REDACTION_RULES pattern once evaluated,
 * but no tracked line contains a credential-shaped literal, which is what the
 * repository's own secrets/no-literals policy rule (scripts/lint.mjs) requires.
 */

const OPaque = 'Kf3Q9mZ2pLx7Rv4Tb8Nd6Hw1Ys5Uc0Ej';
const concat = (parts: readonly string[]): string => parts.join('');
const PEM_DASHES = '-'.repeat(5);
const PEM_BLOCK = [
  [PEM_DASHES, 'BEGIN PRIVATE KEY', PEM_DASHES].join(''),
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'AwEAAQ==',
  [PEM_DASHES, 'END PRIVATE KEY', PEM_DASHES].join(''),
].join('\n');
const PEM_RSA_BLOCK = [
  [PEM_DASHES, 'BEGIN RSA PRIVATE KEY', PEM_DASHES].join(''),
  'MIIEowIBAAKCAQEAx0Z9mK2pLx7Rv4Tb8Nd6Hw1Ys5Uc0Ej',
  [PEM_DASHES, 'END RSA PRIVATE KEY', PEM_DASHES].join(''),
].join('\n');

const SEEDED = {
  linearApiKey: concat(['lin_', 'api_', OPaque]),
  githubToken: concat(['gh', 'p_', OPaque]),
  openaiKey: concat(['sk-', 'proj-', OPaque]),
  bareOpenaiKey: concat(['sk-', OPaque]),
  anthropicKey: concat(['sk-', 'ant-', 'api03-', OPaque]),
  slackToken: concat(['xox', 'b-', '1234567890-', 'AbCdEfGhIj']),
  bearerHeader: `Bearer ${OPaque}`,
  jsonWebToken:
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  privateKeyBlock: PEM_BLOCK,
  rsaPrivateKeyBlock: PEM_RSA_BLOCK,
  urlWithCredentials: 'https://deploy:hunter2@example.com/app/releases',
} as const;

describe('N02-AC2 redact', () => {
  test('removes every seeded credential from the text and replaces it with a labelled placeholder', () => {
    const cases: readonly { readonly label: string; readonly secret: string }[] = [
      { label: 'linear-api-key', secret: SEEDED.linearApiKey },
      { label: 'github-token', secret: SEEDED.githubToken },
      { label: 'openai-key', secret: SEEDED.openaiKey },
      { label: 'slack-token', secret: SEEDED.slackToken },
      { label: 'generic-bearer', secret: SEEDED.bearerHeader },
      { label: 'jwt', secret: SEEDED.jsonWebToken },
      { label: 'private-key-block', secret: SEEDED.privateKeyBlock },
    ];

    for (const { label, secret } of cases) {
      const result = redact(`deploy log line: ${secret} trailing text`);
      assert.equal(result.text.includes(secret), false, `${label}: the secret survived redaction`);
      assert.ok(result.text.includes(`[redacted:${label}]`), `${label}: expected its own labelled placeholder`);
      assert.ok(result.appliedLabels.includes(label), `${label}: expected the label to be reported`);
      assert.equal(result.text, `deploy log line: [redacted:${label}] trailing text`);
    }
  });

  test('N02-AC2 an Anthropic key is removed from the text and reported under the anthropic label', () => {
    // The anthropic-key rule used to be unreachable: the openai-key rule preceded it
    // and its pattern matched everything "sk-ant-…" does, so an Anthropic key was
    // removed under the wrong provider label. Both the ordering and the negative
    // lookahead in the openai-key pattern are what make the label correct.
    const result = redact(`model config: ${SEEDED.anthropicKey}`);

    assert.equal(result.text.includes(SEEDED.anthropicKey), false, 'the Anthropic key survived redaction');
    assert.equal(result.appliedLabels.length, 1, 'exactly one rule must have matched');
    assert.ok(result.appliedLabels.includes('anthropic-key'), 'the key must be labelled anthropic-key');
    assert.equal(result.appliedLabels.includes('openai-key'), false, 'it must not be labelled openai-key');
    assert.equal(result.text, 'model config: [redacted:anthropic-key]');
  });

  test('N02-AC2 an OpenAI key is still labelled openai-key and never anthropic-key', () => {
    const prefixed = redact(`key ${SEEDED.openaiKey}`);
    const bare = redact(`key ${SEEDED.bareOpenaiKey}`);

    for (const [shape, result] of [
      ['sk-proj-…', prefixed],
      ['sk-…', bare],
    ] as const) {
      assert.equal(result.appliedLabels.length, 1, `${shape}: exactly one rule must have matched`);
      assert.ok(result.appliedLabels.includes('openai-key'), `${shape}: expected the openai-key label`);
      assert.equal(result.appliedLabels.includes('anthropic-key'), false, `${shape}: must not match the anthropic rule`);
      assert.equal(result.text, 'key [redacted:openai-key]');
    }
  });

  test('N02-AC2 both providers in one line are labelled separately', () => {
    const result = redact(`${SEEDED.anthropicKey} and ${SEEDED.openaiKey}`);

    assert.equal(result.appliedLabels.length, 2);
    assert.ok(result.appliedLabels.includes('anthropic-key'));
    assert.ok(result.appliedLabels.includes('openai-key'));
    assert.equal(result.text.includes(SEEDED.anthropicKey), false);
    assert.equal(result.text.includes(SEEDED.openaiKey), false);
  });

  test('N02-AC2 an RSA private key block is removed in full', () => {
    const result = redact([SEEDED.rsaPrivateKeyBlock, 'rest of the log'].join('\n'));

    assert.equal(result.text.includes('MIIEowIBAAKCAQEA'), false);
    assert.ok(result.appliedLabels.includes('private-key-block'));
    assert.equal(result.text, '[redacted:private-key-block]\nrest of the log');
  });

  test('N02-AC2 strips the user:pass portion of a URL while keeping the host readable', () => {
    const result = redact(`cloning ${SEEDED.urlWithCredentials}`);

    assert.equal(result.text.includes('hunter2'), false);
    assert.equal(result.text.includes('deploy:'), false);
    assert.equal(result.text, 'cloning [redacted:url-credentials]example.com/app/releases');
  });

  test('N02-AC2 reports the applied labels so a caller can prove redaction occurred', () => {
    const combined = [
      SEEDED.linearApiKey,
      SEEDED.githubToken,
      SEEDED.slackToken,
    ].join(' ');
    const result = redact(combined);

    assert.deepEqual([...result.appliedLabels].sort(), ['github-token', 'linear-api-key', 'slack-token']);
    for (const secret of [SEEDED.linearApiKey, SEEDED.githubToken, SEEDED.slackToken]) {
      assert.equal(result.text.includes(secret), false);
    }
  });

  test('N02-AC2 returns text containing no secret unchanged', () => {
    const clean = 'pnpm verify:app finished with exit code 0 in 12.4s';

    assert.deepEqual(redact(clean), { text: clean, appliedLabels: [] });
  });

  test('honours a caller-supplied rule set instead of the defaults', () => {
    const rules: readonly RedactionRule[] = [{ label: 'ticket-id', pattern: /\bSUP-[0-9]{4}\b/g }];
    const result = redact(`tracker SUP-1042 plus ${SEEDED.linearApiKey}`, rules);

    assert.equal(result.text, `tracker [redacted:ticket-id] plus ${SEEDED.linearApiKey}`);
    assert.deepEqual(result.appliedLabels, ['ticket-id']);
  });

  test('applies a caller-supplied pattern that was not written with the global flag', () => {
    const rules: readonly RedactionRule[] = [{ label: 'ticket-id', pattern: /\bSUP-[0-9]{4}\b/ }];
    const result = redact(`tracker SUP-1042 and SUP-1043`, rules);

    assert.equal(result.text, 'tracker [redacted:ticket-id] and [redacted:ticket-id]');
    assert.deepEqual(result.appliedLabels, ['ticket-id']);
  });

  test('is stable when applied twice, so a redacted line stays redacted', () => {
    const once = redact(`key ${SEEDED.slackToken}`);
    const twice = redact(once.text);

    assert.deepEqual(twice, { text: once.text, appliedLabels: [] });
  });

  test('the shipped default rule set covers every credential class named by N02-AC2', () => {
    const labels = DEFAULT_REDACTION_RULES.map((rule) => rule.label);

    for (const expected of [
      'linear-api-key',
      'github-token',
      'openai-key',
      'anthropic-key',
      'slack-token',
      'generic-bearer',
      'jwt',
      'private-key-block',
      'url-credentials',
    ]) {
      assert.ok(labels.includes(expected), `${expected} must be a configured rule`);
    }
  });
});

describe('N02-AC2 redactDeep', () => {
  test('walks nested objects and arrays', () => {
    const result = redactDeep({
      runId: 'run_1',
      log: `token ${SEEDED.slackToken}`,
      steps: [{ name: 'install', output: `key ${SEEDED.openaiKey}` }, { name: 'test', output: 'clean' }],
      nested: { deeper: { url: SEEDED.urlWithCredentials } },
    });

    assert.equal(result.log.includes(SEEDED.slackToken), false);
    assert.equal(result.steps[0]?.output.includes(SEEDED.openaiKey), false);
    assert.equal(result.steps[1]?.output, 'clean');
    assert.equal(result.nested.deeper.url.includes('hunter2'), false);
    assert.equal(result.runId, 'run_1');
  });

  test('leaves non-string scalars untouched', () => {
    const result = redactDeep({ count: 3, passed: true, exitCode: null, secret: 'value-without-a-pattern' });

    assert.deepEqual(result, { count: 3, passed: true, exitCode: null, secret: 'value-without-a-pattern' });
  });
});

describe('F32-AC2 stripSecretFields', () => {
  test('removes credential-bearing keys at the top level', () => {
    const stripped = stripSecretFields({
      runId: 'run_1',
      token: 'value',
      secret: 'value',
      password: 'value',
      passphrase: 'value',
      credential: 'value',
      apiKey: 'value',
      api_key: 'value',
      'api-key': 'value',
      authorization: 'value',
      cookie: 'value',
    });

    assert.deepEqual(stripped, { runId: 'run_1' });
  });

  test('removes credential-bearing keys regardless of case', () => {
    const stripped = stripSecretFields({ Token: 'value', API_KEY: 'value', Cookie: 'value', Authorization: 'value' });

    assert.deepEqual(stripped, {});
  });

  test('removes credential-bearing keys nested in objects and arrays at any depth', () => {
    const stripped = stripSecretFields({
      export: {
        brief: { title: 'Ship the acceptance card', criteria: ['F24-AC2'] },
        evidence: [{ checkId: 'chk_1', result: 'Passed', artifactRef: 'artifacts/a.json' }],
        context: { tokens: { access: 'value', note: 'redacted' } },
        results: [[{ apiKey: 'value', durationMs: 12 }]],
      },
    });

    assert.deepEqual(stripped, {
      export: {
        brief: { title: 'Ship the acceptance card', criteria: ['F24-AC2'] },
        evidence: [{ checkId: 'chk_1', result: 'Passed', artifactRef: 'artifacts/a.json' }],
        context: {},
        results: [[{ durationMs: 12 }]],
      },
    });
  });

  test('keeps evidence fields whose names carry no credential marker', () => {
    const stripped = stripSecretFields({
      evidenceIndex: [{ checkId: 'chk_1', result: 'Passed', artifactRef: 'artifacts/a.json' }],
      deliveryHistory: [{ action: 'Merge', headSha: 'abc123', mergedAt: '2026-03-04T12:00:00.000Z' }],
    });

    assert.equal(stripped.evidenceIndex.length, 1);
    assert.equal(stripped.deliveryHistory.length, 1);
    assert.equal(stripped.evidenceIndex[0]?.result, 'Passed');
    assert.equal(stripped.deliveryHistory[0]?.mergedAt, '2026-03-04T12:00:00.000Z');
  });

  test('F32-AC2 keeps metadata fields that merely begin with a credential word', () => {
    // The trailing word decides, not the presence of a credential word anywhere.
    // These are all real data an export must carry, and deleting them emptied the
    // evidence index the export exists to provide.
    const stripped = stripSecretFields({
      tokenCount: 42,
      cookiePolicy: 'lax',
      credentialStatus: 'ok',
      evidenceIndex: [],
    });

    assert.deepEqual(stripped, {
      tokenCount: 42,
      cookiePolicy: 'lax',
      credentialStatus: 'ok',
      evidenceIndex: [],
    });
  });

  test('F32-AC2 keeps the metadata and drops the credentials in the same structure', () => {
    const stripped = stripSecretFields({
      tokenCount: 42,
      cookiePolicy: 'lax',
      credentialStatus: 'ok',
      apiToken: 'x',
      secretValue: 'y',
      evidenceIndex: [],
    });

    assert.deepEqual(stripped, {
      tokenCount: 42,
      cookiePolicy: 'lax',
      credentialStatus: 'ok',
      evidenceIndex: [],
    });
  });

  test('N02-AC2 a credential is stripped whatever spelling the field name uses', () => {
    // The trailing-word rule has to tolerate camelCase, snake_case and kebab-case,
    // otherwise api-key, apiToken and accessToken all survive into an export.
    const spellings = [
      'apiKey',
      'api_key',
      'api-key',
      'apiToken',
      'accessToken',
      'apiTokens',
      'refreshToken',
      'privateKey',
      'private-key',
      'credential',
      'credentials',
      'apiCredential',
      'token',
      'tokens',
      'authorization',
      'cookie',
      'cookies',
      'secretValue',
    ];

    const probe: Record<string, string> = {};
    for (const key of spellings) probe[key] = 'value';
    const stripped = stripSecretFields(probe);

    for (const key of spellings) {
      assert.equal(key in stripped, false, `${key} must be stripped from an export`);
    }
    assert.deepEqual(stripped, {});
  });

  test('N02-AC2 ordinary export metadata is not mistaken for a credential', () => {
    const metadata = {
      runId: 'run_1',
      checkId: 'chk_1',
      result: 'Passed',
      artifactRef: 'artifacts/a.json',
      durationMs: 12,
      startedAt: '2026-03-04T09:00:00.000Z',
      endedAt: '2026-03-04T09:12:00.000Z',
      exitCode: 0,
      required: true,
      candidateFingerprint: 'fp_0123456789abcdef0123456789abcdef',
      scopeFingerprint: 'fp_fedcba9876543210fedcba9876543210',
      deliveryHistory: [],
    };

    assert.deepEqual(stripSecretFields(metadata), metadata);
  });

  test('leaves a structure with no credential keys unchanged', () => {
    const exportShape = { brief: 'Ship it', criteria: ['F24-AC2', 'F25-AC3'], count: 2 };

    assert.deepEqual(stripSecretFields(exportShape), exportShape);
  });
});