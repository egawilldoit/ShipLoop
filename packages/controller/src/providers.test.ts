import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  GIT_API_BASE_URL_ENV,
  GIT_CREDENTIAL_REFERENCE_ENV,
  GIT_PROVIDER_ENV,
  GIT_SECRET_ENV,
  GIT_WORKTREE_ENV,
  LINEAR_PROVIDER,
  TICKET_CREDENTIAL_REFERENCE_ENV,
  TICKET_PROVIDER_ENV,
  TICKET_SECRET_ENV,
  createProviderRegistry,
  readProviderConfiguration,
} from './providers.ts';

function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  return result.value;
}

function expectErr(result: unknown): { readonly code: string; readonly reason: string } {
  assert.equal((result as { readonly ok: boolean }).ok, false, 'expected a typed refusal');
  const error = (result as { readonly error: { code: string; reason: string } }).error;
  assert.ok(error !== undefined, 'a refusal carries an error');
  return error;
}

function withWorktree<T>(run: (worktree: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'shiploop-providers-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('F03-AC1 an unconfigured process still builds a registry and names the missing access per operation', () => {
  const configuration = expectOk(readProviderConfiguration({}));
  assert.equal(configuration.ticket, null, 'no ticket provider is invented when none is configured');
  assert.equal(configuration.git, null, 'no git provider is invented when none is configured');

  const registry = expectOk(createProviderRegistry(configuration));
  assert.equal(registry.ticket, null);
  assert.equal(registry.git, null);

  // An unconfigured provider has no credential to be missing, so this returns null: the
  // operation refuses earlier, on the absent provider, rather than on a missing secret.
  // What must not happen is a credential blocker that names the wrong thing.
  assert.equal(
    registry.credentialBlocker('Ticket', 'publishAcceptedWork'),
    null,
    'an unconfigured provider has no credential blocker; the operation blocks on the provider itself',
  );
});

test('F03-AC1 a configured ticket provider builds the real adapter with its declared capabilities', () => {
  const configuration = expectOk(
    readProviderConfiguration({
      [TICKET_PROVIDER_ENV]: LINEAR_PROVIDER,
      [TICKET_CREDENTIAL_REFERENCE_ENV]: 'vault:shiploop/fixture-linear',
      [TICKET_SECRET_ENV]: 'SHIPLOOP_FIXTURE_LINEAR_SECRET',
    }),
  );
  assert.ok(configuration.ticket !== null, 'the ticket binding was read');

  const registry = expectOk(
    createProviderRegistry(configuration, { readSecret: () => undefined }),
  );
  assert.ok(registry.ticket !== null, 'a real ticket adapter was constructed');
  const declared = registry.adapters.declarationsFor('Ticket').map((entry) => entry.kind);
  assert.ok(declared.includes('Ticket:ReadScope'), `expected a declared read capability, got ${declared.join(', ')}`);
  // A resolvable credential leaves no blocker; the same configuration with the secret
  // absent refuses, and the refusal names the variable to set.
  const withSecret = expectOk(
    createProviderRegistry(configuration, { readSecret: () => 'fixture-token' }),
  );
  assert.equal(
    withSecret.credentialBlocker('Ticket', 'publishAcceptedWork'),
    null,
    'a resolvable credential leaves no blocker',
  );
});

test('F03-AC3 a configured provider whose secret is absent refuses with the variable to set, never a silent fake', () => {
  const configuration = expectOk(
    readProviderConfiguration({
      [TICKET_PROVIDER_ENV]: LINEAR_PROVIDER,
      [TICKET_CREDENTIAL_REFERENCE_ENV]: 'vault:shiploop/fixture-linear',
      [TICKET_SECRET_ENV]: 'SHIPLOOP_FIXTURE_LINEAR_SECRET',
    }),
  );
  const registry = expectOk(createProviderRegistry(configuration, { readSecret: () => undefined }));
  const blocker = registry.credentialBlocker('Ticket', 'adoptExistingIssue');
  assert.ok(blocker !== null, 'an unresolved credential blocks the operation');
  assert.equal(blocker.code, 'Blocked');
  assert.match(blocker.reason, /adoptExistingIssue/, 'the refusal names the operation that is blocked');
  assert.ok('prerequisites' in blocker && blocker.prerequisites.length > 0, 'a blocker names its prerequisite');
  const remedy = blocker.prerequisites.map((entry) => entry.remedy).join(' ');
  assert.match(remedy, /SHIPLOOP_FIXTURE_LINEAR_SECRET/, 'the remedy names the variable to set');
  assert.doesNotMatch(
    `${blocker.reason} ${remedy}`,
    /fixture-token/,
    'the refusal never repeats the credential value',
  );
});

