/**
 * The MVP journey in a real browser: Request -> Delivery Contract -> handoff -> candidate ->
 * Review -> decision, plus the states each surface has to be able to show.
 *
 * **What is real and what is substituted.** The browser, the production client bundle, the shipped
 * `src/server/main.ts`, the real sign-in form, the real session cookie and the real CSRF token are
 * all this run's own. Only the eleven MVP endpoints are answered by `mvp-contract-server.ts`, which
 * exists because that backend is being built in parallel and is not in this worktree.
 *
 * **What these specs therefore prove, and what they do not.** They prove the browser client: that
 * the navigation is four surfaces, that the contract's revision rules hold on screen, that a
 * candidate cannot be recorded against an abbreviated SHA, that Accept is refused while
 * verification is unfinished, that Request changes needs feedback, and that loading, empty, error,
 * disconnected and stale read as five different things. They prove nothing about Builder 1's routes
 * or Builder 3's packet generation, and a green run here is not evidence for either.
 *
 * Every assertion is a measurement or a visible fact. Nothing asserts on a class, and nothing
 * asserts that a region merely exists: an empty region passes `toBeVisible` and means nothing, so
 * each one checks the words an owner would read.
 */

import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { SYNTHETIC_OWNER, SYNTHETIC_PASSWORD, expect, test } from './provisioned-owner.ts';
import { installMvpServer, MVP, HEAD_SHA, OTHER_HEAD_SHA, type MvpServer } from './mvp-contract-server.ts';

const REQUEST_TEXT = 'Add a search box to the runs list\nIt should match the run name.';

