/**
 * The session boundary, exercised over real HTTP against the real server.
 *
 * These are API-level facts rather than screen facts. Unauthenticated calls go through
 * Playwright's isolated request context, which holds no cookies at all. Authenticated
 * calls go through a `fetch` inside the page, because that is the only client in the
 * harness that carries the browser's own cookie jar: Playwright's `page.request`
 * re-applies its own cookie rules and will not attach a `Secure` cookie to a plain-HTTP
 * origin, so using it here would silently test something the owner's browser never does.
 */

import type { Page } from '@playwright/test';
import {
  CSRF_HEADER,
  PRIVATE_MARKERS,
  SESSION_COOKIE_NAME,
  SYNTHETIC_OWNER,
  SYNTHETIC_PASSWORD,
  expect,
  test,
} from './fixtures.ts';

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

/** Fastify only parses a JSON body when the request says it is JSON. */
function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

test.describe('authentication boundary', () => {
  // F01-AC1: `/api/health` is the one unauthenticated API route, because the browser harness
  // cannot otherwise tell "ready" from "refused" before it drives a flow. Being reachable without
  // a session is exactly what makes it a disclosure risk, so the fact that it answers at all and
  // the fact that it answers nothing are both asserted here.
  test('the health route answers an anonymous caller and discloses nothing', async ({ request, serverUrl }) => {
    const response = await request.get(`${serverUrl}/api/health`);
    expect(response.status()).toBe(200);

    const body = await response.text();
    const parsed: unknown = JSON.parse(body);
    expect(parsed).toEqual({ status: 'ok' });
    for (const marker of PRIVATE_MARKERS) {
      expect(body).not.toContain(marker);
    }
    // Nothing that would help someone fingerprint the deployment either: `toEqual` above already
    // pins the value, and pinning the key set makes an added field a failure rather than a
    // silent widening of what an unauthenticated caller can read.
    expect(Object.keys(parsed as Record<string, unknown>)).toEqual(['status']);
  });

  test('an unauthenticated private route returns 401 and no private data', async ({ request, serverUrl }) => {
    const response = await request.get(`${serverUrl}/api/owner`);
    expect(response.status()).toBe(401);

    const body = await response.text();
    for (const marker of PRIVATE_MARKERS) {
      expect(body).not.toContain(marker);
    }
  });

  test('a POST without a CSRF token is rejected even when the session is valid', async ({ page, serverUrl }) => {
    // Loaded from the server origin first: a same-origin request needs a real origin,
    // and the API never sends CORS headers, so an opaque one is refused outright.
    await page.goto(`${serverUrl}/`);

    const signIn = await pageCall(page, `${serverUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ ownerId: SYNTHETIC_OWNER.id, password: SYNTHETIC_PASSWORD }),
    });
    expect(signIn.status).toBe(200);

    // The session alone is not enough: the state change is refused for want of a token.
    const withoutToken = await pageCall(page, `${serverUrl}/api/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ displayName: 'Attempted change' }),
    });
    expect(withoutToken.status).toBe(403);
    expect(JSON.parse(withoutToken.body)).toMatchObject({ error: 'Forbidden', csrfReason: 'MissingToken' });

    const session = await pageCall(page, `${serverUrl}/api/session`);
    const csrfToken = (JSON.parse(session.body) as { readonly csrfToken: string }).csrfToken;
    expect(typeof csrfToken).toBe('string');

    // The same request with the token the server issued succeeds, so the 403 above is
    // the CSRF rule and not a route that is simply closed.
    const withToken = await pageCall(page, `${serverUrl}/api/owner`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: csrfToken, 'content-type': 'application/json' },
      body: jsonBody({ displayName: 'Attempted change' }),
    });
    expect(withToken.status).toBe(200);
  });

  test('sign-in sets an HttpOnly, Secure, SameSite=Strict cookie', async ({ page, context, serverUrl }) => {
    await page.goto(`${serverUrl}/`);

    const response = await page.request.post('/api/session', {
      data: { ownerId: SYNTHETIC_OWNER.id, password: SYNTHETIC_PASSWORD },
    });
    expect(response.status()).toBe(200);

    // Unfiltered on purpose: Playwright hides `Secure` cookies from a `http://` URL
    // query, and inspecting a `Secure` cookie is the point of this test.
    const cookie = (await context.cookies()).find((entry) => entry.name === SESSION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');

    // HttpOnly means the page itself cannot read the token, which is why the browser
    // can send it and no script in the page can.
    expect(await page.evaluate(() => document.cookie)).not.toContain(SESSION_COOKIE_NAME);
    expect((await pageCall(page, `${serverUrl}/api/owner`)).status).toBe(200);
  });

  test('sign-out invalidates the session server-side', async ({ page, context, request, serverUrl }) => {
    await page.goto(`${serverUrl}/`);
    const signIn = await pageCall(page, `${serverUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ ownerId: SYNTHETIC_OWNER.id, password: SYNTHETIC_PASSWORD }),
    });
    expect(signIn.status).toBe(200);

    const cookie = (await context.cookies()).find((entry) => entry.name === SESSION_COOKIE_NAME);
    expect(cookie?.value).toBeTruthy();
    const capturedValue = String(cookie?.value);

    // The token works right up to the moment sign-out lands.
    expect((await pageCall(page, `${serverUrl}/api/owner`)).status).toBe(200);

    const session = await pageCall(page, `${serverUrl}/api/session`);
    const csrfToken = (JSON.parse(session.body) as { readonly csrfToken: string }).csrfToken;
    const signOut = await pageCall(page, `${serverUrl}/api/session/sign-out`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: csrfToken },
    });
    expect(signOut.status).toBe(200);

    // Replaying the exact token that worked a moment ago is now refused (F01-AC2). This
    // is server-side revocation: the client never signed in and carries no other proof.
    const replay = await request.get(`${serverUrl}/api/owner`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${capturedValue}` },
    });
    expect(replay.status()).toBe(401);
    const replayBody = await replay.text();
    for (const marker of PRIVATE_MARKERS) {
      expect(replayBody).not.toContain(marker);
    }
  });

  test('a wrong password and an unknown owner are indistinguishable', async ({ request, serverUrl }) => {
    const wrongPassword = await request.post(`${serverUrl}/api/session`, {
      data: { ownerId: SYNTHETIC_OWNER.id, password: 'e2e-synthetic-owner-password-9999' },
    });
    const unknownOwner = await request.post(`${serverUrl}/api/session`, {
      data: { ownerId: 'own_does_not_exist_9999', password: SYNTHETIC_PASSWORD },
    });

    expect(wrongPassword.status()).toBe(401);
    expect(unknownOwner.status()).toBe(401);
    expect(wrongPassword.headers()['content-length']).toBe(unknownOwner.headers()['content-length']);
    expect(await wrongPassword.text()).toBe(await unknownOwner.text());
  });
});
