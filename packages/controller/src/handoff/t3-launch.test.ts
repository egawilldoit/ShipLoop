import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateImplementationPacket } from './implementation-packet.ts';
import { T3_URL_ENV_VAR, parseT3LaunchUrl, resolveT3Launch } from './t3-launch.ts';

/**
 * L02-AC3: the T3 integration is a fallback context packet and a link, so nothing here
 * may claim a session, an agent or a completed piece of work.
 *
 * The configuration lookup has three obligations, and each is asserted below rather
 * than assumed: an unconfigured deployment is a normal state that the packet survives,
 * a configured one opens exactly the URL the operator wrote, and a bad one is refused
 * with a remedy instead of being guessed at or echoed.
 *
 * Every host used here is an RFC 2606 example name. No personal or production hostname
 * appears in this file or in `t3-launch.ts`, which is what "no hardcoded personal
 * hostname" means in practice.
 */

const RESERVED = 'https://t3.example.test';
const DEPLOYMENT_PATH = 'https://t3.example.test/app';

function approved(): Parameters<typeof generateImplementationPacket>[0] {
  return {
    project: { id: 'proj_shiploop', name: 'ShipLoop', repository: 'shiploop/shiploop', defaultBranch: 'main' },
    request: { id: 'req_acceptance_card', title: 'Ship the owner acceptance card', description: 'A reviewable card.' },
    contract: {
      id: 'contract_acceptance_card',
      revision: 2,
      status: 'approved',
      approvedAt: '2026-03-04T12:00:00.000Z',
      outcome: 'An owner can accept or request changes against an exact candidate.',
      scope: 'One page in the owner UI.',
      outOfScope: ['Deployment'],
      acceptanceCriteria: [
        { id: 'AC-1', description: 'The card renders one row per criterion.', verificationType: 'automated' },
      ],
    },
    procedureReferences: [],
  };
}

