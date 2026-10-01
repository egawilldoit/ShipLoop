/**
 * The Linear ticket adapter (F03, F06-AC4, F10, F11, F16-AC2/AC3, F29-AC3, N05-AC2).
 *
 * Three findings from the live read-only probe on 1 October 2026 shaped this file,
 * and all three are limits of the provider rather than of the contract:
 *
 * 1. **`Issue` has no acceptance-criteria field.** All 85 fields of Linear's `Issue`
 *    type were read through introspection; none of them carries criteria. Criteria
 *    therefore exist only inside the issue description's markdown, so `readScope`
 *    extracts them from an explicitly delimited region or from a recognised criteria
 *    heading, and reports **no** criteria when neither is present rather than
 *    promoting arbitrary prose bullets into criteria. Freeform markdown is genuinely
 *    ambiguous, and inventing criteria would put phantom entries into the scope
 *    fingerprint (F12).
 * 2. **Linear reports no issue revision.** `Issue` exposes `updatedAt` only, which is
 *    the closest available `providerRevision`; it is not a monotonic counter, so two
 *    edits inside one millisecond are indistinguishable. The material content
 *    fingerprint, not this field, is what F12 compares.
 * 3. **`searchIssues` returns no similarity score.** It returns identifiers, titles,
 *    descriptions, states and labels, but nothing that ranks one hit above another.
 *    `RelatedIssue.similarity` is therefore a ShipLoop-computed lexical overlap,
 *    documented as such, and never a decision input (F06-AC4).
 *
 * Two further limits were confirmed by introspection on the same date and shape the
 * identity strategy rather than the mapping. `IssueCreateInput.id`, `CommentCreateInput.id`
 * and `IssueRelationCreateInput.id` are all client-supplied `String`s, which is what
 * makes a derived identity an actual provider-side uniqueness constraint rather than a
 * local convention. `IssueUpdateInput` offers no expected-state precondition, so a
 * state change cannot be applied conditionally and is re-read immediately instead
 * (see `requestTransition`).
 *
 * One provider quirk is corrected rather than propagated: Linear's
 * `inverseRelations` for a live EGA issue contained a self-referencing `blocks` row,
 * so a direction-blind mapping would make every issue depend on itself. Self-references
 * are dropped in both directions. The remaining direction of that mapping was confirmed
 * live across 20 readable EGA issues: every `Blocks` reported on one issue appeared as
 * `BlockedBy` on the other, with no disagreement in either direction.
 */

import { createHash } from 'node:crypto';

import {
  conflict,
  err,
  fingerprint,
  invalid,
  ok,
  type CapabilityDeclaration,
  type ConnectorId,
  type DomainError,
  type ProviderId,
  type Result,
  type ScopeCriterion,
  type ScopeSnapshot,
} from '@shiploop/domain';

import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterCapabilities,
  type AdapterCompatibility,
  type AdapterContext,
  type DescribeTransitionsRequest,
  type FailedTicketPublish,
  type ManagedProgressOutcome,
  type ManagedProgressUpdateRequest,
  type ManagedRegion,
  type ManagedRegionTarget,
  type PublishWorkOutcome,
  type PublishWorkRequest,
  type PublishedIssue,
  type RelatedIssue,
  type RelatedIssueSearchRequest,
  type RelatedIssueSignal,
  type ReadTicketScopeRequest,
  type TicketAdapter,
  type TicketIssueRef,
  type TicketRelation,
  type TicketRelationKind,
  type TicketScopeRead,
  type TicketState,
  type TicketTransitionDescriptor,
  type TicketTransitionOutcome,
  type TicketTransitionRequest,
} from '../contracts/index.ts';

import { LinearClient, type LinearClientOptions } from './client.ts';
import { isAlreadyExistsFailure } from './errors.ts';

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

const ISSUE_SCOPE_DOCUMENT = `query LinearIssueScope($id: String!, $commentCount: Int!) {
  issue(id: $id) {
    id identifier title description url updatedAt priority
    state { id name type }
    team { id key }
    labels { nodes { name } }
    parent { id identifier }
    relations { nodes { type issue { id identifier title url state { id name type } } relatedIssue { id identifier title url state { id name type } } } }
    inverseRelations { nodes { type issue { id identifier title url state { id name type } } relatedIssue { id identifier title url state { id name type } } } }
    comments(first: $commentCount) { nodes { id body url createdAt updatedAt } }
  }
}`;

const ISSUE_TEAM_DOCUMENT = `query LinearIssueTeam($id: String!) { issue(id: $id) { id identifier team { id key } } }`;

const TEAMS_DOCUMENT = `query LinearTeams($first: Int!) { teams(first: $first) { nodes { id key name } } }`;

const WORKFLOW_STATES_DOCUMENT = `query LinearWorkflowStates($teamKey: String!, $first: Int!) {
  workflowStates(first: $first, filter: { team: { key: { eq: $teamKey } } }) {
    nodes { id name type position }
  }
}`;

const SEARCH_ISSUES_DOCUMENT = `query LinearSearchIssues($term: String!, $first: Int!) {
  searchIssues(term: $term, first: $first) {
    nodes {
      id identifier title url description priority updatedAt
      team { key }
      state { id name type }
      labels { nodes { name } }
    }
  }
}`;

const ISSUE_CREATE_DOCUMENT = `mutation LinearIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title description url updatedAt priority state { id name type } }
  }
}`;

const ISSUE_UPDATE_DOCUMENT = `mutation LinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier state { id name type } updatedAt } }
}`;

const RELATION_CREATE_DOCUMENT = `mutation LinearRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success issueRelation { id type } }
}`;

const COMMENT_CREATE_DOCUMENT = `mutation LinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body url createdAt updatedAt } }
}`;

const COMMENT_UPDATE_DOCUMENT = `mutation LinearCommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success comment { id body url updatedAt } }
}`;

const VIEWER_DOCUMENT = `query LinearViewer { viewer { id name } }`;

/* -------------------------------------------------------------------------- */
/* ShipLoop vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Linear's workflow-state type mapped onto ShipLoop's own terminal vocabulary.
 *
 * A type absent from this table becomes `Unknown`, never a pass-through of the
 * provider's string: a workflow state named "Done" must not be readable as release
 * confirmation (F29-AC3, F29-AC5).
 *
 * `duplicate` maps to `Cancelled` because that is what it means in this vocabulary: the
 * work is closed and deliberately will not be delivered. It is not `Done`, so nothing
 * downstream can read a duplicated issue as a shipped one. Observed live on EGA, whose
 * states are `backlog`, `unstarted`, `started`, `completed`, `canceled` and `duplicate`.
 */
const STATE_TYPE_TERMINAL: Readonly<Record<string, 'Done' | 'Cancelled' | 'None'>> = {
  completed: 'Done',
  canceled: 'Cancelled',
  duplicate: 'Cancelled',
  triage: 'None',
  backlog: 'None',
  unstarted: 'None',
  started: 'None',
};

/**
 * Linear's numeric priority mapped onto ShipLoop's own names.
 *
 * `priorityLabel` is deliberately unused: it is a provider display string, and this
 * adapter must not pass provider vocabulary through as if it were its own.
 */
