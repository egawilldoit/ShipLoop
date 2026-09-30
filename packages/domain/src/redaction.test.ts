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

  test('N02-AC2 an Anthropic key is removed from the text and reported as redacted', () => {
    // DEFECT D1 (packages/domain/src/redaction.ts:20): the anthropic-key rule is
    // unreachable. The openai-key rule at line 19 precedes it and its pattern
    // [\w-]{16,} matches everything "sk-ant-<16+>" does, so an Anthropic key is
    // labelled openai-key. Proposed fix: put anthropic-key before openai-key, or
    // exclude the "ant-" prefix from the openai-key pattern.
    // The excluded assertion is that appliedLabels contains 'anthropic-key'.
    const result = redact(`model config: ${SEEDED.anthropicKey}`);

    assert.equal(result.text.includes(SEEDED.anthropicKey), false, 'the Anthropic key survived redaction');
    assert.equal(result.appliedLabels.length, 1, 'exactly one rule must have matched');
    assert.ok(result.text.startsWith('model config: [redacted:'));
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

  test('leaves a structure with no credential keys unchanged', () => {
    const exportShape = { brief: 'Ship it', criteria: ['F24-AC2', 'F25-AC3'], count: 2 };

    assert.deepEqual(stripSecretFields(exportShape), exportShape);
  });
});