describe('no T3 configured', () => {
  test('the packet is still generated, unchanged and complete', () => {
    // The journey Request -> Contract -> PR -> Verify -> Review must not depend on an
    // optional connector, so an absent T3 configuration is not an error here.
    const result = generateImplementationPacket(approved());

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.match(result.value.markdown, /## How to carry out this handoff/);
    assert.match(result.value.markdown, /^- Do not merge the pull request\./m);
  });

  test('the packet does not mention T3 at all when T3 is unconfigured', () => {
    const result = generateImplementationPacket(approved());
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');

    assert.equal(result.value.markdown.includes('t3'), false);
    assert.equal(result.value.markdown.includes(T3_URL_ENV_VAR), false);
  });

  test('opening T3 is refused as an actionable configuration problem', () => {
    for (const env of [{}, { [T3_URL_ENV_VAR]: '' }, { [T3_URL_ENV_VAR]: '   ' }]) {
      const result = resolveT3Launch(env);

      assert.equal(result.ok, false, `expected ${JSON.stringify(env)} to be refused`);
      if (result.ok) throw new Error('unreachable');
      assert.equal(result.error.code, 'Blocked');
      if (result.error.code !== 'Blocked') throw new Error('unreachable');
      assert.equal(result.error.prerequisites.length, 1);
      const prerequisite = result.error.prerequisites[0];
      assert.equal(prerequisite?.name, T3_URL_ENV_VAR);
      assert.match(prerequisite?.remedy ?? '', /Set this variable to the base URL/);
      assert.match(prerequisite?.remedy ?? '', /works without it/);
    }
  });
});

describe('a malformed T3 URL', () => {
  test('is refused with a remedy rather than repaired', () => {
    const cases: readonly string[] = [
      't3.example.test',
      'https://',
      '://missing-scheme',
      'http://[not-an-ipv6',
      '   ',
      'not a url at all',
    ];

    for (const value of cases) {
      const result = parseT3LaunchUrl(value);
      assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to be refused`);
      if (result.ok) throw new Error('unreachable');
      assert.equal(result.error.code, 'Blocked');
    }
  });

  test('a scheme other than http or https is refused, naming the scheme', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://t3.example.test',
      'ssh://t3.example.test',
    ]) {
      const result = parseT3LaunchUrl(value);
      assert.equal(result.ok, false, `expected ${value} to be refused`);
      if (result.ok) throw new Error('unreachable');
      if (result.error.code !== 'Blocked') throw new Error('unreachable');
      assert.match(result.error.prerequisites[0]?.remedy ?? '', /HTTP or HTTPS|https:\/\//);
    }
  });

  test('credentials in the URL are refused, because the remedy is to remove them from configuration', () => {
    const result = parseT3LaunchUrl('https://operator:hunter2@t3.example.test');

    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    if (result.error.code !== 'Blocked') throw new Error('unreachable');
    assert.match(result.error.prerequisites[0]?.detail ?? '', /not a usable T3 deployment URL/);
    assert.match(result.error.prerequisites[0]?.remedy ?? '', /Remove the username and password/);
  });

  test('the refusal never echoes the configured value, which may itself be the secret', () => {
    const secretish = 'https://operator:hunter2@t3.example.test/app?token=abcdef';
    const result = parseT3LaunchUrl(secretish);

    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    const serialised = JSON.stringify(result.error);
    assert.equal(serialised.includes('hunter2'), false, 'the password must not appear in the error');
    assert.equal(serialised.includes('abcdef'), false, 'the query must not appear in the error');
    assert.ok(serialised.includes(T3_URL_ENV_VAR), 'the error must name the variable to fix');
  });

  test('the error names the variable without reproducing any part of the configured value', () => {
    const result = parseT3LaunchUrl('https://operator@hunter2.t3.example.test');

    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    const message = JSON.stringify(result.error);
    assert.ok(message.includes(T3_URL_ENV_VAR));
    assert.equal(message.includes('hunter2'), false);
  });
});

describe('a configured T3 URL', () => {
  test('resolves to exactly the configured URL, with nothing appended or substituted', () => {
    for (const value of [RESERVED, DEPLOYMENT_PATH, `${DEPLOYMENT_PATH}/?thread=abc`]) {
      const result = resolveT3Launch({ [T3_URL_ENV_VAR]: value });

      assert.equal(result.ok, true, `expected ${value} to resolve`);
      if (!result.ok) throw new Error('unreachable');
      assert.equal(result.value.url, value, 'the browser must be sent to the configured URL itself');
    }
  });

  test('surrounding whitespace is trimmed, because an operator pasting a URL is not a defect', () => {
    const result = resolveT3Launch({ [T3_URL_ENV_VAR]: `  ${DEPLOYMENT_PATH}  \n` });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.url, DEPLOYMENT_PATH);
  });

  test('http is accepted for a deployment on a private network, and nothing more is', () => {
    const result = resolveT3Launch({ [T3_URL_ENV_VAR]: 'http://t3.internal.test' });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.url, 'http://t3.internal.test');
  });

  test('the resolution carries nothing but the URL: no session, no token, no agent state', () => {
    const result = resolveT3Launch({ [T3_URL_ENV_VAR]: RESERVED });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.deepEqual(Object.keys(result.value).sort(), ['url']);
    assert.match(result.value.url, /^https:\/\//);
  });
});

describe('no T3 hostname is built into the product', () => {
  test('an unset configuration resolves to nothing rather than to a default host', () => {
    const result = resolveT3Launch({});

    assert.equal(result.ok, false, 'there must be no fallback T3 deployment');
    if (result.ok) throw new Error('unreachable');
  });

  test('the module exposes only the variable name, not a URL', () => {
    // The configuration surface is the name of the variable; the value comes from the
    // deployment's environment and from nowhere else.
    assert.equal(T3_URL_ENV_VAR, 'SHIPLOOP_T3_URL');
    assert.equal(T3_URL_ENV_VAR.includes('http'), false);
  });
});