/** Signs in through the real form, because the claim under test is that an owner can reach this by typing. */
async function signIn(page: Page, serverUrl: string): Promise<void> {
  await page.goto(`${serverUrl}/#/home`);
  await page.getByLabel('Email address').fill(SYNTHETIC_OWNER.displayName);
  await page.getByLabel('Password').fill(SYNTHETIC_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Owner sections' })).toBeVisible({ timeout: 15_000 });
}

/** Chooses the project in the header, which is how every project-scoped read is addressed. */
async function chooseProject(page: Page): Promise<void> {
  await page.getByTestId('project-select').selectOption(MVP.projectId);
  await expect(page.getByTestId('project-select')).toHaveValue(MVP.projectId);
}

/** Records a request and arrives on its Delivery Contract, which is what creation navigates to. */
async function createRequest(page: Page): Promise<void> {
  await page.getByTestId('nav-new-request').click();
  await expect(page.getByRole('heading', { name: 'New request', level: 2 })).toBeVisible();
  await page.getByLabel('What do you want changed?').fill(REQUEST_TEXT);
  await page.getByTestId('create-request').click();
  await expect(page.getByRole('heading', { name: 'Delivery contract', level: 2 })).toBeVisible();
}

/** Fills a contract to the point where it can be approved, and approves it. */
/**
 * Fills a contract with one automated criterion and one owner-test criterion, and approves it.
 *
 * Two criteria on purpose, and the second one is deliberately the owner's own: a product in which
 * every criterion is machine-checkable would never show the state that matters most, which is a
 * requirement only a person can judge.
 */
async function writeAndApproveContract(page: Page): Promise<void> {
  await page.getByLabel('Outcome', { exact: true }).fill('An owner finds one run by name and reaches its detail page.');
  await page.getByLabel('Scope', { exact: true }).fill('A search field above the runs table, matching the run name.');
  await page.getByTestId('add-out-of-scope').click();
  await page.getByLabel('Exclusion 1', { exact: true }).fill('searching log output');
  await page.getByTestId('add-criterion').click();
  await page.getByLabel('Criterion 1', { exact: true }).fill('Searching a run name finds that run');
  await page.getByTestId('add-criterion').click();
  await page.getByLabel('Criterion 2', { exact: true }).fill('The owner confirms the result looks right');
  await page.getByLabel('How criterion 2 is verified').selectOption('owner_test');
  await page.getByTestId('save-contract').click();
  await expect(page.getByTestId('contract-message')).toContainText('Saved as revision 1');
  await page.getByTestId('approve-contract').click();
  await expect(page.getByTestId('contract-status')).toContainText('approved');
}

/**
 * Records what the owner observed for the criterion only they can judge.
 *
 * "I saw this work" is all this sends. There is no control anywhere that asserts a criterion
 * passed, because a client that could assert it could manufacture the evidence an acceptance rests
 * on.
 */
async function recordOwnerObservation(page: Page): Promise<void> {
  await page.getByTestId('record-observation').click();
  await expect(page.getByTestId('owner-observation-message')).toContainText('behaviour confirmed');
}

/** Prepares the implementation packet and returns once it is on screen. */
async function prepareImplementation(page: Page): Promise<void> {
  await page.getByTestId('prepare-implementation').click();
  await expect(page.getByRole('heading', { name: 'Implementation handoff', level: 2 })).toBeVisible();
  await page.getByTestId('prepare-implementation-handoff').click();
  await expect(page.getByTestId('packet-content')).toBeVisible();
}

/** Links a candidate by full SHA and arrives on its review. */
async function linkCandidate(page: Page, headSha: string): Promise<void> {
  await page.getByLabel('Repository', { exact: true }).fill(MVP.repository);
  await page.getByLabel('Pull request number (optional)', { exact: true }).fill('7');
  await page.getByLabel('Head commit SHA', { exact: true }).fill(headSha);
  await page.getByTestId('link-candidate').click();
  await expect(page.getByRole('heading', { name: 'Review', level: 2 })).toBeVisible();
}

test.describe('MVP navigation', () => {
  test('the header offers exactly four surfaces, and no retired section is among them', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);

    const tabs = page.getByRole('navigation', { name: 'Owner sections' }).getByRole('button');
    await expect(tabs).toHaveText(['Home', 'New Request', 'Review', 'Settings']);

    // Each retired label is asserted absent by name, because "the nav is short" is not the claim:
    // the claim is that the old sections are unreachable by clicking.
    for (const retired of ['Intake', 'Brief', 'Runs', 'Plan', 'Publication', 'Profiles', 'Connectors', 'Review card', 'Needs you']) {
      await expect(page.getByRole('navigation', { name: 'Owner sections' }).getByRole('button', { name: retired, exact: true })).toHaveCount(0);
    }
  });

  test('each surface is addressable, and the address survives a reload', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);

    for (const [label, hash] of [
      ['Home', '#/home'],
      ['New Request', '#/new-request'],
      ['Review', '#/review'],
      ['Settings', '#/settings'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${hash}$`));
      await page.reload();
      await expect(page.getByRole('navigation', { name: 'Owner sections' }).getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
    }
  });
});

test.describe('Home', () => {
  test('a board with nothing recorded says so in each group, and offers the one action that starts work', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);

    await expect(page.getByTestId('home-state')).toContainText('requests are recorded');
    for (const group of ['needs_you', 'in_progress', 'ready_for_review']) {
      await expect(page.getByTestId(`home-group-state-${group}`)).toContainText('Nothing in');
    }
    await expect(page.getByTestId('new-request-cta')).toBeVisible();
  });

  test('nothing on the board implies ShipLoop is running anything', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);

    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('home-item')).toHaveCount(1);
    // Every group renders even with one request on the board, because a group with nothing in it is
    // an answer and a hidden group is indistinguishable from a page that had not loaded.
    await expect(page.getByTestId('home-group-needs_you')).toBeVisible();
    // An approved contract with no candidate is not reported as progress: the handoff state belongs
    // to the owner, and nothing here observed an implementation being worked on.
    await expect(page.getByTestId('home-group-in_progress')).toContainText('Nothing in in progress');
    await expect(page.getByTestId('home-item-reason')).toContainText('a draft and has not been approved');
    await expect(page.locator('body')).not.toContainText(/agent is running|running now|in flight|queued/i);
  });

  test('a request with no project selected says so instead of listing an empty project', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);

    await expect(page.getByTestId('home-state')).toContainText('No project is selected');
  });
});

test.describe('New Request and the Delivery Contract', () => {
  test('a recorded request opens its contract at revision 1, in draft, with the request attached', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);

    await expect(page.getByTestId('contract-request-title')).toHaveText('Add a search box to the runs list');
    await expect(page.getByTestId('contract-request-description')).toContainText('It should match the run name.');
    await expect(page.getByTestId('contract-revision')).toHaveText('1');
    await expect(page.getByTestId('contract-status')).toContainText('draft');
    await expect(page.getByTestId('contract-approved-at')).toHaveText('Not approved yet.');
  });

  test('the derived title is shown before the request is recorded', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await page.getByTestId('nav-new-request').click();

    await expect(page.getByTestId('new-request-title-preview')).toContainText('The title will be taken from your first line.');
    await page.getByLabel('What do you want changed?').fill(REQUEST_TEXT);
    await expect(page.getByTestId('new-request-title-preview')).toContainText('Title: Add a search box to the runs list');
  });

  test('an empty request is refused before anything is sent, and the typed text survives', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await page.getByTestId('nav-new-request').click();

    // The submit control is disabled on an empty form, so the claim being tested is that the
    // client-side refusal exists at all rather than that the server refused it.
    await expect(page.getByTestId('create-request')).toBeDisabled();
    await page.getByLabel('What do you want changed?').fill(REQUEST_TEXT);
    await expect(page.getByTestId('create-request')).toBeEnabled();
  });

  test('an incomplete contract is refused per field, and approval lists why', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);

    await page.getByTestId('approve-contract').click();
    await expect(page.getByTestId('contract-approval-refusals')).toContainText('An outcome is required');
    await expect(page.getByTestId('contract-approval-refusals')).toContainText('At least one acceptance criterion is required');
    await expect(page.getByTestId('contract-revision')).toHaveText('1');
  });

  test('an approved contract becomes read-only until the owner says they are changing it', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);

    await expect(page.getByLabel('Outcome', { exact: true })).toBeDisabled();
    await expect(page.getByTestId('save-contract')).toBeDisabled();
    await expect(page.getByTestId('approve-contract')).toBeDisabled();
    await expect(page.getByTestId('contract-approval-refusals')).toContainText('already approved');

    // Enabling the fields makes the draft dirty, and a dirty approved revision is exactly the case
    // that must record a new revision rather than rewriting approved text.
    await page.getByTestId('revise-contract').click();
    await page.getByLabel('Outcome', { exact: true }).fill('An owner finds one run by name, its status and its last update.');
    await expect(page.getByTestId('save-contract')).toBeEnabled();
    await expect(page.getByTestId('save-contract')).toHaveText('Save as a new revision');
    await page.getByTestId('save-contract').click();
    await expect(page.getByTestId('contract-revision')).toHaveText('2');
    await expect(page.getByTestId('contract-status')).toContainText('draft');
  });

  test('every write carries the session CSRF token', async ({ page, serverUrl }) => {
    const server = await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);

    expect(server.csrfHeaders.length).toBeGreaterThan(0);
    for (const header of server.csrfHeaders) {
      expect(typeof header, 'a state-changing request carried no CSRF header').toBe('string');
      expect((header ?? '').length).toBeGreaterThan(0);
    }
  });
});

test.describe('the handoff', () => {
  test('the packet is the server\'s text, verbatim, and offers copy and an external tool', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);

    await expect(page.getByTestId('packet-content')).toHaveValue(/Contract revision: 1/);
    await expect(page.getByTestId('packet-content')).toHaveValue(/Searching a run name finds that run/);
    await expect(page.getByTestId('packet-content')).toHaveValue(/searching log output/);
    await expect(page.getByTestId('packet-revision')).toHaveText('1');

    // "Open T3" opens the configured tool in a new tab and claims nothing about starting work.
    const openT3 = page.getByTestId('open-t3');
    await expect(openT3).toHaveAttribute('href', MVP.t3Url);
    await expect(openT3).toHaveAttribute('target', '_blank');
    await expect(openT3).toHaveAttribute('rel', /noopener/);
    await expect(page.getByTestId('handoff-t3-note')).toContainText('does not send anything, start anything, or report back');
  });

  test('the copy action puts the packet on the clipboard', async ({ page, context, serverUrl }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);

    const shown = await page.getByTestId('packet-content').inputValue();
    await page.getByTestId('copy-packet').click();
    await expect(page.getByTestId('copy-state')).toContainText('on your clipboard');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(shown);
  });

  test('with no T3 address configured, the handoff states that rather than offering a dead link', async ({ page, serverUrl }) => {
    await installMvpServer(page, { t3Url: null });
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);

    await expect(page.getByTestId('open-t3')).toHaveCount(0);
    await expect(page.getByTestId('handoff-t3-note')).toContainText('No T3 address is configured');
  });

  test('a candidate cannot be linked by an abbreviated SHA, and the reason names the mistake', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);

    await page.getByLabel('Repository', { exact: true }).fill(MVP.repository);
    await page.getByLabel('Head commit SHA', { exact: true }).fill(HEAD_SHA.slice(0, 7));
    await page.getByTestId('link-candidate').click();
    await expect(page.getByTestId('sha-error')).toContainText('abbreviated SHA');
    await expect(page.getByTestId('candidate-linked')).toHaveCount(0);

    // A branch name is a different mistake and is named differently, because "the SHA is wrong"
    // would send the owner looking for a typo they never made.
    await page.getByLabel('Head commit SHA', { exact: true }).fill('feature/search-box');
    await page.getByTestId('link-candidate').click();
    await expect(page.getByTestId('sha-error')).toContainText('not a commit SHA');
  });

  test('a candidate linked by full SHA is carried to its review with that SHA, unabbreviated', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);

    await page.getByLabel('Repository', { exact: true }).fill(MVP.repository);
    await page.getByLabel('Pull request number (optional)', { exact: true }).fill('7');
    await page.getByLabel('Head commit SHA', { exact: true }).fill(HEAD_SHA);
    await page.getByTestId('link-candidate').click();

    // The review opens on the candidate that was just linked, so the SHA the owner pasted is the
    // one they are about to decide about. Asserted as an exact match on the full 40 characters:
    // an abbreviation would satisfy a `contains` check and would name a different commit.
    await expect(page.getByTestId('review-head-sha')).toHaveText(new RegExp(`^${HEAD_SHA}$`));
  });
});

test.describe('Review', () => {
  test('an unverified candidate shows what was checked and refuses Accept with the reason', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, HEAD_SHA);

    await expect(page.getByTestId('review-request')).toHaveText('Add a search box to the runs list');
    await expect(page.getByTestId('review-revision')).toHaveText('1');
    await expect(page.getByTestId('review-pr')).toContainText('#7');
    await expect(page.getByTestId('review-head-sha')).toHaveText(HEAD_SHA);
    await expect(page.getByTestId('review-check')).toHaveCount(2);

    // A check nobody ran and a check that failed are different words, and neither reads as passed.
    await expect(page.getByTestId('review-check').first()).toContainText('Waiting');
    await expect(page.getByTestId('review-check').nth(1)).toContainText('Missing');
    await expect(page.getByTestId('review-criterion')).toHaveCount(2);
    await expect(page.getByTestId('review-pending-owner-tests')).toContainText('you test this one');

    await expect(page.getByTestId('review-accept-refusals')).toContainText('Verification has not finished');
    await expect(page.getByTestId('accept-candidate')).toBeDisabled();
    // Verification is not a decision, so nothing here reports one as made.
    await expect(page.getByTestId('review-decision-state')).toContainText('No decision recorded');
  });

  test('the review offers Request changes and Accept, and nothing that merges, releases or deploys', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, HEAD_SHA);

    await expect(page.getByTestId('request-changes')).toBeVisible();
    await expect(page.getByTestId('accept-candidate')).toBeVisible();
    for (const removed of ['Merge', 'Release', 'Deploy', 'Ship it', 'Publish']) {
      await expect(page.getByRole('button', { name: removed, exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: removed, exact: true })).toHaveCount(0);
    }
  });

  test('requesting changes needs feedback, and keeps it against the commit that was tested', async ({ page, serverUrl }) => {
    const server = await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, HEAD_SHA);

    await page.getByTestId('request-changes').click();
    await expect(page.getByTestId('review-feedback-error')).toContainText('Feedback with nothing in it is not feedback');
    await expect(server.state.decisions()).toHaveLength(0);

    await page.getByLabel('What is wrong with this work', { exact: true }).fill('The search ignores the run name.');
    await page.getByTestId('request-changes').click();
    await expect(page.getByTestId('review-decision-outcome')).toContainText('Changes requested');
    expect(server.state.decisions()).toHaveLength(1);
    expect(server.state.decisions()[0]?.feedback).toBe('The search ignores the run name.');
    expect(server.state.decisions()[0]?.headSha).toBe(HEAD_SHA);
  });

  test('a verified candidate can be accepted, and the acceptance is bound to the exact commit', async ({ page, serverUrl }) => {
    const server = await installMvpServer(page, { verificationComplete: true });
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, HEAD_SHA);

    await recordOwnerObservation(page);
    await expect(page.getByTestId('review-state')).toContainText('Verification recorded');
    await expect(page.getByTestId('review-accept-refusals')).toHaveCount(0);
    await expect(page.getByTestId('accept-candidate')).toBeEnabled();

    await page.getByTestId('accept-candidate').click();
    await expect(page.getByTestId('review-decision-outcome')).toContainText('Nothing is merged or deployed');
    const decision = server.state.decisions()[0];
    expect(decision?.kind).toBe('accepted');
    expect(decision?.headSha).toBe(HEAD_SHA);
    expect(decision?.contractRevision).toBe(1);

    // Accepting again is refused rather than silently doing nothing.
    await expect(page.getByTestId('accept-candidate')).toBeDisabled();
    await expect(page.getByTestId('review-accept-refusals')).toContainText('already accepted');
  });

  test('a candidate with no linked contract revision cannot be accepted, and the stale reason is shown', async ({ page, serverUrl }) => {
    await installMvpServer(page, { verificationComplete: true, staleCandidate: true });
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, OTHER_HEAD_SHA);

    await recordOwnerObservation(page);
    await expect(page.getByTestId('review-stale')).toContainText('stale');
    await expect(page.getByTestId('review-state')).toContainText('Stale');
    await expect(page.getByTestId('review-accept-refusals')).toContainText('This review is stale');
    await expect(page.getByTestId('accept-candidate')).toBeDisabled();
    // Changes remain available: a stale review is still reviewable.
    await expect(page.getByTestId('request-changes')).toBeEnabled();
  });

  test('the queue lists a candidate by its request, revision and full SHA before it is opened', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, HEAD_SHA);

    await page.getByTestId('back-to-review-queue').click();
    await expect(page.getByTestId('review-queue-item')).toHaveCount(1);
    await expect(page.getByTestId('review-queue-item')).toContainText('Add a search box to the runs list');
    await expect(page.getByTestId('review-queue-summary')).toContainText('contract revision 1');
    await expect(page.getByTestId('review-queue-sha')).toHaveText(HEAD_SHA);
  });
});

test.describe('Settings', () => {
  test('project, GitHub, optional Linear and the T3 address are all here, and no connector page is needed', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await page.getByTestId('nav-settings').click();

    await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Project', level: 3 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'GitHub', level: 3 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Linear (optional)', level: 3 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'T3 address (optional)', level: 3 })).toBeVisible();

    await expect(page.getByTestId('settings-state')).toContainText(MVP.projectName);
    await expect(page.getByLabel('Repository', { exact: true })).toHaveValue(`https://${MVP.repository}`);
    await expect(page.getByLabel('Base branch', { exact: true })).toHaveValue('main');
    // A credential reference, never a secret: the field names where the secret lives.
    await expect(page.getByLabel('GitHub credential reference', { exact: true })).toHaveValue('env:E2E_SYNTHETIC_REPO_TOKEN');
    await expect(page.getByLabel('Linear team key (optional)', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('T3 address', { exact: true })).toHaveValue(MVP.t3Url);
    await expect(page.getByTestId('settings-t3-state')).toContainText('Configured');
  });

  test('a missing optional connector is stated as optional, not rendered as an unfinished form', async ({ page, serverUrl }) => {
    await installMvpServer(page, { linearTeamKey: null, t3Url: null, githubConfigured: false });
    await signIn(page, serverUrl);
    await chooseProject(page);
    await page.getByTestId('nav-settings').click();

    await expect(page.getByTestId('settings-state')).toBeVisible();
    const linear = page.locator('section[aria-labelledby="settings-linear-title"]');
    await expect(linear).toContainText('Linear: not configured');
    await expect(linear).toContainText('Every other step still works without one');
    await expect(page.getByTestId('settings-t3-state')).toContainText('No T3 address is configured');
  });

  test('an invalid T3 address is refused by the server and its reason is shown', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await page.getByTestId('nav-settings').click();

    await page.getByLabel('T3 address', { exact: true }).fill('not a url');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-save-failure')).toContainText('https URL');
    await expect(page.getByTestId('settings-save-message')).toHaveCount(0);
  });

  test('saving a project name and a credential reference is reported back', async ({ page, serverUrl }) => {
    const server = await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await page.getByTestId('nav-settings').click();

    await page.getByLabel('Project name', { exact: true }).fill('Renamed Synthetic Project');
    await page.getByLabel('Linear team key (optional)', { exact: true }).fill('ENG');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-save-message')).toContainText('Saved');

    expect(server.state.settings().name).toBe('Renamed Synthetic Project');
    expect(server.state.settings().linearTeamKey).toBe('ENG');
  });
});

