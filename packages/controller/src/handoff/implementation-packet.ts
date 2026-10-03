/**
 * The implementation handoff packet: the whole text an external coding environment is
 * given, generated from an approved Delivery Contract (mvp-spec L02, L02-AC3;
 * ARCHITECTURE "T3 Code initially receives a context packet/manual handoff").
 *
 * External execution is outside ShipLoop. The owner may implement in T3 Code, in an
 * editor, or nowhere at all; what ShipLoop owes them is a complete, reviewable
 * description of the work and the rules that work must obey. This module produces
 * that text and nothing else. It opens no session, contacts no provider, reads no
 * environment, and knows nothing about any coding runtime.
 *
 * Five properties are structural here rather than promised in prose:
 *
 *   - **One input, one output, byte-identical.** `generateImplementationPacket` reads
 *     nothing but its argument: no clock, no randomness, no ambient configuration and
 *     no property-order dependence. The same approved contract always renders the same
 *     bytes, so a packet pasted into two environments is the same document and can be
 *     compared rather than trusted.
 *   - **Only an approved contract can produce a packet.** The parameter type admits
 *     `status: 'approved'` and nothing else, and the runtime check refuses a wider
 *     value that reached this layer through JSON. A draft is not a permission slip.
 *   - **Every rendered value passes through one function.** `renderedText` is the only
 *     place a stored string becomes packet text, and it applies the domain's `redact`
 *     (N02-AC2) before anything is written. A token pasted into a criterion description
 *     cannot travel into a clipboard, a screenshot or a T3 thread.
 *   - **The prohibitions are data, not prose to be retyped.** `PACKET_INSTRUCTIONS`
 *     holds the branch/PR/merge/deploy/acceptance rules as values the renderer emits
 *     verbatim, so they cannot be edited away by contract content and can be asserted
 *     directly.
 *   - **Nothing claimed about the future.** The document says the work is not done and
 *     has not been verified; it never says a session exists, that an agent ran, or that
 *     the work was completed. "agent completed" is not "verified", "verified" is not
 *     "accepted", and "accepted" is not "merged" or "deployed".
 *
 * The clipboard belongs to the UI: this returns text, and a caller decides where it
 * goes.
 */

import { err, fingerprint, invalid, ok, redact } from '@shiploop/domain';
import type { DomainError, Fingerprint, InvalidError, Result } from '@shiploop/domain';

/* -------------------------------------------------------------------------- */
/* The contract this layer accepts                                              */
/* -------------------------------------------------------------------------- */

/**
 * How a criterion is verified.
 *
 * These are the two methods the MVP understands. The packet states which one applies
 * to each criterion because the implementer can see what ShipLoop will and will not
 * treat as proof, and a method they cannot satisfy is a scope problem worth knowing
 * about before they write code.
 */
export const CONTRACT_VERIFICATION_TYPES = ['automated', 'owner_test'] as const;

export type ContractVerificationType = (typeof CONTRACT_VERIFICATION_TYPES)[number];

export function isContractVerificationType(value: unknown): value is ContractVerificationType {
  return (
    typeof value === 'string' &&
    (CONTRACT_VERIFICATION_TYPES as readonly string[]).includes(value)
  );
}

/**
 * One acceptance criterion, in the shape the shared contract fixes:
 * `id`, `description`, `verificationType`.
 */
export interface DeliveryContractCriterion {
  readonly id: string;
  readonly description: string;
  readonly verificationType: ContractVerificationType;
}

/**
 * An approved Delivery Contract.
 *
 * `status` is the literal `'approved'` rather than the wider status union, so a draft
 * or a stale contract has no argument that type-checks its way into a handoff. The
 * runtime check in `generateImplementationPacket` exists for values that arrived as
 * JSON, where the type was never applied.
 *
 * `revision` is the version the owner approved. It is rendered because a packet
 * without it cannot be matched back to the approval it came from, and a materially
 * changed contract is a new revision rather than an edit of this one.
 */
export interface ApprovedDeliveryContract {
  readonly id: string;
  readonly revision: number;
  readonly status: 'approved';
  readonly approvedAt: string;
  readonly outcome: string;
  readonly scope: string;
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly DeliveryContractCriterion[];
}

/** The project the work belongs to, and the repository facts already known about it. */
export interface HandoffProject {
  readonly id: string;
  readonly name: string;
  /** `owner/name` as the host knows it, or null when no repository is recorded. */
  readonly repository: string | null;
  /** The branch a pull request should target, or null when it is not recorded. */
  readonly defaultBranch: string | null;
}

/** The Request the contract was raised against. */
export interface HandoffRequest {
  readonly id: string;
  readonly title: string;
  /** May be empty: an absent description is stated as absent rather than invented. */
  readonly description: string;
}

