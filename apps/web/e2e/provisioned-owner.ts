/**
 * Provisions the synthetic owner this store holds, once per worker.
 *
 * The controller's store holds a single owner and the harness does not seed it, so a spec that
 * signs in without provisioning sees a refused sign-in that reads exactly like a wrong password.
 * Four of the retired surfaces' specs each declare their own copy of this fixture, and this module
 * exists so the MVP specs are not a fifth copy: the shape is identical, and an integration that
 * extracts the shared form can delete this file and the four others together.
 *
 * Declared `auto` on purpose. Playwright starts a fresh worker, and therefore a fresh isolated
 * server with a fresh empty database, whenever the next test asks for a different set of
 * worker-scoped fixtures. A fixture only some tests declare produces exactly that — a whole file
 * whose signed-in half silently runs against an unprovisioned store.
 *
 * Provisioning is idempotent: a repeated call answers `Conflict` and names the owner it refused to
 * replace, which is enough to learn the same id, so a retried test does not have to detect itself.
 */

import { expect, test as base } from './fixtures.ts';
import { SYNTHETIC_OWNER, SYNTHETIC_PASSWORD } from './fixtures.ts';

const PROVISION_PATH = '/api/owner/provision';

interface OwnerFixtures {
  readonly seededOwner: { readonly ownerId: string };
}

/** `test` with the synthetic owner provisioned. Every spec in this namespace uses this one. */
export const test = base.extend<OwnerFixtures, OwnerFixtures>({
  seededOwner: [
    async ({ shipLoopServer }, use) => {
      const response = await fetch(`${shipLoopServer.origin}${PROVISION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: SYNTHETIC_OWNER.displayName, password: SYNTHETIC_PASSWORD }),
      });
      const text = await response.text();
      const parsed: unknown = text === '' ? null : JSON.parse(text);
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(
          `Provisioning the owner failed (status ${response.status}), so no signed-in fact here can be ` +
            `tested: ${text}`,
        );
      }
      const ownerId =
        response.status === 201
          ? (parsed as { readonly owner: { readonly ownerId: string } }).owner.ownerId
          : ((parsed as { readonly error?: { readonly actual?: unknown } }).error?.actual as string);
      if (typeof ownerId !== 'string' || ownerId === '') {
        throw new Error(`Provisioning returned no owner id (status ${response.status}): ${text}`);
      }
      await use({ ownerId });
    },
    { scope: 'worker', auto: true },
  ],
});

export { expect, SYNTHETIC_OWNER, SYNTHETIC_PASSWORD };