test.describe('the states a surface has to be able to show', () => {
  test('loading says the surface is asking, so an empty board is not mistaken for one', async ({ page, serverUrl }) => {
    await installMvpServer(page, { homeDelayMs: 1500 });
    await signIn(page, serverUrl);
    await chooseProject(page);

    await expect(page.getByTestId('home-state')).toContainText('Reading your requests…');
    await expect(page.getByTestId('home-state')).toContainText('requests are recorded');
  });

  test('an unreachable server marks the view no longer current, and the retry recovers it', async ({ page, serverUrl }) => {
    const server = await installMvpServer(page, { homeFault: 'transport' });
    await signIn(page, serverUrl);
    await chooseProject(page);

    await expect(page.locator('[data-connected="false"]')).toBeVisible();
    await expect(page.getByTestId('home-state')).toContainText('could not be reached');
    await expect(page.getByTestId('home-retry')).toBeVisible();

    // The retry has to be shown to *recover*, not merely to exist: a control that re-renders the
    // same failure would pass a "is it there" assertion while doing nothing.
    server.heal();
    await page.getByTestId('home-retry').click();
    await expect(page.locator('[data-connected="true"]')).toBeVisible();
    await expect(page.getByTestId('home-state')).toContainText('requests are recorded');
  });

  // A refusal is an answer. Marking the view stale because the server declined would tell the owner
  // their data had gone out of date when the server received the request and said no.
  test('a refusal is shown as an error without claiming the connection was lost', async ({ page, serverUrl }) => {
    await installMvpServer(page, { homeFault: 'server' });
    await signIn(page, serverUrl);
    await chooseProject(page);

    await expect(page.getByTestId('home-state')).toContainText('could not be collected right now');
    await expect(page.locator('[data-connected="false"]')).toHaveCount(0);
  });

  test('a contract address that names nothing is its own state rather than an empty editor', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);

    await page.evaluate(() => {
      window.location.hash = '#/contracts/ctc_does_not_exist';
    });
    await expect(page.getByTestId('contract-state')).toContainText('No contract was found at this address');
    await expect(page.getByLabel('Outcome', { exact: true })).toHaveCount(0);
  });

  test('nothing is waiting is an answer, and every group still says so', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await page.getByTestId('nav-review').click();

    await expect(page.getByTestId('review-state')).toContainText('Nothing is waiting on your decision');
    await expect(page.getByRole('heading', { name: 'Nothing to decide', level: 3 })).toBeVisible();
  });
});

