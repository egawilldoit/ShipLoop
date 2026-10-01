/**
 * Connector references, credential handling, capability reporting and revocation
 * (F03-AC1, F03-AC2, F03-AC3, F03-AC4, F02-AC4, N02-AC2, N05-AC2).
 *
 * A connector row holds a credential *reference* and never a credential. That is
 * the cheapest moment to keep a secret out of a backup, an export and an issue
 * comment: before it is written (F03-AC3). Reads therefore project the record
 * without the reference, carrying the stored digest instead, which is what lets an
 * export prove which reference a row used without reproducing it (F32-AC2).
 *
 * The adapter itself is injected as a probe, so this layer never calls a provider
 * SDK. It decides admissibility — may this connector perform that operation right
 * now — and the probe only observes. That separation is what makes a revocation
 * observable mid-attempt: the attempt re-asks this module and receives a `Blocked`
 * naming the remedy, instead of retrying the same credentials (F03-AC4).
 */

import { blocked, capabilitiesFor, err, invalid, ok, redact, secretFreeReason } from '@shiploop/domain';
import type {
  CapabilityDeclaration,
  CapabilityKind,
  ConnectorHealth,
  ConnectorId,
  DomainError,
  ProjectId,
  Result,
} from '@shiploop/domain';
import { unsupportedOperation } from '@shiploop/adapters';
import type {
  CapabilitySummary,
  ConnectorKind,
  ConnectorRecord,
  ConnectorRepository,
} from '@shiploop/storage';
import type { ControllerClock, OwnerActor } from './profiles.ts';

/** A stored connector with the credential reference removed. */
export type ConnectorView = Omit<ConnectorRecord, 'credentialReference'>;

/**
 * What an adapter is told when asked whether a connector still works.
 *
 * `credentialReference` is a pointer into the credential store, not a value, so
 * handing it to an adapter that resolves references is safe while returning it
 * would not be (F03-AC3).
 */
export interface ConnectorProbeContext {
  readonly connectorId: ConnectorId;
  readonly provider: string;
  readonly resourceScope: string;
  readonly credentialReference: string;
  readonly now: string;
  /** The caller's configured credential patterns, applied before any text is stored. */
  readonly redact: (text: string) => string;
}

/**
 * What an adapter observed.
 *
 * `accessible` false with `state: 'Revoked'` is how expired or withdrawn access
 * reaches the owner as an actionable message rather than a generic failure
 * (F03-AC2). `declarations` is null when the provider could not be asked, which
 * keeps the previously declared set rather than replacing it with an empty one.
 */
export interface ConnectorProbeObservation {
  readonly accessible: boolean;
  readonly state: 'Healthy' | 'Degraded' | 'Revoked' | 'Unreachable';
  readonly error: string | null;
  readonly declarations: readonly CapabilityDeclaration[] | null;
}

/** The only provider-facing surface this layer uses. */
export interface ConnectorProbe {
  readonly kind: ConnectorKind;
  readonly provider: string;
  probe(context: ConnectorProbeContext): Promise<ConnectorProbeObservation>;
}

/**
 * The configured adapters.
 *
 * Injected rather than constructed here so a use case can be exercised without any
 * provider present, and so adding an adapter is configuration rather than a change
 * to lifecycle code (N05-AC1).
 */
export interface AdapterRegistry {
  /** Every capability the configured adapter for this kind declares. */
  declarationsFor(kind: ConnectorKind): readonly CapabilityDeclaration[];
  /** The adapter bound to a stored connector, or null when none is configured. */
  probeFor(record: ConnectorRecord): ConnectorProbe | null;
}

export interface RegisterConnectorInput {
  readonly projectId: ProjectId;
  readonly kind: ConnectorKind;
  readonly provider: string;
  readonly resourceScope: string;
  readonly credentialReference: string;
}

export interface RevokeConnectorInput {
  readonly connectorId: ConnectorId;
  readonly reason: string;
}

export interface ConnectorReadRequest {
  readonly projectId: ProjectId;
  readonly actor: OwnerActor;
}

/**
 * A connector operation an attempt is about to perform.
 *
 * `capability` is null for an operation that needs no provider capability, such as
 * reading a stored reference.
 */
