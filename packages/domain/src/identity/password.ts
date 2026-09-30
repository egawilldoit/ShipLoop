/**
 * Owner credential hashing and verification (F01-AC1, F03-AC3, N02-AC2).
 *
 * The plaintext exists only inside the sign-in request. Everything durable is a
 * self-describing encoding of algorithm, version, cost parameters, salt and
 * digest, so a stronger cost can be recognized later without a migration guess
 * and a row written by another version fails closed instead of throwing.
 *
 * Verification deliberately spends the same work on every input. A corrupt row
 * and a wrong password both answer `false`, and neither answer leaks whether the
 * stored value was well formed (N02-AC1: an unauthenticated caller gets an
 * authorization outcome, never an oracle).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DEFAULT_REDACTION_RULES, redact } from '../redaction.ts';
import { err, invalid, ok, type InvalidError, type Result } from '../result.ts';

declare const passwordBrand: unique symbol;

/**
 * An encoded credential digest. The plaintext never has this type, so it cannot
 * be passed where a stored value is expected.
 */
export type PasswordHash = string & { readonly [passwordBrand]: 'PasswordHash' };

/**
 * Explicit scrypt cost. Recording it in the encoding is what allows the cost to
 * be raised for new credentials while old ones keep verifying.
 */
export interface ScryptParameters {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
  readonly saltLength: number;
}

/** Node's scrypt defaults, pinned here so the encoded row states what was used. */
export const DEFAULT_SCRYPT_PARAMETERS: ScryptParameters = {
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
};

/**
 * Length bounds. The floor rejects credentials that offer no resistance at all;
 * the ceiling bounds the work an unauthenticated caller can request (N02-AC1).
 */
export const MINIMUM_PASSWORD_LENGTH = 12;
export const MAXIMUM_PASSWORD_LENGTH = 1024;

export type PasswordPolicyCode = 'TooShort' | 'TooLong' | 'InvalidParameters';

/** Why a password was refused. Carries no part of the submitted value. */
export interface PasswordPolicyError extends InvalidError {
  readonly policyCode: PasswordPolicyCode;
}

const ALGORITHM = 'scrypt';
const VERSION = 'v1';
const ENCODED_FIELDS = 9;
const MAX_ENCODED_LENGTH = 512;
const DECIMAL = /^(?:0|[1-9][0-9]{0,9})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_COST = 1 << 20;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

const ZERO_SALT = Buffer.alloc(DEFAULT_SCRYPT_PARAMETERS.saltLength);
const ZERO_DIGEST = Buffer.alloc(DEFAULT_SCRYPT_PARAMETERS.keyLength);

interface ParsedHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly digest: Buffer;
}

/**
 * Reason text that may be logged, shown or persisted.
 *
 * Every message this module produces passes through the configured credential
 * rules first, so a credential-shaped value cannot reach a UI response, an issue
 * comment or a log even if a future message quotes the submitted input
 * (F03-AC3, N02-AC2).
 */
export function secretFreeReason(message: string): string {
  return redact(message, DEFAULT_REDACTION_RULES).text;
}

function policyFailure(code: PasswordPolicyCode, message: string): PasswordPolicyError {
  const safe = secretFreeReason(message);
  return { ...invalid(safe, [{ path: 'password', message: safe }]), policyCode: code };
}

/**
 * Hashes an owner password.
 *
 * The salt is random per call, so two hashes of the same password differ and a
 * database of digests cannot be attacked with one precomputed table (F03-AC3).
 */
