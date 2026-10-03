/**
 * The planning, readiness, publication and adoption slice driven through a real browser
 * against the shipped server.
 *
 * Every assertion here is a measurement or a real request against
 * `apps/web/src/server/main.ts` composed from `@shiploop/controller` (F01-AC1). The flow
 * is the owner's: sign in through the form, open a request, see the proposed plan with
 * every field F08-AC1 names, see the readiness assessment over every area, accept a
 * task, reorder another, and see that an unaccepted task still has nothing to publish.
 *
 * Four properties are asserted rather than assumed:
 *
 *   - this run drove the shipped entrypoint. `e2e/fixtures.ts` substitutes a real
 *     in-process server when `main.ts` cannot become ready, and announces that on
 *     stderr; without this assertion a completely broken startup would read as a
 *     passing browser gate (F01-AC1).
 *   - the plan reached the server's own SQLite file. The seed below goes through
 *     `POST /api/plans` on the running server, and the assertions then read the plan
 *     back through the UI, so a screen that rendered a local copy of the request rather
 *     than the stored plan would fail here (F08-AC1, F02-AC3).
 *   - readiness is a record over every area, not a boolean. The test counts the area
 *     rows against the seven F09-AC1 names and reads the reasons, so an assessment that
 *     omitted an area would render fewer rows and fail (F09-AC1).
 *   - the page does not scroll sideways at 375px or 1280px, read off
 *     `document.documentElement` the way `smoke.spec.ts` does, because a CSS class says
 *     what was intended and the measurement says what happened (F01-AC3).
 *
 * The plan is seeded over HTTP rather than through a form because no screen drafts one:
 * a plan is a proposal a model produces and the owner reviews, and the worker that would
 * produce it does not exist yet. Everything after the seed is driven from the page.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { SESSION_COOKIE_NAME, SYNTHETIC_OWNER, SYNTHETIC_PASSWORD, expect, test as base } from './fixtures.ts';
import { openLegacy } from './legacy-nav.ts';

const VIEWS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const AREAS_F09_AC1 = ['Scope', 'Criteria', 'Repository', 'Target', 'Dependencies', 'Verification', 'Access'] as const;

/** The one owner this store holds, provisioned through the real route (F01-AC1). */
interface OwnerFixtures {
  readonly seededOwner: { readonly ownerId: string };
}

