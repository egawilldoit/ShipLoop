/**
 * The session boundary, exercised over real HTTP against the shipped server.
 *
 * These are API-level facts rather than screen facts, and every path and body key in this file is
 * the one `apps/web/src/server/routes/*.ts` actually serves. That is a change from the earlier
 * version, which spoke the harness substitute server's private API (`/api/session`, with
 * `/api/owner` as a write target) and therefore had nothing to say about the application: on the
 * shipped server those paths are not routed at all, so every request fell through to the
 * not-found handler and was answered with the same 401 an anonymous caller gets. The suite read
 * as a contract test while proving nothing about the contract.
 *
 * Two harnesses decide which client can be used for a call. Unauthenticated calls go through
 * Playwright's isolated request context, which holds no cookies at all. Authenticated calls go
 * through a `fetch` inside the page, because that is the only client here that carries the
 * browser's own cookie jar: Playwright's `page.request` re-applies its own cookie rules and will
 * not attach a `Secure` cookie to a plain-HTTP origin, so using it for an authenticated call would
 * silently test something the owner's browser never does.
 *
 * The store is seeded once per worker through the real `POST /api/owner/provision`, because the
 * controller's store holds exactly one owner and the harness does not seed it. A session is only
 * reachable through the `signedIn` fixture, which cannot be asked for without the store being
 * seeded first: an earlier draft left provisioning as an optional fixture that a test could simply
 * not declare, and a test that skipped it got a 401 from sign-in that looked like a wrong password
 * rather than a missing owner.
 */

import type { Page } from '@playwright/test';
import {
  CSRF_HEADER,
  SESSION_COOKIE_NAME,
  SYNTHETIC_OWNER,
  SYNTHETIC_PASSWORD,
  expect,
  test as base,
} from './fixtures.ts';

const PROVISION_PATH = '/api/owner/provision';
const SIGN_IN_PATH = '/api/owner/sign-in';
const SESSION_PATH = '/api/owner/session';
const SIGN_OUT_PATH = '/api/owner/sign-out';
const PROFILES_PATH = '/api/profiles';

interface PageCall {
  readonly status: number;
  readonly body: string;
}