export interface ConnectorOperationRequest {
  readonly connectorId: ConnectorId;
  readonly capability: CapabilityKind | null;
}

export interface ConnectorUseCaseDeps {
  readonly clock: ControllerClock;
  readonly connectors: ConnectorRepository;
  readonly adapters: AdapterRegistry;
}

export interface ConnectorUseCases {
  readonly registerConnector: (
    input: RegisterConnectorInput,
    actor: OwnerActor,
  ) => Result<ConnectorView, DomainError>;
  readonly listConnectors: (request: ConnectorReadRequest) => Result<readonly ConnectorView[], DomainError>;
  readonly describeConnector: (
    connectorId: ConnectorId,
    actor: OwnerActor,
  ) => Result<ConnectorView, DomainError>;
  readonly revokeConnector: (
    input: RevokeConnectorInput,
    actor: OwnerActor,
  ) => Result<ConnectorView, DomainError>;
  readonly resolveConnectorHealth: (
    request: ConnectorReadRequest,
  ) => Result<readonly ConnectorHealth[], DomainError>;
  readonly testConnections: (
    request: ConnectorReadRequest,
  ) => Promise<Result<readonly ConnectorHealth[], DomainError>>;
  readonly capabilitySummary: (
    connectorId: ConnectorId,
    actor: OwnerActor,
  ) => Result<CapabilitySummary, DomainError>;
  readonly requireUsableConnector: (
    request: ConnectorOperationRequest,
  ) => Result<ConnectorView, DomainError>;
}

const CONNECTOR_KINDS: readonly ConnectorKind[] = ['Ticket', 'Git', 'Deployment', 'Engine'];

/**
 * Whether a value is a usable string.
 *
 * An omitted optional field is a legitimate input, so absence is a validation
 * result rather than a crash (F02-AC4).
 */
function isNonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether a supplied value is a credential reference rather than a credential.
 *
 * The domain's own rules decide this, so the refusal cannot drift from the patterns
 * stripped from logs, exports and issue text (F03-AC3, N02-AC2). A value that
 * matches is never persisted, not even to be rejected afterwards.
 */
function secretReferenceProblem(value: string): string | null {
  if (!isNonEmpty(value)) return 'Required.';
  const applied = redact(value).appliedLabels;
  if (applied.length === 0) return null;
  return `Looks like a secret value (${applied.join(', ')}). Store a reference into the credential store instead (F03-AC3).`;
}

/** The projection every read returns. */
function toView(record: ConnectorRecord): ConnectorView {
  const { credentialReference: withheld, ...view } = record;
  void withheld;
  return view;
}

/**
 * Storage's own state vocabulary is slightly wider than the owner-visible one:
 * "unreachable" is how the owner sees a degraded connection, not a fifth state
 * (F03-AC2).
 */
function healthStateFor(record: ConnectorRecord): ConnectorHealth['state'] {
  if (record.state === 'Unreachable') return 'Degraded';
  return record.state;
}

/** The owner-facing health of one connector, with reads and writes declared. */
function toHealth(record: ConnectorRecord): ConnectorHealth {
  const summary = capabilitiesFor(record.declarations);
  return {
    connectorId: record.connectorId,
    provider: record.provider,
    state: healthStateFor(record),
    reads: summary.reads,
    writes: summary.writes,
    lastCheckedAt: record.lastCheckedAt,
    lastSuccessAt: record.lastSuccessAt,
    error: record.error === null ? null : secretFreeReason(record.error),
  };
}

/**
 * Builds the connector use cases.
 *
 * `clock` and `adapters` are injected, so a check result is reproducible and no
 * provider is contacted unless a caller explicitly asks to test connections.
 */
