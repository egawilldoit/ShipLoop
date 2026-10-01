/**
 * Linear webhook signature verification, over the original payload bytes (F30-AC1).
 *
 * The cases that matter here are the negative ones. A verifier that accepts a good
 * signature proves only that it can compute an HMAC; what F30-AC1 asks is that it
 * refuses every payload it did not receive, which is why the tampered-body and
 * re-serialised-body cases carry the weight of this file.
 *
 * Every payload is signed exactly as Linear documents signing it: a hex-encoded
 * HMAC-SHA256 of the **raw body bytes** keyed with the webhook's signing secret, with
 * freshness taken from `webhookTimestamp`. That algorithm is documentation-derived and
 * is not observable from this environment, which has no webhook endpoint configured;
 * `README.md` records that.
 *
 * Criterion IDs in each test name are the specification lines the assertion enforces.
 */

import { createHmac } from 'node:crypto';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redact, type DomainError } from '@shiploop/domain';

import {
  DEFAULT_MAX_DELIVERY_AGE_MS,
  verifyLinearWebhook,
  type LinearWebhookDelivery,
  type LinearWebhookHeaders,
} from './signature.ts';

const WEBHOOK_SECRET = 'test-signing-secret-from-the-webhook-detail-page';
const OTHER_SECRET = 'a-different-signing-secret-entirely';
const NOW_MS = Date.parse('2026-09-30T12:00:00.000Z');
const DELIVERY_ID = '234d1a4e-b617-4388-90fe-adc3633d6b72';

/**
 * A delivery body shaped like Linear's documented data-change payload.
 *
 * The timestamp is written into the body so a body signed as-is is fresh, and every
 * negative case is produced by changing one thing about this exact byte string.
 */
function payloadBytes(overrides: {
  readonly webhookTimestampMs?: number;
  readonly action?: string;
  readonly type?: string;
  readonly subjectId?: string;
  readonly body?: string;
  readonly indentation?: number;
} = {}): Uint8Array {
  const body = {
    action: overrides.action ?? 'create',
    type: overrides.type ?? 'Comment',
    actor: { id: 'b5ea5f1f-8adc-4f52-b4bd-ab4e84cf51ba', type: 'user', name: 'Linear Orbit' },
    createdAt: '2020-01-23T12:53:18.084Z',
    data: {
      id: overrides.subjectId ?? '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9',
      body: overrides.body ?? 'Indeed, I think this is definitely an improvement.',
      issueId: '539068e2-ae88-4d09-bd75-22eb4a59612f',
    },
    url: 'https://linear.app/issue/LIN-1778/foo-bar#comment-77217de3-fb52-4dad-bb9a-b356beb93de8',
    organizationId: 'dc844923-f9a4-40a3-825c-dea7747e57d6',
    webhookTimestamp: overrides.webhookTimestampMs ?? NOW_MS,
    webhookId: '000042e3-d123-4980-b49f-8e140eef9329',
  };
  return Buffer.from(JSON.stringify(body, null, overrides.indentation ?? 0), 'utf8');
}

