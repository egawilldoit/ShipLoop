/**
 * Server configuration read from the environment.
 *
 * Configuration is a boundary, so it is parsed once, validated once, and returned
 * as a typed result rather than read ad hoc inside handlers (principle: concentrate
 * guards at the boundary). Two rules are not negotiable: a CSRF secret must be
 * supplied, because an absent secret would let a cross-site page derive a valid
 * token for any session it cannot read (F01-AC4); and cookies stay `Secure`
 * unless a developer explicitly asks otherwise outside production, because the
 * session cookie is the only thing standing between a stolen request and the
 * owner's workspace (F01-AC4, N02-AC1).
 */

import { resolve } from 'node:path';
import type { SessionCookieSameSite } from '@shiploop/domain';

export type NodeEnvironment = 'production' | 'development' | 'test';

export interface ServerConfig {
  readonly host: string;
  /**
   * `0` asks the operating system to choose the port, which is what the browser E2E runbook
   * requires so parallel runs cannot collide on a fixed number. The caller must then read the
   * bound address back from the server rather than assume a port (TESTING.md: prefer port 0 and
   * read the actual bound port). A non-zero value is this server's own listener.
   */
  readonly port: number;
  readonly nodeEnv: NodeEnvironment;
  readonly csrfSecret: string;
  /** False only when a developer turns it off explicitly; see `readServerConfig`. */
  readonly cookieSecure: boolean;
  readonly cookieSameSite: SessionCookieSameSite;
  readonly cookiePath: string;
  /** Absolute session lifetime. The controller applies it when it stores a session. */
  readonly sessionAbsoluteTtlSeconds: number;
  readonly sessionIdleTimeoutSeconds: number;
  /** Directory holding the owner shell and its client assets. Null disables static serving. */
  readonly staticRoot: string | null;
  /** Directory holding artifacts. Always served behind the session guard (F01-AC1). */
  readonly artifactRoot: string | null;
  readonly trustProxy: boolean;
  readonly bodyLimitBytes: number;
  readonly logLevel: string;
}

export interface ConfigProblem {
  readonly path: string;
  readonly message: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly value: ServerConfig }
  | { readonly ok: false; readonly errors: readonly ConfigProblem[] };

/** 32 characters of secret material, which is what makes a derived token unguessable. */
const MINIMUM_CSRF_SECRET_LENGTH = 32;

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 60 * 60;
const ALLOWED_SAME_SITE: readonly SessionCookieSameSite[] = ['Strict', 'Lax'];
const ALLOWED_ENVIRONMENTS: readonly NodeEnvironment[] = ['production', 'development', 'test'];
const INTEGER = /^\d+$/;

/**
 * The lowest value each setting accepts.
 *
 * Only the port may be zero, and only because zero has a defined meaning there rather than
 * being an absent value; every other setting treats zero as the unusable input it is.
 */
const MINIMUM_PORT = 0;
const MINIMUM_POSITIVE = 1;

/**
 * Builds the configuration.
 *
 * Returns every problem at once so a misconfigured deployment is fixed in one pass
 * instead of one restart per mistake. Nothing is defaulted silently except the
 * transport defaults, which cannot weaken a rule.
 */