const PRIORITY_NAMES: Readonly<Record<number, string>> = {
  0: 'NoPriority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

const RELATION_KIND_OUTGOING: Readonly<Record<string, TicketRelationKind | null>> = {
  blocks: 'Blocks',
  duplicate: 'Duplicate',
  related: 'Related',
};

const RELATION_KIND_INCOMING: Readonly<Record<string, TicketRelationKind | null>> = {
  blocks: 'BlockedBy',
  duplicate: 'Duplicate',
  related: 'Related',
};

/** Markers that delimit the regions ShipLoop owns inside a Linear issue body. */
const CRITERIA_START = '<!--shiploop:criteria:start-->';
const CRITERIA_END = '<!--shiploop:criteria:end-->';
const MANAGED_MARKER_PREFIX = '<!--shiploop:managed:v1';
const MANAGED_MARKER_SUFFIX = '-->';

/** Headings whose list items are acceptance criteria when no explicit region exists. */
const DEFAULT_CRITERIA_HEADINGS: readonly RegExp[] = [
  /^acceptance criteria\b/i,
  /^automated acceptance criteria\b/i,
  /^acceptance tests?\b/i,
  /^definition of done\b/i,
];

const MAX_CRITERIA = 200;
const MAX_COMMENTS_SCANNED = 50;
const MAX_RELATIONS = 200;

export interface CriteriaExtraction {
  readonly headingPatterns: readonly RegExp[];
  readonly maxCriteria: number;
}

export const DEFAULT_CRITERIA_EXTRACTION: CriteriaExtraction = {
  headingPatterns: DEFAULT_CRITERIA_HEADINGS,
  maxCriteria: MAX_CRITERIA,
};

export interface LinearTicketAdapterOptions {
  readonly connectorId: ConnectorId;
  readonly client: LinearClientOptions;
  readonly criteria?: CriteriaExtraction;
  /** Bounded because Linear rejects a single query above 10,000 complexity points. */
  readonly workflowStatePageSize?: number;
}

/* -------------------------------------------------------------------------- */
/* Boundary readers                                                            */
/* -------------------------------------------------------------------------- */

interface LinearStateShape {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

interface LinearCommentShape {
  readonly id: string;
  readonly body: string;
  readonly url: string;
  readonly updatedAt: string;
}

interface LinearRelationShape {
  readonly type: string;
  readonly issue: LinearIssueShape | null;
  readonly relatedIssue: LinearIssueShape | null;
}

interface LinearIssueShape {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly description: string | null;
  readonly updatedAt: string;
  readonly priority: number | null;
  readonly state: LinearStateShape | null;
  readonly teamKey: string | null;
  readonly labelNames: readonly string[];
  readonly relations: readonly LinearRelationShape[];
  readonly inverseRelations: readonly LinearRelationShape[];
  readonly comments: readonly LinearCommentShape[];
  readonly parentId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** A direct object field. `viewer` and `issue` are objects, not connections. */
function fieldOf(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** A connection's `nodes`. */
function nodesOf(value: unknown, key: string): readonly unknown[] {
  const nodes = fieldOf(fieldOf(value, key), 'nodes');
  return Array.isArray(nodes) ? nodes : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredStr(value: unknown): string | null {
  const found = str(value);
  return found !== null && found.length > 0 ? found : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readState(value: unknown): LinearStateShape | null {
  const id = requiredStr(fieldOf(value, 'id'));
  const name = requiredStr(fieldOf(value, 'name'));
  const type = requiredStr(fieldOf(value, 'type'));
  return id === null || name === null || type === null ? null : { id, name, type };
}

/**
 * Reads an issue, or a nested related issue, from an untyped payload.
 *
 * Returns `null` rather than a partial record, so a shape change becomes one honest
 * `Unavailable` for the whole read instead of a snapshot with silently dropped scope.
 * `depth` bounds the recursion: related issues are one level deep and carry no
 * relations of their own.
 */
function readIssue(value: unknown, depth: number): LinearIssueShape | null {
  const id = requiredStr(fieldOf(value, 'id'));
  const identifier = requiredStr(fieldOf(value, 'identifier'));
  const url = requiredStr(fieldOf(value, 'url'));
  if (id === null || identifier === null || url === null) return null;
  const team = fieldOf(value, 'team');
  return {
    id,
    identifier,
    title: str(fieldOf(value, 'title')) ?? '',
    url,
    description: str(fieldOf(value, 'description')),
    updatedAt: str(fieldOf(value, 'updatedAt')) ?? '',
    priority: intOrNull(fieldOf(value, 'priority')),
    state: readState(fieldOf(value, 'state')),
    teamKey: requiredStr(fieldOf(team, 'key')),
    labelNames: readLabelNames(fieldOf(value, 'labels')),
    relations: depth === 0 ? readRelations(fieldOf(value, 'relations')) : [],
    inverseRelations: depth === 0 ? readRelations(fieldOf(value, 'inverseRelations')) : [],
    comments: depth === 0 ? readComments(fieldOf(value, 'comments')) : [],
    parentId: requiredStr(fieldOf(fieldOf(value, 'parent'), 'id')),
  };
}

function readRelations(value: unknown): readonly LinearRelationShape[] {
  const nodes = fieldOf(value, 'nodes');
  if (!Array.isArray(nodes)) return [];
  const collected: LinearRelationShape[] = [];
  for (const node of nodes.slice(0, MAX_RELATIONS)) {
    const type = requiredStr(fieldOf(node, 'type'));
    if (type === null) continue;
    collected.push({
      type,
      issue: readIssue(fieldOf(node, 'issue'), 1),
      relatedIssue: readIssue(fieldOf(node, 'relatedIssue'), 1),
    });
  }
  return collected;
}

function readLabelNames(value: unknown): readonly string[] {
  const nodes = fieldOf(value, 'nodes');
  if (!Array.isArray(nodes)) return [];
  const collected: string[] = [];
  for (const node of nodes) {
    const name = requiredStr(fieldOf(node, 'name'));
    if (name !== null) collected.push(name);
  }
  return collected;
}

function readComments(value: unknown): readonly LinearCommentShape[] {
  const nodes = fieldOf(value, 'nodes');
  if (!Array.isArray(nodes)) return [];
  const collected: LinearCommentShape[] = [];
  for (const node of nodes.slice(0, MAX_COMMENTS_SCANNED)) {
    const id = requiredStr(fieldOf(node, 'id'));
    const body = str(fieldOf(node, 'body'));
    if (id === null || body === null) continue;
    collected.push({ id, body, url: str(fieldOf(node, 'url')) ?? '', updatedAt: str(fieldOf(node, 'updatedAt')) ?? '' });
  }
  return collected;
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

function mapTicketState(state: LinearStateShape | null, redact: (text: string) => string): TicketState {
  if (state === null) {
    return { kind: 'Unknown', detail: 'Linear reported no workflow state for this issue, so its state cannot be mapped.' };
  }
  const terminal = STATE_TYPE_TERMINAL[state.type];
  if (terminal === undefined) {
    return {
      kind: 'Unknown',
      detail: redact(
        `Linear reported a workflow state type this adapter does not recognise ("${state.type}"), so the state is reported as unknown rather than passed through as a ShipLoop state.`,
      ),
    };
  }
  return { kind: 'ProviderState', name: state.name, terminal };
}

function mapPriority(priority: number | null): string | null {
  if (priority === null) return null;
  return PRIORITY_NAMES[priority] ?? null;
}

function issueRef(issue: LinearIssueShape): TicketIssueRef {
  return { issueId: issue.id as ProviderId, identifier: issue.identifier, url: issue.url };
}

/**
 * Maps both relation directions, dropping self-references.
 *
 * Linear populates the two sides of the connection differently. On `relations` the
 * row reads `issue = <subject>`, `relatedIssue = <counterparty>`; on
 * `inverseRelations` — captured live on EGA-663, whose inbound rows are
 * `issue = EGA-662, relatedIssue = EGA-663` — `relatedIssue` resolves back to the
 * **subject**. Reading `relatedIssue` on both sides therefore yields the issue itself
 * for every inbound row, which a self-reference filter then discards: `BlockedBy`
 * dependencies would come back permanently empty and `ScopeSnapshot.dependencyIssueIds`
 * would silently under-report real scope (F12-AC1). The counterparty is whichever of
 * the two fields is not the subject, so direction is derived from the data rather than
 * assumed.
 */
function mapRelations(issue: LinearIssueShape): readonly TicketRelation[] {
  const collected: TicketRelation[] = [];
  const seen = new Set<string>();
  for (const [relation, kinds] of [
    [issue.relations, RELATION_KIND_OUTGOING],
    [issue.inverseRelations, RELATION_KIND_INCOMING],
  ] as const) {
    for (const row of relation) {
      const kind = kinds[row.type];
      if (kind === undefined || kind === null) continue;
      const counterparty = counterpartyOf(issue.id, row);
      if (counterparty === null) continue;
      const identity = `${kind}:${counterparty.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      collected.push({ kind, issue: issueRef(counterparty) });
    }
  }
  return collected;
}

function counterpartyOf(subjectId: string, row: LinearRelationShape): LinearIssueShape | null {
  if (row.relatedIssue !== null && row.relatedIssue.id !== subjectId) return row.relatedIssue;
  if (row.issue !== null && row.issue.id !== subjectId) return row.issue;
  return null;
}

function dependencyIds(relations: readonly TicketRelation[]): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const relation of relations) {
    if (relation.kind !== 'BlockedBy') continue;
    const id = relation.issue.issueId;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Acceptance criteria                                                         */
/* -------------------------------------------------------------------------- */

const TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;
const BULLET_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
/** An author-supplied stable criterion identity, e.g. `AC2`, `[AC-2]` or `AC 2:`. */
const EXPLICIT_ID = /^\[?(AC[-_ ]?\d{1,4})\]?(\s*[:.—–-]\s*|\s+)(.*)$/i;
/** The marker `publicationBody` writes so a published criterion id survives verbatim. */
const PUBLISHED_ID = /^<!--shiploop:ac:([^>]+?)-->\s*(.*)$/;

function criteriaRegion(description: string): string | null {
  const start = description.indexOf(CRITERIA_START);
  const end = description.indexOf(CRITERIA_END);
  if (start < 0 || end < 0 || end <= start) return null;
  return description.slice(start + CRITERIA_START.length, end);
}

function sectionAfterHeading(description: string, pattern: RegExp): string | null {
  const collected: string[] = [];
  let headingLevel: number | null = null;
  for (const line of description.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const title = (heading[2] ?? '').trim();
      if (headingLevel === null) {
        if (pattern.test(title)) headingLevel = level;
        continue;
      }
      if (level <= headingLevel) break;
    }
    if (headingLevel !== null) collected.push(line);
  }
  return headingLevel === null ? null : collected.join('\n');
}

/**
 * Extracts criteria with ids that survive an unrelated edit.
 *
 * An id is never an array index, because inserting a criterion at the top would
 * renumber every criterion below it and report a material scope change for a change
 * that touched no existing criterion (F12-AC2). Ids come from, in order: the marker
 * `publicationBody` wrote, an author-supplied `AC<n>` token, or a slug of the criterion
 * text.
 *
 * Every id is registered in one collision set, explicit ids included. Without that, a
 * criterion written as `- [AC-1] …` and a prose criterion that slugs to `ac-1` would
 * both be reported as `AC1`, and `compareScope` would then treat an edit to one as an
 * edit to both.
 */
export function extractAcceptanceCriteria(
  description: string,
  extraction: CriteriaExtraction = DEFAULT_CRITERIA_EXTRACTION,
): readonly ScopeCriterion[] {
  const body = criteriaRegion(description) ?? findCriteriaSection(description, extraction);
  if (body === null) return [];

  const slugs = new Map<string, number>();
  const taken = new Set<string>();
  const criteria: ScopeCriterion[] = [];
  for (const line of body.split('\n')) {
    if (criteria.length >= extraction.maxCriteria) break;
    const parsed = parseCriterionLine(line);
    if (parsed === null) continue;
    const id = parsed.id ?? uniqueSlug(parsed.text, slugs);
    if (taken.has(id)) continue;
    taken.add(id);
    criteria.push({ id, text: parsed.text });
  }
  return criteria;
}

function findCriteriaSection(description: string, extraction: CriteriaExtraction): string | null {
  for (const pattern of extraction.headingPatterns) {
    const section = sectionAfterHeading(description, pattern);
    if (section !== null) return section;
  }
  return null;
}

function parseCriterionLine(line: string): { readonly id: string | null; readonly text: string } | null {
  const task = TASK_ITEM.exec(line);
  const raw = task !== null
    ? (task[2] ?? null)
    : (BULLET_ITEM.exec(line)?.[1] ?? ORDERED_ITEM.exec(line)?.[1] ?? null);
  if (raw === null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  const published = PUBLISHED_ID.exec(text);
  if (published !== null) {
    return { id: decodeURIComponent(published[1] ?? ''), text: (published[2] ?? '').trim() };
  }
  if (text.startsWith('<!--')) return null;
  const explicit = EXPLICIT_ID.exec(text);
  if (explicit === null) return { id: null, text };
  return { id: canonicalCriterionId(explicit[1] ?? ''), text: (explicit[3] ?? '').trim() };
}

function canonicalCriterionId(raw: string): string {
  const digits = /(\d{1,4})\s*$/.exec(raw);
  return `AC${digits?.[1] ?? raw.replace(/\D+/g, '')}`;
}

/**
 * A readable, deterministic id from criterion text.
 *
 * Two different criteria can normalise to the same slug, so a document-order ordinal
 * disambiguates them. That ordinal counts repeats of one text, not position in the
 * list, which is what keeps an insertion from renaming anything.
 */
function uniqueSlug(text: string, used: Map<string, number>): string {
  const base = slugify(text);
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen + 1}`;
}

function slugify(text: string): string {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const trimmed = normalized.slice(0, 60).replace(/-+$/g, '');
  return trimmed.length > 0 ? trimmed : 'criterion';
}

/* -------------------------------------------------------------------------- */
/* Managed region                                                              */
/* -------------------------------------------------------------------------- */

interface ManagedMarker {
  readonly operationId: string | null;
  readonly milestoneKey: string | null;
  readonly digest: string | null;
  readonly deliveredAt: string | null;
}

/**
 * The provenance of the last delivery, written into the comment it belongs to.
 *
 * It lives in the provider, not in ShipLoop, so the answer to "was this milestone
 * already delivered?" survives a restart, a lost response and a second process. Every
 * field is URL-encoded because a milestone key is caller-supplied free text.
 */
export function managedMarkerLine(input: {
  readonly issueId: string;
  readonly operationId: string;
  readonly milestoneKey: string;
  readonly digest: string;
  readonly deliveredAt: string;
}): string {
  const fields = [
    `issue=${input.issueId}`,
    `op=${encodeURIComponent(input.operationId)}`,
    `milestone=${encodeURIComponent(input.milestoneKey)}`,
    `digest=${input.digest}`,
    `at=${encodeURIComponent(input.deliveredAt)}`,
  ];
  return `${MANAGED_MARKER_PREFIX} ${fields.join(' ')} ${MANAGED_MARKER_SUFFIX}`;
}

function parseManagedMarker(body: string): ManagedMarker | null {
  const start = body.indexOf(MANAGED_MARKER_PREFIX);
  if (start < 0) return null;
  const end = body.indexOf(MANAGED_MARKER_SUFFIX, start);
  if (end < 0) return null;
  const fields = body.slice(start + MANAGED_MARKER_PREFIX.length, end).trim().split(/\s+/);
  const read = (name: string): string | null => {
    const field = fields.find((entry) => entry.startsWith(`${name}=`));
    return field === undefined ? null : field.slice(name.length + 1);
  };
  return {
    operationId: decodeOrNull(read('op')),
    milestoneKey: decodeOrNull(read('milestone')),
    digest: read('digest'),
    deliveredAt: decodeOrNull(read('at')),
  };
}

/**
 * Decodes a marker field, tolerating a value this version did not encode.
 *
 * A marker written by an older build, or one a human edited, may hold a raw string; a
 * failed decode returns the raw value rather than discarding the field, so a partially
 * readable marker still suppresses the deliveries it can identify.
 */
function decodeOrNull(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function contentDigest(body: string): string {
  return fingerprint({ body }).slice(3, 19);
}

/**
 * The one region ShipLoop owns in a Linear issue.
 *
 * A dedicated comment is the mechanism because Linear's `commentUpdate` replaces only
 * that comment, so writing it cannot touch the issue description or any other comment.
 * That is what F16-AC2 requires; `commentCreate`, `commentUpdate` and a client-supplied
 * `CommentCreateInput.id` were all confirmed present in Linear's mutation set through
 * introspection on 1 October 2026.
 *
 * Every managed comment found is reported, not just the first. A second one means
 * something outside this adapter created a competing region, and hiding it would let
 * ShipLoop update a region while the owner reads another.
 */
function managedCommentsOf(comments: readonly LinearCommentShape[]): readonly ManagedCommentShape[] {
  const found: ManagedCommentShape[] = [];
  for (const comment of comments) {
    const marker = parseManagedMarker(comment.body);
    if (marker !== null) found.push({ commentId: comment.id, marker });
  }
  return found;
}

interface ManagedCommentShape {
  readonly commentId: string;
  readonly marker: ManagedMarker | null;
}

/**
 * Where a managed-region target resolved to.
 *
 * `Unobserved` is a distinct answer rather than a null comment, because "this comment
 * is not in the page I read" and "there is no managed comment yet" call for opposite
 * responses: one refuses, the other creates.
 */
type ManagedTargetLookup =
  | { readonly kind: 'Found'; readonly comment: ManagedCommentShape | null }
  | { readonly kind: 'Unobserved'; readonly commentId: string };

function managedRegionsOf(issue: LinearIssueShape): readonly ManagedRegion[] {
  const found = managedCommentsOf(issue.comments);
  if (found.length === 0) {
    return [
      {
        target: { kind: 'AppendOnlyCommentThread', lastCommentId: null },
        lastMilestoneKey: null,
        lastDeliveredAt: null,
        lastDeliveredContentDigest: null,
      },
    ];
  }
  return found.map((comment) => ({
    target: { kind: 'UpdatableComment', commentId: comment.commentId as ProviderId },
    lastMilestoneKey: comment.marker?.milestoneKey ?? null,
    lastDeliveredAt: comment.marker?.deliveredAt ?? null,
    lastDeliveredContentDigest: comment.marker?.digest ?? null,
  }));
}

/* -------------------------------------------------------------------------- */
/* Deterministic identities                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The Linear issue identity a publication owns.
 *
 * `IssueCreateInput.id` is a client-supplied `String` (confirmed by introspection on
 * 1 October 2026), so the identity is derived from the `OperationId` rather than chosen
 * at random. Two attempts at the same publication therefore address the same Linear
 * issue, so the write cannot produce two issues and a lost response is resolved by
 * reading that identity rather than by guessing (F10-AC3, F30-AC5).
 */
export function publicationIssueId(operationId: string): string {
  return uuidFromName(`shiploop:linear:issue:${operationId}`);
}

/**
 * The comment identity one delivery operation owns.
 *
 * `CommentCreateInput.id` is client-supplied as well, so a replayed milestone delivery
 * cannot create a second comment even if the read that decides it races (F16-AC3).
 */
export function managedCommentId(operationId: string): string {
  return uuidFromName(`shiploop:linear:comment:${operationId}`);
}

/**
 * The relation identity one published dependency owns.
 *
 * `IssueRelationCreateInput.id` is client-supplied, so re-running the same publication
 * addresses the same relation row instead of adding a second one.
 */
export function publicationRelationId(operationId: string, dependencyId: string): string {
  return uuidFromName(`shiploop:linear:relation:${operationId}:${dependencyId}`);
}

function uuidFromName(name: string): string {
  const digest = createHash('sha256').update(name).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A human-facing Linear identifier such as `EGA-664`; Linear resolves it to the UUID. */
const IDENTIFIER_SHAPE = /^[A-Z][A-Z0-9]{0,9}-[0-9]{1,7}$/;

export type LinearIssueRefusal = 'NotALinearIdentity' | 'ResolvableIdentifier';

function classifyIssueRef(issueId: string): LinearIssueRefusal | null {
  if (UUID_SHAPE.test(issueId)) return null;
  if (IDENTIFIER_SHAPE.test(issueId)) return 'ResolvableIdentifier';
  return 'NotALinearIdentity';
}

/**
 * Refuses an identity that cannot be a Linear issue at all.
 *
 * Linear owns UUID issue identities, and also accepts its own `KEY-123` identifiers —
 * verified live, `issue(id: "EGA-664")` returned EGA-664's UUID — so a human-typed
 * identifier is resolvable rather than refused. Anything else, such as a repository
 * identity, is a wrong-provider mapping and ARCHITECTURE requires it refused rather than
 * looked up and possibly satisfied by a same-named resource (F11-AC3, N05-AC2).
 */
function refuseForeignIdentity(issueId: string, redact: (text: string) => string): DomainError | null {
  if (classifyIssueRef(issueId) !== 'NotALinearIdentity') return null;
  return {
    code: 'Forbidden',
    reason: redact(
      `"${issueId}" is neither a Linear issue UUID nor a Linear team identifier. Refused rather than searched for a similarly named issue, because a match by name is not an identity (F11-AC3).`,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

const DECLARATIONS: readonly CapabilityDeclaration[] = [
  { kind: 'Ticket:ReadScope', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Ticket:PublishIssue', supported: true, limitation: null, privileged: false, supportsPrecondition: true },
  { kind: 'Ticket:UpdateManagedProgress', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
  { kind: 'Ticket:RequestTransition', supported: true, limitation: null, privileged: false, supportsPrecondition: false },
];

export class LinearTicketAdapter implements TicketAdapter {
  readonly kind = 'Ticket' as const;
  readonly connectorId: ConnectorId;
  private readonly client: LinearClient;
  private readonly criteria: CriteriaExtraction;
  private readonly workflowStatePageSize: number;

  constructor(options: LinearTicketAdapterOptions) {
    this.connectorId = options.connectorId;
    this.client = new LinearClient(options.client);
    this.criteria = options.criteria ?? DEFAULT_CRITERIA_EXTRACTION;
    this.workflowStatePageSize = options.workflowStatePageSize ?? 50;
  }

  capabilities(): AdapterCapabilities {
    return { kind: 'Ticket', contractVersion: ADAPTER_CONTRACT_VERSION, declarations: DECLARATIONS };
  }

  /**
   * Probes the credential rather than assuming it (F03-AC2).
   *
   * Linear reports no API version, so `runtimeVersion` is null and the contract
   * version is the only compatibility fact available. A revoked credential yields
   * `compatible: false` carrying the reauthorization instruction, so the owner UI can
   * show an actionable error before work starts (F03-AC4).
   */
  async checkCompatibility(context: AdapterContext): Promise<Result<AdapterCompatibility>> {
    const observedAt = context.clock.now();
    const viewer = await this.client.execute(context, {
      operationName: 'LinearViewer',
      document: VIEWER_DOCUMENT,
      variables: {},
    });
    if (!viewer.ok) {
      return ok({
        kind: 'Ticket',
        contractVersion: ADAPTER_CONTRACT_VERSION,
        runtimeVersion: null,
        compatible: false,
        detail: viewer.error.reason,
        observedAt,
      });
    }
    const id = requiredStr(fieldOf(fieldOf(viewer.value.data, 'viewer'), 'id'));
    return ok({
      kind: 'Ticket',
      contractVersion: ADAPTER_CONTRACT_VERSION,
      runtimeVersion: null,
      compatible: id !== null,
      detail:
        id === null
          ? 'Linear answered the identity query with a shape this adapter cannot read, so access is unproven.'
          : 'Linear accepted the connector credential. Linear reports no API version, so the contract version is the only compatibility fact.',
      observedAt,
    });
  }

  /** F11-AC1, F12-AC1: the live issue content and the immutable snapshot derived from it. */
  async readScope(context: AdapterContext, request: ReadTicketScopeRequest): Promise<Result<TicketScopeRead>> {
    const foreign = refuseForeignIdentity(request.issueId, context.redact);
    if (foreign !== null) return err(foreign);

    const read = await this.fetchIssue(context, request.issueId);
    if (!read.ok) return read;
    const issue = read.value;
    const relations = mapRelations(issue);
    const observedAt = context.clock.now();
    return ok({
      issue: issueRef(issue),
      snapshot: this.snapshotOf(issue, request.workItemId, dependencyIds(relations), observedAt),
      state: mapTicketState(issue.state, context.redact),
      relations,
      managedRegions: managedRegionsOf(issue),
      observedAt,
    });
  }

  /**
   * F06-AC4: surfaces potentially related work and never decides.
   *
   * Two sources, in that order, because they carry different weight. The scope issue's
   * **declared relations** are provider facts — a `blocks` row is Linear telling us
   * these two issues depend on each other, and hiding it behind a text-similarity filter
   * would discard the strongest related-work signal the provider offers. Then Linear's
   * **search** contributes candidates, of which only the ones whose similarity signals
   * this adapter actually measured are reported.
   *
   * Every result is `RequiresOwnerDecision`; the contract has no auto-adopt variant and
   * this adapter does not manufacture one. `searchIssues` is used because `issueSearch`
   * answers `{"Unknown argument \"term\" on field \"Query.issueSearch\""}` with HTTP 400
   * on the live API, verified on 1 October 2026.
   *
   * `RelatedIssueSearchRequest` carries only a `ScopeSnapshot`, which has no label
   * field, so `SharedLabel` cannot be derived from the declared inputs alone. The scope
   * snapshot does name its issue, so that issue's labels are read as a provider fact and
   * compared. A result with no measured signal is dropped rather than returned with an
   * empty `matchedOn`, which the contract's own type says is a list of reasons.
   */
  async findRelatedIssues(
    context: AdapterContext,
    request: RelatedIssueSearchRequest,
  ): Promise<Result<readonly RelatedIssue[]>> {
    const limit = Math.max(1, Math.min(request.limit, 50));
    const scope = await this.fetchIssue(context, request.scope.issueId);
    const declared = scope.ok ? relatedFromRelations(scope.value, request.scope.issueId, context.redact) : [];
    if (declared.length >= limit) return ok(declared.slice(0, limit));

    const term = searchTermFor(request.scope);
    if (term.length === 0) return ok(declared);
    const search = await this.client.execute(context, {
      operationName: 'LinearSearchIssues',
      document: SEARCH_ISSUES_DOCUMENT,
      variables: { term, first: limit + 1 },
    });
    if (!search.ok) return search;

    const seen = new Set<string>(declared.map((entry) => entry.issue.issueId as string));
    const related: RelatedIssue[] = [...declared];
    for (const node of nodesOf(search.value.data, 'searchIssues')) {
      const issue = readIssue(node, 0);
      if (issue === null || issue.id === request.scope.issueId || seen.has(issue.id)) continue;
      const matchedOn = matchSignals(request.scope, issue, scope.ok ? scope.value.labelNames : []);
      if (matchedOn.length === 0) continue;
      seen.add(issue.id);
      related.push({
        issue: issueRef(issue),
        relation: 'Related',
        state: mapTicketState(issue.state, context.redact),
        matchedOn,
        similarity: lexicalOverlap(request.scope.title, issue.title),
        adoption: {
          kind: 'RequiresOwnerDecision',
          reason:
            'Linear returns no similarity score for a search result, so this overlap is ShipLoop\'s own text measure and is presentation only. Resemblance never merges or discards an idea; the owner chooses link, extend or create new (F06-AC4).',
        },
      });
      if (related.length >= limit) break;
    }
    return ok(related);
  }

  /**
   * F10-AC1, F10-AC3, F10-AC5: publication keyed by `OperationId`.
   *
   * The issue identity is derived from the operation, so a repeat either finds the
   * issue it already created or is the first attempt that created it. There is no
   * window in which a repeat creates a second issue, because both attempts carry the
   * same client-supplied `id` and that value *is* the Linear issue identity.
   *
   * A repeat does **not** skip dependency linking: `PartiallyPublished` declares itself
   * `recoverable`, and it could only be that if re-running the same `operationId`
   * finished the links that failed. The returned snapshot is then re-read from the
   * provider rather than copied from the proposal, so what it reports is what Linear
   * holds (F10-AC2, F10-AC4).
   */
  async publishWork(context: AdapterContext, request: PublishWorkRequest): Promise<Result<PublishWorkOutcome>> {
    if (request.adoptExistingIssueId !== null) {
      return this.adoptExisting(context, request);
    }

    const targetIssueId = publicationIssueId(request.operationId);
    const team = await this.resolveTeam(context, request.revision.targetTeamKey);
    if (!team.ok) return team;

    const existing = await this.fetchIssue(context, targetIssueId);
    if (existing.ok) {
      return this.completePublication(context, request, existing.value, 'AlreadyPresent');
    }
    if (existing.error.code !== 'NotFound') return err(existing.error);

    const created = await this.client.execute(context, {
      operationName: 'LinearIssueCreate',
      mutating: true,
      target: `linear:issue:${targetIssueId}`,
      document: ISSUE_CREATE_DOCUMENT,
      variables: {
        input: {
          id: targetIssueId,
          teamId: team.value,
          title: request.revision.title,
          description: publicationBody({ ...request.revision, operationId: request.operationId }),
        },
      },
    });
    if (!created.ok) {
      // A lost response is already the honest answer: rewriting it as a plain failure
      // would invite the retry that creates the duplicate this identity exists to
      // prevent (F30-AC5).
      if (created.error.code === 'OutcomeUnknown') return err(created.error);
      // Two attempts at one publication can overlap: the existence read above may be
      // answered before the other attempt's create lands. The provider's own rejection
      // of the taken identity is resolved by reading it, never by creating again.
      if (isAlreadyExistsFailure(created.error)) {
        const raced = await this.fetchIssue(context, targetIssueId);
        if (raced.ok) return this.completePublication(context, request, raced.value, 'AlreadyPresent');
      }
      return err(
        invalid(
          context.redact(`Linear refused to create the published issue: ${created.error.reason}`),
          created.error.code === 'Invalid' ? created.error.fields : [],
        ),
      );
    }
    const issue = readIssue(fieldOf(fieldOf(created.value.data, 'issueCreate'), 'issue'), 0);
    if (issue === null) {
      return err({
        code: 'Unavailable',
        reason:
          'Linear accepted the issue creation but returned a shape this adapter cannot read. The issue identity is known from the operation, so read that identity before any retry rather than creating another issue.',
      });
    }
    return this.completePublication(context, request, issue, 'CreatedNew');
  }

  /**
   * F16-AC2, F16-AC3: one updatable comment, written at most once per milestone.
   *
   * A repeat of the same `milestoneKey` is answered `Unchanged` **without any write**,
   * so a second comment cannot appear. Reconciliation after a lost response works
   * because the delivered milestone is written into the comment's own managed marker
   * and read back from the issue, so the answer comes from provider state rather than
   * from a local guess.
   */
  async updateManagedProgress(
    context: AdapterContext,
    request: ManagedProgressUpdateRequest,
  ): Promise<Result<ManagedProgressOutcome>> {
    if (request.region.kind === 'ManagedBodyBlock') {
      return err({
        code: 'Unavailable',
        reason:
          'This managed region is a delimited description block. Linear offers no partial update of an issue description, so honouring it would rewrite human-authored content. ShipLoop uses a dedicated updatable comment instead, and this region shape is refused rather than approximated (F16-AC2).',
      });
    }
    const foreign = refuseForeignIdentity(request.issueId, context.redact);
    if (foreign !== null) return err(foreign);

    const read = await this.fetchIssue(context, request.issueId);
    if (!read.ok) return read;

    const target = this.resolveManagedTarget(read.value, request.region);
    if (target.kind === 'Unobserved') {
      return err({
        code: 'Unavailable',
        reason: `The managed comment ${target.commentId} was not observed on this issue in the newest ${MAX_COMMENTS_SCANNED} comments. ShipLoop will not create a second comment to work around a comment it failed to read; widen the comment read and retry.`,
      });
    }

    const digest = contentDigest(request.body);
    const existing = target.comment;
    if (existing !== null && existing.marker !== null) {
      const unchanged = this.alreadyDelivered(existing.marker, request, digest);
      if (unchanged !== null) {
        return ok({
          kind: 'Unchanged',
          region: { kind: 'UpdatableComment', commentId: existing.commentId as ProviderId },
          deliveredMilestoneKey: unchanged.milestoneKey,
          deliveredAt: unchanged.deliveredAt,
        });
      }
    }

    const deliveredAt = context.clock.now();
    const body = `${managedMarkerLine({
      issueId: request.issueId,
      operationId: request.operationId,
      milestoneKey: request.milestoneKey,
      digest,
      deliveredAt,
    })}\n${request.body}`;
    const previousMilestoneKey = existing?.marker?.milestoneKey ?? null;

    if (existing !== null) {
      const updated = await this.client.execute(context, {
        operationName: 'LinearCommentUpdate',
        mutating: true,
        target: `linear:comment:${existing.commentId}`,
        document: COMMENT_UPDATE_DOCUMENT,
        variables: { id: existing.commentId, input: { body } },
      });
      if (!updated.ok) return updated;
      return ok({
        kind: 'Updated',
        region: { kind: 'UpdatableComment', commentId: existing.commentId as ProviderId },
        previousMilestoneKey,
        deliveredAt,
      });
    }

    const commentId = managedCommentId(request.operationId);
    const created = await this.client.execute(context, {
      operationName: 'LinearCommentCreate',
      mutating: true,
      target: `linear:comment:${commentId}`,
      document: COMMENT_CREATE_DOCUMENT,
      variables: { input: { id: commentId, issueId: request.issueId, body } },
    });
    if (!created.ok) return created;
    if (fieldOf(fieldOf(created.value.data, 'commentCreate'), 'success') !== true) {
      return err({
        code: 'OutcomeUnknown',
        reason: `Linear reported the managed comment as not created for ${commentId}, so the managed region may or may not exist. Read the issue before any retry rather than creating a second comment.`,
        operationId: request.operationId,
        target: `linear:comment:${commentId}`,
      });
    }
    const returnedId = requiredStr(fieldOf(fieldOf(created.value.data, 'commentCreate'), 'comment'));
    return ok({
      kind: 'Updated',
      region: { kind: 'UpdatableComment', commentId: (returnedId ?? commentId) as ProviderId },
      previousMilestoneKey,
      deliveredAt,
    });
  }

  /**
   * The delivery the region already holds, or null when this milestone is genuinely new.
   *
   * Two keys suppress a rewrite. The **operation identity** matches when the same
   * delivery is replayed, whatever it now carries — that is F30-AC2's replay clause.
   * The **milestone key** matches when the provider already holds that milestone, which
   * is F16-AC3's duplicate clause. The **content digest** matches when the rendered body
   * is byte-identical, which is why `ManagedRegion` carries it: republishing unchanged
   * content must not append a second visible comment either.
   *
   * When the digest matched but the milestone key did not, the milestone reported is the
   * one the provider actually holds, not the one requested. Reporting the requested key
   * would tell the caller a milestone was delivered that was not.
   */
  private alreadyDelivered(
    marker: ManagedMarker,
    request: ManagedProgressUpdateRequest,
    digest: string,
  ): { readonly milestoneKey: string; readonly deliveredAt: string } | null {
    if (marker.operationId === request.operationId || marker.milestoneKey === request.milestoneKey) {
      return {
        milestoneKey: marker.milestoneKey ?? request.milestoneKey,
        deliveredAt: marker.deliveredAt ?? request.observedAt,
      };
    }
    if (marker.digest === digest) {
      return {
        milestoneKey: marker.milestoneKey ?? request.milestoneKey,
        deliveredAt: marker.deliveredAt ?? request.observedAt,
      };
    }
    return null;
  }

  /**
   * F29-AC3: the transitions a configured closure may request.
   *
   * `transitionId` is the Linear workflow-state id, so a caller can never pass
   * free-form state text. Linear models no transition graph — any state may be set to
   * any other — so `fromStates` is every other state of the same team and the adapter
   * says so rather than implying a constrained workflow it cannot read.
   */
  async describeTransitions(
    context: AdapterContext,
    request: DescribeTransitionsRequest,
  ): Promise<Result<readonly TicketTransitionDescriptor[]>> {
    const foreign = refuseForeignIdentity(request.issueId, context.redact);
    if (foreign !== null) return err(foreign);
    const teamKey = await this.resolveIssueTeamKey(context, request.issueId);
    if (!teamKey.ok) return teamKey;
    const states = await this.workflowStates(context, teamKey.value);
    if (!states.ok) return states;
    const names = states.value.map((state) => state.name);
    return ok(
      states.value.map((state) => ({
        transitionId: state.id,
        fromStates: names.filter((name) => name !== state.name),
        toState: state.name,
        terminal: STATE_TYPE_TERMINAL[state.type] ?? 'None',
      })),
    );
  }

  /**
   * F29-AC3: request a configured state change and report what the provider holds.
   *
   * Linear's `issueUpdate` has **no** expected-state precondition, so a concurrent
   * human edit can land between the read and the write. The race is not hidden: the
   * state is re-read immediately after the write, and a disagreement is returned as
   * `Conflict` naming both states rather than reported as applied (ARCHITECTURE,
   * "Use provider compare-and-set when offered; otherwise state the race limitation
   * and recheck immediately").
   */
  async requestTransition(
    context: AdapterContext,
    request: TicketTransitionRequest,
  ): Promise<Result<TicketTransitionOutcome>> {
    const foreign = refuseForeignIdentity(request.issueId, context.redact);
    if (foreign !== null) return err(foreign);

    const transitions = await this.describeTransitions(context, { issueId: request.issueId });
    if (!transitions.ok) return transitions;
    const target = transitions.value.find((entry) => entry.transitionId === request.transitionId);
    if (target === undefined) {
      return err(
        invalid(
          context.redact(
            `"${request.transitionId}" is not a workflow state this adapter offered for this issue. ShipLoop requests a configured transition by identity, never by free-form state text.`,
          ),
          [{ path: 'transitionId', message: 'Not one of the transitions returned by describeTransitions.' }],
        ),
      );
    }

    const before = await this.fetchIssue(context, request.issueId);
    if (!before.ok) return before;
    const fromState = mapTicketState(before.value.state, context.redact);
    if (fromState.kind === 'ProviderState' && fromState.name === target.toState) {
      return ok({ kind: 'AlreadyInState', state: fromState });
    }
    if (request.expectedState !== null && describeState(request.expectedState) !== describeState(fromState)) {
      return err(
        conflict(
          context.redact(
            `The issue moved before the requested transition could be applied: the caller expected "${describeState(request.expectedState)}" and Linear reports "${describeState(fromState)}".`,
          ),
          describeState(request.expectedState),
          describeState(fromState),
        ),
      );
    }

    const updated = await this.client.execute(context, {
      operationName: 'LinearIssueUpdate',
      mutating: true,
      target: `linear:issue:${request.issueId}`,
      document: ISSUE_UPDATE_DOCUMENT,
      variables: { id: request.issueId, input: { stateId: request.transitionId } },
    });
    if (!updated.ok) return updated;
    if (fieldOf(fieldOf(updated.value.data, 'issueUpdate'), 'success') !== true) {
      return err({
        code: 'OutcomeUnknown',
        reason: `Linear reported the state change on ${request.issueId} as not applied. The issue may or may not have moved; read it before retrying, because repeating the write cannot resolve the ambiguity.`,
        operationId: request.operationId,
        target: `linear:issue:${request.issueId}`,
      });
    }

    const appliedAt = context.clock.now();
    const after = await this.fetchIssue(context, request.issueId);
    if (!after.ok) {
      return err({
        code: 'Unavailable',
        reason:
          'Linear accepted the state change but the confirming read failed, so the landing state is unproven. The issue was written once; read it again rather than repeating the write.',
      });
    }
    const observed = mapTicketState(after.value.state, context.redact);
    if (describeState(observed) !== target.toState) {
      return err(
        conflict(
          context.redact(
            `Linear accepted the state change but the issue now reports "${describeState(observed)}" rather than the requested "${target.toState}". Linear offers no expected-state precondition, so a concurrent edit is the likely cause.`,
          ),
          target.toState,
          describeState(observed),
        ),
      );
    }
    return ok({ kind: 'Applied', from: fromState, to: observed, appliedAt });
  }

  /* ------------------------------------------------------------------ */

  private snapshotOf(
    issue: LinearIssueShape,
    workItemId: string,
    dependencies: readonly string[],
    retrievedAt: string,
  ): ScopeSnapshot {
    const description = issue.description ?? '';
    return {
      workItemId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      title: issue.title,
      description,
      providerRevision: issue.updatedAt.length > 0 ? issue.updatedAt : null,
      priority: mapPriority(issue.priority),
      dependencyIssueIds: dependencies,
      acceptanceCriteria: extractAcceptanceCriteria(description, this.criteria),
      retrievedAt,
    };
  }

  /**
   * The managed comment this update addresses.
   *
   * An `UpdatableComment` the read did not observe is an honest failure rather than a
   * reason to create a second comment: creating here would be exactly the duplicate
   * F16-AC3 forbids. An unreadable page is therefore reported as unavailable.
   *
   * `AppendOnlyCommentThread` carries the same guard, and it is the reason the field
   * exists. A `lastCommentId` of null is the shape `readScope` reports for an issue
   * with no managed comment yet, so creating one is correct. A **non-null**
   * `lastCommentId` means a previous read saw a populated thread: either a managed
   * comment is in the page and is updated in place, or the page this read returned did
   * not contain it — in which case creating is how a second managed comment appears.
   */
  private resolveManagedTarget(
    issue: LinearIssueShape,
    region: ManagedRegionTarget,
  ): ManagedTargetLookup {
    if (region.kind === 'UpdatableComment') {
      const observed = issue.comments.find((entry) => entry.id === region.commentId);
      if (observed === undefined) {
        return { kind: 'Unobserved', commentId: region.commentId };
      }
      return {
        kind: 'Found',
        comment: { commentId: observed.id, marker: parseManagedMarker(observed.body) },
      };
    }
    const [first] = managedCommentsOf(issue.comments);
    if (first !== undefined) return { kind: 'Found', comment: first };
    if (region.kind === 'AppendOnlyCommentThread' && region.lastCommentId !== null) {
      return { kind: 'Unobserved', commentId: region.lastCommentId };
    }
    return { kind: 'Found', comment: null };
  }

  private async fetchIssue(context: AdapterContext, issueId: string): Promise<Result<LinearIssueShape>> {
    const response = await this.client.execute(context, {
      operationName: 'LinearIssueScope',
      document: ISSUE_SCOPE_DOCUMENT,
      variables: { id: issueId, commentCount: MAX_COMMENTS_SCANNED },
    });
    if (!response.ok) return response;
    const issue = readIssue(fieldOf(response.value.data, 'issue'), 0);
    if (issue === null) {
      return err({
        code: 'Unavailable',
        reason:
          'Linear answered the issue query with a shape this adapter cannot read, so no scope was derived. Reporting nothing is preferred to reporting partial scope (F12).',
      });
    }
    return ok(issue);
  }

  private async resolveTeam(context: AdapterContext, teamKey: string): Promise<Result<string>> {
    const response = await this.client.execute(context, {
      operationName: 'LinearTeams',
      document: TEAMS_DOCUMENT,
      variables: { first: 50 },
    });
    if (!response.ok) return response;
    for (const node of nodesOf(response.value.data, 'teams')) {
      if (requiredStr(fieldOf(node, 'key')) !== teamKey) continue;
      const id = requiredStr(fieldOf(node, 'id'));
      if (id !== null) return ok(id);
    }
    return err({
      code: 'NotFound',
      reason: context.redact(
        `Linear has no accessible team with key "${teamKey}". Publication cannot name a team the connector cannot read, and a similarly named team is not a substitute (F11-AC3).`,
      ),
    });
  }

  private async resolveIssueTeamKey(context: AdapterContext, issueId: string): Promise<Result<string>> {
    const response = await this.client.execute(context, {
      operationName: 'LinearIssueTeam',
      document: ISSUE_TEAM_DOCUMENT,
      variables: { id: issueId },
    });
    if (!response.ok) return response;
    const teamKey = requiredStr(fieldOf(fieldOf(fieldOf(response.value.data, 'issue'), 'team'), 'key'));
    if (teamKey === null) {
      return err({
        code: 'Unavailable',
        reason: 'Linear reported no team for this issue, so its configured workflow states cannot be read.',
      });
    }
    return ok(teamKey);
  }

  private async workflowStates(context: AdapterContext, teamKey: string): Promise<Result<readonly LinearStateShape[]>> {
    const response = await this.client.execute(context, {
      operationName: 'LinearWorkflowStates',
      document: WORKFLOW_STATES_DOCUMENT,
      variables: { teamKey, first: this.workflowStatePageSize },
    });
    if (!response.ok) return response;
    const states: LinearStateShape[] = [];
    for (const node of nodesOf(response.value.data, 'workflowStates')) {
      const state = readState(node);
      if (state !== null) states.push(state);
    }
    return ok(states);
  }

  /** F11-AC3: adoption verifies the live issue rather than trusting the offered identity. */
  private async adoptExisting(context: AdapterContext, request: PublishWorkRequest): Promise<Result<PublishWorkOutcome>> {
    const adoptedId = request.adoptExistingIssueId;
    if (adoptedId === null) {
      return err({ code: 'Invalid', reason: 'No issue was offered for adoption.', fields: [] });
    }
    const foreign = refuseForeignIdentity(adoptedId, context.redact);
    if (foreign !== null) return err(foreign);
    const read = await this.fetchIssue(context, adoptedId);
    if (!read.ok) return read;
    const relations = mapRelations(read.value);
    const retrievedAt = context.clock.now();
    return ok({
      kind: 'AdoptedExisting',
      published: [
        {
          issue: issueRef(read.value),
          disposition: 'AlreadyPresent',
          snapshot: this.snapshotOf(read.value, request.revision.workItemId, dependencyIds(relations), retrievedAt),
        },
      ],
    });
  }

  /**
   * Finishes a publication: links whatever is still unlinked, then re-reads the issue.
   *
   * The re-read is what keeps `PublishedIssue.snapshot` a provider fact. Reporting the
   * proposal's own dependency list back would claim links Linear may have refused; the
   * re-read reports only the relations that exist, and `failed` names the rest, so
   * `compareScope` against this snapshot and a later `readScope` agree (F10-AC2, F10-AC4).
   */
  private async completePublication(
    context: AdapterContext,
    request: PublishWorkRequest,
    issue: LinearIssueShape,
    disposition: PublishedIssue['disposition'],
  ): Promise<Result<PublishWorkOutcome>> {
    const failed = await this.linkDependencies(context, request, issue.id, mapRelations(issue));
    const confirmed = disposition === 'CreatedNew' ? await this.fetchIssue(context, issue.id) : ok(issue);
    const finalIssue = confirmed.ok ? confirmed.value : issue;
    const published = [
      this.publishedFrom(finalIssue, request, disposition, context.clock.now()),
    ];
    if (failed.length > 0) {
      return ok({ kind: 'PartiallyPublished', published, failed, recoverable: true });
    }
    return ok({ kind: 'Published', published });
  }

  private publishedFrom(
    issue: LinearIssueShape,
    request: PublishWorkRequest,
    disposition: PublishedIssue['disposition'],
    retrievedAt: string,
  ): PublishedIssue {
    return {
      issue: issueRef(issue),
      disposition,
      snapshot: this.snapshotOf(issue, request.revision.workItemId, dependencyIds(mapRelations(issue)), retrievedAt),
    };
  }

  /**
   * Creates the declared block relations, recording each failure individually.
   *
   * A dependency that cannot be resolved is reported rather than dropped: F10-AC2
   * requires a partial failure to identify what remains unpublished, and F10-AC5
   * requires a retry that keeps the mappings that already succeeded. `linked` carries
   * the relations the provider already holds, so a repeated publication of the same
   * operation adds nothing; each relation also carries a client-supplied identity
   * derived from the operation, so a lost response is recoverable by reading it.
   */
  private async linkDependencies(
    context: AdapterContext,
    request: PublishWorkRequest,
    publishedIssueId: string,
    linked: readonly TicketRelation[],
  ): Promise<readonly FailedTicketPublish[]> {
    const alreadyLinked = new Set(
      linked.filter((relation) => relation.kind === 'BlockedBy').map((relation) => relation.issue.issueId as string),
    );
    const failed: FailedTicketPublish[] = [];
    for (const dependencyId of request.revision.dependencyIssueIds) {
      if (alreadyLinked.has(dependencyId)) continue;
      const target = `linear:issueRelation:${publishedIssueId}->${dependencyId}`;
      const resolved = await this.fetchIssue(context, dependencyId);
      if (!resolved.ok) {
        failed.push({ target, operationId: request.operationId, error: resolved.error });
        continue;
      }
      const relation = await this.client.execute(context, {
        operationName: 'LinearRelationCreate',
        mutating: true,
        target,
        document: RELATION_CREATE_DOCUMENT,
        variables: {
          input: {
            id: publicationRelationId(request.operationId, dependencyId),
            type: 'blocks',
            issueId: dependencyId,
            relatedIssueId: publishedIssueId,
          },
        },
      });
      if (!relation.ok) {
        failed.push({ target, operationId: request.operationId, error: relation.error });
        continue;
      }
      alreadyLinked.add(dependencyId);
    }
    return failed;
  }
}

/* -------------------------------------------------------------------------- */
/* Text helpers                                                                */
/* -------------------------------------------------------------------------- */

function describeState(state: TicketState): string {
  return state.kind === 'ProviderState' ? state.name : 'Unknown';
}

/**
 * The scope issue's declared relations, as candidates for adoption.
 *
 * `BlockedBy` and `Blocks` both become `DependentWork`: either direction is Linear
 * stating that one issue depends on the other, and the owner decides what that means for
 * the work item. A `Duplicate` row becomes `PotentialDuplicate`, which is the one
 * resemblance relation a provider can assert outright. All of them match on
 * `ExplicitLink`, because the link is what the provider reported — no text overlap was
 * measured and none is claimed.
 */
function relatedFromRelations(
  issue: LinearIssueShape,
  scopeIssueId: string,
  redact: (text: string) => string,
): readonly RelatedIssue[] {
  const collected: RelatedIssue[] = [];
  const seen = new Set<string>();
  const sides: readonly (readonly [readonly LinearRelationShape[], Readonly<Record<string, TicketRelationKind | null>>])[] = [
    [issue.relations, RELATION_KIND_OUTGOING],
    [issue.inverseRelations, RELATION_KIND_INCOMING],
  ];
  for (const [rows, kinds] of sides) {
    for (const row of rows) {
      const kind = kinds[row.type];
      if (kind === undefined || kind === null) continue;
      const counterparty = counterpartyOf(scopeIssueId, row);
      if (counterparty === null || counterparty.id === scopeIssueId || seen.has(counterparty.id)) continue;
      seen.add(counterparty.id);
      collected.push({
        issue: issueRef(counterparty),
        relation:
          kind === 'Duplicate'
            ? 'PotentialDuplicate'
            : kind === 'Blocks' || kind === 'BlockedBy'
              ? 'DependentWork'
              : 'ExplicitLink',
        state: mapTicketState(counterparty.state, redact),
        matchedOn: ['ExplicitLink'],
        similarity: 0,
        adoption: {
          kind: 'RequiresOwnerDecision',
          reason: `Linear reports this issue as ${kind} on the scope issue, so only the owner decides whether ShipLoop adopts it as related work (F06-AC4).`,
        },
      });
    }
  }
  return collected;
}

/**
 * Which overlap signals a search result actually exhibits.
 *
 * An empty list means the result shares nothing measurable with the scope, and the
 * caller drops it rather than reporting a signal it did not observe.
 *
 * `SharedComponent` and `RecentActivity` are never produced: Linear has no component
 * concept, and recency is not something this adapter claims to have measured.
 * Reporting either would be asserting a provider fact this adapter cannot read.
 */
function matchSignals(
  scope: ScopeSnapshot,
  issue: LinearIssueShape,
  scopeLabels: readonly string[],
): readonly RelatedIssueSignal[] {
  const signals: RelatedIssueSignal[] = [];
  if (lexicalOverlap(scope.title, issue.title) >= 0.5) signals.push('TitleOverlap');
  if (
    scope.description.length > 0 &&
    issue.description !== null &&
    lexicalOverlap(scope.description, issue.description) >= 0.4
  ) {
    signals.push('DescriptionOverlap');
  }
  if (scopeLabels.some((label) => issue.labelNames.includes(label))) signals.push('SharedLabel');
  return signals;
}

function searchTermFor(scope: ScopeSnapshot): string {
  const words = scope.title.split(/\s+/).filter((word) => word.replace(/[^A-Za-z0-9]/g, '').length > 2);
  const chosen = words.slice(0, 8).join(' ');
  return chosen.length > 2 ? chosen : scope.title.trim();
}

/**
 * Shared vocabulary as a fraction of the shorter text, in [0, 1].
 *
 * This is ShipLoop's own measure, not a Linear-reported score: Linear's `searchIssues`
 * returns no similarity field, and `searchIssues` is the only related-work discovery
 * the API offers. It is presentation only and is never a decision input (F06-AC4).
 *
 * Containment rather than Jaccard, because Jaccard punishes the length asymmetry that
 * makes an issue a duplicate of another. Calibrated live on 1 October 2026 over the
 * 7,140 title pairs of 120 readable issues: at a 0.5 gate Jaccard admitted 4 pairs,
 * all near-identical, and rejected every pair of differing length even where the
 * shorter title was wholly contained in the longer one — the exact case a duplicate
 * search exists to find. Containment admits 71 and ranks real near-duplicates at the
 * top (three "[W6][SPEC-006] Implement MCP … tool" issues at 0.833, against 0 for any
 * pair sharing no content word). The gate value is unchanged; only the measure is.
 */
export function lexicalOverlap(left: string, right: string): number {
  const tokens = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2),
    );
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return Math.round((shared / Math.min(a.size, b.size)) * 1000) / 1000;
}

/**
 * The description ShipLoop writes at publication.
 *
 * Criteria are written inside an explicit marker region, each carrying its id inside an
 * HTML comment. The comment form is what makes the round trip exact: an `AC<n>` id is
 * recoverable from prose, but an arbitrary stable id — a slug, a scope key — is not, and
 * re-deriving it from the text would rename a criterion and report the publication
 * itself as a material scope change (F12-AC2). Ids are percent-encoded so an id
 * containing `-->` cannot break out of the comment.
 */
export function publicationBody(revision: {
  readonly description: string;
  readonly criteria: readonly ScopeCriterion[];
  readonly operationId: string;
}): string {
  const lines: string[] = [revision.description.trim()];
  if (revision.criteria.length > 0) {
    lines.push('', CRITERIA_START);
    for (const criterion of revision.criteria) {
      lines.push(`- <!--shiploop:ac:${encodeURIComponent(criterion.id)}--> ${criterion.text.trim()}`);
    }
    lines.push(CRITERIA_END);
  }
  lines.push('', `<!--shiploop:publication:${revision.operationId}-->`);
  return lines.join('\n');
}