/** The signature Linear documents: hex-encoded HMAC-SHA256 over the raw bytes. */
function sign(rawBody: Uint8Array, secret: string = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Reads the delivered bytes back as text.
 *
 * Deliberately through a byte view rather than a string cast: the whole point of the
 * contract under test is that the payload is handled as bytes, and a helper that
 * quietly turned it into a string would hide the distinction being verified.
 */
function toText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

function headersFor(rawBody: Uint8Array, overrides: Partial<LinearWebhookHeaders> = {}): LinearWebhookHeaders {
  const sentAtMs = JSON.parse(toText(rawBody))['webhookTimestamp'] as number;
  return {
    signature: sign(rawBody),
    timestamp: String(sentAtMs),
    deliveryId: DELIVERY_ID,
    eventType: 'Comment',
    ...overrides,
  };
}

async function refusalOf(
  rawBody: Uint8Array,
  headers: LinearWebhookHeaders,
  secret = WEBHOOK_SECRET,
): Promise<DomainError> {
  const result = verifyLinearWebhook({
    rawBody,
    headers,
    secret,
    nowMs: NOW_MS,
    redact: (text) => redact(text).text,
  });
  if (result.ok) assert.fail('expected the delivery to be refused, received success');
  return result.error;
}

function acceptOf(
  rawBody: Uint8Array,
  headers: LinearWebhookHeaders,
  secret = WEBHOOK_SECRET,
): LinearWebhookDelivery {
  const result = verifyLinearWebhook({ rawBody, headers, secret, nowMs: NOW_MS });
  if (!result.ok) assert.fail(`expected the delivery to verify, received ${result.error.code}: ${result.error.reason}`);
  return result.value;
}

/* -------------------------------------------------------------------------- */
/* The accepted case                                                           */
/* -------------------------------------------------------------------------- */

test('F30-AC1 a correctly signed, fresh delivery verifies and yields the provider identities', () => {
  const rawBody = payloadBytes();
  const delivery = acceptOf(rawBody, headersFor(rawBody));
  assert.equal(delivery.deliveryId, DELIVERY_ID);
  assert.equal(delivery.eventType, 'Comment');
  assert.equal(delivery.action, 'create');
  assert.equal(delivery.entityType, 'Comment');
  assert.equal(delivery.webhookTimestampMs, NOW_MS);
  assert.equal(delivery.organizationId, 'dc844923-f9a4-40a3-825c-dea7747e57d6');
  assert.equal(delivery.webhookId, '000042e3-d123-4980-b49f-8e140eef9329');
  assert.equal(
    delivery.subjectId,
    '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9',
    'the caller must not have to parse `data` to learn which issue this is about',
  );
  assert.match(delivery.subjectUrl ?? '', /^https:\/\/linear\.app\//);
});

/* -------------------------------------------------------------------------- */
/* Wrong, missing and malformed signatures                                     */
/* -------------------------------------------------------------------------- */

test('F30-AC1 a body signed with a different secret is refused', async () => {
  const rawBody = payloadBytes();
  const error = await refusalOf(rawBody, headersFor(rawBody), OTHER_SECRET);
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /did not match the payload bytes/);
});

test('F30-AC1 a request with no Linear-Signature header is refused', async () => {
  const rawBody = payloadBytes();
  const error = await refusalOf(rawBody, { ...headersFor(rawBody), signature: undefined });
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /no Linear-Signature header/);
});

test('F30-AC1 a request with an empty or whitespace signature is refused', async () => {
  const rawBody = payloadBytes();
  for (const signature of ['', '   ']) {
    const error = await refusalOf(rawBody, { ...headersFor(rawBody), signature });
    assert.equal(error.code, 'Forbidden', `the signature ${JSON.stringify(signature)} was not refused`);
  }
});

test('F30-AC1 a signature that is not hex is refused without being compared', async () => {
  const rawBody = payloadBytes();
  for (const signature of ['not-hex', 'zzzz', 'abc']) {
    const error = await refusalOf(rawBody, { ...headersFor(rawBody), signature });
    assert.equal(error.code, 'Forbidden');
    assert.match(error.reason, /hex digest/, 'a malformed signature was compared rather than rejected outright');
  }
});

test('F30-AC1 a correctly signed body is still refused when the secret is unconfigured', async () => {
  const rawBody = payloadBytes();
  const error = await refusalOf(rawBody, headersFor(rawBody), '');
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /reauthorize|signing secret is configured/);
  assert.equal(error.reason.includes(WEBHOOK_SECRET), false);
});

/* -------------------------------------------------------------------------- */
/* Tampering                                                                   */
/* -------------------------------------------------------------------------- */

