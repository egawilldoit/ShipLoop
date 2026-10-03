/**
 * The intake slice driven through a real browser against the shipped server.
 *
 * Every assertion here is a measurement or a real request against
 * `apps/web/src/server/main.ts` composed from `@shiploop/controller` (F01-AC1). The
 * flow is the owner's: sign in through the form, capture a request, read it back,
 * attach a named file, see possibly-related work before anything is published, brief
 * it, answer a question, correct it, and archive it.
 *
 * Three properties are asserted rather than assumed:
 *
 *   - this run drove the shipped entrypoint. `e2e/fixtures.ts` substitutes a real
 *     in-process server when `main.ts` cannot become ready, and announces that on
 *     stderr; without this assertion a completely broken startup would read as a
 *     passing browser gate (F01-AC1).
 *   - archiving creates no ticket and consumes no coding run. The claim is checked
 *     against the server's own SQLite file rather than against a UI badge, because a
 *     badge is what the implementation would print whether or not a row existed
 *     (F06-AC5).
 *   - the page does not scroll sideways at 375px or 1280px, read off
 *     `document.documentElement` the way `smoke.spec.ts` does, because a CSS class
 *     says what was intended and the measurement says what happened (F01-AC3).
 *
 * The "no ticket, no run" check reads the store with `node:sqlite` in read-only mode.
 * That is deliberate: the server holds the file open and this suite is a second
 * observer, exactly as a backup tool or an operator would be. The assertion that
 * matters is the count, and it is taken before and after so a pre-existing row cannot
 * make the check pass.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { SYNTHETIC_OWNER, SYNTHETIC_PASSWORD, expect, test as base } from './fixtures.ts';
import { openLegacy } from './legacy-nav.ts';

/** Tables a capture or an archive must never add a row to (F06-AC5). */
const WORK_TABLES: readonly string[] = ['work_items', 'jobs', 'attempts', 'candidates'];

const VIEWS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

/** A unique raw request per test, so a shared store cannot make a list assertion pass by accident. */
function uniqueRequest(label: string): string {
  return `e2e intake ${label} ${Date.now()} ${Math.round(Math.random() * 1e6)}: the runs list needs a way to find one run by name`;
}

function countRows(shipLoopServer: { readonly dataDirectory: string }, table: string): number {
  const database = new DatabaseSync(join(shipLoopServer.dataDirectory, 'shiploop.db'), { readOnly: true });
  try {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
    const total = row === undefined ? undefined : row['total'];
    return typeof total === 'bigint' ? Number(total) : typeof total === 'number' ? total : -1;
  } finally {
    database.close();
  }
}

function workCounts(shipLoopServer: { readonly dataDirectory: string }): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of WORK_TABLES) counts[table] = countRows(shipLoopServer, table);
  return counts;
}

