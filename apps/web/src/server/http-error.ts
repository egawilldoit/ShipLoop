/**
 * Domain errors to honest HTTP responses.
 *
 * The mapping exists so the status code tells the owner the truth. A `Blocked`
 * prerequisite is a 422 and never a 200, an unknown external write is a 202 that
 * reports an operation id and never a success status, and a conflict carries the
 * expected and actual revisions so the owner can re-read current facts
 * (F04-AC3, F24-AC4, F02-AC2). Every message passes through the domain redaction
 * rules on the way out, so a credential-shaped value cannot reach a UI response
 * even if a use case quotes it (F03-AC3, N02-AC2).
 */

import { secretFreeReason } from '@shiploop/domain';
import type { DomainError } from '@shiploop/domain';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

/** One field a form can attach a message to (F02-AC4, F03-AC2, N03-AC3). */
export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly FieldError[];
    readonly prerequisites?: readonly { readonly name: string; readonly detail: string; readonly remedy: string }[];
    readonly expected?: string;
    readonly actual?: string;
    readonly operationId?: string;
    readonly target?: string;
    readonly retryAfterSeconds?: number;
  };
  readonly signInRequired?: boolean;
}

/** A status code, body and any extra headers an error needs. */
export interface HttpProblem {
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A refusal produced by this layer rather than by a use case.
 *
 * Separate from `DomainError` so an authentication refusal can never be produced by
 * a use case that happened to be handed an anonymous request (F01-AC1).
 */
export class UnauthorizedError extends Error {
  constructor(message = 'Sign in to continue.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Shapes a 401.
 *
 * The default reason is the only thing a caller with no cookie learns. A caller that
 * did present a cookie is told what happened to that session, which is a fact only
 * the holder of that token can observe.
 */
export function signInRequiredProblem(reason = 'Sign in to continue.'): HttpProblem {
  return {
    status: 401,
    body: { error: { code: 'Unauthorized', message: safe(reason) }, signInRequired: true },
    headers: {},
  };
}

const GENERIC_SIGN_IN_FAILURE = 'Sign-in failed. Check the details and try again.';
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface ProblemOptions {
  /**
   * 401 or 403 for a `Forbidden`. A caller that failed to authenticate is 401; one
   * that is authenticated but may not do this is 403.
   */
  readonly forbiddenStatus?: 401 | 403;
}

/** The caller may not do this, so the request stops here (F01-AC4, F03-AC5). */
export function forbidden(reason: string): DomainError {
  return { code: 'Forbidden', reason };
}

/** Nothing is at that address. The reason names what is missing, never who asked. */
export function notFound(reason: string): DomainError {
  return { code: 'NotFound', reason };
}

/**
 * Maps one domain error to a response.
 *
 * `Invalid` keeps its per-field messages because a form has to be able to say which
 * input is wrong (F02-AC4, F03-AC2, N03-AC3). `Blocked` keeps the failed
 * prerequisite and its remedy, because "blocked" alone tells the owner nothing
 * actionable (F04-AC3).
 */
export function problemFor(error: DomainError, options: ProblemOptions = {}): HttpProblem {
  const message = safe(error.reason);
  switch (error.code) {
    case 'Invalid': {
      const fields = error.fields.map((field) => ({ path: field.path, message: safe(field.message) }));
      return problem(400, 'Invalid', message, fields.length > 0 ? { fields } : {});
    }
    case 'NotFound':
      return problem(404, 'NotFound', message, {});
    case 'Forbidden':
      return problem(options.forbiddenStatus ?? 403, 'Forbidden', message, {});
    case 'Conflict':
      return problem(409, 'Conflict', message, { expected: error.expected, actual: error.actual });
    case 'Blocked': {
      const prerequisites = error.prerequisites.map((prerequisite) => ({
        name: prerequisite.name,
        detail: safe(prerequisite.detail),
        remedy: safe(prerequisite.remedy),
      }));
      return problem(422, 'Blocked', message, prerequisites.length > 0 ? { prerequisites } : {});
    }
    case 'OutcomeUnknown':
      return problem(202, 'OutcomeUnknown', message, { operationId: error.operationId, target: error.target });
    case 'RateLimited': {
      const retryAfterSeconds =
        error.retryAfterMs === null
          ? DEFAULT_RETRY_AFTER_SECONDS
          : Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      return problem(429, 'RateLimited', message, { retryAfterSeconds }, {
        'retry-after': String(retryAfterSeconds),
      });
    }
    case 'Unavailable':
      return problem(503, 'Unavailable', message, {});
  }
}

/**
 * The one response every failed sign-in produces.
 *
 * A wrong password and an unknown owner are answered identically, so neither the
 * transport nor the use case can be read as an owner-existence oracle
 * (N02-AC1).
 */
export function signInFailureProblem(): HttpProblem {
  return {
    status: 401,
    body: { error: { code: 'Unauthorized', message: GENERIC_SIGN_IN_FAILURE }, signInRequired: true },
    headers: {},
  };
}

/**
 * The response for a failure this server did not anticipate.
 *
 * Fixed wording on purpose: the original message may name a file, a query or a
 * provider, and none of that is the owner's business (N02-AC1).
 */
export function internalErrorProblem(): HttpProblem {
  return {
    status: 500,
    body: { error: { code: 'InternalError', message: 'The request could not be completed.' } },
    headers: {},
  };
}

/**
 * Client-error codes the framework chooses, named rather than flattened.
 *
 * A caller branches on the code, so 413 and 415 must not both answer `BadRequest`:
 * "your body is too large" and "send it as JSON" are different instructions, and the
 * status alone is too easy for a client to conflate (N03-AC3).
 */
const FRAMEWORK_CODES: Readonly<Record<number, string>> = {
  400: 'BadRequest',
  404: 'NotFound',
  405: 'MethodNotAllowed',
  406: 'NotAcceptable',
  409: 'Conflict',
  411: 'LengthRequired',
  413: 'PayloadTooLarge',
  415: 'UnsupportedMediaType',
  422: 'UnprocessableContent',
};

/**
 * A refusal the framework raised before a handler ran.
 *
 * The status the framework chose is kept rather than collapsed into 400, because the
 * difference between a malformed body and an oversized one is what tells the client
 * what to change.
 */
export function frameworkProblem(status: number, message: string): HttpProblem {
  return {
    status,
    body: { error: { code: FRAMEWORK_CODES[status] ?? 'BadRequest', message: safe(message) } },
    headers: {},
  };
}

/**
 * Path used when the whole body is the problem, so a form always has one field to
 * attach the message to instead of an empty key.
 */
const ROOT_FIELD = 'body';

const KNOWN_CODES = [
  'Blocked',
  'Conflict',
  'OutcomeUnknown',
  'Invalid',
  'NotFound',
  'Forbidden',
  'RateLimited',
  'Unavailable',
] as const;

/**
 * Recognizes a domain error that arrived as a thrown value.
 *
 * The CSRF guard throws one instead of returning a result, so the error handler can
 * tell a refusal it raised from a framework error and map it through the same
 * honest status codes rather than through a generic 500.
 */
export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly code?: unknown; readonly reason?: unknown };
  if (typeof candidate.reason !== 'string') return false;
  return KNOWN_CODES.some((code) => code === candidate.code);
}

/**
 * A parsed body, or the issues that stopped it.
 */
export type ParsedBody<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: z.ZodError };

