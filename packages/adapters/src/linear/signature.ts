/**
 * Linear webhook signature verification (F30-AC1, N02-AC1).
 *
 * The HMAC is computed over the **original request bytes**. Re-serialising a parsed
 * body changes key order and whitespace and produces a different digest, so this
 * module takes a byte buffer and never accepts a parsed object; that is what stops
 * a verified-but-different body from being accepted (F30-AC1).
 *
 * One honest limitation drives the shape of this module. An HMAC over the payload
 * cannot detect a replay: the same bytes with the same signature are, by
 * construction, still valid. Linear's own guidance is to reject a delivery whose
 * `webhookTimestamp` is not within a minute of the receiver's clock, so freshness is
 * verified here as a separate, explicit condition, using the `Linear-Timestamp` header
 * when present and the body field otherwise. Deduplication of a delivery that is still
 * inside the window is the store's job (`packages/storage/src/events/inbox.ts`), not
 * this module's: two deliveries inside the window are both genuine, and only the
 * recorded `Linear-Delivery` identity distinguishes them (F30-AC2). `signature.test.ts`
 * proves that a replay inside the window verifies and is left for the store, rather
 * than pretending this function rejects it.
 *
 * Header names, values and payload fields are as documented by Linear at
 * <https://linear.app/developers/webhooks>: `Linear-Signature` is a hex-encoded
 * HMAC-SHA256 of the raw body keyed with the webhook's signing secret, `Linear-Timestamp`
 * is the send time in milliseconds, `Linear-Delivery` is a UUID, and `Linear-Event` is the
 * entity type. They were **not** observed from a live delivery, because provoking one
 * would require a publicly reachable HTTPS endpoint configured in the owner's workspace.
 * `README.md` records that distinction, and the algorithm above is the only
 * documentation-derived part of the adapter that guards a security boundary.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { err, ok, type DomainError, type Result } from '@shiploop/domain';

/** Headers Linear sends with every data-change delivery. */
export const LINEAR_SIGNATURE_HEADER = 'linear-signature';
export const LINEAR_TIMESTAMP_HEADER = 'linear-timestamp';
export const LINEAR_DELIVERY_HEADER = 'linear-delivery';
export const LINEAR_EVENT_HEADER = 'linear-event';

/** Linear recommends rejecting a delivery whose timestamp is not within a minute. */
export const DEFAULT_MAX_DELIVERY_AGE_MS = 60_000;

export interface LinearWebhookHeaders {
  readonly signature?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly deliveryId?: string | undefined;
  readonly eventType?: string | undefined;
}

export interface VerifyLinearWebhookRequest {
  /** The exact bytes Linear posted. Not a parsed object, and never re-serialised. */
  readonly rawBody: Uint8Array;
  readonly headers: LinearWebhookHeaders;
  /** The webhook's signing secret from the Linear webhook detail page. */
  readonly secret: string;
  readonly nowMs: number;
  readonly maxAgeMs?: number;
  readonly redact?: (text: string) => string;
}