export function hashPassword(
  plaintext: string,
  parameters: Partial<ScryptParameters> = {},
): Result<PasswordHash, PasswordPolicyError> {
  if (plaintext.length < MINIMUM_PASSWORD_LENGTH) {
    return err(policyFailure('TooShort', `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`));
  }
  if (plaintext.length > MAXIMUM_PASSWORD_LENGTH) {
    return err(policyFailure('TooLong', `Password must be at most ${MAXIMUM_PASSWORD_LENGTH} characters.`));
  }
  const resolved = validateParameters({ ...DEFAULT_SCRYPT_PARAMETERS, ...parameters });
  if (resolved === null) {
    return err(policyFailure('InvalidParameters', 'Password cost parameters are outside the supported range.'));
  }
  const salt = randomBytes(resolved.saltLength);
  const digest = derive(plaintext, salt, resolved);
  return ok(
    [
      ALGORITHM,
      VERSION,
      resolved.N,
      resolved.r,
      resolved.p,
      resolved.keyLength,
      resolved.saltLength,
      salt.toString('base64url'),
      digest.toString('base64url'),
    ].join('$') as PasswordHash,
  );
}

/**
 * Verifies a password against a stored encoding.
 *
 * Returns a boolean rather than throwing: a malformed or corrupt row must not
 * become a sign-in crash, and it must never become a silent success either
 * (N02-AC1). The full key derivation always runs, including for a malformed
 * row and for an over-long candidate, and the digests are compared in one shot,
 * so a candidate that matches a prefix and then diverges is exactly as expensive
 * as one that diverges immediately.
 */
export function verifyPassword(plaintext: string, encoded: string): boolean {
  if (plaintext.length > MAXIMUM_PASSWORD_LENGTH) return false;
  const parsed = parseEncoded(encoded);
  const parameters = parsed?.parameters ?? DEFAULT_SCRYPT_PARAMETERS;
  const salt = parsed?.salt ?? ZERO_SALT;
  const computed = derive(plaintext, salt, parameters);
  return safeEqual(computed, parsed?.digest ?? ZERO_DIGEST);
}

function derive(password: string, salt: Buffer, parameters: ScryptParameters): Buffer {
  return scryptSync(password, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: MAX_MEMORY_BYTES,
  });
}

/**
 * Returns null for anything this module cannot verify against, including a cost
 * above the supported ceiling, so a hostile row cannot demand unbounded memory.
 */
function parseEncoded(encoded: string): ParsedHash | null {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_ENCODED_LENGTH) return null;
  const fields = encoded.split('$');
  if (fields.length !== ENCODED_FIELDS) return null;
  const [algorithm, version, costN, costR, costP, keyLength, saltLength, saltText, digestText] = fields;
  if (algorithm !== ALGORITHM || version !== VERSION) return null;
  if (saltText === undefined || digestText === undefined) return null;
  if (!BASE64URL.test(saltText) || !BASE64URL.test(digestText)) return null;
  if (costN === undefined || costR === undefined || costP === undefined || keyLength === undefined || saltLength === undefined) {
    return null;
  }
  if (!DECIMAL.test(costN) || !DECIMAL.test(costR) || !DECIMAL.test(costP)) return null;
  if (!DECIMAL.test(keyLength) || !DECIMAL.test(saltLength)) return null;
  if (Number(costN) > MAX_COST) return null;
  const parameters = validateParameters({
    N: Number(costN),
    r: Number(costR),
    p: Number(costP),
    keyLength: Number(keyLength),
    saltLength: Number(saltLength),
  });
  if (parameters === null) return null;
  const salt = Buffer.from(saltText, 'base64url');
  const digest = Buffer.from(digestText, 'base64url');
  if (salt.length !== parameters.saltLength || digest.length !== parameters.keyLength) return null;
  return { parameters, salt, digest };
}

function validateParameters(candidate: ScryptParameters): ScryptParameters | null {
  const { N, r, p, keyLength, saltLength } = candidate;
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > MAX_COST) return null;
  if (!Number.isInteger(r) || r < 1) return null;
  if (!Number.isInteger(p) || p < 1) return null;
  if (!Number.isInteger(keyLength) || keyLength < 16 || keyLength > 1024) return null;
  if (!Number.isInteger(saltLength) || saltLength < 8 || saltLength > 64) return null;
  if (128 * N * r > MAX_MEMORY_BYTES) return null;
  return candidate;
}

/**
 * Compares two derived keys without inspecting a prefix. The length branch only
 * reflects the stored row's integrity, which the caller already supplied.
 */
function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