/**
 * Validates a request body against a schema.
 *
 * Validation happens at this boundary and nowhere else, so a handler can never see
 * unvalidated input (F02-AC4, F03-AC2).
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): ParsedBody<T> {
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: parsed.error };
}

/**
 * Turns schema issues into per-field messages.
 *
 * Every offending field is reported rather than the first, because a form can only
 * mark the inputs it knows about (F02-AC4, N03-AC3). Two issues on one field collapse
 * to the first message so the form does not render a contradiction.
 */
export function fieldErrorsOf(problem: z.ZodError): readonly FieldError[] {
  const seen = new Set<string>();
  const fields: FieldError[] = [];
  for (const issue of problem.issues) {
    const prefix = issue.path.map((segment) => String(segment)).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const path = [...issue.path.map(String), key].join('.');
        if (seen.has(path)) continue;
        seen.add(path);
        fields.push({
          path,
          message: `"${key}" is not accepted here. Remove it or check the spelling.`,
        });
      }
      continue;
    }
    const path = prefix === '' ? ROOT_FIELD : prefix;
    if (seen.has(path)) continue;
    seen.add(path);
    fields.push({ path, message: safe(issue.message) });
  }
  return fields;
}

/**
 * A 400 carrying every field message the schema produced.
 *
 * All of them, in one response, because a form that only learns about the first bad
 * input cannot show the owner everything they have to fix (F02-AC4, N03-AC3).
 */
export function fieldsProblem(
  fields: readonly FieldError[],
  message = 'The submitted values were not accepted.',
): HttpProblem {
  return {
    status: 400,
    body: { error: { code: 'Invalid', message: safe(message), fields } },
    headers: {},
  };
}

/** Writes a problem: status, body and any headers it needs. */
export function sendProblem(reply: FastifyReply, problem: HttpProblem): FastifyReply {
  for (const [name, value] of Object.entries(problem.headers)) reply.header(name, value);
  return reply.status(problem.status).send(problem.body);
}

function problem(
  status: number,
  code: string,
  message: string,
  detail: Partial<ErrorBody['error']>,
  headers: Readonly<Record<string, string>> = {},
): HttpProblem {
  return { status, body: { error: { code, message, ...detail } }, headers };
}

/** Reason text that may be shown to the owner or written to a log (N02-AC2). */
function safe(reason: string): string {
  return secretFreeReason(reason);
}