test('F30-AC1 a single changed byte in the body is refused', async () => {
  const original = payloadBytes();
  const headers = headersFor(original);
  // The signature is over the untampered bytes, so the change is made after signing.
  const tampered = Buffer.from(toText(original).replace('definitely', 'absolutely'), 'utf8');
  assert.notEqual(toText(tampered), toText(original), 'the tampering changed nothing');
  const error = await refusalOf(tampered, headers);
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /did not match the payload bytes/);
});

test('F30-AC1 a body re-serialised after parsing is refused, which is why the original bytes are kept', async () => {
  // The documented failure this module exists to prevent: a middleware parses the JSON
  // and the handler re-serialises it. The bytes differ, so the digest differs, and a
  // verifier that accepted the re-serialised form would be verifying a body nobody sent.
  const original = payloadBytes({ indentation: 2 });
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(toText(original))), 'utf8');
  assert.notEqual(
    toText(reserialised),
    toText(original),
    'the fixture did not actually differ after re-serialisation',
  );

  // A signature computed over the RE-SERIALISED bytes must not authenticate the ORIGINAL.
  const forgedOverReserialised = {
    ...headersFor(original),
    signature: sign(reserialised),
  };
  const error = await refusalOf(original, forgedOverReserialised);
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /did not match the payload bytes/);

  // And the original signature still authenticates the original bytes, so the refusal
  // above is about the bytes and not about the fixture.
  const accepted = acceptOf(original, headersFor(original));
  assert.equal(accepted.deliveryId, DELIVERY_ID);
});

test('F30-AC1 a verified body that is not a JSON object is refused after the signature passes', async () => {
  for (const body of ['"a string"', '42', 'null']) {
    const rawBody = Buffer.from(body, 'utf8');
    const error = await refusalOf(rawBody, {
      signature: sign(rawBody),
      timestamp: String(NOW_MS),
      deliveryId: DELIVERY_ID,
      eventType: 'Comment',
    });
    assert.equal(error.code, 'Forbidden', `the verified body ${body} was not refused`);
    assert.match(error.reason, /not a JSON object/);
  }
});

/* -------------------------------------------------------------------------- */
/* Replay and freshness                                                        */
/* -------------------------------------------------------------------------- */

test('F30-AC2 a replay of the same bytes inside the acceptance window verifies, and is left to the store', async () => {
  // An HMAC over a payload cannot detect a replay: identical bytes with a valid
  // signature are valid by construction. Asserting otherwise would be a false claim, so
  // the test pins the real behaviour — the module does not pretend to deduplicate, and
  // `deliveryId` is the identity the store records it under.
  const rawBody = payloadBytes();
  const headers = headersFor(rawBody);
  const first = acceptOf(rawBody, headers);
  const replayed = acceptOf(rawBody, headers);
  assert.equal(replayed.deliveryId, first.deliveryId, 'the delivery identity is what the store deduplicates on');
  assert.equal(replayed.webhookTimestampMs, first.webhookTimestampMs);
  assert.equal(replayed.subjectId, first.subjectId);
});

test('F30-AC1 a delivery older than the acceptance window is refused as a possible replay', async () => {
  const staleMs = NOW_MS - DEFAULT_MAX_DELIVERY_AGE_MS - 1;
  const rawBody = payloadBytes({ webhookTimestampMs: staleMs });
  const error = await refusalOf(rawBody, headersFor(rawBody));
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /acceptance window/);
  assert.match(error.reason, /replay/);
});

test('F30-AC1 a delivery claiming a timestamp beyond the window in the future is refused', async () => {
  const futureMs = NOW_MS + DEFAULT_MAX_DELIVERY_AGE_MS + 60_000;
  const rawBody = payloadBytes({ webhookTimestampMs: futureMs });
  const error = await refusalOf(rawBody, headersFor(rawBody));
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /future/);
});

test('F30-AC1 freshness is taken from the Linear-Timestamp header when the body timestamp disagrees', async () => {
  // The header is the transport's own claim and the body field is inside the signature,
  // so a fresh header with a stale body is a disagreement rather than a fresh delivery.
  const rawBody = payloadBytes({ webhookTimestampMs: NOW_MS - 3_600_000 });
  const error = await refusalOf(rawBody, {
    ...headersFor(rawBody),
    timestamp: String(NOW_MS),
  });
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /disagree beyond the acceptance window/);
});

