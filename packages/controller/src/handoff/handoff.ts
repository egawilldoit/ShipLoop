/**
 * The implementation handoff as a use case: one Delivery Contract revision plus the facts
 * stored beside it, rendered into the packet an implementer outside ShipLoop is handed
 * (mvp-spec L02, L02-AC3; ARCHITECTURE "T3 Code initially receives a context packet/manual
 * handoff").
 *
 * `implementation-packet.ts` owns the text and `t3-launch.ts` owns the optional deployment
 * URL. Neither may read storage, so something has to load the rows, decide whether this
 * revision may be handed off at all, and join the two answers into one response. That is
 * this module and nothing more: it introduces no rule of its own, restates no validation,
 * and there is no second way to produce a packet.
 *
 * Five decisions are structural rather than documented:
 *
 *   - **The approval decision is not re-made here.** `readers.contracts.getContract` is
 *     the same gated, project-scoped read the `GET .../:revision` route makes, and it
 *     already carries the domain `contractGate`'s verdict as `blockedBecause`. This module
 *     reads that field and refuses; "was it approved?" asked twice is two chances to answer
 *     it differently, and a draft is not a permission slip (mvp-spec 3).
 *   - **The packet is rendered only after every row has been read.** A refusal therefore
 *     never renders half a document, and the generator's own refusal stays the second line
 *     of defence rather than the first.
 *   - **Nothing here contacts T3.** The configured URL is resolved with
 *     `parseT3LaunchUrl` and reported; no API is called, no session is created, and no
 *     execution state is read or implied, because external execution is outside ShipLoop
 *     and ShipLoop must never claim progress it cannot prove (mvp-spec L02).
 *   - **Three T3 states, because two would be a lie.** `Configured` carries a URL the
 *     operator wrote, `NotConfigured` is the normal state of a deployment that does not use
 *     T3 and leaves the packet fully usable, and `Unusable` is a configured value that is
 *     refused - which is neither "configured and openable" nor "not configured". None of the
 *     three ever reproduces the configured value, because a value bad enough to be refused
 *     may itself be the secret (N02-AC2).
 *   - **Absences are reported, not filled.** A project with no saved profile yields a null
 *     repository and branch and the packet states that neither is recorded, rather than this
 *     module inventing a host, a branch or a default (N02-AC2).
 */

import { blocked, err, ok } from '@shiploop/domain';
import type {
  BlockedPrerequisite,
  ContractId,
  DomainError,
  Fingerprint,
  ProjectId,
  RequestId,
  Result,
} from '@shiploop/domain';
import type { ProjectProfileRepository, ProjectRepository, RequestRepository } from '@shiploop/storage';
import type { ContractUseCases, ContractView } from '../contracts.ts';
import type { OwnerActor } from '../profiles.ts';
import { generateImplementationPacket } from './implementation-packet.ts';
import { parseT3LaunchUrl } from './t3-launch.ts';

/**
 * The rows this module reads, as the four ports it needs them by.
 *
 * Structural picks from the real handles rather than copies of their interfaces: the
 * composition root's own `contractUseCases`, `requests`, `projects` and `profiles` are
 * passed straight in, so there is one implementation of every read and a fake in a test is
 * the only other thing that can satisfy these four lines (F02-AC2).
 */
export interface HandoffReaders {
  /** The gated, project-scoped contract read. Its authorization is not repeated here. */
  readonly contracts: Pick<ContractUseCases, 'getContract'>;
  readonly requests: Pick<RequestRepository, 'read'>;
  readonly projects: Pick<ProjectRepository, 'get'>;
  readonly profiles: Pick<ProjectProfileRepository, 'currentVersion'>;
}

/** The one revision, in the one project, that is being handed off. */
export interface BuildHandoffCommand {
  readonly projectId: ProjectId;
  readonly contractId: ContractId;
  readonly revision: number;
  /**
   * The operator's configured external deployment URL, or null.
   *
   * Carried on the command rather than read from an environment here, so this module holds
   * no ambient state: the value arrives from the composition boundary and a test hands it
   * one directly (N02-AC2).
   */
  readonly t3Url: string | null;
}

/**
 * Where the browser may open the external executor, if anywhere.
 *
 * A union rather than a nullable URL because "nothing is configured" and "configured with
 * something refused" are different operator problems with different remedies, and a client
 * that cannot tell them apart can only guess. `Unusable` never carries the configured value
 * (N02-AC2).
 */
export type HandoffT3State =
  | {
      readonly state: 'Configured';
      /** Exactly what the operator configured, validated. Nothing is appended to it. */
      readonly url: string;
    }
  | {
      readonly state: 'NotConfigured';
      readonly reason: string;
      readonly prerequisites: readonly BlockedPrerequisite[];
    }
  | {
      readonly state: 'Unusable';
      readonly reason: string;
      readonly prerequisites: readonly BlockedPrerequisite[];
    };

/**
 * The packet, exactly as the generator rendered it.
 *
 * `markdown` is carried byte for byte and is never reflowed, trimmed or re-escaped here: the
 * document's value is that one approved contract produces the same bytes everywhere, and a
 * transport that tidied it up would make two packets differ for a reason that has nothing to
 * do with the contract. `fingerprint` is the digest of those bytes, so a client can compare
 * without diffing them.
 */
export interface HandoffPacket {
  readonly markdown: string;
  readonly fingerprint: Fingerprint;
}

/** Everything one handoff read answers. */
export interface ImplementationHandoff {
  readonly contractId: string;
  readonly revision: number;
  readonly packet: HandoffPacket;
  readonly t3: HandoffT3State;
}