export function readServerConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const errors: ConfigProblem[] = [];
  const nodeEnv = readEnum(env['SHIPLOOP_NODE_ENV'], ALLOWED_ENVIRONMENTS, 'SHIPLOOP_NODE_ENV', 'production', errors);
  const csrfSecret = env['SHIPLOOP_CSRF_SECRET'] ?? '';
  if (csrfSecret.length < MINIMUM_CSRF_SECRET_LENGTH) {
    errors.push({
      path: 'SHIPLOOP_CSRF_SECRET',
      message: `A CSRF secret of at least ${MINIMUM_CSRF_SECRET_LENGTH} characters is required (F01-AC4).`,
    });
  }
  const cookieSameSite = readEnum(
    env['SHIPLOOP_COOKIE_SAME_SITE'],
    ALLOWED_SAME_SITE,
    'SHIPLOOP_COOKIE_SAME_SITE',
    'Strict',
    errors,
  );
  const cookiePath = env['SHIPLOOP_COOKIE_PATH'] ?? '/';
  const port = readInteger(env['SHIPLOOP_PORT'], 'SHIPLOOP_PORT', DEFAULT_PORT, errors, MINIMUM_PORT);
  const cookieSecure = readBoolean(env['SHIPLOOP_COOKIE_SECURE'], 'SHIPLOOP_COOKIE_SECURE', true, errors);
  const trustProxy = readBoolean(env['SHIPLOOP_TRUST_PROXY'], 'SHIPLOOP_TRUST_PROXY', false, errors);
  const absoluteTtlSeconds = readInteger(
    env['SHIPLOOP_SESSION_TTL_SECONDS'],
    'SHIPLOOP_SESSION_TTL_SECONDS',
    DEFAULT_SESSION_TTL_SECONDS,
    errors,
  );
  const idleTimeoutSeconds = readInteger(
    env['SHIPLOOP_SESSION_IDLE_SECONDS'],
    'SHIPLOOP_SESSION_IDLE_SECONDS',
    DEFAULT_IDLE_TIMEOUT_SECONDS,
    errors,
  );
  const bodyLimitBytes = readInteger(
    env['SHIPLOOP_BODY_LIMIT_BYTES'],
    'SHIPLOOP_BODY_LIMIT_BYTES',
    DEFAULT_BODY_LIMIT_BYTES,
    errors,
  );
  if (cookieSecure === false && nodeEnv === 'production') {
    errors.push({
      path: 'SHIPLOOP_COOKIE_SECURE',
      message: 'A production session cookie must be Secure (F01-AC4).',
    });
  }
  if (cookiePath === '') {
    errors.push({ path: 'SHIPLOOP_COOKIE_PATH', message: 'Expected a non-empty cookie path.' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      host: env['SHIPLOOP_HOST'] ?? DEFAULT_HOST,
      port,
      nodeEnv,
      csrfSecret,
      cookieSecure,
      cookieSameSite,
      cookiePath,
      sessionAbsoluteTtlSeconds: absoluteTtlSeconds,
      sessionIdleTimeoutSeconds: idleTimeoutSeconds,
      staticRoot: resolveConfiguredDirectory(env['SHIPLOOP_STATIC_ROOT']),
      artifactRoot: resolveConfiguredDirectory(env['SHIPLOOP_ARTIFACT_ROOT']),
      trustProxy,
      bodyLimitBytes,
      logLevel: env['SHIPLOOP_LOG_LEVEL'] ?? 'info',
    },
  };
}

/** One line naming every configuration problem, for the process to print on exit. */
export function describeConfigErrors(errors: readonly ConfigProblem[]): string {
  return errors.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
}

function readEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  path: string,
  fallback: T,
  errors: ConfigProblem[],
): T {
  if (raw === undefined || raw === '') return fallback;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    errors.push({ path, message: `Expected one of: ${allowed.join(', ')}.` });
    return fallback;
  }
  return match;
}

/**
 * Resolves a configured directory to an absolute path, or records why it is unusable.
 *
 * `@fastify/static` requires an absolute root and refuses a relative one at plugin
 * registration, which surfaces as a bare startup crash several frames deep instead
 * of a configuration error naming the variable. Resolving here also makes the value
 * independent of whatever directory the process happened to be started from, which
 * matters because the worker and the server may be launched from different places.
 */
function resolveConfiguredDirectory(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  return resolve(value.trim());
}

function readInteger(
  raw: string | undefined,
  path: string,
  fallback: number,
  errors: ConfigProblem[],
  minimum = MINIMUM_POSITIVE,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!INTEGER.test(raw)) {
    errors.push({ path, message: 'Expected a whole number.' });
    return fallback;
  }
  const value = Number(raw);
  if (value < minimum) {
    errors.push({ path, message: minimumMessage(minimum) });
    return fallback;
  }
  return value;
}

function minimumMessage(minimum: number): string {
  return minimum === MINIMUM_PORT
    ? 'Expected zero, meaning "let the operating system choose", or a positive number.'
    : 'Expected a positive number.';
}

function readBoolean(
  raw: string | undefined,
  path: string,
  fallback: boolean,
  errors: ConfigProblem[],
): boolean {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  errors.push({ path, message: 'Expected true or false.' });
  return fallback;
}