export function createConnectorUseCases(deps: ConnectorUseCaseDeps): ConnectorUseCases {
  const requireOwner = (actor: OwnerActor): Result<true, DomainError> => {
    if (actor.role !== 'Owner') {
      return err({
        code: 'Forbidden',
        reason: `Only the owner may change connector configuration; the ${actor.role} role may not (F03-AC1).`,
      });
    }
    return ok(true);
  };

  /**
   * Records a connector by reference (F03-AC1, F03-AC3).
   *
   * A value that looks like a secret is refused here rather than stored and
   * complained about later. The row starts `Unconfigured`: configuring a reference
   * is not the same observation as reaching the provider, and only a probe may
   * claim access.
   */
  const registerConnector = (
    input: RegisterConnectorInput,
    actor: OwnerActor,
  ): Result<ConnectorView, DomainError> => {
    const permitted = requireOwner(actor);
    if (!permitted.ok) return err(permitted.error);

    const fields: { path: string; message: string }[] = [];
    if (!CONNECTOR_KINDS.includes(input.kind)) {
      fields.push({ path: 'kind', message: `Must be one of: ${CONNECTOR_KINDS.join(', ')}.` });
    }
    if (!isNonEmpty(input.provider)) fields.push({ path: 'provider', message: 'Required.' });
    if (!isNonEmpty(input.resourceScope)) {
      fields.push({ path: 'resourceScope', message: 'The project resource this connector may reach is required.' });
    }
    const referenceProblem = secretReferenceProblem(input.credentialReference);
    if (referenceProblem !== null) {
      fields.push({ path: 'credentialReference', message: referenceProblem });
    }
    if (fields.length > 0) {
      return err(invalid('The connector could not be registered.', fields));
    }

    const now = deps.clock.now();
    const saved = deps.connectors.upsert({
      projectId: input.projectId,
      provider: input.provider,
      kind: input.kind,
      resourceScope: input.resourceScope,
      credentialReference: input.credentialReference,
      declarations: deps.adapters.declarationsFor(input.kind),
      state: 'Unconfigured',
      error: 'Configured but not yet tested against the provider (F03-AC1).',
      at: now,
    });
    if (!saved.ok) return err(saved.error);
    return ok(toView(saved.value));
  };

  const listConnectors = (
    request: ConnectorReadRequest,
  ): Result<readonly ConnectorView[], DomainError> => {
    const permitted = requireOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);
    const listed = deps.connectors.listForProject(request.projectId);
    if (!listed.ok) return err(listed.error);
    return ok(listed.value.map(toView));
  };

  const describeConnector = (
    connectorId: ConnectorId,
    actor: OwnerActor,
  ): Result<ConnectorView, DomainError> => {
    const permitted = requireOwner(actor);
    if (!permitted.ok) return err(permitted.error);
    const record = deps.connectors.get(connectorId);
    if (!record.ok) return err(record.error);
    return ok(toView(record.value));
  };

  /**
   * Withdraws a connector (F03-AC4).
   *
   * Revocation changes what may be attempted next; it does not erase the row. The
   * history of what was configured and when it last worked stays readable, because
   * a run that already used the connector has to be explainable afterwards.
   */
  const revokeConnector = (
    input: RevokeConnectorInput,
    actor: OwnerActor,
  ): Result<ConnectorView, DomainError> => {
    const permitted = requireOwner(actor);
    if (!permitted.ok) return err(permitted.error);
    const reason = isNonEmpty(input.reason)
      ? secretFreeReason(input.reason)
      : 'Access to this connector was revoked; new operations through it are blocked (F03-AC4).';
    const revoked = deps.connectors.revoke(input.connectorId, deps.clock.now(), reason);
    if (!revoked.ok) return err(revoked.error);
    return ok(toView(revoked.value));
  };

  /**
   * The owner-visible health of a project's connectors (F03-AC2).
   *
   * Reads the declared capabilities and the recorded check times; it contacts no
   * provider, so it is safe to call on every render.
   */
  const resolveConnectorHealth = (
    request: ConnectorReadRequest,
  ): Result<readonly ConnectorHealth[], DomainError> => {
    const permitted = requireOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);
    const listed = deps.connectors.listForProject(request.projectId);
    if (!listed.ok) return err(listed.error);
    return ok(listed.value.map(toHealth));
  };

  /**
   * Probes every connector of a project and records what was observed (F03-AC1).
   *
   * A probe that throws is recorded as a degraded observation rather than allowed
   * to escape: a failing adapter must not turn a health page into a 500. Only a
   * success moves `lastSuccessAt`, so a failure cannot present itself as a fresh
   * check.
   *
   * A revoked connector is reported from its stored state and never probed. Probing
   * it would be the credential retry F03-AC4 forbids, and a probe that happened to
   * succeed must not silently undo an explicit revocation.
   */
  const testConnections = async (
    request: ConnectorReadRequest,
  ): Promise<Result<readonly ConnectorHealth[], DomainError>> => {
    const permitted = requireOwner(request.actor);
    if (!permitted.ok) return err(permitted.error);
    const listed = deps.connectors.listForProject(request.projectId);
    if (!listed.ok) return err(listed.error);

    const health: ConnectorHealth[] = [];
    for (const record of listed.value) {
      if (record.state === 'Revoked') {
        health.push(toHealth(record));
        continue;
      }
      const probe = deps.adapters.probeFor(record);
      const checkedAt = deps.clock.now();
      const observation =
        probe === null
          ? {
              accessible: false,
              state: 'Unreachable' as const,
              error: `No ${record.kind} adapter is configured, so ${record.provider} was not contacted (F03-AC1).`,
              declarations: null,
            }
          : await observe(probe, record, checkedAt);

      const recorded = deps.connectors.recordCheck(record.connectorId, {
        checkedAt,
        succeeded: observation.accessible,
        state: observation.state,
        error: observation.error,
        declarations: observation.declarations,
      });
      if (!recorded.ok) return err(recorded.error);
      health.push(toHealth(recorded.value));
    }
    return ok(health);
  };

  const capabilitySummary = (
    connectorId: ConnectorId,
    actor: OwnerActor,
  ): Result<CapabilitySummary, DomainError> => {
    const permitted = requireOwner(actor);
    if (!permitted.ok) return err(permitted.error);
    return deps.connectors.capabilitySummary(connectorId);
  };

  /**
   * The gate an attempt passes before it touches a connector (F03-AC4).
   *
   * A revoked connector blocks the operation immediately and says what to do about
   * it, which is what lets a running attempt report the blocker and preserve its
   * work rather than retrying credentials until a budget is spent (F03-AC4). An
   * operation the provider never declared is refused as unsupported instead of being
   * attempted and failing obscurely (F03-AC2, N05-AC2).
   */
  const requireUsableConnector = (
    request: ConnectorOperationRequest,
  ): Result<ConnectorView, DomainError> => {
    const record = deps.connectors.get(request.connectorId);
    if (!record.ok) return err(record.error);

    if (record.value.state === 'Revoked') {
      return err(
        blocked(`${record.value.provider} access was revoked; this operation cannot proceed.`, [
          {
            name: `${record.value.provider} connector`,
            detail: record.value.error ?? 'Access to this connector was revoked.',
            remedy: `Restore access in ${record.value.provider}, or point this project at another connector, then start a new attempt. Existing work is preserved (F03-AC4).`,
          },
        ]),
      );
    }

    if (request.capability !== null) {
      const declaration = record.value.declarations.find((entry) => entry.kind === request.capability);
      if (declaration === undefined || !declaration.supported) {
        return err(
          unsupportedOperation(
            record.value.kind,
            request.capability,
            declaration?.limitation ?? 'this provider does not declare it',
          ),
        );
      }
    }

    return ok(toView(record.value));
  };

  return {
    registerConnector,
    listConnectors,
    describeConnector,
    revokeConnector,
    resolveConnectorHealth,
    testConnections,
    capabilitySummary,
    requireUsableConnector,
  };
}

/** Runs a probe and turns a thrown adapter into a degraded observation. */
async function observe(
  probe: ConnectorProbe,
  record: ConnectorRecord,
  now: string,
): Promise<ConnectorProbeObservation> {
  try {
    const observed = await probe.probe({
      connectorId: record.connectorId,
      provider: record.provider,
      resourceScope: record.resourceScope,
      credentialReference: record.credentialReference,
      now,
      redact: (text: string) => redact(text).text,
    });
    return {
      accessible: observed.accessible,
      state: observed.state,
      error: observed.error === null ? null : secretFreeReason(observed.error),
      declarations: observed.declarations,
    };
  } catch (error) {
    return {
      accessible: false,
      state: 'Unreachable',
      error: secretFreeReason(
        `${probe.provider} could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      ),
      declarations: null,
    };
  }
}