/**
 * Everything the packet may contain, in one argument.
 *
 * One argument because the packet has exactly one source of truth. The alternative —
 * reading the project and request from the store inside this module — would make the
 * output depend on state this function cannot show, and "deterministic" would become a
 * claim about timing instead of a property of the code.
 */
export interface ApprovedContractHandoff {
  readonly project: HandoffProject;
  readonly request: HandoffRequest;
  readonly contract: ApprovedDeliveryContract;
  /**
   * Project procedure references already stored, such as a runbook path.
   *
   * Empty when nothing is stored, which is reported as an absence: an empty section
   * reads as an oversight, and inventing a reference would send an implementer to a
   * document that does not exist.
   */
  readonly procedureReferences: readonly string[];
}

/** The rendered packet and the identity of the contract it came from. */
export interface ImplementationPacket {
  readonly contractId: string;
  readonly contractRevision: number;
  /** The complete document. LF line endings, no trailing whitespace, one final newline. */
  readonly markdown: string;
  /** A stable digest of `markdown`, so two packets can be compared without a diff. */
  readonly fingerprint: Fingerprint;
}

/* -------------------------------------------------------------------------- */
/* The rules the packet states, as data                                        */
/* -------------------------------------------------------------------------- */

/**
 * What every implementer must be told, independent of the contract's own wording.
 *
 * These are values rather than a paragraph because they are the load-bearing part of
 * the handoff: they are what keeps an external agent inside the lifecycle. Rendered
 * verbatim, asserted directly by tests, and not reachable from contract content.
 */
export const PACKET_INSTRUCTIONS = {
  implementOnABranch:
    'Implement on a Git branch or in a dedicated Git worktree. Never commit directly to the target branch.',
  openAPullRequest:
    'Open a GitHub pull request from your branch, or provide the pull request that already exists, and record it in ShipLoop with the full 40-character head commit SHA.',
  doNotMerge: "Do not merge the pull request. Merging is the owner's decision in ShipLoop, after review and acceptance.",
  doNotDeploy:
    'Do not deploy. ShipLoop v0.1 ends at owner acceptance and authorises no deployment.',
  shipLoopVerifies:
    'ShipLoop verifies the exact candidate you link, independently. Your own report that the work is finished is not verification.',
  completionIsNotAcceptance:
    'Finishing this work does not mean ShipLoop accepted it. Only the owner accepts a candidate, in ShipLoop, against the exact commit SHA that is linked.',
  noAuthorityToClose:
    'This handoff grants no authority to merge, deploy, close the request, or record any acceptance, verification or delivery result in ShipLoop.',
} as const;

/** What each verification type means to the person implementing the work. */
export const VERIFICATION_METHOD_NOTES: Readonly<Record<ContractVerificationType, string>> = Object.freeze({
  automated:
    "ShipLoop verifies this criterion from the checks recorded against the exact candidate, not from the implementer's summary.",
  owner_test:
    'The owner verifies this criterion manually in ShipLoop and records the result themselves; no automated check can satisfy it.',
});

/** What the packet says when the project has recorded no repository or branch. */
export const NOT_RECORDED = 'Not recorded in ShipLoop.';

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Renders the handoff packet for an approved Delivery Contract.
 *
 * The only way to obtain packet text. There is no second entry point and no default,
 * so a packet cannot be produced from a draft, from a guess, or from a partially
 * populated contract without every gap being named.
 */
