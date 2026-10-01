/**
 * The Linear provider adapter surface.
 *
 * Exported as a subpath so a consumer can import the Linear adapter without pulling
 * in every adapter. `README.md` beside these files records exactly which behaviour
 * was proven against the live API and which is proven only against constructed
 * payloads, which is the distinction the specification requires a provider claim to
 * make (mvp-spec 9, N05-AC2).
 */

export {
  LINEAR_GRAPHQL_ENDPOINT,
  LinearClient,
  isLinearWrite,
  type LinearClientOptions,
  type LinearQuery,
  type LinearRateLimitSnapshot,
  type LinearReadQuery,
  type LinearSuccess,
  type LinearWriteQuery,
} from './client.ts';

export {
  isAlreadyExistsFailure,
  linearRetryAfterMs,
  lostWriteOutcome,
  mapLinearErrors,
  mapLinearFailure,
  parseLinearErrors,
  type LinearApiError,
  type LinearFailure,
  type LinearHeaders,
} from './errors.ts';

export {
  DEFAULT_MAX_DELIVERY_AGE_MS,
  LINEAR_DELIVERY_HEADER,
  LINEAR_EVENT_HEADER,
  LINEAR_SIGNATURE_HEADER,
  LINEAR_TIMESTAMP_HEADER,
  verifyLinearWebhook,
  type LinearWebhookDelivery,
  type LinearWebhookHeaders,
  type VerifyLinearWebhookRequest,
} from './signature.ts';

export {
  DEFAULT_CRITERIA_EXTRACTION,
  LinearTicketAdapter,
  extractAcceptanceCriteria,
  lexicalOverlap,
  managedCommentId,
  managedMarkerLine,
  publicationBody,
  publicationIssueId,
  publicationRelationId,
  type CriteriaExtraction,
  type LinearTicketAdapterOptions,
} from './adapter.ts';
