/**
 * The shell renders, lays out without sideways scrolling, and admits a lost connection.
 *
 * Every assertion here is a measurement or a real request. The responsive check reads
 * `scrollWidth` and `clientWidth` off the document element rather than looking for a
 * CSS class, because a class says what was intended and the measurement says what
 * happened (F01-AC3).
 */

import { SYNTHETIC_OWNER, SYNTHETIC_PASSWORD, expect, test } from './fixtures.ts';

// F01-AC1, F01-AC4: the rest of this file proves the browser client and the domain rules, which
// hold whichever server answered. This assertion is the one that proves the server under test was
// the process the application ships.
//
// `e2e/fixtures.ts` substitutes a real in-process server when `src/server/main.ts` cannot become
// ready, and announces that loudly on stderr. Loud is not the same as enforced: without this
// check the substitution would let a completely broken startup read as a passing browser gate,
// which is the one conclusion a green run must never support. It is an assertion and not a skip,
// so the gate stays red for exactly as long as the shipped entrypoint cannot serve, and goes
// green on its own the moment it can - no one has to remember to remove anything.
test.describe('server under test', () => {
  test('this run drove the shipped server entrypoint, not a substitute', async ({ shipLoopServer }) => {
    expect(
      shipLoopServer.kind,
      'the shipped src/server/main.ts did not serve this run; the substitution reason is printed above. ' +
        'Everything else in this suite is then proof of the browser client and the domain rules only.',
    ).toBe('real-entrypoint');
  });
});

test.describe('application shell', () => {
  test('renders a mounted root with visible text', async ({ page, serverUrl }) => {
    const response = await page.goto(`${serverUrl}/`);
    expect(response?.status()).toBe(200);

    const root = page.locator('#root');
    await expect(root).toBeVisible();

    const text = (await root.innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    await expect(root).toContainText('ShipLoop');
  });

  // F01-AC3: the page must not scroll sideways on a 375px phone or on a desktop.
  for (const viewport of [
    { name: 'phone', width: 375, height: 812 },
    { name: 'desktop', width: 1280, height: 900 },
  ]) {
    test(`does not scroll horizontally at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
      serverUrl,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${serverUrl}/`);
      await expect(page.locator('#root')).toBeVisible();
      await page.waitForLoadState('networkidle');

      const measurement = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
      }));

      expect(measurement.clientWidth).toBe(viewport.width);
      expect(measurement.scrollWidth).toBe(measurement.clientWidth);
    });
  }

  // F01-AC1, N03-AC3: a signed-out owner whose server is unreachable is told so, in words,
  // on a surface that exists before sign-in. The earlier version of this test waited for a
  // `[data-connected="false"]` banner, which `ConnectionBanner` renders only in the signed-in
  // branch of `App.tsx`, so it could never appear here no matter how the client behaved.
  //
  // For a signed-out owner "disconnected" has a different meaning than for a signed-in one, and
  // this is the honest version of it. The signed-in banner reports that the *view* has stopped
  // being current, because a stale screen is the hazard there. A signed-out owner has no view and
  // no cached facts, so the hazard is different: a submit that silently does nothing, leaving the
  // owner to believe the credentials were refused when the server was never reached. The state
  // that must be visible is therefore the sign-in form naming the server as unreachable, which is
  // a different sentence from the refusal it must not be confused with - and asserting that
  // distinction is the part that has value, since collapsing the two is exactly the defect.
  test('a signed-out owner is told the server could not be reached, not that sign-in failed', async ({
    page,
    serverUrl,
  }) => {
    const attempted: string[] = [];
    await page.route('**/api/owner/**', async (route) => {
      attempted.push(new URL(route.request().url()).pathname);
      await route.abort('failed');
    });

    await page.goto(`${serverUrl}/`);

    // The session check itself is refused by the same route, so this is the signed-out path and
    // not a signed-in shell that merely lost its connection.
    const summary = page.locator('[role="status"][data-state="idle"]');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveText('Signed out.');

    await page.getByLabel('Email address').fill(SYNTHETIC_OWNER.email);
    await page.getByLabel('Password').fill(SYNTHETIC_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    const unreachable = page.locator('[role="alert"][data-state="failed"]');
    await expect(unreachable).toBeVisible();
    await expect(unreachable).toContainText('The server could not be reached');
    await expect(unreachable).toContainText('sign-in could not be completed');

    // The refusal text a reachable server would send must not appear: telling an owner their
    // password was rejected when the request never arrived sends them to reset a password that
    // was correct.
    await expect(unreachable).not.toContainText('not accepted');

    // The credential was really submitted and really failed at the transport, rather than the
    // form refusing to validate locally and rendering the same words for a different reason.
    expect(attempted).toContain('/api/owner/sign-in');

    // The typed password survives the failure, so a retry needs no retyping (N03-AC3).
    await expect(page.getByLabel('Password')).toHaveValue(SYNTHETIC_PASSWORD);
  });
});