test.describe('the owner judgement the product cannot make for them', () => {
  test('an owner observation is stored against the criterion and the exact commit, never a verdict', async ({ page, serverUrl }) => {
    const server = await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, HEAD_SHA);

    // The observation names the environment it was made in, because "it worked locally" and "it
    // worked on the deployment" are different claims about the same criterion.
    await page.getByLabel('Where you tested it').selectOption('Preview');
    await page.getByLabel('What you saw').selectOption('BehaviorConfirmed');
    await page.getByTestId('record-observation').click();
    await expect(page.getByTestId('owner-observation-message')).toContainText('on Preview');
    await expect(page.getByTestId('owner-observation-message')).toContainText(HEAD_SHA);

    const write = server.calls.find((call) => call.path.endsWith('/observations'));
    assert.ok(write !== undefined, 'no owner observation reached the server');
    const body = write.body as Record<string, unknown>;
    // The vocabulary is an observation, never "this passed". A body carrying a verdict would let a
    // client manufacture the evidence an acceptance rests on.
    assert.equal(body['observation'], 'BehaviorConfirmed');
    assert.equal(body['environment'], 'Preview');
    assert.equal(body['expectedHeadSha'], HEAD_SHA);
    assert.equal('status' in body, false, 'a client must not be able to send a criterion status');
    assert.equal('verdict' in body, false, 'a client must not be able to send a verdict');
  });

  test('a candidate is still unverified after an owner observation, because the owner is not a check', async ({ page, serverUrl }) => {
    await installMvpServer(page, { observationCompletesVerification: false });
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, HEAD_SHA);

    await recordOwnerObservation(page);
    // The observation was recorded and the criterion now has evidence, yet verification is still
    // unfinished. That is the truthfulness this product is built on: a person's report is not a check.
    await expect(page.getByTestId('review-accept-refusals')).toContainText('Verification has not finished');
    await expect(page.getByTestId('accept-candidate')).toBeDisabled();
    // And changes remain available whatever the verification says.
    await expect(page.getByTestId('request-changes')).toBeEnabled();
  });

  test('an observation naming a commit that has moved is refused rather than re-attributed', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await writeAndApproveContract(page);
    await prepareImplementation(page);
    await linkCandidate(page, HEAD_SHA);

    // The refusal is arranged at the transport: a 409 the moment an observation is posted, which is
    // what the server does when the candidate has moved since the review was collected. Only the
    // client is under test here, so the refusal is injected rather than reproduced.
    await page.route('**/api/review/**', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'POST' || !url.pathname.endsWith('/observations')) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'Conflict',
            message: 'The candidate has moved since this review was collected.',
            fields: [],
            prerequisites: [],
          },
        }),
      });
    });

    await page.getByTestId('record-observation').click();
    await expect(page.getByTestId('owner-observation-failure')).toContainText('The candidate has moved');
    await expect(page.getByTestId('owner-observation-message')).toHaveCount(0);
  });
});