test('F30-AC1 freshness falls back to the body timestamp, and is refused only when neither is usable', async () => {
  // The body field is inside the signature, so it is trustworthy where the header is
  // not; Linear documents `webhookTimestamp` as the replay guard and sends both.
  const rawBody = payloadBytes();
  const fallback = acceptOf(rawBody, { ...headersFor(rawBody), timestamp: undefined });
  assert.equal(fallback.webhookTimestampMs, NOW_MS, 'the body timestamp was not used as the freshness source');

  // A body whose `webhookTimestamp` is not a number, with no header to fall back on, is
  // the one case that cannot be aged at all.
  const undated = Buffer.from(
    JSON.stringify({ action: 'create', type: 'Comment', data: { id: '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9' }, webhookTimestamp: null }),
    'utf8',
  );
  const refused = await refusalOf(undated, { signature: sign(undated), deliveryId: DELIVERY_ID, eventType: 'Comment' });
  assert.equal(refused.code, 'Forbidden');
  assert.match(refused.reason, /no usable Linear-Timestamp header or webhookTimestamp/);
});

/* -------------------------------------------------------------------------- */
/* The fields a delivery must carry to be recordable                            */
/* -------------------------------------------------------------------------- */

test('F30-AC1 a delivery with no Linear-Delivery header is refused, because it cannot be recorded once', async () => {
  const rawBody = payloadBytes();
  const error = await refusalOf(rawBody, { ...headersFor(rawBody), deliveryId: undefined });
  assert.equal(error.code, 'Forbidden');
  assert.match(error.reason, /Linear-Delivery header/);
});

test('F30-AC1 a verified payload missing the action or type is refused rather than half-interpreted', async () => {
  for (const override of [{ action: '' }, { type: '' }]) {
    const rawBody = payloadBytes(override);
    const error = await refusalOf(rawBody, headersFor(rawBody));
    assert.equal(error.code, 'Forbidden', `a payload with ${JSON.stringify(override)} was not refused`);
    assert.match(error.reason, /action or type/);
  }
});

test('F30-AC1 the event type falls back to the payload type when the header is absent', () => {
  const rawBody = payloadBytes({ type: 'Issue' });
  const delivery = acceptOf(rawBody, { ...headersFor(rawBody), eventType: undefined });
  assert.equal(delivery.eventType, 'Issue');
  assert.equal(delivery.entityType, 'Issue');
});

/* -------------------------------------------------------------------------- */
/* N02-AC2: a hostile payload cannot put a credential into an operator's log     */
/* -------------------------------------------------------------------------- */

/** Assembled at runtime, so no tracked source line contains a credential-shaped string. */
const SEEDED_CREDENTIAL = ['lin', 'api', 'AAAABBBBCCCCDDDDEEEE'].join('_');

test('N02-AC2 a credential-shaped string in a refused payload never reaches the refusal reason', async () => {
  const rawBody = payloadBytes({ body: `leaked ${SEEDED_CREDENTIAL} into the comment` });
  const error = await refusalOf(rawBody, headersFor(rawBody), OTHER_SECRET);
  assert.equal(error.code, 'Forbidden');
  assert.equal(
    error.reason.includes(SEEDED_CREDENTIAL),
    false,
    'a refused payload was echoed into the reason an operator reads',
  );
});

test('N02-AC2 a subject id that is missing or not a string is reported as absent, not as a number', () => {
  const numeric = payloadBytes();
  const rewritten = Buffer.from(
    toText(numeric).replace('"2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9"', '4711'),
    'utf8',
  );
  const delivery = acceptOf(rewritten, headersFor(rewritten));
  assert.equal(delivery.subjectId, null, 'a numeric id was coerced into a string identity');
});