const test = base.extend<OwnerFixtures, OwnerFixtures>({
  seededOwner: [
    async ({ shipLoopServer }, use) => {
      const response = await fetch(`${shipLoopServer.origin}/api/owner/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: SYNTHETIC_OWNER.displayName, password: SYNTHETIC_PASSWORD }),
      });
      const text = await response.text();
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(
          `Provisioning the owner failed (status ${response.status}), so no signed-in fact in this file can be tested: ${text}`,
        );
      }
      await use({ ownerId: SYNTHETIC_OWNER.id });
    },
    { scope: 'worker', auto: true },
  ],
});

/**
 * Signs in through the real form and waits for the owner shell.
 *
 * The form, not a direct request, because the claim under test is that an owner can
 * reach the plan screen by typing into a page: a fixture that signed in over raw HTTP
 * would pass whether or not the client's sign-in path works.
 */
async function signInThroughTheForm(page: Page, serverUrl: string): Promise<void> {
  await page.goto(`${serverUrl}/`);
  await page.getByLabel('Email address').fill(SYNTHETIC_OWNER.displayName);
  await page.getByLabel('Password').fill(SYNTHETIC_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Owner sections' })).toBeVisible({ timeout: 15_000 });
}

async function openPlanTab(page: Page): Promise<void> {
  await openLegacy(page, 'plan');
  await expect(page.getByRole('heading', { name: 'Plan and readiness', level: 2 })).toBeVisible();
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

/**
 * Captures a request through the real capture form, then reads its id back over HTTP.
 *
 * The form rather than a direct request, because the plan screen is reached by selecting
 * a row from the intake list, and a request captured out of band would not be in the
 * list that screen loaded. Seeding behind the screen's back would leave the two views
 * describing different things and the test would then be asserting on a path the owner
 * cannot take (F06-AC1).
 *
 * The id is read back by matching the request text rather than scraped from the DOM,
 * because the id is not what the owner reads and a locator keyed on a generated id would
 * break on any change to how rows are keyed (F06-AC1).
 */
async function captureThroughForm(page: Page, rawRequest: string): Promise<{ readonly ideaId: string; readonly session: Session }> {
  const origin = new URL(page.url()).origin;
  const session = await sessionFromBrowser(page, origin);
  // Reaching the capture form is part of capturing through it. The shell used to open on Intake,
  // so a signed-in page was already showing this field; the MVP's default surface is Home, and
  // relying on a default that the product now states differently would make every test below
  // depend on which surface happens to be first.
  await openLegacy(page, 'intake');
  await expect(page.getByRole('heading', { name: 'Intake', level: 2 })).toBeVisible();
  await page.getByLabel('The request, in your own words').fill(rawRequest);
  await page.getByRole('button', { name: 'Capture this request' }).click();
  await expect(page.locator('[data-testid="raw-request"]')).toHaveText(rawRequest);

  const ideaId = await page.evaluate(
    async ([origin, wanted]) => {
      const response = await fetch(`${origin}/api/intake/ideas`, { credentials: 'same-origin' });
      const body = (await response.json()) as {
        readonly ideas?: readonly { readonly ideaId: string; readonly rawRequest: string }[];
      };
      const match = (body.ideas ?? []).filter((idea) => idea.rawRequest === wanted);
      return match.length === 1 ? match[0]?.ideaId ?? '' : '';
    },
    [origin, rawRequest] as const,
  );
  if (ideaId === '') {
    throw new Error(`The captured request did not appear exactly once in the intake list, so the plan has no request to belong to: ${rawRequest}`);
  }
  return { ideaId, session };
}

/**
 * Opens the plan for the request just captured, from the intake list.
 *
 * The route through the list is deliberate: it is the path an owner takes, and it proves
 * the plan screen is reachable from the request rather than only from a hand-written
 * address (F08-AC1).
 */
async function openPlanForRequest(page: Page, requestFragment: string): Promise<void> {
  await openLegacy(page, 'intake');
  await expect(page.getByRole('heading', { name: 'Intake', level: 2 })).toBeVisible();
  await page
    .locator('li')
    .filter({ hasText: requestFragment })
    .getByRole('button', { name: 'Open brief and questions' })
    .click();
  await expect(page.getByRole('heading', { name: 'Brief and clarification', level: 2 })).toBeVisible();
  await openPlanTab(page);
}

/**
 * Drafts a plan through the shipped server, driven by the real cookie and CSRF token.
 *
 * Two independently reviewable surfaces with a dependency between them, so the plan is
 * a justified split rather than one-file work cut in three (F08-AC2). Every requested
 * outcome is covered by a task, which is what F08-AC5 requires of every plan.
 */
async function seedPlan(
  serverUrl: string,
  cookie: string,
  csrfToken: string,
  ideaId: string,
  label: string,
): Promise<{ readonly planId: string }> {
  const response = await fetch(`${serverUrl}/api/plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-shiploop-csrf': csrfToken },
    body: JSON.stringify({
      ideaId,
      planId: `plan_e2e_${label}`,
      change: {
        summary: 'Show the readiness assessment and refuse an unpublishable proposal.',
        surfaces: [
          {
            surfaceId: 'readiness_panel',
            description: 'The readiness assessment panel on the plan screen.',
            observableBehaviour: 'Every area and its reason are readable, satisfied or not.',
            independentlyReviewable: true,
          },
          {
            surfaceId: 'publish_gate',
            description: 'The publish control on the publication screen.',
            observableBehaviour: 'Publishing is offered only when a proposal is accepted.',
            independentlyReviewable: true,
          },
        ],
        dependencyEdges: [{ surface: 'publish_gate', dependsOn: 'readiness_panel' }],
      },
      proposal: {
        kind: 'PlanProposal',
        briefId: `brief_e2e_${label}`,
        draftedAt: '2026-03-01T12:00:00.000Z',
        basedOnRevision: null,
        requestedOutcomes: [{ id: 'out_readiness', statement: 'The owner can see why a build may not start.' }],
        tasks: [
          {
            taskId: 'task_panel',
            outcome: 'Every readiness area is on screen with its reason.',
            scope: 'Render the recorded assessment area by area on the plan screen.',
            acceptanceCriteria: ['All seven areas named by F09-AC1 appear with a reason beside each.'],
            verificationMethod: 'The browser suite counts the area rows and reads their reasons.',
            dependencies: [],
            relevantProjectContext: ['apps/web/src/ui/pages/PlanPage.tsx'],
            implementationLocation: {
              kind: 'ProposedLocation',
              candidates: ['apps/web/src/ui/pages/PlanPage.tsx'],
              basis: 'The plan screen is where the assessment is read.',
            },
            coversOutcomeIds: ['out_readiness'],
          },
          {
            taskId: 'task_publish_gate',
            outcome: 'An unaccepted proposal cannot be published.',
            scope: 'Gate the publish control on at least one accepted proposal.',
            acceptanceCriteria: ['The publish control is disabled and says which proposals are accepted.'],
            verificationMethod: 'The browser suite reads the control before and after accepting a task.',
            dependencies: ['task_panel'],
            relevantProjectContext: ['apps/web/src/ui/pages/PublicationPage.tsx'],
            implementationLocation: {
              kind: 'ProposedLocation',
              candidates: ['apps/web/src/ui/pages/PublicationPage.tsx'],
              basis: 'Publication is gated on the accepted-proposal count.',
            },
            coversOutcomeIds: ['out_readiness'],
          },
        ],
        exclusions: [],
      },
    }),
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`Drafting the plan failed (status ${response.status}): ${text}`);
  }
  const parsed: unknown = text === '' ? null : JSON.parse(text);
  const planId = (parsed as { readonly plan?: { readonly planId?: string } } | null)?.plan?.planId;
  if (typeof planId !== 'string' || planId === '') {
    throw new Error(`The plan draft returned no plan id: ${text}`);
  }
  return { planId };
}

/**
 * The session cookie and CSRF token the signed-in browser is holding.
 *
 * The cookie is read from the browser context rather than from `document.cookie`,
 * because the session cookie is `HttpOnly` by F01-AC2 and the page deliberately cannot
 * see it. Reading it out of the page would have meant either weakening that attribute
 * for a test or guessing the token.
 */
async function sessionFromBrowser(page: Page, serverUrl: string): Promise<Session> {
  // Read without a URL filter: a scoped lookup matches on path as well as host, and the
  // session cookie is scoped to `/`, so an unfiltered read is both simpler and correct.
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
  if (session === undefined || session.value === '') {
    throw new Error('The browser is holding no session cookie, so the request below would be anonymous.');
  }
  const csrfToken = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/owner/session`, { credentials: 'same-origin' });
    const body = (await response.json()) as { readonly csrfToken?: string };
    return body.csrfToken ?? '';
  }, serverUrl);
  if (csrfToken === '') {
    throw new Error('The session route returned no CSRF token, so every write below would be refused (F01-AC4).');
  }
  return { cookie: `${SESSION_COOKIE_NAME}=${session.value}`, csrfToken };
}

function countRows(dataDirectory: string, table: string): number {
  const database = new DatabaseSync(join(dataDirectory, 'shiploop.db'), { readOnly: true });
  try {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
    const total = row === undefined ? undefined : row['total'];
    return typeof total === 'bigint' ? Number(total) : typeof total === 'number' ? total : -1;
  } finally {
    database.close();
  }
}

test.describe('server under test', () => {
  test('this run drove the shipped server entrypoint, not a substitute', async ({ shipLoopServer }) => {
    expect(
      shipLoopServer.kind,
      'the shipped src/server/main.ts did not serve this run; the substitution reason is printed above. ' +
        'Everything else in this suite is then proof of the browser client and the domain rules only.',
    ).toBe('real-entrypoint');
  });
});

test.describe('the proposed plan', () => {
  test('the owner sees every field F08-AC1 names, with the location shown as a proposal (F08-AC1, F08-AC5)', async ({
    page,
    serverUrl,
  }) => {
    const label = 'fields';
    await signInThroughTheForm(page, serverUrl);
    const { ideaId, session } = await captureThroughForm(
      page,
      `e2e planning fields ${Date.now()}: the plan must show every field F08-AC1 names`,
    );
    await seedPlan(serverUrl, session.cookie, session.csrfToken, ideaId, label);

    await openPlanForRequest(page, 'the plan must show every field F08-AC1 names');

    const panel = page.locator('[data-testid="plan-task-task_panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Render the recorded assessment area by area on the plan screen.')).toBeVisible();
    await expect(panel.getByText('All seven areas named by F09-AC1 appear with a reason beside each.')).toBeVisible();
    await expect(page.locator('[data-testid="plan-task-verification-task_panel"]')).toContainText('browser suite');
    await expect(page.locator('[data-testid="plan-task-dependencies-task_panel"]')).toContainText('Nothing');
    await expect(panel.getByText('apps/web/src/ui/pages/PlanPage.tsx').first()).toBeVisible();

    // F08-AC5: the location is labelled a proposal and carries its basis, so a
    // suggestion cannot be read as an inspected fact.
    const location = page.locator('[data-testid="plan-task-location-task_panel"]');
    await expect(location).toContainText('ProposedLocation');
    await expect(location).toContainText('a proposal, not an inspected location');
    await expect(location).toContainText('Based on: The plan screen is where the assessment is read.');

    // F08-AC2: the split carries its justification rather than the owner trusting a count.
    await expect(page.locator('[data-testid="plan-split-reason"]')).toContainText('(F08-AC2)');

    // F08-AC5: every requested outcome is accounted for, by task or by exclusion.
    await expect(page.getByRole('region', { name: 'Requested outcomes and how each is covered' })).toContainText(
      'The owner can see why a build may not start.',
    );
  });

  test('an unaccepted task has no publishable form, and accepting is what gives it one (F08-AC3)', async ({
    page,
    serverUrl,
  }) => {
    const label = 'accept';
    await signInThroughTheForm(page, serverUrl);
    const { ideaId, session } = await captureThroughForm(
      page,
      `e2e planning accept ${Date.now()}: accepting is what makes a proposal publishable`,
    );
    await seedPlan(serverUrl, session.cookie, session.csrfToken, ideaId, label);

    await openPlanForRequest(page, 'accepting is what makes a proposal publishable');

    await expect(page.getByRole('heading', { name: 'Plan and readiness', level: 2 })).toBeVisible();
    await expect(page.locator('[data-testid="plan-task-task_panel"]')).toBeVisible();

    const revision = await page.locator('[data-testid="plan-revision"]').textContent();
    expect(revision).toContain('1');

    await page.getByRole('button', { name: 'Accept "Every readiness area is on screen with its reason."' }).click();
    await expect(page.locator('[data-testid="plan-revision"]')).toContainText('2');
    await expect(page.locator('[data-testid="plan-task-task_panel"]')).toContainText('Task Accepted');

    // F08-AC3: publication is a separate screen and it is refused until something is
    // accepted, so the two screens read the same stored plan rather than separate state.
    await openLegacy(page, 'publication');
    await expect(page.getByRole('heading', { name: 'Publication and adoption', level: 2 })).toBeVisible();
    await expect(page.locator('[data-testid="publishable-count"]')).toContainText('1 accepted');
    await expect(page.getByRole('button', { name: 'Publish the accepted proposals' })).toBeEnabled();

    await page.getByRole('button', { name: 'Back to the plan' }).click();
    await page.getByRole('button', { name: 'Remove "Every readiness area is on screen with its reason."' }).click();
    await expect(page.locator('[data-testid="plan-revision"]')).toContainText('3');

    await openLegacy(page, 'publication');
    await expect(page.locator('[data-testid="publishable-count"]')).toContainText('No proposal on this plan is accepted');
    // F08-AC3: the control is not offered as available, because an unaccepted proposal
    // has no publishable representation at all.
    await expect(page.getByRole('button', { name: 'Publish the accepted proposals' })).toBeDisabled();
  });

  test('the owner reorders a task and the proposed order follows (F08-AC3, F08-AC4)', async ({ page, serverUrl }) => {
    const label = 'reorder';
    await signInThroughTheForm(page, serverUrl);
    const { ideaId, session } = await captureThroughForm(
      page,
      `e2e planning reorder ${Date.now()}: the owner reorders two proposals before publication`,
    );
    await seedPlan(serverUrl, session.cookie, session.csrfToken, ideaId, label);

    await openPlanForRequest(page, 'the owner reorders two proposals');
    await expect(page.locator('[data-testid="plan-order"]')).toHaveText('task_panel then task_publish_gate');

    await page.getByRole('button', { name: 'Move "Every readiness area is on screen with its reason." later' }).click();

    // F08-AC3: the edit is recorded against the revision on screen and the new order is
    // stated back, so the owner can see what their action did rather than infer it.
    // F08-AC3: the owner's agreed sequence is what a reorder changes, and it is stated
    // back so the owner sees what their action did rather than inferring it.
    await expect(page.getByText('The agreed order is now task_publish_gate then task_panel', { exact: false })).toBeVisible();
    await expect(page.locator('[data-testid="plan-order"]')).toHaveText('task_publish_gate then task_panel');
    // F08-AC4: the order the dependencies permit is unchanged by the owner's choice, and
    // saying so is what keeps a reorder from looking like it removed the dependency.
    await expect(page.locator('[data-testid="plan-dependency-order"]')).toHaveText('task_panel then task_publish_gate');
    await expect(page.locator('[data-testid="plan-revision"]')).toContainText('2');
  });
});

test.describe('the readiness assessment', () => {
  test('every area F09-AC1 names is assessed with a reason, and build is gated on what is unmet (F09-AC1, F09-AC2)', async ({
    page,
    serverUrl,
  }) => {
    const label = 'readiness';
    await signInThroughTheForm(page, serverUrl);
    const { ideaId, session } = await captureThroughForm(
      page,
      `e2e planning readiness ${Date.now()}: readiness must be recorded over every area`,
    );
    await seedPlan(serverUrl, session.cookie, session.csrfToken, ideaId, label);

    await openPlanForRequest(page, 'readiness must be recorded over every area');

    await expect(page.locator('[data-testid="readiness-verdict"]')).toBeVisible();
    await expect(page.locator('[data-testid="readiness-verdict"]')).toContainText('Readiness:');
    await expect(page.locator('[data-testid="readiness-verdict"]')).toContainText(
      /Readiness: (Ready|NeedsInformation|Blocked)/,
    );

    // F09-AC1: every area is present whether or not it is satisfied, each with a reason.
    for (const area of AREAS_F09_AC1) {
      const row = page.locator(`[data-testid="readiness-area-${area}"]`);
      await expect(row, `the ${area} area must be on screen (F09-AC1)`).toBeVisible();
      await expect(row).toContainText(`${area}:`);
    }

    // F09-AC3: the two tasks form a dependency, so the Dependencies area has something to
    // say about it, and it says why the dependency is not available rather than only that
    // it is not. A dependency the work consumes needs a release receipt, and "Done"
    // without one is not a delivery.
    const dependencies = page.locator('[data-testid="readiness-area-Dependencies"]');
    await expect(dependencies).toContainText('Dependencies:');
    const dependencyText = (await dependencies.textContent()) ?? '';
    expect(dependencyText).toMatch(/task_publish_gate|awaited|available/);
    expect(dependencyText, `the Dependencies area must explain itself (F09-AC3): ${dependencyText}`).not.toBe(
      'Dependencies: Satisfied',
    );

    // F09-AC2: the build control and the investigation control are separate sentences, and
    // one being disabled must not disable the other.
    const build = page.locator('[data-testid="readiness-start-build"]');
    const investigation = page.locator('[data-testid="readiness-start-investigation"]');
    const buildDisabled = await build.isDisabled();
    const investigationDisabled = await investigation.isDisabled();
    const detail = (await page.locator('[data-testid="readiness-build-detail"]').textContent()) ?? '';
    expect(detail).not.toBe('');

    if (buildDisabled) {
      expect(detail, 'a disabled build names the areas blocking it (F09-AC2)').toContain(
        'A build is disabled because',
      );
      expect(detail).toMatch(/F09-AC2/);
      // The blocking areas are named, not summarised, so the owner knows what to fix.
      expect(detail).toContain('Access');

      // F09-AC2: read-only investigation is offered exactly when every open area is one
      // investigation can resolve. This deployment configures no ticket connector, so
      // Access is open, and a credential is the one thing investigation cannot supply; the
      // screen therefore says an operator has to act rather than offering investigation as
      // the way past it. The assertion is on the sentence the screen chooses, which is the
      // part F09-AC2 governs.
      if (investigationDisabled) {
        expect(detail).toContain('What is open cannot be resolved by investigation');
        await expect(investigation).toBeDisabled();
      } else {
        expect(detail).toContain('Read-only investigation can still be started');
        await expect(investigation).toBeEnabled();
      }
    } else {
      expect(detail).toContain('a build may start');
      await expect(build).toBeEnabled();
    }

    // F09-AC4: it is a recorded assessment, not a percentage.
    const assessment = await page.locator('[data-testid="readiness-areas"]').textContent();
    expect(assessment ?? '').not.toMatch(/\d+\s*%/);
  });
});

test.describe('publication and adoption', () => {
  test('adoption reads existing work and offers no merge control (F11-AC1, F11-AC3)', async ({ page, serverUrl }) => {
    await signInThroughTheForm(page, serverUrl);
    await openLegacy(page, 'publication');
    await expect(page.getByRole('heading', { name: 'Publication and adoption', level: 2 })).toBeVisible();

    const adoption = page.getByRole('region', { name: 'Adopt an issue that already exists' });
    await expect(adoption).toBeVisible();

    // F11-AC1, F11-AC3: nothing on this page can merge or replace. The absence is the
    // assertion: there is no such control to click.
    for (const label of ['Merge', 'Replace', 'Create a new issue', 'Sync from ShipLoop']) {
      await expect(page.getByRole('button', { name: label })).toHaveCount(0);
      await expect(page.getByRole('link', { name: label })).toHaveCount(0);
    }
    await expect(adoption).toContainText('no merge control');

    // F11-AC3: an issue is named by provider identity, and a title is never searched for.
    await expect(page.getByLabel('Issue identity')).toBeVisible();
    await expect(page.getByText('A title is not an identity')).toBeVisible();

    // F11-AC5: Build is offered and refused with its reason rather than hidden, because
    // an owner who asks for a build has to be told why it is the wrong answer.
    await expect(page.getByRole('button', { name: 'Request a Build' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request a Test' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request a Review' })).toBeVisible();
  });

  test('an empty issue identity is refused per field and the typed text survives (F02-AC4, N03-AC3)', async ({
    page,
    serverUrl,
  }) => {
    await signInThroughTheForm(page, serverUrl);
    await openLegacy(page, 'publication');

    await page.getByLabel('Issue identity').fill('   ');
    await page.getByRole('button', { name: 'Adopt this existing issue' }).click();

    await expect(page.locator('#adoption-issue-id-error')).toBeVisible();
    // The value the owner typed is still there, so a refusal costs a correction rather
    // than a retype.
    await expect(page.getByLabel('Issue identity')).toHaveValue('   ');
  });

  test('drafting a plan writes one durable row and creates no work item (F08-AC3, F10-AC1)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const label = 'durability';
    await signInThroughTheForm(page, serverUrl);
    const { ideaId, session } = await captureThroughForm(
      page,
      `e2e planning durability ${Date.now()}: a proposal is not a ticket`,
    );
    await seedPlan(serverUrl, session.cookie, session.csrfToken, ideaId, label);

    const database = new DatabaseSync(join(shipLoopServer.dataDirectory, 'shiploop.db'), { readOnly: true });
    let plans: number;
    let workItems: number;
    try {
      plans = Number(database.prepare('SELECT COUNT(*) AS total FROM plans').get()?.['total'] ?? -1);
      workItems = Number(database.prepare('SELECT COUNT(*) AS total FROM work_items').get()?.['total'] ?? -1);
    } finally {
      database.close();
    }

    expect(plans, 'the plan is a durable row, not a screen state').toBeGreaterThanOrEqual(1);
    // F10-AC1: drafting a proposal creates nothing at a provider, and no work item
    // exists until the owner acts on publication.
    expect(workItems, 'drafting a plan creates no work item').toBe(0);
    expect(countRows(shipLoopServer.dataDirectory, 'jobs')).toBe(0);
  });
});

test.describe('responsive layout', () => {
  for (const viewport of VIEWS) {
    test(`the plan screen does not scroll horizontally at ${viewport.name} (${viewport.width}x${viewport.height}) (F01-AC3)`, async ({
      page,
      serverUrl,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signInThroughTheForm(page, serverUrl);
      const { ideaId, session } = await captureThroughForm(
        page,
        `e2e planning layout ${viewport.name} ${Date.now()}: the plan screen must not scroll sideways at ${viewport.width}px`,
      );
      await seedPlan(serverUrl, session.cookie, session.csrfToken, ideaId, `layout${viewport.width}`);

      await openPlanForRequest(page, `must not scroll sideways at ${viewport.width}px`);
      await expect(page.locator('[data-testid="readiness-areas"]')).toBeVisible();

      const measurement = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      expect(measurement.clientWidth).toBe(viewport.width);
      expect(measurement.scrollWidth).toBe(measurement.clientWidth);
    });
  }
});

test.describe('accessibility', () => {
  test('the plan controls are keyboard reachable with a visible focus ring, and status is not colour alone (N03-AC1)', async ({
    page,
    serverUrl,
  }) => {
    const label = 'a11y';
    await signInThroughTheForm(page, serverUrl);
    const { ideaId, session } = await captureThroughForm(
      page,
      `e2e planning a11y ${Date.now()}: every plan control must be keyboard operable`,
    );
    await seedPlan(serverUrl, session.cookie, session.csrfToken, ideaId, label);

    await openPlanForRequest(page, 'every plan control must be keyboard operable');

    // Reach the control by tabbing from the top of the document rather than focusing it
    // programmatically. A programmatic focus does not engage `:focus-visible`, so a ring
    // read that way proves nothing about what a keyboard user sees (N03-AC1).
    const accept = page.getByRole('button', { name: 'Accept "Every readiness area is on screen with its reason."' });
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    let reached = false;
    for (let step = 0; step < 80 && !reached; step += 1) {
      await page.keyboard.press('Tab');
      reached = await accept.evaluate((node) => node === document.activeElement);
    }
    expect(reached, `tabbing must reach the accept control (N03-AC1)`).toBe(true);
    await expect(accept).toBeFocused();
    const outline = await accept.evaluate((node) => window.getComputedStyle(node).outlineStyle);
    expect(outline, 'focus must be drawn, not removed').not.toBe('none');

    // Activating with the keyboard is the same action as clicking it.
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="plan-revision"]')).toContainText('2');

    // N03-AC1: the acceptance badge names the state as a word and draws a mark, so a
    // reader in monochrome or with a colour-vision difference can still read it.
    const badge = page.locator('[data-testid="plan-task-task_panel"] .badge').first();
    await expect(badge).toContainText('Task Accepted');
    await expect(badge.locator('.badge__mark')).toHaveCount(1);

    // Every readiness area is a labelled row rather than an unlabelled colour chip.
    const areas = page.locator('[data-testid="readiness-areas"] .detail-list__row');
    await expect(areas).toHaveCount(AREAS_F09_AC1.length);
    for (const area of AREAS_F09_AC1) {
      await expect(page.locator(`[data-testid="readiness-area-${area}"] .badge__label`)).toContainText(area);
    }

    // The build and investigation controls are described rather than left to a title.
    const build = page.locator('[data-testid="readiness-start-build"]');
    await expect(build).toHaveAttribute('aria-describedby', 'readiness-build-detail');
    await expect(page.locator('#readiness-build-detail')).toBeVisible();
  });

  test('a refused owner edit is announced and the plan is still readable (N03-AC1, F08-AC3)', async ({
    page,
    serverUrl,
  }) => {
    const label = 'refusal';
    await signInThroughTheForm(page, serverUrl);
    const { ideaId, session } = await captureThroughForm(
      page,
      `e2e planning refusal ${Date.now()}: a refused edit must be announced`,
    );
    await seedPlan(serverUrl, session.cookie, session.csrfToken, ideaId, label);

    await openPlanForRequest(page, 'a refused edit must be announced');

    // Submitting the combine form with nothing selected is refused locally, per field,
    // and announced rather than silently ignored.
    await page.getByRole('button', { name: 'Combine these proposals' }).click();
    await expect(page.locator('#plan-combine-into-error')).toBeVisible();
    await expect(page.getByText('Nothing was combined because the task selection is incomplete (F08-AC3).')).toBeVisible();
    // The tasks are still on screen, so a refusal costs a correction rather than a reload.
    await expect(page.locator('[data-testid="plan-task-task_panel"]')).toBeVisible();
  });
});
