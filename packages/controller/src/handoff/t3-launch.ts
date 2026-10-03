/**
 * Where T3 lives, as far as ShipLoop is concerned (mvp-spec L02; ARCHITECTURE "T3 Code
 * initially receives a context packet/manual handoff").
 *
 * This module answers exactly one question: is there an external T3 deployment the
 * owner has configured, and if so what URL may the browser be sent to? It is a
 * configuration lookup, not an integration.
 *
 * What it deliberately does not do is the part that matters most:
 *
 *   - **It contacts nothing.** No T3 API is called, no thread is created, no session
 *     identifier is read or minted, and no claim is made that any of that happened.
 *     The only supported interface in the MVP is a URL a human opens (L02-AC1, which is
 *     still an open question about the user's deployed version).
 *   - **It carries no credentials.** The configured value must be a plain HTTP or
 *     HTTPS URL. A URL carrying a username or password is refused rather than
 *     sanitised, because a sanitised credential-bearing URL still proves the operator
 *     put a secret in configuration, and the remedy has to be "remove it from the
 *     environment", not "we removed it from the link" (N02-AC2).
 *   - **It holds no default.** There is no hostname in this file. A deployment that
 *     forgets the variable gets a refusal naming the variable, not a silent jump to
 *     somebody's private T3 instance — and the packet stays fully usable, because the
 *     handoff is text the owner can paste anywhere.
 *   - **It never echoes the configured value into an error.** A malformed value may
 *     itself be the secret, so a refusal describes the problem and points at the
 *     variable without reproducing what was typed into it.
 */

import { blocked, err, ok } from '@shiploop/domain';
import type { BlockedError, DomainError, Result } from '@shiploop/domain';

/** The environment variable holding the external T3 deployment's base URL. */
export const T3_URL_ENV_VAR = 'SHIPLOOP_T3_URL';

/** A T3 deployment ShipLoop is allowed to send a browser to. */
export interface T3LaunchTarget {
  /**
   * Exactly the configured URL, trimmed.
   *
   * Returned verbatim rather than normalised: the browser is going to open the
   * deployment the operator configured, so no path, host or query is invented here.
   */
  readonly url: string;
}

/** The environment shape this lookup reads. Deliberately narrower than `ProcessEnv`. */
export type T3ConfigurationSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the configured T3 deployment from an environment.
 *
 * Absent or blank means "not configured", which is a normal state for a deployment
 * that does not use T3: the caller gets an actionable refusal for the button that
 * needs it, and the handoff packet is unaffected.
 */
export function resolveT3Launch(env: T3ConfigurationSource): Result<T3LaunchTarget, DomainError> {
  const configured = env[T3_URL_ENV_VAR];
  return parseT3LaunchUrl(configured === undefined ? null : configured);
}

/**
 * Validates one configured value as a T3 launch target.
 *
 * Split from `resolveT3Launch` so the rule is testable and callable without an
 * environment, and so there is exactly one implementation of "what a usable T3 URL is".
 */
export function parseT3LaunchUrl(configured: string | null): Result<T3LaunchTarget, DomainError> {
  if (configured === null || configured.trim() === '') {
    return err(
      blocked(`No T3 deployment is configured, so there is nowhere to open (${T3_URL_ENV_VAR} is not set).`, [
        {
          name: T3_URL_ENV_VAR,
          detail: 'The external T3 deployment\'s base URL, for example https://t3.example.test',
          remedy:
            'Set this variable to the base URL of your T3 deployment and restart the server, or run without T3: the implementation handoff packet works without it.',
        },
      ]),
    );
  }

  const candidate = configured.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return err(unusable('is not a valid absolute URL', 'Set an absolute URL that starts with https:// or http://.'));
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return err(
      unusable(
        `uses the unsupported scheme "${parsed.protocol}"`,
        'T3 is opened over HTTP or HTTPS; use https:// for anything reachable from another machine.',
      ),
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return err(
      unusable(
        'carries credentials in the URL',
        'Remove the username and password from the URL and configure them out of band; ShipLoop never needs a T3 credential.',
      ),
    );
  }

  return ok({ url: candidate });
}

/**
 * The refusal for a configured value that cannot be used.
 *
 * `Blocked` rather than `Invalid` because the remedy is an operator action on a
 * prerequisite — the same shape as every other missing prerequisite in the system, so
 * the HTTP layer renders it with the remedy attached instead of a bare 400. The
 * configured value itself is never included: a value bad enough to be refused is
 * exactly the value that should not be written to a log or an error body (N02-AC2).
 */
function unusable(problem: string, remedy: string): BlockedError {
  return blocked(`The configured T3 URL ${problem} (${T3_URL_ENV_VAR}).`, [
    {
      name: T3_URL_ENV_VAR,
      detail: 'The configured value was not a usable T3 deployment URL.',
      remedy,
    },
  ]);
}