test.describe('responsive layout and accessibility', () => {
  for (const viewport of [
    { name: 'phone', width: 375, height: 812 },
    { name: 'desktop', width: 1280, height: 900 },
  ]) {
    test(`the MVP surfaces do not scroll horizontally at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
      serverUrl,
    }) => {
      await installMvpServer(page, { verificationComplete: true });
      await signIn(page, serverUrl);
      // The viewport is set here rather than assumed from the project config, which pins a desktop
      // device. A responsive measurement taken at an unintended width asserts nothing at all.
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await chooseProject(page);
      await createRequest(page);
      await writeAndApproveContract(page);
      await prepareImplementation(page);
      await linkCandidate(page, HEAD_SHA);

      for (const hash of ['#/home', '#/new-request', '#/review', '#/settings', `#/review/${HEAD_SHA}`]) {
        await page.evaluate((value) => {
          window.location.hash = value;
        }, hash);
        await page.waitForLoadState('networkidle');
        const measurement = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(measurement.clientWidth, hash).toBe(viewport.width);
        expect(measurement.scrollWidth, `${hash} scrolls sideways at ${viewport.name}`).toBe(measurement.clientWidth);
      }
    });
  }

  test('every contract control is labelled and reachable by keyboard, with a visible focus ring', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);
    await page.getByTestId('add-criterion').click();

    // No control on the contract page may be nameless: a screen reader announcing "text field 3"
    // is the same as announcing nothing, and the owner has to hear which requirement they are editing.
    for (const control of await page.locator('.page input, .page textarea, .page select, .page button').all()) {
      const name = await control.evaluate((element) => {
        const labelled = element.getAttribute('aria-label');
        if (labelled !== null && labelled !== '') return labelled;
        const id = element.getAttribute('id');
        if (id !== null) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label !== null) return label.textContent ?? '';
        }
        return element.textContent ?? '';
      });
      expect(name.trim().length, 'a contract control has no accessible name').toBeGreaterThan(0);
    }

    const outcome = page.getByLabel('Outcome', { exact: true });
    await outcome.focus();
    await expect(outcome).toBeFocused();
    const outline = await outcome.evaluate((element) => window.getComputedStyle(element).outlineStyle);
    expect(outline).not.toBe('none');
  });

  test('contract state is carried by words, not by colour alone', async ({ page, serverUrl }) => {
    await installMvpServer(page);
    await signIn(page, serverUrl);
    await chooseProject(page);
    await createRequest(page);

    const badge = page.getByTestId('contract-status');
    await expect(badge).toContainText('draft');
    await expect(badge.locator('.badge__mark')).toBeVisible();
    await expect(badge.locator('.badge__label')).toBeVisible();
  });
});