export function generateImplementationPacket(
  handoff: ApprovedContractHandoff,
): Result<ImplementationPacket, DomainError> {
  const problem = validateHandoff(handoff);
  if (problem !== null) return err(problem);
  const markdown = render(handoff);
  return ok({
    contractId: handoff.contract.id,
    contractRevision: handoff.contract.revision,
    markdown,
    fingerprint: fingerprint(markdown),
  });
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Identifiers are restricted to characters that are safe to quote in the document.
 *
 * A criterion id is rendered inside a code span; an id containing a backtick or a
 * newline would either break the quoting or let stored text introduce structure. The
 * refinement is refused with the field named instead of escaped, so a caller learns
 * that its identifier scheme does not fit rather than wondering why a criterion is
 * rendered oddly.
 */
const SAFE_IDENTITY = /^[A-Za-z0-9._:@-]{1,128}$/;

/**
 * Checks the handoff before anything is rendered.
 *
 * The checks that need a runtime are the ones a type cannot enforce across a storage
 * or HTTP boundary: whether the status really is `approved`, whether the revision is a
 * whole number, whether a verification type is one this layer understands, and whether
 * any required value is blank. The shape of the argument is trusted; the values in it
 * are not.
 *
 * Returns the problem to report, or null when the handoff is renderable. Every failure
 * is collected into one response so a caller fixes its contract in one pass rather than
 * one field per rebuild.
 */
function validateHandoff(handoff: ApprovedContractHandoff): InvalidError | null {
  const fields: { readonly path: string; readonly message: string }[] = [];
  const { project, request, contract } = handoff;

  requireIdentity(project.id, 'project.id', fields);
  requireText(project.name, 'project.name', fields);
  requireOptionalText(project.repository, 'project.repository', fields);
  requireOptionalText(project.defaultBranch, 'project.defaultBranch', fields);

  requireIdentity(request.id, 'request.id', fields);
  requireText(request.title, 'request.title', fields);

  requireIdentity(contract.id, 'contract.id', fields);
  if (!Number.isInteger(contract.revision) || contract.revision < 1) {
    fields.push({
      path: 'contract.revision',
      message: 'Expected a whole number of at least 1, so the packet names the approved version.',
    });
  }
  // A compile-time `'approved'` is not enough: this value may have arrived as JSON or
  // through a wider delivery-contract type, and a draft must not become a handoff.
  if (readContractStatus(contract) !== 'approved') {
    fields.push({
      path: 'contract.status',
      message:
        'Only an approved Delivery Contract can be handed off. Raise the revision and have the owner approve it first.',
    });
  }
  requireText(contract.outcome, 'contract.outcome', fields);
  requireText(contract.scope, 'contract.scope', fields);
  if (!isInstant(contract.approvedAt)) {
    fields.push({ path: 'contract.approvedAt', message: 'Expected the instant the owner approved this revision.' });
  }
  contract.outOfScope.forEach((item, index) => {
    requireText(item, `contract.outOfScope[${index}]`, fields);
  });
  validateCriteria(contract.acceptanceCriteria, fields);

  handoff.procedureReferences.forEach((reference, index) => {
    requireText(reference, `procedureReferences[${index}]`, fields);
  });

  if (fields.length === 0) return null;
  return invalid('This handoff is missing something the packet must state.', fields);
}

/**
 * Criteria are checked for uniqueness as well as for content.
 *
 * Two criteria sharing an id would make the verification methods section ambiguous
 * about which one a method applies to, and the packet is the artifact a reviewer
 * reads. Refusing is cheaper than a document that reads correctly only by accident.
 */
function validateCriteria(
  criteria: readonly DeliveryContractCriterion[],
  fields: { readonly path: string; readonly message: string }[],
): void {
  if (criteria.length === 0) {
    fields.push({
      path: 'contract.acceptanceCriteria',
      message: 'Expected at least one criterion; a handoff with none states no way to be judged correct.',
    });
    return;
  }
  const seen = new Set<string>();
  criteria.forEach((criterion, index) => {
    const path = `contract.acceptanceCriteria[${index}]`;
    requireIdentity(criterion.id, `${path}.id`, fields);
    requireText(criterion.description, `${path}.description`, fields);
    if (seen.has(criterion.id)) {
      fields.push({
        path: `${path}.id`,
        message: `Duplicate criterion id "${criterion.id}"; each criterion needs its own identity.`,
      });
    }
    seen.add(criterion.id);
    if (!isContractVerificationType(criterion.verificationType)) {
      fields.push({
        path: `${path}.verificationType`,
        message: `Expected one of: ${CONTRACT_VERIFICATION_TYPES.join(', ')}.`,
      });
    }
  });
}

function requireIdentity(value: string, path: string, fields: { path: string; message: string }[]): void {
  if (!SAFE_IDENTITY.test(value)) {
    fields.push({
      path,
      message: 'Expected an identifier of letters, digits, dot, underscore, colon, at-sign or dash.',
    });
  }
}

function requireText(value: string, path: string, fields: { path: string; message: string }[]): void {
  if (value.trim() === '') {
    fields.push({ path, message: 'Expected text; the packet states this and cannot omit it silently.' });
  }
}

/** An absent optional value is fine; a present blank one is a caller bug worth naming. */
function requireOptionalText(
  value: string | null,
  path: string,
  fields: { path: string; message: string }[],
): void {
  if (value === null) return;
  requireText(value, path, fields);
}

function isInstant(value: string): boolean {
  return value !== '' && Number.isFinite(Date.parse(value));
}

function readContractStatus(contract: ApprovedDeliveryContract): unknown {
  return (contract as { status: unknown }).status;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Renders the document.
 *
 * Reads only `handoff`, in a fixed section order, with no clock and no lookup. Each
 * value reaches the output through `renderedText`, so redaction is applied to
 * everything the packet can say.
 */
function render(handoff: ApprovedContractHandoff): string {
  const { project, request, contract } = handoff;
  const lines: string[] = [];

  lines.push(
    '# ShipLoop implementation handoff',
    '',
    'This text was generated from an approved Delivery Contract and from nothing else. ' +
      'ShipLoop started no session, ran no agent and observed no work while producing it, ' +
      'and it will not do any of those things when you use it.',
    '',
    '## Identity',
    '',
    bullet(`ShipLoop project: ${inline(project.name)} (\`${renderedText(project.id)}\`)`),
    bullet(`Request: ${inline(request.title)} (\`${renderedText(request.id)}\`)`),
    bullet(`Delivery Contract: \`${renderedText(contract.id)}\``),
    bullet(`Contract revision: ${String(contract.revision)}`),
    bullet(`Approved at: ${renderedText(contract.approvedAt)}`),
    '',
    '## Repository',
    '',
    bullet(`Repository: ${project.repository === null ? NOT_RECORDED : inline(project.repository)}`),
    bullet(
      `Target branch for the pull request: ${project.defaultBranch === null ? NOT_RECORDED : inline(project.defaultBranch)}`,
    ),
    '',
    'Project procedure references:',
    '',
  );

  if (handoff.procedureReferences.length === 0) {
    lines.push('No project procedure references are stored for this project.', '');
  } else {
    for (const reference of handoff.procedureReferences) lines.push(bullet(inline(reference)));
    lines.push('');
  }

  lines.push('## Request', '', inline(request.title), '');
  const description = renderedText(request.description);
  lines.push(
    description === '' ? 'No further description was recorded for this request.' : description,
    '',
    '## Outcome',
    '',
    renderedText(contract.outcome),
    '',
    '## Scope',
    '',
    renderedText(contract.scope),
    '',
    '## Explicitly out of scope',
    '',
  );

  if (contract.outOfScope.length === 0) {
    lines.push('The contract excludes nothing beyond what it states in scope.', '');
  } else {
    for (const item of contract.outOfScope) lines.push(bullet(renderedText(item)));
    lines.push('');
  }

  lines.push('## Acceptance criteria', '');
  for (const criterion of contract.acceptanceCriteria) {
    lines.push(
      bullet(
        `\`${renderedText(criterion.id)}\` — ${renderedText(criterion.description)} (verification: ${renderedText(criterion.verificationType)})`,
      ),
    );
  }
  lines.push('', '## Verification methods', '');
  for (const criterion of contract.acceptanceCriteria) {
    lines.push(
      bullet(
        `\`${renderedText(criterion.id)}\` (${renderedText(criterion.verificationType)}): ${VERIFICATION_METHOD_NOTES[criterion.verificationType]}`,
      ),
    );
  }
  lines.push('', '## How to carry out this handoff', '');

  for (const instruction of [
    PACKET_INSTRUCTIONS.implementOnABranch,
    PACKET_INSTRUCTIONS.openAPullRequest,
    PACKET_INSTRUCTIONS.doNotMerge,
    PACKET_INSTRUCTIONS.doNotDeploy,
    PACKET_INSTRUCTIONS.shipLoopVerifies,
    PACKET_INSTRUCTIONS.completionIsNotAcceptance,
    PACKET_INSTRUCTIONS.noAuthorityToClose,
  ]) {
    lines.push(bullet(instruction));
  }
  lines.push('');

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Text handling                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The one place a stored value becomes packet text.
 *
 * Redaction runs first so a multi-line secret such as a private key block is removed as
 * one unit, and normalisation second so the placeholder it leaves is not split across
 * lines or mangled by line-start escaping.
 *
 * This is the structural half of N02-AC2 for the packet. The other half is that the
 * renderer has no source of text other than `handoff`: no environment variable, no
 * configuration object and no ambient state reaches a line of output.
 */
function renderedText(value: string): string {
  return normalise(redact(value).text);
}

/**
 * Canonical form of one stored value.
 *
 * Line endings are unified, trailing whitespace is dropped and leading/trailing blank
 * lines are removed, so the same text always renders the same bytes regardless of how
 * it was typed into a form or read from a provider.
 */
function normalise(value: string): string {
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(escapeLineStart).join('\n');
}

/**
 * Neutralises markdown block structure at the start of a line.
 *
 * A stored description beginning with `#`, `>` or a fence would otherwise become a
 * heading or a code block in whatever renders this packet, which means the reader
 * would see structure the owner never wrote. One backslash keeps the text itself and
 * removes the meaning, and it applies to the owner's own bullets too, so a pasted list
 * stays words rather than becoming part of this document's structure.
 */
const MARKDOWN_BLOCK_START = /^(?:[#>`~*+|<-]|\d+[.)])/;

function escapeLineStart(line: string): string {
  return MARKDOWN_BLOCK_START.test(line) ? `\\${line}` : line;
}

/** A single-line value rendered inside a bullet or a sentence. */
function inline(value: string): string {
  return renderedText(value).replace(/\n/g, ' ').trim();
}

function bullet(content: string): string {
  return `- ${content}`;
}