interface PageCallInput {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

/** A request made by the page itself, carrying whatever the browser cookie jar holds. */
async function pageCall(
  page: Page,
  url: string,
  options: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<PageCall> {
  const input: PageCallInput = {
    url,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    body: options.body ?? null,
  };
  return page.evaluate(async (call: PageCallInput) => {
    const response = await fetch(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      credentials: 'same-origin',
    });
    return { status: response.status, body: await response.text() };
  }, input);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

interface SignInResponse {
  readonly owner: { readonly ownerId: string; readonly displayName: string };
  readonly session: { readonly sessionId: string; readonly issuedAt: string; readonly expiresAt: string };
  readonly csrfToken: string;
}

async function signIn(page: Page, serverUrl: string): Promise<SignInResponse> {
  await page.goto(`${serverUrl}/`);
  const result = await pageCall(page, `${serverUrl}${SIGN_IN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json({ identifier: SYNTHETIC_OWNER.displayName, password: SYNTHETIC_PASSWORD }),
  });
  expect(result.status, `sign-in was refused: ${result.body}`).toBe(200);
  return JSON.parse(result.body) as SignInResponse;
}

/**
 * A profile body the route's own schema accepts, as an object rather than a string.
 *
 * Schema-valid on purpose. The point of the request is to reach the CSRF gate and then the domain,
 * so a body the schema would have refused would prove nothing about either: the same 400 comes
 * back for a malformed body and for a well-formed one this slice cannot satisfy, and a test that
 * cannot tell those apart is not testing the gate.
 */
function profileSave(projectId: string): Record<string, unknown> {
  return {
    projectId,
    note: 'Saved by the authentication boundary suite.',
    expectedVersionNumber: null,
    content: {
      references: {
        repository: 'example.invalid/e2e-synthetic/repo',
        ticketProvider: 'example.invalid',
        ticketTeamKey: 'E2E',
        baseBranch: 'main',
        targetBranch: 'main',
        deploymentProvider: 'example.invalid',
        engine: 'example.invalid/engine-1',
        previewComponents: [{ component: 'web', environment: 'preview' }],
      },
      policy: {
        requiredChecks: ['build'],
        deliveryBehavior: 'ManualAuthorizationOnly',
        maxFixPasses: 2,
        workspaceIsolation: 'WorktreeAndDataDirectory',
        capabilityVersion: 1,
      },
      recipe: 'npm ci && npm test',
      environment: { runtime: 'node-24', ports: [3000], secretReferences: ['env:E2E_SYNTHETIC_TOKEN'] },
    },
  };
}

interface SeededOwner {
  readonly ownerId: string;
  readonly displayName: string;
}

interface SessionFixtures {
  readonly signedIn: SignInResponse;
}

interface WorkerFixtures {
  readonly seededOwner: SeededOwner;
}

const test = base.extend<SessionFixtures, WorkerFixtures>({
  /**
   * Provisions the one owner the store holds, once per worker.
   *
   * The store is a single-owner store and the harness does not seed it, so this is what makes a
   * signed-in fact testable at all. It is idempotent because a retried test may re-enter it against
   * a store that already has the owner, and the conflict response names the owner it refused to
   * replace, so a second entry learns the same id instead of failing.
   *
   * A store the process cannot open is reported as the named cause rather than as a status code,
   * because every signed-in fact in this file depends on it and six copies of a bare 503 would be
   * six copies of a puzzle instead of one line that says what to fix.
   */
  seededOwner: [
    async ({ shipLoopServer }, use) => {
      const response = await fetch(`${shipLoopServer.origin}${PROVISION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json({ displayName: SYNTHETIC_OWNER.displayName, password: SYNTHETIC_PASSWORD }),
      });
      const body = await response.text();
      const parsed: unknown = body === '' ? null : JSON.parse(body);

      if (response.status === 503) {
        const message =
          typeof parsed === 'object' && parsed !== null
            ? String((parsed as { readonly error?: { readonly message?: unknown } }).error?.message ?? body)
            : body;
        if (message.includes('SHIPLOOP_DATABASE_PATH')) {
          throw new Error(
            'The shipped server started but its store is not configured, so no owner can be ' +
              'provisioned and no signed-in fact in this file can be tested. The controller reads ' +
              'SHIPLOOP_DATABASE_PATH and refuses to fall back to a default (F01-AC1), and ' +
              'e2e/fixtures.ts sets SHIPLOOP_DATA_DIRECTORY instead, which nothing reads. ' +
              `Server said: ${message}`,
          );
        }
        throw new Error(`Provisioning is unavailable and not for the expected reason: ${message}`);
      }

      const ownerId =
        response.status === 201
          ? (parsed as { readonly owner: { readonly ownerId: string } }).owner.ownerId
          : ((parsed as { readonly error?: { readonly actual?: unknown } }).error?.actual as string | undefined);
      if (typeof ownerId !== 'string' || ownerId === '') {
        throw new Error(`Provisioning returned no owner id (status ${response.status}): ${body}`);
      }

      await use({ ownerId, displayName: SYNTHETIC_OWNER.displayName });
    },
    { scope: 'worker' },
  ],

  /**
   * A signed-in session, which is only obtainable through a seeded store.
   *
   * Depending on `seededOwner` here rather than in each test is the whole point: a test cannot
   * receive a session from a store that was never provisioned, so the failure mode of forgetting
   * to seed does not exist. The CSRF token comes back on the sign-in response, which is how the
   * client is meant to learn it - it is derived from the session, it is in no cookie, and the
   * cookie carrying the session is `HttpOnly`, so nothing in the page could have read it.
   */
  signedIn: async ({ page, serverUrl, seededOwner }, use) => {
    void seededOwner;
    await use(await signIn(page, serverUrl));
  },
});