test.describe('the whole journey, end to end', () => {
  test('one request becomes an approved contract, a packet, a linked candidate and an owner decision', async ({
    page,
    serverUrl,
  }) => {
    const server: MvpServer = await installMvpServer(page, { verificationComplete: true });
    await signIn(page, serverUrl);
    await chooseProject(page);

    // Request -> contract.
    await createRequest(page);
    // Contract -> approved.
    await writeAndApproveContract(page);
    // Contract -> handoff.
    await prepareImplementation(page);
    // Handoff -> candidate.
    await linkCandidate(page, HEAD_SHA);
    // Candidate -> evidence, including the criterion only the owner can judge.
    await expect(page.getByTestId('review-accept-refusals')).toContainText('Verification has not finished');
    await recordOwnerObservation(page);
    // Candidate -> decision.
    await page.getByTestId('accept-candidate').click();
    await expect(page.getByTestId('review-decision-state')).toContainText('accepted');

    // Back on Home, the request is settled rather than outstanding, and is counted rather than
    // silently dropped: a request that disappears is indistinguishable from one never captured.
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('home-settled')).toContainText('1 request has been accepted');
    await expect(page.getByTestId('home-item')).toHaveCount(0);
    await expect(page.getByTestId('home-group-state-ready_for_review')).toContainText('Nothing in ready for review');

    // And the writes all reached the server through the assumed routes.
    const writes = server.calls.filter((call) => call.method === 'POST').map((call) => call.path);
    assert.deepEqual(
      writes.map((path) => path.replace(/ctc_[a-z0-9_]+/, '<contract>').replace(/cnd_[a-z0-9_]+/, '<candidate>')),
      [
        '/api/requests',
        '/api/contracts/<contract>',
        '/api/contracts/<contract>/approve',
        '/api/contracts/<contract>/handoff',
        '/api/candidates',
        '/api/review/<candidate>/observations',
        '/api/review/<candidate>/decision',
      ],
    );
  });
});