/**
 * The one owner this store holds, provisioned through the real route.
 *
 * The controller's store holds a single owner and the harness does not seed it, so
 * every test here signs in against a store that would otherwise be empty and would
 * see a refused sign-in that reads exactly like a wrong password (F01-AC1).
 *
 * It is declared `auto` rather than per test on purpose. Playwright starts a fresh
 * worker, and therefore a fresh isolated server and a fresh empty database, whenever
 * the next test asks for a different set of worker-scoped fixtures; a fixture only
 * some tests declare produces exactly that. One automatic fixture means every test in
 * this file needs the same worker, so they all share one server and one provisioned
 * owner. Provisioning is idempotent because a repeated call is a `Conflict` that names
 * the owner it refused to replace, which is enough to learn the same id.
 */
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
      const parsed: unknown = text === '' ? null : JSON.parse(text);
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(
          `Provisioning the owner failed (status ${response.status}), so no signed-in fact in this file can be tested: ${text}`,
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

/**
 * Signs in through the real form and waits for the owner shell.
 *
 * The form, not a direct request, because the claim under test is that an owner can
 * reach intake by typing into a page: a fixture that signed in over raw HTTP would
 * pass whether or not the client's sign-in path works.
 */
async function signInThroughTheForm(page: Page, serverUrl: string): Promise<void> {
  await page.goto(`${serverUrl}/`);
  await page.getByLabel('Email address').fill(SYNTHETIC_OWNER.displayName);
  await page.getByLabel('Password').fill(SYNTHETIC_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Owner sections' })).toBeVisible({ timeout: 15_000 });
}

async function openIntake(page: Page): Promise<void> {
  await openLegacy(page, 'intake');
  await expect(page.getByRole('heading', { name: 'Intake', level: 2 })).toBeVisible();
}

/**
 * Opens the brief for one named request.
 *
 * Scoped to the list item carrying the request text, because the store keeps every
 * request every earlier test captured and a positional locator would open whichever
 * one happened to be last.
 */
async function openBriefFor(page: Page, request: string): Promise<void> {
  await page
    .locator('li')
    .filter({ hasText: request })
    .getByRole('button', { name: 'Open brief and questions' })
    .click();
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

test.describe('capture', () => {
  test('an owner signs in, captures a rough request and reads it back exactly as written (F06-AC1, F06-AC3)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const request = uniqueRequest('raw-request');
    const before = workCounts(shipLoopServer);

    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    // Loading, empty and ready are three different sentences, so the empty state is
    // distinguishable from a page that has not finished loading.
    await expect(page.locator('#intake-list-title + .state-line')).toBeVisible();

    await page.getByLabel('The request, in your own words').fill(request);
    await page.getByRole('button', { name: 'Capture this request' }).click();

    await expect(page.locator('[data-testid="raw-request"]')).toHaveText(request);
    await expect(page.locator('#intake-list-title').locator('..')).toContainText(request);

    // No summary exists until one is generated, and its absence is stated rather than
    // rendered as an empty string beside the request.
    await expect(page.getByText('No summary has been generated.')).toBeVisible();
    await expect(page.locator('[data-testid="generated-summary"]')).toHaveCount(0);

    expect(workCounts(shipLoopServer), 'capturing creates no ticket and consumes no coding run').toEqual(before);
  });

  test('a bug is captured from its symptom alone, with every detail optional (F06-AC3)', async ({ page, serverUrl }) => {
    const request = uniqueRequest('bug');
    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    await page.getByLabel('The request, in your own words').fill(request);
    await page.getByRole('radio', { name: 'A bug' }).check();
    await expect(page.getByLabel('Expected behaviour (optional)')).toBeVisible();
    await page.getByLabel('Actual behaviour (optional)').fill('pressing save does nothing');
    await page.getByRole('button', { name: 'Capture this request' }).click();

    await expect(page.locator('[data-testid="raw-request"]')).toHaveText(request);
    // Expected and reproduction were left blank, and each says so rather than showing
    // nothing where a value could have been.
    await expect(page.getByText('Not stated.').first()).toBeVisible();
  });

  test('a blank request is refused per field and the typed text survives (F02-AC4, N03-AC3)', async ({ page, serverUrl }) => {
    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    await page.getByLabel('The request, in your own words').fill('   ');
    await page.getByRole('button', { name: 'Capture this request' }).click();

    const refusal = page.locator('#capture-title ~ .state-line').first();
    await expect(refusal).toBeVisible();
    await expect(page.locator('#intake-raw-request-error')).toBeVisible();
    // The value the owner typed is still there, so a refusal costs a correction rather
    // than a retype.
    await expect(page.getByLabel('The request, in your own words')).toHaveValue('   ');
  });

  test('a generated summary is shown apart from the request and never in place of it (F06-AC1)', async ({
    page,
    serverUrl,
  }) => {
    const request = uniqueRequest('summary');
    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    await page.getByLabel('The request, in your own words').fill(request);
    await page.getByRole('button', { name: 'Capture this request' }).click();
    await expect(page.locator('[data-testid="raw-request"]')).toHaveText(request);

    await page.getByLabel('Generated summary').fill('The owner cannot find a run by name.');
    await page.getByLabel('Generated by').fill('e2e-summary-generator');
    await page.getByRole('button', { name: 'Record summary' }).click();

    await expect(page.locator('[data-testid="generated-summary"]')).toHaveText('The owner cannot find a run by name.');
    await expect(page.locator('[data-testid="raw-request"]')).toHaveText(request);
    await expect(page.getByText('e2e-summary-generator', { exact: false })).toBeVisible();
  });

  test('an attachment is added by name and an escaping name is refused per field (F06-AC1)', async ({ page, serverUrl }) => {
    const request = uniqueRequest('attachment');
    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    await page.getByLabel('The request, in your own words').fill(request);
    await page.getByRole('button', { name: 'Capture this request' }).click();
    await expect(page.locator('[data-testid="raw-request"]')).toHaveText(request);

    await page.getByLabel('File name').fill('../escape.txt');
    await page.getByLabel('File content').fill('should never be written');
    await page.getByRole('button', { name: 'Attach file' }).click();

    // The refusal names the offending field and arrives as a 400 with a field message,
    // beside the input rather than as a banner.
    const nameError = page.locator('#intake-attachment-name-error');
    await expect(nameError).toBeVisible();
    await expect(nameError).toContainText('path separator');

    await page.getByLabel('File name').fill('e2e-run-list-notes.txt');
    await page.getByRole('button', { name: 'Attach file' }).click();
    await expect(page.getByText('e2e-run-list-notes.txt (text/plain', { exact: false })).toBeVisible();
  });
});

test.describe('possibly-related work before publication', () => {
  test('resemblance is offered with an explicit choice and nothing is merged (F06-AC4)', async ({ page, serverUrl, shipLoopServer }) => {
    const before = workCounts(shipLoopServer);
    const first = uniqueRequest('related-first');
    const second = uniqueRequest('related-second');

    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    for (const request of [first, second]) {
      await page.getByLabel('The request, in your own words').fill(request);
      await page.getByRole('button', { name: 'Capture this request' }).click();
      await expect(page.locator('[data-testid="raw-request"]')).toHaveText(request);
    }

    // Work on the second request, which is the near-duplicate of the first. It is
    // selected by name rather than by position, because the store already holds every
    // request the earlier tests captured.
    await page
      .locator('li')
      .filter({ hasText: second })
      .getByRole('button', { name: /Work on this request|Selected request/ })
      .click();
    await expect(page.locator('[data-testid="raw-request"]')).toHaveText(second);

    await page.getByRole('button', { name: 'Check for related work' }).click();
    const related = page.locator('#intake-related-title ~ .state-line').first();
    await expect(related).toBeVisible();
    await expect(related).toContainText('Nothing has been merged.');

    // The three choices are offered as three separate controls. There is no merge
    // control, because there is nothing here that could merge.
    await expect(page.getByRole('button', { name: 'Link to the existing request' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Extend the existing request' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create a new issue instead' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Extend the existing request' }).first().click();
    await expect(page.getByText('You chose "Extend the existing request"', { exact: false })).toBeVisible();
    await expect(page.getByText('Nothing was merged', { exact: false }).first()).toBeVisible();

    expect(workCounts(shipLoopServer), 'choosing a relation creates no ticket').toEqual(before);
  });
});

test.describe('brief and clarification', () => {
  test('the brief carries the seven sections, a question states why it mattered, and a correction appends (F07-AC1, F07-AC2, F07-AC3)', async ({
    page,
    serverUrl,
  }) => {
    const request = uniqueRequest('brief');
    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    await page.getByLabel('The request, in your own words').fill(request);
    await page.getByRole('button', { name: 'Capture this request' }).click();
    await expect(page.locator('[data-testid="raw-request"]')).toHaveText(request);

    await openBriefFor(page, request);
    await expect(page.getByRole('heading', { name: 'Brief and clarification', level: 2 })).toBeVisible();
    await expect(page.locator('[data-testid="brief-raw-request"]')).toHaveText(request);

    // A brief with no versions yet says so, which is a different sentence from loading.
    await expect(page.getByText('No brief has been drafted for this request yet.')).toBeVisible();

    // A criterion that only states a quality is refused with a per-field message, and
    // the rest of the form survives it.
    const draft = page.getByRole('region', { name: 'Draft the first brief' });
    await draft.getByLabel('Problem').fill('The runs list offers no way to find one run by name');
    await draft.getByLabel('Desired outcome').fill('An owner finds one run by name and reaches its detail page');
    await draft.getByLabel('Included behaviour').fill('a search field above the runs table');
    await draft.getByLabel('Excluded behaviour').fill('searching log output');
    await draft.getByLabel('Assumptions').fill('runs are listed per project');
    await draft.getByLabel('Acceptance criteria').fill('AC-1 | the search feels fast and intuitive');
    await draft.getByRole('button', { name: 'Record this brief' }).click();

    await expect(page.locator('#draft-acceptanceCriteria-error')).toBeVisible();
    await expect(page.locator('#draft-acceptanceCriteria-error')).toContainText('states a quality rather than a behaviour');

    await draft
      .getByLabel('Acceptance criteria')
      .fill('AC-1 | typing a run name shows that run in the results list\nAC-2 | the results list shows the run name and its status');
    await draft.getByRole('button', { name: 'Record this brief' }).click();

    await expect(page.getByText('Brief version 1 recorded as a proposal. It is not agreed yet.', { exact: false })).toBeVisible();
    for (const section of [
      'Problem',
      'Desired outcome',
      'Included behaviour',
      'Excluded behaviour',
      'Assumptions',
      'Acceptance criteria',
      'Unresolved questions',
    ]) {
      await expect(page.getByRole('heading', { name: section, exact: true }).first()).toBeVisible();
    }

    // Agreement is about scope, and the screen says so rather than implying acceptance.
    await page.getByRole('button', { name: 'Agree version 1' }).click();
    await expect(page.getByText('Agreement is not product acceptance, delivery or release.', { exact: false })).toBeVisible();
    await expect(page.locator('[data-testid="brief-version-1"]')).toContainText('State: Agreed');

    // A material ambiguity earns a question. The ambiguity lives in the ask form, so
    // each control is addressed inside that region rather than by a bare label.
    const ask = page.getByRole('region', { name: 'Ask the questions worth asking' });
    await ask.getByLabel('One ambiguity you think is open (optional)').fill('what the search matches on');
    await ask.getByLabel('First possible reading').fill('the run name only');
    await ask.getByLabel('Second possible reading').fill('the run name and its labels');
    await ask.getByLabel('Request text that shows the ambiguity exists').fill(request);
    await ask.getByRole('button', { name: 'Ask clarifying questions' }).click();
    await expect(page.getByText('1 question was asked', { exact: false })).toBeVisible();

    const asked = page.getByRole('region', { name: 'Questions asked' });
    await expect(asked).toContainText('Each reading changes what is built');
    await expect(asked).toContainText('the run name and its labels');

    await asked.getByLabel('Your answer').fill('the run name only');
    await asked.getByRole('button', { name: 'Record this answer' }).click();
    await expect(asked).toContainText('It cannot be changed once recorded.');
    await expect(asked).toContainText('the run name only');

    // A correction appends the next version and leaves the prior one readable.
    const correction = page.getByRole('region', { name: 'Record a correction' });
    await correction.getByLabel('What are you correcting, in your own words?').fill('also match labels');
    await correction
      .getByLabel('Acceptance criteria')
      .fill('AC-1 | typing a run name shows that run in the results list\nAC-3 | selecting a label shows only the runs carrying that label');
    await correction.getByRole('button', { name: 'Append version 2' }).click();

    await expect(page.getByText('Version 2 was appended. Version 1 stays readable and withdrew AC-2.', { exact: false })).toBeVisible();
    await expect(page.locator('[data-testid="brief-version-1"]')).toContainText('State: Agreed');
    await expect(page.locator('[data-testid="brief-version-1"]')).toContainText('AC-2');
    await expect(page.locator('[data-testid="brief-version-2"]')).toContainText('State: Proposed');
    await expect(page.locator('[data-testid="brief-raw-request"]')).toHaveText(request);
  });
});

test.describe('archive', () => {
  test('archiving sets a request aside and creates no ticket and no coding run (F06-AC5)', async ({
    page,
    serverUrl,
    shipLoopServer,
  }) => {
    const request = uniqueRequest('archive');
    const before = workCounts(shipLoopServer);

    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    await page.getByLabel('The request, in your own words').fill(request);
    await page.getByRole('button', { name: 'Capture this request' }).click();
    await expect(page.locator('[data-testid="raw-request"]')).toHaveText(request);
    // Scoped to the list item for this request, because the store holds every request
    // every earlier test captured.
    const listed = page.locator('li').filter({ hasText: request });
    await expect(listed.getByText('Disposition: Unpublished')).toBeVisible();

    // Two steps, and the second names its target, because archiving is not something
    // an owner should do to the wrong request by accident.
    await page.getByRole('button', { name: 'Archive this request' }).click();
    await page.getByRole('button', { name: 'Confirm archiving this request' }).click();
    await expect(page.getByText('No ticket was created and no coding run was consumed.', { exact: false })).toBeVisible();
    await expect(listed.getByText('Disposition: Archived')).toBeVisible();

    // The claim is checked against the server's own store, not against the badge.
    expect(workCounts(shipLoopServer), 'archiving creates no ticket and consumes no coding run').toEqual(before);
    await expect(page.getByRole('button', { name: 'Already archived' })).toBeVisible();
  });
});

test.describe('responsive layout', () => {
  for (const viewport of VIEWS) {
    test(`the intake screen does not scroll horizontally at ${viewport.name} (${viewport.width}x${viewport.height}) (F01-AC3)`, async ({
      page,
      serverUrl,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signInThroughTheForm(page, serverUrl);
      await openIntake(page);

      await page.getByLabel('The request, in your own words').fill(uniqueRequest('layout'));
      await page.getByRole('button', { name: 'Capture this request' }).click();
      await expect(page.locator('[data-testid="raw-request"]')).toBeVisible();
      await page.getByRole('button', { name: 'Check for related work' }).click();
      await page.waitForLoadState('networkidle');

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
  test('every intake control is keyboard reachable with a visible focus ring (N03-AC1)', async ({ page, serverUrl }) => {
    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);

    const request = page.getByLabel('The request, in your own words');
    await request.focus();
    await expect(request).toBeFocused();

    const outline = await request.evaluate((node) => window.getComputedStyle(node).outlineStyle);
    expect(outline, 'focus must be drawn, not removed').not.toBe('none');

    // Tab from the request field reaches the kind group, so the capture form is
    // operable without a pointer. The group is one tab stop and the arrow keys move
    // within it, which is the platform convention rather than a gap in the page.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'A feature request' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: 'A bug' })).toBeFocused();
    await expect(page.getByLabel('Expected behaviour (optional)')).toBeVisible();
  });

  test('the brief screen controls are labelled and reachable by keyboard (N03-AC1)', async ({ page, serverUrl }) => {
    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);
    const request = uniqueRequest('a11y');
    await page.getByLabel('The request, in your own words').fill(request);
    await page.getByRole('button', { name: 'Capture this request' }).click();
    await openBriefFor(page, request);

    await expect(page.getByRole('heading', { name: 'Brief and clarification', level: 2 })).toBeVisible();
    const draft = page.getByRole('region', { name: 'Draft the first brief' });
    for (const label of ['Problem', 'Desired outcome', 'Included behaviour', 'Excluded behaviour', 'Assumptions', 'Acceptance criteria', 'Unresolved questions']) {
      await expect(draft.getByLabel(label)).toBeVisible();
    }
    await draft.getByLabel('Problem').focus();
    await expect(draft.getByLabel('Problem')).toBeFocused();

    // A button is named by its own text, so it is addressed by role rather than by a
    // label element: a control's accessible name is the claim being checked here.
    const back = page.getByRole('button', { name: 'Back to intake' });
    await back.focus();
    await expect(back).toBeFocused();
    await expect(back).toHaveText('Back to intake');
  });

  test('status is carried by text and shape, never by colour alone (N03-AC1)', async ({ page, serverUrl }) => {
    await signInThroughTheForm(page, serverUrl);
    await openIntake(page);
    await page.getByLabel('The request, in your own words').fill(uniqueRequest('status-shape'));
    await page.getByRole('button', { name: 'Capture this request' }).click();

    const badge = page.locator('.badge', { hasText: 'Disposition: Unpublished' }).first();
    await expect(badge).toBeVisible();
    // The word is in the text, so a monochrome reader is not relying on the mark.
    await expect(badge).toContainText('Unpublished');
    await expect(badge.locator('.badge__mark')).toBeVisible();
  });
});