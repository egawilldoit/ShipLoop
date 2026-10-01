/**
 * The controller as the HTTP layer sees it (F01-AC1, F02-AC1, F03-AC1).
 *
 * `apps/web` composes its controller from a module specifier and checks the loaded
 * value against the ports it declares, so something has to actually answer that
 * shape. Before this module existed, `@shiploop/controller` exported its own use
 * cases under their own names and the web server refused to start with a named
 * error. Neither side was wrong on its own and each was tested against its own
 * doubles, which is how a seam that had never been crossed stayed green.
 *
 * This is an adapter and nothing else. Every method below delegates to a use case
 * that already exists in `profiles.ts`, `sessions.ts` or `connectors.ts`; no rule,
 * no validation and no refusal is restated here. Three things happen at this
 * boundary because they belong to it and to no use case:
 *
 *   - renaming. The controller speaks of `tokenHash`, `lastSeenAt` and two-argument
 *     calls; the transport speaks of `tokenDigest`, `lastActivityAt` and one
 *     command object. Two vocabularies for one row are fine as long as exactly one
 *     translation exists, and this file is it.
 *   - promisification. Most use cases are synchronous because their storage is a
 *     single local writer; the port is asynchronous because the port is not
 *     storage, and one of them is asynchronous because it writes an attachment
 *     file. Wrapping rather than rewriting keeps the use cases testable without a
 *     promise in sight.
 *   - the owner actor. `saveProfile` and the connector use cases demand an actor
 *     and judge its role. Writes carry the owner the transport proved; reads carry
 *     no caller at all in the port, so the adapter resolves the single provisioned
 *     owner through `resolveOwnerActor`, which refuses when there is none. No actor
 *     is ever invented.
 *
 * One port field is worth naming rather than hiding. `at` on a write command is the
 * transport's instant, while the controller records writes with its injected clock;
 * in a single process those are the same clock read moments apart, and keeping one
 * time source in the use cases is worth more than millisecond agreement
 * (mvp-spec 7). Sessions are deliberately not left to that: a session's `issuedAt`
 * is the instant its stored deadline is computed from, so there the caller's value
 * is what gets written.
 *
 * The shapes below are declared here rather than imported from the web package,
 * because `apps/web` depends on `@shiploop/controller` and a controller that
 * imports its own consumer's types is a cycle. `web-surface.test.ts` therefore
 * assigns a real surface to the web package's `ControllerSurface`: the port stays
 * the authority, and this file is what has to satisfy it.
 */

import { DEFAULT_IDLE_TIMEOUT_SECONDS, capabilitiesFor, err, ok } from '@shiploop/domain';
import type {
  CapabilityDeclaration,
  CapabilityKind,
  ConnectorId,
  DomainError,
  IdeaId,
  OwnerId,
  ProfileVersionId,
  ProjectId,
  Result,
} from '@shiploop/domain';
import type { ConnectorKind, ConnectorRecord, ConnectorState, IdeaExport } from '@shiploop/storage';
import type { CompositionRoot } from './composition.ts';
import { createCompositionRoot } from './composition.ts';
import type { IdeaDraft } from '@shiploop/domain';
import type { ControllerClock, OwnerActor } from './profiles.ts';
import type { StoredSessionRecord } from './sessions.ts';
import type { AdapterRegistry, ConnectorProbe } from './connectors.ts';
import type {
  BriefSectionsInput,
  BriefView,
  BriefVersionView,
  CapturedIdeaView,
  ClarificationRoundView,
  ClarifyingQuestionView,
  CorrectionView,
  IntakeDetailView,
  RejectedCandidateView,
  RelatedWorkChoiceView,
  RelatedWorkView,
} from './intake.ts';

/** The connector kinds the transport names. Storage names the same four. */
export type SurfaceConnectorKind = ConnectorKind;

export type SurfaceConnectorState = ConnectorState;

export interface SurfaceStoredSession {
  readonly sessionId: string;
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastActivityAt: string | null;
}