test.describe('authentication boundary', () => {
  // F01-AC1: `/api/health` is the one unauthenticated API route, because the browser harness cannot
  // otherwise tell "ready" from "refused" before it drives a flow. Being reachable without a session
  // is exactly what makes it a disclosure risk, so the fact that it answers at all and the fact that
  // it answers nothing are both asserted here.
  test('the health route answers an anonymous caller and discloses nothing', async ({ request, serverUrl }) => {
    const response = await request.get(`${serverUrl}/api/health`);
    expect(response.status()).toBe(200);

    const body = await response.text();
    const parsed: unknown = JSON.parse(body);
    expect(parsed).toEqual({ status: 'ok' });
    // Nothing that would help someone fingerprint the deployment either: `toEqual` above already
    // pins the value, and pinning the key set makes an added field a failure rather than a silent
    // widening of what an unauthenticated caller can read.
    expect(Object.keys(parsed as Record<string, unknown>)).toEqual(['status']);
  });

  // F01-AC1: a real private route, refused to an anonymous caller, disclosing nothing. A read and a
  // write are both asked, because the boundary has to hold for a request that would have changed
  // something as much as for one that only reads.
  //
  // The markers are the provisioned owner's real id and real display name. `SYNTHETIC_OWNER.id` is
  // deliberately not used: the shipped server mints its own owner id, so asserting that an invented
  // id is absent from a 401 body proves nothing at all.
  test('an unauthenticated private route returns 401 and no private data', async ({
    request,
    serverUrl,
    seededOwner,
  }) => {
    const read = await request.get(`${serverUrl}${SESSION_PATH}`);
    expect(read.status()).toBe(401);

    const write = await request.post(`${serverUrl}${PROFILES_PATH}`, { data: profileSave('e2e-anonymous') });
    expect(write.status()).toBe(401);

    for (const response of [read, write]) {
      const body = await response.text();
      expect(body).not.toContain(seededOwner.ownerId);
      expect(body).not.toContain(seededOwner.displayName);
    }
  });

  // F01-AC4: a state-changing request is refused for want of a forgery token even when the session
  // behind it is perfectly valid, and the refusal changes nothing.
  //
  // Sign-out is the vehicle because it is the one authenticated write this slice can actually
  // complete: it needs no body and no provider capability, so a 204 afterwards is the route having
  // worked rather than a coincidence. The "still signed in" check in the middle is what gives the
  // 403 its meaning - a refusal that had revoked the session anyway would satisfy a status
  // assertion while being exactly the wrong behaviour.
  test('a POST without a CSRF token is rejected even when the session is valid', async ({
    page,
    serverUrl,
    signedIn,
  }) => {
    expect(typeof signedIn.csrfToken).toBe('string');

    const withoutToken = await pageCall(page, `${serverUrl}${SIGN_OUT_PATH}`, { method: 'POST' });
    expect(withoutToken.status).toBe(403);
    expect(JSON.parse(withoutToken.body)).toMatchObject({ error: { code: 'Forbidden' } });

    // The refusal revoked nothing: the session is still good, which is what makes the next call a
    // fair test of the token rather than a test of a session that had already been closed.
    const stillValid = await pageCall(page, `${serverUrl}${SESSION_PATH}`);
    expect(stillValid.status).toBe(200);

    // The same request with the token the server issued succeeds, so the 403 above is the CSRF
    // rule and not a route that is simply closed.
    const withToken = await pageCall(page, `${serverUrl}${SIGN_OUT_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: signedIn.csrfToken },
    });
    expect(withToken.status).toBe(204);
    expect((await pageCall(page, `${serverUrl}${SESSION_PATH}`)).status).toBe(401);
  });

  // F01-AC4, F02-AC3: the same gate on a write that would have stored something, and the refusal
  // has to leave no trace, so the project is read back and must still be absent.
  //
  // The request carrying a valid token is expected to be refused by the domain, because this slice
  // configures no provider adapters and a profile cannot be saved without capabilities none of them
  // declare (F03-AC2). That refusal is asserted rather than avoided: it is what proves the 403 above
  // was the forgery check and not a permanently closed route. A 400 naming missing capabilities and
  // a 403 naming a missing token are different answers to different questions, and a test that only
  // ever saw the 403 could not tell a working gate from a broken route.
  test('a data write without a CSRF token is refused, writes nothing, and the token is what changed the answer', async ({
    page,
    serverUrl,
    signedIn,
  }) => {
    const projectId = 'e2e-csrf-write-project';
    const body = json(profileSave(projectId));

    const withoutToken = await pageCall(page, `${serverUrl}${PROFILES_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(withoutToken.status).toBe(403);
    expect(JSON.parse(withoutToken.body)).toMatchObject({ error: { code: 'Forbidden' } });

    // Nothing was stored. A gate that refused the request but let the write through would answer 403
    // here and still have a profile on the next line.
    const afterRefusal = await pageCall(page, `${serverUrl}${PROFILES_PATH}/${projectId}`);
    expect(afterRefusal.status).toBe(404);
    expect(JSON.parse(afterRefusal.body)).toMatchObject({ error: { code: 'NotFound' } });

    const withToken = await pageCall(page, `${serverUrl}${PROFILES_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: signedIn.csrfToken, 'content-type': 'application/json' },
      body,
    });
    // The forgery token was accepted; the write then failed on this slice's own policy, naming every
    // capability it would have needed and finding no adapter that declares it.
    expect(withToken.status).toBe(400);
    const refused = JSON.parse(withToken.body) as {
      readonly error: { readonly code: string; readonly fields: readonly { path: string; message: string }[] };
    };
    expect(refused.error.code).toBe('Invalid');
    expect(refused.error.fields.length).toBeGreaterThan(0);
    for (const field of refused.error.fields) {
      expect(field.path).toBe('connectors');
      expect(field.message).toMatch(/no configured .* adapter declares it/);
    }
  });

  // F01-AC2, F01-AC4: the session cookie is HttpOnly, Secure and SameSite=Strict, and those flags
  // come from the domain policy rather than from a literal at a call site. The sign-in here is issued
  // through `page.request` rather than the `signedIn` fixture so that the cookie being inspected is
  // provably the one this request created.
  test('sign-in sets an HttpOnly, Secure, SameSite=Strict cookie', async ({
    page,
    context,
    serverUrl,
    seededOwner,
  }) => {
    await page.goto(`${serverUrl}/`);

    const response = await page.request.post(SIGN_IN_PATH, {
      data: { identifier: SYNTHETIC_OWNER.displayName, password: SYNTHETIC_PASSWORD },
    });
    expect(response.status()).toBe(200);

    // Unfiltered on purpose: Playwright hides `Secure` cookies from a `http://` URL query, and
    // inspecting a `Secure` cookie is the point of this test.
    const cookie = (await context.cookies()).find((entry) => entry.name === SESSION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');

    // HttpOnly means the page itself cannot read the token, which is why the browser can send it
    // and no script in the page can.
    expect(await page.evaluate(() => document.cookie)).not.toContain(SESSION_COOKIE_NAME);
    expect((await pageCall(page, `${serverUrl}${SESSION_PATH}`)).status).toBe(200);
    // The cookie the jar holds is the one the server issued, not a stray one from another test.
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.value).not.toBe(seededOwner.ownerId);
  });

  // F01-AC2: sign-out is server-side, not a deleted cookie. The replay is the proof - it is a
  // different request context carrying only the captured token, so nothing about the browser's own
  // state can be doing the refusing.
  test('sign-out invalidates the session server-side', async ({ page, context, request, serverUrl, signedIn }) => {
    const cookie = (await context.cookies()).find((entry) => entry.name === SESSION_COOKIE_NAME);
    expect(cookie?.value).toBeTruthy();
    const capturedValue = String(cookie?.value);

    // The token works right up to the moment sign-out lands.
    expect((await pageCall(page, `${serverUrl}${SESSION_PATH}`)).status).toBe(200);

    const signOut = await pageCall(page, `${serverUrl}${SIGN_OUT_PATH}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: signedIn.csrfToken },
    });
    expect(signOut.status).toBe(204);

    // Replaying the exact token that worked a moment ago is now refused. The message names the
    // revocation, which is more than a generic refusal: the server read the stored row and found it
    // signed out, rather than failing to recognise a token it had never issued.
    const replay = await request.get(`${serverUrl}${SESSION_PATH}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${capturedValue}` },
    });
    expect(replay.status()).toBe(401);
    const replayBody = await replay.text();
    expect(replayBody).toContain('signed out');
    expect(replayBody).not.toContain(signedIn.owner.ownerId);
    expect(replayBody).not.toContain(signedIn.owner.displayName);
  });

  // N02-AC1: a wrong password and an unknown owner are answered identically, so neither the
  // transport nor the use case can be read as an owner-existence oracle. Compared on the status, the
  // response length and the body, because a difference in any one of them is enough to leak.
  test('a wrong password and an unknown owner are indistinguishable', async ({
    request,
    serverUrl,
    seededOwner,
  }) => {
    const wrongPassword = await request.post(`${serverUrl}${SIGN_IN_PATH}`, {
      data: { identifier: SYNTHETIC_OWNER.displayName, password: 'e2e-synthetic-owner-password-9999' },
    });
    const unknownOwner = await request.post(`${serverUrl}${SIGN_IN_PATH}`, {
      data: { identifier: 'No Such Owner', password: SYNTHETIC_PASSWORD },
    });

    expect(wrongPassword.status()).toBe(401);
    expect(unknownOwner.status()).toBe(401);
    expect(wrongPassword.headers()['content-length']).toBe(unknownOwner.headers()['content-length']);
    expect(await wrongPassword.text()).toBe(await unknownOwner.text());
    // The refusal is generic: it must not name the owner that exists, only the credential that was
    // wrong. This is the body half of the comparison above, against a value genuinely in the store.
    expect(await wrongPassword.text()).not.toContain(seededOwner.ownerId);
  });
});
