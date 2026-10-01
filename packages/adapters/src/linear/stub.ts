/**
 * A scripted Linear endpoint for the adapter's own tests.
 *
 * This is test support, not a fake adapter: it speaks only HTTP and the GraphQL
 * envelope, so every assertion in `linear.test.ts` still travels through the real
 * `LinearClient`, the real error mapping and the real translation code. What it adds
 * is the one thing `fetch` cannot give — a record of which operations were actually
 * issued, which is how "a repeated write produced exactly one side effect" becomes an
 * assertion rather than a claim (F10-AC3, F16-AC3, F30-AC2).
 *
 * It is not a model of Linear. The response bodies used by the tests are captures from
 * the live API on 1 October 2026, cited in `README.md`; the shapes that were not
 * captured are marked as constructed where they are used.
 */

export interface RecordedCall {
  readonly operationName: string;
  readonly variables: Record<string, unknown>;
}

export interface StubReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** Fail before any HTTP response, as a dropped connection would. */
  readonly transportFailure?: string;
}

export type Responder = (variables: Record<string, unknown>, callIndex: number) => StubReply;

/** A Linear issue as the scope query returns it. */
export interface StubIssueFields {
  readonly id: string;
  readonly identifier: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly url?: string;
  readonly updatedAt?: string;
  readonly priority?: number | null;
  readonly state?: { readonly id: string; readonly name: string; readonly type: string } | null | undefined;
  readonly team?: { readonly id: string; readonly key: string } | null | undefined;
  readonly labelNames?: readonly string[];
  readonly parentId?: string | null;
  readonly relations?: readonly StubRelationRow[] | undefined;
  readonly inverseRelations?: readonly StubRelationRow[] | undefined;
  readonly comments?: readonly { readonly id: string; readonly body: string; readonly url?: string; readonly updatedAt?: string }[];
}

/**
 * One `IssueRelation` row.
 *
 * `issue` and `relatedIssue` are modelled separately because Linear populates them
 * asymmetrically: on `inverseRelations` the `relatedIssue` field resolves back to the
 * subject. That asymmetry is captured live and is what the counterparty mapping exists
 * to survive.
 */
export interface StubRelationRow {
  readonly type: string;
  readonly issue: StubIssueFields | null;
  readonly relatedIssue: StubIssueFields | null;
}

export function relationRow(
  type: string,
  issue: StubIssueFields | null,
  relatedIssue: StubIssueFields | null,
): StubRelationRow {
  return { type, issue, relatedIssue };
}

function stubReference(issue: StubIssueFields): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title ?? '',
    url: issue.url ?? `https://linear.app/stub/issue/${issue.identifier}`,
    state: issue.state ?? null,
  };
}

/** The issue node exactly as `LinearIssueScope` selects it. */
export function stubIssuePayload(issue: StubIssueFields): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title ?? '',
    description: issue.description ?? null,
    url: issue.url ?? `https://linear.app/stub/issue/${issue.identifier}`,
    updatedAt: issue.updatedAt ?? '2026-09-30T12:00:00.000Z',
    priority: issue.priority ?? 0,
    state: issue.state ?? null,
    team: issue.team ?? null,
    labels: { nodes: (issue.labelNames ?? []).map((name) => ({ name })) },
    parent: issue.parentId === undefined || issue.parentId === null ? null : { id: issue.parentId },
    relations: {
      nodes: (issue.relations ?? []).map((row) => ({
        type: row.type,
        issue: row.issue === null ? null : stubReference(row.issue),
        relatedIssue: row.relatedIssue === null ? null : stubReference(row.relatedIssue),
      })),
    },
    inverseRelations: {
      nodes: (issue.inverseRelations ?? []).map((row) => ({
        type: row.type,
        issue: row.issue === null ? null : stubReference(row.issue),
        relatedIssue: row.relatedIssue === null ? null : stubReference(row.relatedIssue),
      })),
    },
    comments: {
      nodes: (issue.comments ?? []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        url: comment.url ?? `https://linear.app/stub/comment/${comment.id}`,
        updatedAt: comment.updatedAt ?? '2026-09-30T12:00:00.000Z',
      })),
    },
  };
}

/**
 * A scripted endpoint that records every operation it is asked to run.
 *
 * `responders` is keyed by the GraphQL operation name the adapter supplies, so a test
 * states what the provider answers and nothing else. An operation with no responder
 * fails the test loudly rather than returning an empty success.
 */
export class StubLinear {
  readonly calls: RecordedCall[] = [];
  readonly fetch: typeof fetch;
  private readonly responders: Readonly<Record<string, Responder>>;

  constructor(responders: Readonly<Record<string, Responder>>) {
    this.responders = responders;
    this.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        operationName?: string;
        variables?: Record<string, unknown>;
      };
      const operationName = payload.operationName ?? '(unnamed)';
      const variables = payload.variables ?? {};
      const callIndex = this.calls.length;
      this.calls.push({ operationName, variables });

      const responder = this.responders[operationName];
      if (responder === undefined) {
        return new Response(
          JSON.stringify({ errors: [{ message: `stub has no responder for ${operationName}` }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const reply = responder(variables, callIndex);
      if (reply.transportFailure !== undefined) {
        throw new TypeError(reply.transportFailure);
      }
      return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
      });
    };
  }

  /** How many times one operation was issued, which is the side-effect count. */
  countOf(operationName: string): number {
    return this.calls.filter((call) => call.operationName === operationName).length;
  }

  variablesFor(operationName: string, index = 0): Record<string, unknown> | undefined {
    return this.calls.filter((call) => call.operationName === operationName)[index]?.variables;
  }
}

/** A successful envelope. */
export function data(reply: Record<string, unknown>): StubReply {
  return { body: { data: reply } };
}

/**
 * A Linear error envelope.
 *
 * `statusCode` and `type` are set because the live captures carry them and the mapping
 * reads them; a response without them exercises a different branch, which the
 * transport tests state explicitly.
 */
export function apiError(
  message: string,
  extensions: {
    readonly code?: string;
    readonly type?: string;
    readonly statusCode?: number;
    readonly userPresentableMessage?: string;
    readonly path?: readonly string[];
  } = {},
  status?: number,
): StubReply {
  return {
    ...(status === undefined ? {} : { status }),
    body: {
      errors: [
        {
          message,
          ...(extensions.path === undefined ? {} : { path: [...extensions.path] }),
          extensions: {
            type: extensions.type ?? 'invalid input',
            code: extensions.code ?? 'INPUT_ERROR',
            statusCode: extensions.statusCode ?? 400,
            userError: true,
            ...(extensions.userPresentableMessage === undefined
              ? {}
              : { userPresentableMessage: extensions.userPresentableMessage }),
          },
        },
      ],
      data: null,
    },
  };
}

/** The live capture of a missing issue: HTTP 200, `data: null`, one error entry. */
export function notFoundEnvelope(): StubReply {
  return apiError('Entity not found: Issue', {
    code: 'INPUT_ERROR',
    type: 'invalid input',
    statusCode: 400,
    userPresentableMessage: 'Could not find referenced Issue.',
    path: ['issue'],
  });
}

/** The live capture of an unusable credential. */
export function unauthenticatedEnvelope(): StubReply {
  return {
    status: 401,
    body: {
      errors: [
        {
          message: 'Authentication required, not authenticated',
          extensions: {
            type: 'authentication error',
            code: 'AUTHENTICATION_ERROR',
            statusCode: 401,
            userError: true,
            userPresentableMessage: 'You need to authenticate to access this operation.',
          },
        },
      ],
      data: null,
    },
  };
}