export interface SurfaceOwner {
  readonly ownerId: OwnerId;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface SurfaceSessionGrant {
  readonly session: SurfaceStoredSession;
}

export interface SurfacePreviewComponent {
  readonly component: string;
  readonly environment: string;
}

export interface SurfaceProfileReferences {
  readonly repository: string;
  readonly ticketProvider: string;
  readonly ticketTeamKey: string | null;
  readonly baseBranch: string;
  readonly targetBranch: string;
  readonly deploymentProvider: string;
  readonly engine: string;
  readonly previewComponents: readonly SurfacePreviewComponent[];
}

export interface SurfaceProfilePolicy {
  readonly requiredChecks: readonly string[];
  readonly deliveryBehavior: 'ManualAuthorizationOnly';
  readonly maxFixPasses: number;
  readonly workspaceIsolation: 'WorktreeAndDataDirectory';
  readonly capabilityVersion: number;
}

export interface SurfaceProfileEnvironment {
  readonly runtime: string;
  readonly ports: readonly number[];
  readonly secretReferences: readonly string[];
}

export interface SurfaceProfileContent {
  readonly references: SurfaceProfileReferences;
  readonly policy: SurfaceProfilePolicy;
  readonly recipe: string;
  readonly environment: SurfaceProfileEnvironment;
}

export interface SurfaceProfileVersion {
  readonly profileVersionId: ProfileVersionId;
  readonly projectId: ProjectId;
  readonly versionNumber: number;
  readonly supersedesVersionId: ProfileVersionId | null;
  readonly content: SurfaceProfileContent;
  readonly contentFingerprint: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface SurfaceConnector {
  readonly connectorId: ConnectorId;
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly kind: SurfaceConnectorKind;
  readonly resourceScope: string;
  readonly credentialReference: string;
  readonly credentialReferenceDigest: string;
  readonly state: SurfaceConnectorState;
  readonly error: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly reads: readonly CapabilityKind[];
  readonly writes: readonly CapabilityKind[];
  readonly unsupported: readonly { readonly kind: CapabilityKind; readonly limitation: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SurfaceOwnerUseCases {
  provision(command: {
    readonly displayName: string;
    readonly password: string;
    readonly at: string;
  }): Promise<Result<SurfaceOwner, DomainError>>;
  signIn(command: {
    readonly identifier: string;
    readonly password: string;
    readonly tokenDigest: string;
    readonly issuedAt: string;
    readonly absoluteTtlSeconds: number;
    readonly idleTimeoutSeconds: number;
  }): Promise<Result<SurfaceSessionGrant, DomainError>>;
}

export interface SurfaceSessionUseCases {
  loadByToken(token: string): Promise<Result<SurfaceStoredSession, DomainError>>;
  create(command: {
    readonly ownerId: OwnerId;
    readonly displayName: string;
    readonly tokenDigest: string;
    readonly issuedAt: string;
    readonly absoluteTtlSeconds: number;
    readonly idleTimeoutSeconds: number;
  }): Promise<Result<SurfaceStoredSession, DomainError>>;
  revoke(command: {
    readonly sessionId: string;
    readonly revokedAt: string;
  }): Promise<Result<SurfaceStoredSession, DomainError>>;
  touch(command: { readonly sessionId: string; readonly lastActivityAt: string }): Promise<Result<null, DomainError>>;
}

export interface SurfaceProfileUseCases {
  saveVersion(command: {
    readonly projectId: ProjectId;
    readonly content: SurfaceProfileContent;
    readonly note: string | null;
    readonly expectedVersionNumber: number | null;
    readonly at: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceProfileVersion, DomainError>>;
  currentVersion(projectId: ProjectId): Promise<Result<SurfaceProfileVersion | null, DomainError>>;
  listVersions(projectId: ProjectId): Promise<Result<readonly SurfaceProfileVersion[], DomainError>>;
}

export interface SurfaceConnectorUseCases {
  register(command: {
    readonly projectId: ProjectId;
    readonly provider: string;
    readonly kind: SurfaceConnectorKind;
    readonly resourceScope: string;
    readonly credentialReference: string;
    readonly at: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceConnector, DomainError>>;
  listForProject(projectId: ProjectId): Promise<Result<readonly SurfaceConnector[], DomainError>>;
  revoke(command: {
    readonly connectorId: ConnectorId;
    readonly at: string;
    readonly reason: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceConnector, DomainError>>;
}


/**
 * One captured request as the transport names it (F06-AC1, F06-AC3, F06-AC5).
 *
 * The controller's own view nests the request inside an `IdeaDraft` and keeps the bug
 * detail inside a discriminated union. The transport names the same facts flat, with
 * the kind and the three optional bug fields as siblings, so this file is where that
 * one translation lives rather than in each of the fifteen intake routes.
 */
export interface SurfaceIntakeIdea {
  readonly ideaId: IdeaId;
  readonly rawRequest: string;
  readonly projectId: string | null;
  readonly notes: string | null;
  readonly kind: 'FeatureRequest' | 'Bug';
  readonly bugDetail: {
    readonly expected: string | null;
    readonly actual: string | null;
    readonly reproduction: string | null;
  };
  readonly attachments: readonly { readonly name: string; readonly mediaType: string; readonly byteSize: number; readonly addedAt: string }[];
  readonly summary: {
    readonly text: string;
    readonly generatedAt: string;
    readonly generatedBy: string;
    readonly rawRequestFingerprint: string;
  } | null;
  readonly disposition: 'Unpublished' | 'Published' | 'Deferred' | 'Archived';
  readonly dispositionDetail: string | null;
  readonly capturedAt: string;
}

export interface SurfaceRelatednessReport {
  readonly candidateIdeaId: IdeaId;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly mergeable: false;
  readonly discardable: false;
  readonly disposition: 'OwnerChoiceRequired';
  readonly ownerChoices: readonly ('LinkToExisting' | 'ExtendExisting' | 'CreateNewIssue')[];
}

export interface SurfaceIntakeDetail {
  readonly idea: SurfaceIntakeIdea;
  readonly brief: {
    readonly briefId: string | null;
    readonly currentVersion: number | null;
    readonly current: BriefVersionView | null;
    readonly versions: readonly BriefVersionView[];
  };
  readonly questions: readonly ClarifyingQuestionView[];
  readonly rejected: readonly RejectedCandidateView[];
  readonly turns: readonly {
    readonly kind: 'RawRequest' | 'Question' | 'Answer' | 'Correction';
    readonly at: string;
    readonly text: string;
    readonly reference: string | null;
  }[];
}

/**
 * The intake port the transport loads.
 *
 * Every command carries `actor` on a write and nothing on a read, following the same
 * rule as the other groups: the transport has proven who is asking, and reads carry
 * no caller so a read cannot be authorized by a request body (F01-AC1). The view
 * types are the controller's own, because this file's job is translating vocabulary
 * and not restating shapes.
 */
export interface SurfaceIntakeUseCases {
  captureIdea(command: {
    readonly rawRequest: string;
    readonly kind: 'FeatureRequest' | 'Bug';
    readonly projectId: string | null;
    readonly notes: string | null;
    readonly detail: { readonly expected: string | null; readonly actual: string | null; readonly reproduction: string | null } | null;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  listIdeas(): Promise<Result<readonly SurfaceIntakeIdea[], DomainError>>;
  getIdea(ideaId: IdeaId): Promise<Result<SurfaceIntakeDetail, DomainError>>;
  attachFile(command: {
    readonly ideaId: IdeaId;
    readonly name: string;
    readonly mediaType: string;
    readonly content: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  recordSummary(command: {
    readonly ideaId: IdeaId;
    readonly text: string;
    readonly generatedBy: string;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  archiveIdea(command: {
    readonly ideaId: IdeaId;
    readonly reason: string | null;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  deferIdea(command: {
    readonly ideaId: IdeaId;
    readonly reason: string | null;
    readonly actor: OwnerId;
  }): Promise<Result<SurfaceIntakeIdea, DomainError>>;
  findRelatedWork(ideaId: IdeaId): Promise<Result<readonly SurfaceRelatednessReport[], DomainError>>;
  recordRelatedWorkChoice(command: {
    readonly ideaId: IdeaId;
    readonly candidateIdeaId: IdeaId;
    readonly choice: string;
    readonly actor: OwnerId;
  }): Promise<Result<RelatedWorkChoiceView, DomainError>>;
  draftBrief(command: {
    readonly ideaId: IdeaId;
    readonly authoredBy: 'Owner' | 'ClarificationModel' | 'OwnerEdit';
    readonly sections: BriefSectionsInput;
    readonly basedOnBriefVersion: number | null;
    readonly actor: OwnerId;
  }): Promise<Result<BriefVersionView, DomainError>>;
  agreeBrief(command: { readonly ideaId: IdeaId; readonly actor: OwnerId }): Promise<Result<BriefVersionView, DomainError>>;
  askClarifyingQuestions(command: {
    readonly ideaId: IdeaId;
    readonly sections: BriefSectionsInput;
    readonly ambiguities: readonly {
      readonly kind: 'UnspecifiedSubject' | 'ConflictingStatement' | 'MissingAcceptanceThreshold' | 'UnstatedScopeBoundary' | 'UnresolvedDependency';
      readonly topic: string;
      readonly readings: readonly string[];
      readonly answeredBy: readonly string[];
      readonly impact: 'ChangesBehaviour' | 'ChangesAcceptance' | 'Cosmetic';
      readonly evidence: string;
    }[];
    readonly actor: OwnerId;
  }): Promise<Result<ClarificationRoundView, DomainError>>;
  answerClarifyingQuestion(command: {
    readonly ideaId: IdeaId;
    readonly questionId: string;
    readonly answer: string;
    readonly actor: OwnerId;
  }): Promise<Result<ClarifyingQuestionView, DomainError>>;
  applyOwnerCorrection(command: {
    readonly ideaId: IdeaId;
    readonly text: string;
    readonly sections: BriefSectionsInput;
    readonly basedOnBriefVersion: number;
    readonly actor: OwnerId;
  }): Promise<Result<CorrectionView, DomainError>>;
  exportIdea(ideaId: IdeaId): Promise<Result<IdeaExport, DomainError>>;
}

/** The whole injected surface. One argument, so a missing use case is a type error. */
export interface ControllerSurface {
  readonly owners: SurfaceOwnerUseCases;
  readonly sessions: SurfaceSessionUseCases;
  readonly profiles: SurfaceProfileUseCases;
  readonly connectors: SurfaceConnectorUseCases;
  readonly intake: SurfaceIntakeUseCases;
}

/**
 * Where the surface gets its root.
 *
 * A resolver rather than a root so the one adapter serves both callers: a test or
 * a worker that already has a root hands it in directly, and the module default
 * handed to the transport resolves one from the environment on first use. One
 * implementation, so the two cannot drift.
 */
export type SurfaceRootResolver = () => Result<CompositionRoot, DomainError>;

/** The owner actor every capability-checked use case demands. */
function ownerActor(actorId: OwnerId): OwnerActor {
  return { actorId, role: 'Owner', ownerId: actorId, sessionId: null };
}

function toSurfaceSession(record: StoredSessionRecord): SurfaceStoredSession {
  return { ...record };
}

/**
 * The owner-visible connector projection.
 *
 * The read/write split and the unsupported list come from the domain's own
 * `capabilitiesFor` rather than from a rule written here, so what the owner is told
 * cannot drift from what the domain authorizes (F03-AC2). The record arrives whole
 * because this is the owner's own settings path; every other read in the controller
 * withholds the reference (F03-AC3).
 */
function toSurfaceConnector(record: ConnectorRecord): SurfaceConnector {
  const capabilities = capabilitiesFor(record.declarations);
  return {
    connectorId: record.connectorId,
    projectId: record.projectId,
    provider: record.provider,
    kind: record.kind,
    resourceScope: record.resourceScope,
    credentialReference: record.credentialReference,
    credentialReferenceDigest: record.credentialReferenceDigest,
    state: record.state,
    error: record.error,
    lastCheckedAt: record.lastCheckedAt,
    lastSuccessAt: record.lastSuccessAt,
    reads: capabilities.reads,
    writes: capabilities.writes,
    unsupported: capabilities.unsupported,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toSurfaceProfile(version: {
  readonly profileVersionId: ProfileVersionId;
  readonly projectId: ProjectId;
  readonly versionNumber: number;
  readonly supersedesVersionId: ProfileVersionId | null;
  readonly content: SurfaceProfileContent;
  readonly contentFingerprint: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}): SurfaceProfileVersion {
  return { ...version };
}

/**
 * One draft as the transport's flat view of it (F06-AC1, F06-AC3).
 *
 * The kind and the bug detail are read out of the domain's discriminated union here
 * and nowhere else, so the routes never have to know that "a feature request with
 * reproduction steps" is not a shape the product recognises.
 */
function toSurfaceIdea(view: CapturedIdeaView): SurfaceIntakeIdea {
  const idea: IdeaDraft = view.idea;
  const request = idea.request;
  const disposition = idea.disposition;
  return {
    ideaId: idea.ideaId,
    rawRequest: idea.rawRequest,
    projectId: idea.projectId,
    notes: idea.notes,
    kind: request.kind,
    bugDetail:
      request.kind === 'Bug'
        ? {
            expected: request.detail.expected,
            actual: request.detail.actual,
            reproduction: request.detail.reproduction,
          }
        : { expected: null, actual: null, reproduction: null },
    attachments: [...view.attachments],
    summary:
      view.summary === null
        ? null
        : {
            text: view.summary.text,
            generatedAt: view.summary.generatedAt,
            generatedBy: view.summary.generatedBy,
            rawRequestFingerprint: view.summary.rawRequestFingerprint,
          },
    disposition: disposition.state,
    dispositionDetail:
      disposition.state === 'Archived'
        ? (disposition.reason ?? 'archived without a stated reason')
        : disposition.state === 'Deferred'
          ? (disposition.reason ?? 'deferred without a stated reason')
          : disposition.state === 'Published'
            ? `${disposition.workItemIds.length} work item(s), ${disposition.codingRunIds.length} coding run(s)`
            : null,
    capturedAt: idea.capturedAt,
  };
}

/**
 * One resemblance report, keyed by the candidate's identity (F06-AC4).
 *
 * The report is reported whole, including the literal `false` flags and the single
 * `OwnerChoiceRequired` disposition, because dropping them here is exactly how a
 * client would come to read a high score as permission to merge.
 */
function toSurfaceRelatedness(entries: readonly RelatedWorkView[]): SurfaceRelatednessReport[] {
  return entries.map((entry) => ({
    candidateIdeaId: entry.candidate.idea.ideaId,
    score: entry.report.score,
    reasons: [...entry.report.reasons],
    mergeable: entry.report.mergeable,
    discardable: entry.report.discardable,
    disposition: entry.report.disposition,
    ownerChoices: [...entry.report.ownerChoices],
  }));
}

/**
 * Everything one captured request consists of, in the transport's vocabulary.
 *
 * The brief and the questions are carried whole: this file renames vocabularies and
 * flattens the one idea view, and it does not reshape facts the owner reads.
 */
function toSurfaceDetail(detail: IntakeDetailView): SurfaceIntakeDetail {
  const brief: BriefView = detail.brief;
  return {
    idea: toSurfaceIdea({ idea: detail.idea, summary: detail.idea.summary, attachments: detail.idea.attachments, disposition: detail.idea.disposition.state }),
    brief: {
      briefId: brief.briefId,
      currentVersion: brief.currentVersion,
      current: brief.current,
      versions: brief.versions,
    },
    questions: detail.questions,
    rejected: detail.rejected,
    turns: detail.turns,
  };
}

/**
 * Builds the surface a transport can inject.
 *
 * Every method is a one-line delegation, so a use case whose shape changes breaks
 * this file's type check here rather than as a 500 on the owner's first request.
 */
export function createControllerSurface(resolve: SurfaceRootResolver): ControllerSurface {
  const use = async <T>(
    body: (root: CompositionRoot) => Result<T, DomainError> | Promise<Result<T, DomainError>>,
  ): Promise<Result<T, DomainError>> => {
    const root = resolve();
    if (!root.ok) return root;
    try {
      return await body(root.value);
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `A controller use case failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  return {
    owners: {
      /**
       * Provisions the owner, naming it the way the transport names it (F01-AC1).
       *
       * `createdAt` is the row's own creation instant, so it is the instant the
       * provision was recorded with rather than a second reading of the clock.
       */
      provision: async (command) =>
        use((root) => {
          const provisioned = root.useCases.provisionNamedOwner(command);
          if (!provisioned.ok) return err(provisioned.error);
          return ok({
            ownerId: provisioned.value.ownerId,
            displayName: command.displayName,
            createdAt: provisioned.value.provisionedAt,
          });
        }),

      /**
       * Verifies a credential and opens the session in one step (F01-AC2).
       *
       * The token was minted and digested by the caller, so this layer receives a
       * digest and the grant carries no token: the plaintext never enters this
       * module and so cannot be logged from here (F01-AC4).
       */
      signIn: async (command) =>
        use((root) => {
          const granted = root.useCases.openOwnerSession(command, root.sessionUseCases);
          if (!granted.ok) return err(granted.error);
          return ok({ session: toSurfaceSession(granted.value) });
        }),
    },

    sessions: {
      /**
       * Resolves a presented cookie token to its stored row.
       *
       * Judges nothing about liveness: the caller's `authorizeSession` is the
       * authority on revocation and needs the row to say so, so a revoked session
       * still loads and is refused there (F01-AC2).
       */
      loadByToken: async (token) =>
        use((root) => {
          const loaded = root.sessionUseCases.loadByToken(token);
          if (!loaded.ok) return err(loaded.error);
          return ok(toSurfaceSession(loaded.value));
        }),

      /**
       * Stores a session under the caller's own limits (F01-AC2).
       *
       * No token parameter and no token in the result: the caller minted it, and
       * this layer only ever sees its digest.
       */
      create: async (command) =>
        use((root) => {
          const opened = root.sessionUseCases.open(command);
          if (!opened.ok) return err(opened.error);
          return ok(toSurfaceSession(opened.value));
        }),

      /** Revokes by stored identity; clearing the cookie is the caller's half (F01-AC2). */
      revoke: async (command) =>
        use((root) => {
          const revoked = root.sessionUseCases.revoke(command);
          if (!revoked.ok) return err(revoked.error);
          return ok(toSurfaceSession(revoked.value));
        }),

      /**
       * Records activity so the configured idle timeout can fire (F01-AC2).
       *
       * `null` on success because the port types this as a side effect with nothing
       * to report, not a read that could return something worth reading.
       */
      touch: async (command) =>
        use((root) => {
          const touched = root.sessionUseCases.touch(command);
          if (!touched.ok) return err(touched.error);
          return ok(null);
        }),
    },

    profiles: {
      saveVersion: async (command) =>
        use((root) => {
          const saved = root.useCases.saveProfile(
            {
              projectId: command.projectId,
              content: command.content,
              note: command.note,
              expectedVersionNumber: command.expectedVersionNumber,
            },
            ownerActor(command.actor),
          );
          if (!saved.ok) return err(saved.error);
          return ok(toSurfaceProfile(saved.value));
        }),

/**
       * The newest version, or null when the project has none.
       *
       * `currentProfile` has exactly one `NotFound` branch and it is this condition,
       * so translating it here is a renaming rather than a suppression, and it is the
       * only error this mapping interprets. The port types the answer as null and the
       * transport turns null into 404; inventing a refusal here as well would give one
       * condition two different answers depending on who asked.
       */
      currentVersion: async (projectId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const current = root.useCases.currentProfile({ projectId, actor: actor.value });
          if (!current.ok) {
            return current.error.code === 'NotFound' ? ok(null) : err(current.error);
          }
          return ok(current.value === null ? null : toSurfaceProfile(current.value));
        }),

      listVersions: async (projectId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const versions = root.useCases.listProfileVersions({ projectId, actor: actor.value });
          if (!versions.ok) return err(versions.error);
          return ok(versions.value.map(toSurfaceProfile));
        }),
    },

    connectors: {
      /**
       * Registers a credential reference and probes nothing.
       *
       * The returned reference is the one the caller supplied, which the use case
       * has just persisted, paired with the digest from the stored row, so the two
       * cannot describe different references (F03-AC3).
       */
      register: async (command) =>
        use((root) => {
          const actor = ownerActor(command.actor);
          const registered = root.useCases.registerConnector(
            {
              projectId: command.projectId,
              kind: command.kind,
              provider: command.provider,
              resourceScope: command.resourceScope,
              credentialReference: command.credentialReference,
            },
            actor,
          );
          if (!registered.ok) return err(registered.error);
          const stored = root.useCases.ownerConnector(registered.value.connectorId, actor);
          if (!stored.ok) return err(stored.error);
          return ok(toSurfaceConnector({ ...stored.value, credentialReference: command.credentialReference }));
        }),

      listForProject: async (projectId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const listed = root.useCases.ownerConnectors({ projectId, actor: actor.value });
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map(toSurfaceConnector));
        }),

      revoke: async (command) =>
        use((root) => {
          const actor = ownerActor(command.actor);
          const revoked = root.useCases.revokeConnector(
            { connectorId: command.connectorId, reason: command.reason },
            actor,
          );
          if (!revoked.ok) return err(revoked.error);
          const stored = root.useCases.ownerConnector(command.connectorId, actor);
          if (!stored.ok) return err(stored.error);
          return ok(toSurfaceConnector(stored.value));
        }),
    },

    intake: {
      captureIdea: async (command) =>
        use((root) => {
          const captured = root.intakeUseCases.captureIdea(
            {
              rawRequest: command.rawRequest,
              kind: command.kind,
              projectId: command.projectId,
              notes: command.notes,
              detail: command.detail,
            },
            ownerActor(command.actor),
          );
          if (!captured.ok) return err(captured.error);
          return ok(toSurfaceIdea(captured.value));
        }),

      /**
       * Reads carry no caller, so the owner is resolved rather than assumed, and the
       * same `requireOwner` gate every write passes is what a read passes (F01-AC1).
       */
      listIdeas: async () =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const listed = root.intakeUseCases.listIdeas(actor.value);
          if (!listed.ok) return err(listed.error);
          return ok(listed.value.map(toSurfaceIdea));
        }),

      getIdea: async (ideaId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const detail = root.intakeUseCases.getIdea(ideaId, actor.value);
          if (!detail.ok) return err(detail.error);
          return ok(toSurfaceDetail(detail.value));
        }),

      attachFile: async (command) =>
        use(async (root) => {
          const attached = await root.intakeUseCases.attachFile(
            {
              ideaId: command.ideaId,
              name: command.name,
              mediaType: command.mediaType,
              content: command.content,
            },
            ownerActor(command.actor),
          );
          if (!attached.ok) return err(attached.error);
          return ok(toSurfaceIdea(attached.value));
        }),

      recordSummary: async (command) =>
        use((root) => {
          const summarized = root.intakeUseCases.recordSummary(
            { ideaId: command.ideaId, text: command.text, generatedBy: command.generatedBy },
            ownerActor(command.actor),
          );
          if (!summarized.ok) return err(summarized.error);
          return ok(toSurfaceIdea(summarized.value));
        }),

      archiveIdea: async (command) =>
        use((root) => {
          const archived = root.intakeUseCases.archiveIdea(
            { ideaId: command.ideaId, reason: command.reason },
            ownerActor(command.actor),
          );
          if (!archived.ok) return err(archived.error);
          return ok(toSurfaceIdea(archived.value));
        }),

      deferIdea: async (command) =>
        use((root) => {
          const deferred = root.intakeUseCases.deferIdea(
            { ideaId: command.ideaId, reason: command.reason },
            ownerActor(command.actor),
          );
          if (!deferred.ok) return err(deferred.error);
          return ok(toSurfaceIdea(deferred.value));
        }),

      findRelatedWork: async (ideaId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          const related = root.intakeUseCases.findRelatedWork({ ideaId }, actor.value);
          if (!related.ok) return err(related.error);
          return ok(toSurfaceRelatedness(related.value));
        }),

      recordRelatedWorkChoice: async (command) =>
        use((root) => root.intakeUseCases.recordRelatedWorkChoice({
          ideaId: command.ideaId,
          candidateIdeaId: command.candidateIdeaId,
          choice: command.choice,
        }, ownerActor(command.actor))),

      draftBrief: async (command) =>
        use((root) =>
          root.intakeUseCases.draftBrief(
            {
              ideaId: command.ideaId,
              authoredBy: command.authoredBy,
              sections: command.sections,
              basedOnBriefVersion: command.basedOnBriefVersion,
            },
            ownerActor(command.actor),
          ),
        ),

      agreeBrief: async (command) =>
        use((root) => root.intakeUseCases.agreeBrief(command.ideaId, ownerActor(command.actor))),

      askClarifyingQuestions: async (command) =>
        use((root) =>
          root.intakeUseCases.askClarifyingQuestions(
            { ideaId: command.ideaId, sections: command.sections, ambiguities: command.ambiguities },
            ownerActor(command.actor),
          ),
        ),

      answerClarifyingQuestion: async (command) =>
        use((root) =>
          root.intakeUseCases.answerClarifyingQuestion(
            { ideaId: command.ideaId, questionId: command.questionId, answer: command.answer },
            ownerActor(command.actor),
          ),
        ),

      applyOwnerCorrection: async (command) =>
        use((root) =>
          root.intakeUseCases.applyOwnerCorrection(
            {
              ideaId: command.ideaId,
              text: command.text,
              sections: command.sections,
              basedOnBriefVersion: command.basedOnBriefVersion,
            },
            ownerActor(command.actor),
          ),
        ),

      exportIdea: async (ideaId) =>
        use((root) => {
          const actor = root.useCases.resolveOwnerActor();
          if (!actor.ok) return err(actor.error);
          return root.intakeUseCases.exportIdea(ideaId, actor.value);
        }),
    },
  };
}

/**
 * A surface bound to a root that already exists.
 *
 * What a test, a worker or any in-process caller uses: the root is the same object
 * the use cases were built from, so there is nothing to resolve and nothing to
 * cache.
 */
export function bindControllerSurface(root: CompositionRoot): ControllerSurface {
  return createControllerSurface(() => ok(root));
}

/** The environment variable naming the durable store this process serves. */
export const DATABASE_PATH_ENV = 'SHIPLOOP_DATABASE_PATH';

/** The environment variable naming the idle session limit this process enforces. */
export const SESSION_IDLE_TIMEOUT_ENV = 'SHIPLOOP_SESSION_IDLE_SECONDS';

/**
 * The environment variable naming the directory intake attachments are written under.
 *
 * The same variable `apps/web` reads for its static artifact mount, because the row
 * an attachment records stores a path relative to that one root; two variables would
 * mean two roots and a pointer that resolves to neither (F06-AC1).
 */
export const ARTIFACT_ROOT_ENV = 'SHIPLOOP_ARTIFACT_ROOT';

/**
 * No provider adapter is configured in this slice.
 *
 * Declaring no capabilities is the honest state: `saveProfile` then refuses any
 * profile needing one, naming the missing adapter, instead of accepting a profile
 * whose delivery would later fail against a provider nobody has implemented
 * (F03-AC2, N05-AC1). Wiring a test double here would make the product claim a
 * capability it does not have.
 */
const NO_ADAPTERS: AdapterRegistry = {
  declarationsFor(): readonly CapabilityDeclaration[] {
    return [];
  },
  probeFor(): ConnectorProbe | null {
    return null;
  },
};

const SYSTEM_CLOCK: ControllerClock = { now: () => new Date().toISOString() };

/**
 * Builds the root this process serves from the environment.
 *
 * The database path is required and has no default: silently opening a file the
 * operator did not name is how a process ends up serving a different store than
 * the one that was backed up (F01-AC1). The idle limit falls back to the domain
 * default, which is a deliberate published value rather than an absence.
 */
export function resolveSurfaceRoot(env: NodeJS.ProcessEnv): Result<CompositionRoot, DomainError> {
  const databasePath = env[DATABASE_PATH_ENV];
  if (databasePath === undefined || databasePath === '') {
    return err({
      code: 'Unavailable',
      reason: `${DATABASE_PATH_ENV} must name the SQLite file this process serves; there is no default store to fall back on (F01-AC1).`,
    });
  }
  return createCompositionRoot({
    databasePath,
    clock: SYSTEM_CLOCK,
    adapters: NO_ADAPTERS,
    sessionIdleTimeoutSeconds: readPositiveInteger(env[SESSION_IDLE_TIMEOUT_ENV]),
    artifactRoot: env[ARTIFACT_ROOT_ENV] === undefined || env[ARTIFACT_ROOT_ENV] === '' ? null : env[ARTIFACT_ROOT_ENV],
  });
}

function readPositiveInteger(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_IDLE_TIMEOUT_SECONDS;
  if (!/^\d+$/.test(raw)) return DEFAULT_IDLE_TIMEOUT_SECONDS;
  const value = Number(raw);
  return value > 0 ? value : DEFAULT_IDLE_TIMEOUT_SECONDS;
}

/**
 * A surface that opens its store on first use, and keeps it.
 *
 * The transport loads this module and checks the loaded value structurally, so a
 * value has to exist before anything has been asked of it. Reading the environment
 * and opening a database at import time would make importing this module an
 * action, so the root is built on the first call instead and reused afterwards. A
 * refusal is returned to the caller rather than thrown, because the caller's
 * contract is a typed `Result` and a library that exits the process is not
 * honouring it.
 */
function createDeferredSurface(): ControllerSurface {
  let root: Result<CompositionRoot, DomainError> | null = null;
  return createControllerSurface(() => {
    root ??= resolveSurfaceRoot(process.env);
    return root;
  });
}

/**
 * The surface `apps/web` loads as `@shiploop/controller`.
 *
 * A default export because the transport accepts either a default or the module
 * namespace, and the namespace already carries the named exports every other caller
 * uses; adding `owners`, `sessions`, `profiles` and `connectors` to it would put
 * four vague names in the package's front door.
 */
const controllerSurface: ControllerSurface = createDeferredSurface();

export default controllerSurface;