/**
 * Procedure references the packet may cite.
 *
 * Empty in this version, and reported as an absence rather than omitted, because the store
 * keeps procedures per subject - a task, a work item - with no project-wide enumeration: a
 * reference this module invented would send an implementer to a document that does not exist
 * (L02-AC3).
 */
const NO_PROCEDURE_REFERENCES: readonly string[] = [];

/**
 * Reads one revision and the facts stored beside it, and renders the handoff packet.
 *
 * The caller either receives a complete packet it can compare byte for byte, or a typed
 * refusal naming what to do next. Nothing in between is representable.
 */
export function buildImplementationHandoff(
  readers: HandoffReaders,
  command: BuildHandoffCommand,
  actor: OwnerActor,
): Result<ImplementationHandoff, DomainError> {
  // The first read decides authorization and project scope. A caller that may not act learns
  // nothing about whether the revision exists, and an identity from another project is not
  // found here at all (F01-AC1, F02-AC2).
  const contract = readers.contracts.getContract(
    { projectId: command.projectId, contractId: command.contractId, revision: command.revision },
    actor,
  );
  if (!contract.ok) return err(contract.error);

  // The gate is the domain's and was applied by the contract use case; this reads its
  // verdict. The second condition is not a second rule: it is what narrows a stored status
  // to the literal an approved contract carries, together with the approval instant that
  // only an approved revision has. A packet cannot name the approval it came from without
  // one.
  if (contract.value.blockedBecause !== null || contract.value.status !== 'approved' || contract.value.approvedAt === null) {
    return err(needsApproval(contract.value));
  }

  const project = readers.projects.get(command.projectId);
  if (!project.ok) return err(project.error);
  if (project.value === null) return err({ code: 'NotFound', reason: 'No such project.' });

  // The request row is addressed by the project as well as its identity, so a contract that
  // names a request in another project cannot borrow this project's text (F02-AC2).
  const request = readers.requests.read(command.projectId, contract.value.requestId as RequestId);
  if (!request.ok) return err(request.error);

  const profile = readers.profiles.currentVersion(command.projectId);
  if (!profile.ok) return err(profile.error);

  const packet = generateImplementationPacket({
    project: {
      id: String(project.value.projectId),
      name: project.value.name,
      repository: profile.value === null ? null : storedReference(profile.value.content.references.repository),
      // The branch a pull request should target, which is what the packet has to tell an
      // implementer: `targetBranch`, not the branch a run happens to compare against.
      defaultBranch: profile.value === null ? null : storedReference(profile.value.content.references.targetBranch),
    },
    request: {
      id: String(request.value.requestId),
      title: request.value.title,
      description: request.value.description,
    },
    contract: {
      id: contract.value.contractId,
      revision: contract.value.revision,
      status: 'approved',
      approvedAt: contract.value.approvedAt,
      outcome: contract.value.outcome,
      /**
       * The stored scope is a list of statements and the packet states one block of scope.
       *
       * Joined with a line break so the order the owner wrote is the order the implementer
       * reads, and each statement keeps its own line rather than being folded into a
       * sentence the owner never wrote. The generator normalises line endings and strips
       * trailing whitespace afterwards, so the join is the only shaping here and the bytes
       * stay the generator's own (mvp-spec 3).
       */
      scope: contract.value.scope.join('\n'),
      outOfScope: contract.value.outOfScope,
      acceptanceCriteria: contract.value.acceptanceCriteria,
    },
    procedureReferences: NO_PROCEDURE_REFERENCES,
  });
  if (!packet.ok) return err(packet.error);

  return ok({
    contractId: packet.value.contractId,
    revision: packet.value.contractRevision,
    packet: { markdown: packet.value.markdown, fingerprint: packet.value.fingerprint },
    t3: handoffT3State(command.t3Url),
  });
}

/**
 * The refusal for a revision that may not be handed off.
 *
 * `Blocked` rather than `Forbidden` because the caller is allowed to ask this question and
 * the answer is that a prerequisite is missing: the owner approving the revision. The remedy
 * is an action in ShipLoop, which is what a blocked prerequisite is for (F04-AC3).
 */
function needsApproval(contract: ContractView): DomainError {
  return blocked(
    contract.blockedBecause ?? `Contract revision ${contract.revision} is ${contract.status}.`,
    [
      {
        name: 'contractApproval',
        detail: 'Only an approved Delivery Contract revision can be handed off.',
        remedy: `Have the owner approve revision ${contract.revision} in ShipLoop, then read the handoff again.`,
      },
    ],
  );
}

/**
 * What the browser may be sent to, resolved from the operator's configuration.
 *
 * The value arrives as a string so this module keeps no environment handle, and
 * `parseT3LaunchUrl` stays the single implementation of what a usable T3 URL is (N02-AC2).
 */
function handoffT3State(configured: string | null): HandoffT3State {
  const launch = parseT3LaunchUrl(configured);
  if (launch.ok) return { state: 'Configured', url: launch.value.url };
  // `parseT3LaunchUrl` only ever refuses with `Blocked`, and that is what carries the
  // remedy. Narrowed rather than asserted, so a future non-`Blocked` refusal would be a
  // compile error here instead of a response that silently dropped the reason.
  if (launch.error.code !== 'Blocked') {
    return { state: 'Unusable', reason: launch.error.reason, prerequisites: [] };
  }
  const absent = configured === null || configured.trim() === '';
  return absent
    ? { state: 'NotConfigured', reason: launch.error.reason, prerequisites: launch.error.prerequisites }
    : { state: 'Unusable', reason: launch.error.reason, prerequisites: launch.error.prerequisites };
}

/**
 * A stored profile reference, or null when there is none.
 *
 * Blank counts as absent because an empty profile field is not a repository, and printing
 * it would put an empty bullet where the packet's own "not recorded" line belongs (N02-AC2).
 */
function storedReference(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