export interface LinearWebhookDelivery {
  readonly deliveryId: string;
  readonly eventType: string;
  readonly action: string;
  readonly entityType: string;
  readonly webhookTimestampMs: number;
  readonly organizationId: string | null;
  /** Which configured webhook produced this delivery, so one endpoint can serve several. */
  readonly webhookId: string | null;
  /** The provider's own subject identity, so the caller never parses `data` to find it. */
  readonly subjectId: string | null;
  /** The provider's own subject URL, likewise never re-derived from `data`. */
  readonly subjectUrl: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Verifies the signature and the freshness window, then parses the envelope.
 *
 * The signature is checked against the raw bytes before the payload is looked at, so
 * nothing a delivery claims influences a decision until its bytes are authentic.
 * Returns a `DomainError` rather than a boolean so the caller can record why a
 * delivery was refused; every refusal is deliberately indistinguishable in shape from
 * every other, because a caller must not learn which check failed.
 */
export function verifyLinearWebhook(
  request: VerifyLinearWebhookRequest,
): Result<LinearWebhookDelivery, DomainError> {
  const redact = request.redact ?? ((text: string): string => text);
  const signature = typeof request.headers.signature === 'string' ? request.headers.signature.trim() : '';
  if (signature.length === 0) {
    return err(refusal('the request carried no Linear-Signature header'));
  }
  if (request.secret.length === 0) {
    return err(
      forbiddenRefusal(
        redact(
          'No Linear webhook signing secret is configured, so no delivery can be verified and none was processed. Configure the secret from the Linear webhook detail page.',
        ),
      ),
    );
  }

  const expected = createHmac('sha256', request.secret).update(request.rawBody).digest();
  const supplied = decodeHex(signature);
  if (supplied === null) {
    return err(refusal('the Linear-Signature header was not a hex digest'));
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return err(refusal('the Linear-Signature header did not match the payload bytes'));
  }

  const parsed = parseJson(request.rawBody);
  if (parsed === null || !isRecord(parsed)) {
    return err(refusal('the verified payload was not a JSON object'));
  }

  const headerTimestampMs = deliveryTimestampMs(request.headers.timestamp);
  const bodyTimestampMs = numberOrNull(parsed['webhookTimestamp']);
  const sentAtMs = headerTimestampMs ?? bodyTimestampMs;
  if (sentAtMs === null) {
    return err(refusal('the request carried no usable Linear-Timestamp header or webhookTimestamp'));
  }
  if (
    headerTimestampMs !== null &&
    bodyTimestampMs !== null &&
    Math.abs(bodyTimestampMs - headerTimestampMs) > (request.maxAgeMs ?? DEFAULT_MAX_DELIVERY_AGE_MS)
  ) {
    return err(
      refusal(
        'the payload webhookTimestamp and the Linear-Timestamp header disagree beyond the acceptance window',
      ),
    );
  }

  const maxAgeMs = request.maxAgeMs ?? DEFAULT_MAX_DELIVERY_AGE_MS;
  const ageMs = request.nowMs - sentAtMs;
  if (ageMs > maxAgeMs) {
    return err(
      refusal(
        `the delivery was sent ${Math.round(ageMs / 1000)}s ago, outside the ${Math.round(maxAgeMs / 1000)}s acceptance window, so it is refused as a possible replay`,
      ),
    );
  }
  if (ageMs < -maxAgeMs) {
    return err(
      refusal(
        `the delivery claims a timestamp ${Math.round(-ageMs / 1000)}s in the future, which is outside the ${Math.round(maxAgeMs / 1000)}s acceptance window`,
      ),
    );
  }

  const deliveryId = typeof request.headers.deliveryId === 'string' ? request.headers.deliveryId.trim() : '';
  if (deliveryId.length === 0) {
    return err(refusal('the request carried no Linear-Delivery header, so it cannot be recorded once'));
  }

  const action = stringOr(parsed['action'], '');
  const entityType = stringOr(parsed['type'], '');
  if (action.length === 0 || entityType.length === 0) {
    return err(refusal('the verified payload was missing the action or type a delivery must carry'));
  }

  return ok({
    deliveryId,
    eventType:
      typeof request.headers.eventType === 'string' && request.headers.eventType.length > 0
        ? request.headers.eventType
        : entityType,
    action,
    entityType,
    webhookTimestampMs: sentAtMs,
    organizationId: stringOrNull(parsed['organizationId']),
    webhookId: stringOrNull(parsed['webhookId']),
    subjectId: subjectIdOf(parsed['data']),
    subjectUrl: stringOrNull(parsed['url']),
    payload: parsed,
  });
}

/**
 * A refused delivery.
 *
 * `Forbidden` rather than a boolean so a controller records the refusal with a
 * reason. No provider text is interpolated: the reasons below are fixed strings, so
 * a hostile payload cannot put a credential-shaped string into an operator's log
 * through this path (N02-AC2).
 */
function refusal(reason: string): DomainError {
  return { code: 'Forbidden', reason: `The Linear delivery was rejected: ${reason}.` };
}

function forbiddenRefusal(reason: string): DomainError {
  return { code: 'Forbidden', reason };
}

/** Strict hex decoding; a short or non-hex signature must not be compared at all. */
function decodeHex(value: string): Buffer | null {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) return null;
  return Buffer.from(value, 'hex');
}

function deliveryTimestampMs(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function subjectIdOf(data: unknown): string | null {
  if (!isRecord(data)) return null;
  return stringOrNull(data['id']);
}