test('F03-AC2 a git provider configured without a checkout is refused with the variable to set', () => {
  const refusal = expectErr(
    readProviderConfiguration({
      [GIT_PROVIDER_ENV]: 'github',
      [GIT_CREDENTIAL_REFERENCE_ENV]: 'vault:shiploop/fixture-git',
      [GIT_SECRET_ENV]: 'SHIPLOOP_FIXTURE_GIT_SECRET',
      [GIT_API_BASE_URL_ENV]: 'https://api.github.test',
    }),
  );
  assert.equal(refusal.code, 'Invalid');
  assert.match(refusal.reason, /not usable/);
  // The individual field errors are what the operator acts on, so they must name the
  // variable rather than only saying the configuration was rejected.
  const fields = (refusal as unknown as { readonly fields: readonly { path: string; message: string }[] }).fields;
  assert.ok(Array.isArray(fields) && fields.some((field) => field.path === GIT_WORKTREE_ENV),
    `the refusal names ${GIT_WORKTREE_ENV}: ${JSON.stringify(fields)}`);
});

test('F11-AC3 two configurations resolve to their own repository and provider, never a similarly named one', () => {
  withWorktree((worktree) => {
    const first = expectOk(
      createProviderRegistry(
        expectOk(
          readProviderConfiguration({
            [GIT_PROVIDER_ENV]: 'github',
            [GIT_CREDENTIAL_REFERENCE_ENV]: 'vault:shiploop/profile-one',
            [GIT_SECRET_ENV]: 'SHIPLOOP_FIXTURE_GIT_SECRET',
            [GIT_API_BASE_URL_ENV]: 'https://api.github.test',
            [GIT_WORKTREE_ENV]: worktree,
          }),
        ),
        { readSecret: () => 'fixture', fetchImpl: async () => new Response('{}') },
      ),
    );
    const second = expectOk(
      createProviderRegistry(
        expectOk(
          readProviderConfiguration({
            [GIT_PROVIDER_ENV]: 'github',
            [GIT_CREDENTIAL_REFERENCE_ENV]: 'vault:shiploop/profile-two',
            [GIT_SECRET_ENV]: 'SHIPLOOP_FIXTURE_GIT_SECRET',
            [GIT_API_BASE_URL_ENV]: 'https://api.github.test',
            [GIT_WORKTREE_ENV]: worktree,
          }),
        ),
        { readSecret: () => 'fixture', fetchImpl: async () => new Response('{}') },
      ),
    );

    // Each profile carries its own credential reference, so neither can act with the
    // other's. A similarly named repository is never resolved by name.
    // Profile one's own reference blocks because its secret is not resolvable; profile
    // two's reference is not profile one's, so it is refused as a mismatch rather than
    // silently acting under the wrong credential (F11-AC3).
    // Profile one acts under its own reference and only its own: a connector row naming
    // another profile's reference is refused rather than served with profile one's
    // credential, which is exactly F11-AC3 and F03-AC3.
    assert.equal(
      first.credentialBlocker('Git', 'linkExistingChange', 'vault:shiploop/profile-one'),
      null,
      'a connector naming this deployment\'s own reference resolves',
    );
    const foreign = first.credentialBlocker('Git', 'linkExistingChange', 'vault:shiploop/profile-two');
    assert.ok(foreign !== null, 'a reference from another profile does not silently pass');
    assert.match(foreign.reason, /vault:shiploop\/profile-one/, 'the refusal names the reference actually in force');
    assert.notEqual(first.git, second.git, 'two configurations do not share one adapter instance');
  });
});
