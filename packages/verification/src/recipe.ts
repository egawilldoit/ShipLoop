/**
 * Versioned environment recipes (F04-AC1, F04-AC4, F05-AC1, F05-AC4, F07-AC5, F14-AC3).
 *
 * A recipe is how a project remembers how to run itself: required runtime and
 * CPU/architecture, dependency installation, service startup, check commands,
 * isolated ports and test-data locations, and the test access it needs. It is
 * appended as a new version rather than edited in place, because a run that
 * silently inherits "last week's recipe" cannot explain why its environment
 * behaved the way it did, and an agent that could edit the recipe could quietly
 * relax the commands its own work is judged by (F05-AC4).
 *
 * Validation is exhaustive and field-specific so a profile form can place each
 * problem next to the input that caused it (F02-AC4), and so a plan is refused
 * before any process is started.
 *
 * This module is pure. It performs no I/O and spawns nothing; the preflight
 * runner in `./preflight.ts` executes a recipe through an injected command port.
 */

import { posix } from 'node:path';
import type { DomainError, Fingerprint, ForbiddenError, Result } from '@shiploop/domain';
import { blocked, err, fingerprint, invalid, ok } from '@shiploop/domain';

/** Bounds accepted for any command a recipe records; a recipe cannot widen these. */
const MAX_COMMAND_TIMEOUT_MS = 3_600_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Synthetic root used to prove a recorded data location stays attempt-relative. */
const ATTEMPT_ROOT = '/shiploop-attempt';

/**
 * Capabilities a recipe step may require.
 *
 * The split that matters is read-only versus mutating. Clarification must run
 * with a read-only profile, so it must be impossible for a clarification step to
 * install dependencies, start a service or write into the workspace (F07-AC5).
 */
export const RECIPE_CAPABILITIES = [
  'Repository:Read',
  'Runtime:Inspect',
  'Dependencies:Inspect',
  'Secret:InspectPresence',
  'Service:Probe',
  'Dependencies:Install',
  'Service:Start',
  'Check:Execute',
  'Workspace:Write',
] as const;
export type RecipeCapability = (typeof RECIPE_CAPABILITIES)[number];

export type CapabilityEffect = 'ReadOnly' | 'Mutating';

const MUTATING_CAPABILITIES: ReadonlySet<RecipeCapability> = new Set<RecipeCapability>([
  'Dependencies:Install',
  'Service:Start',
  'Check:Execute',
  'Workspace:Write',
]);

/**
 * Whether a capability can change something outside the answering process.
 *
 * `Check:Execute` counts as mutating because a project's check command builds and
 * writes artifacts; classifying it as read-only would make a read-only profile
 * able to change the workspace it is only meant to inspect.
 */
export function capabilityEffect(capability: RecipeCapability): CapabilityEffect {
  return MUTATING_CAPABILITIES.has(capability) ? 'Mutating' : 'ReadOnly';
}

/** A command recorded by a recipe: an argv array, never a shell string. */
export interface BoundedCommand {
  readonly argv: readonly string[];
  /** Null means unbounded, which validation rejects (mvp-spec "Bound output/context packets, subprocess duration"). */
  readonly timeoutMs: number | null;
  readonly maxOutputBytes: number;
  /** Working directory relative to the attempt root, or null for the attempt root itself. */
  readonly cwd: string | null;
}

export type RecipeStepKind = 'InspectDependencies' | 'InstallDependencies' | 'StartService';

export interface RecipeStep {
  readonly id: string;
  readonly kind: RecipeStepKind;
  readonly description: string;
  readonly command: BoundedCommand;
  readonly requiredCapability: RecipeCapability;
  /** Service this step starts, for StartService steps. */
  readonly serviceId: string | null;
  /** Isolated port this step binds, which must be an allocation of this recipe. */
  readonly port: number | null;
}

export interface CheckCommand {
  readonly id: string;
  readonly name: string;
  readonly command: BoundedCommand;
  readonly required: boolean;
}

export interface RuntimeRequirement {
  readonly name: string;
  readonly minVersion: string;
  readonly maxVersionExclusive: string | null;
}

export interface CpuConstraint {
  readonly architecture: string;
  readonly minCores: number;
}

export interface EnvironmentRequirements {
  /** Null when the recipe has not recorded a runtime, which validation rejects. */
  readonly runtime: RuntimeRequirement | null;
  readonly cpu: CpuConstraint | null;
}

export type PortPurpose = 'Application' | 'Test' | 'Database' | 'Metrics';

export interface PortAllocation {
  readonly serviceId: string;
  readonly port: number;
  readonly purpose: PortPurpose;
  /** A required port that is unreachable is a blocker; an optional one is only reported. */
  readonly required: boolean;
}

export type DataLocationPurpose = 'TestData' | 'Cache' | 'Worktree' | 'Evidence';

export interface DataLocation {
  readonly id: string;
  /** Path relative to the attempt root. A path leaving it is shared project data. */
  readonly path: string;
  readonly purpose: DataLocationPurpose;
}

export type TestAccessKind = 'ServiceEndpoint' | 'Fixture' | 'TestAccount' | 'SecretPresence';

export interface TestAccessReference {
  readonly id: string;
  readonly description: string;
  readonly kind: TestAccessKind;
  /** Endpoint, fixture path or secret name. Never a secret value (F03-AC3, N02-AC2). */
  readonly target: string;
}

/**
 * What happens when the workspace's dependencies no longer match the recipe.
 *
 * Either a recorded maintenance step is run, or the change is reported as an
 * explicit incompatibility. There is no third option, because silently reusing
 * an older successful setup is exactly the failure F04-AC4 forbids.
 */
export interface MaintenancePolicy {
  readonly action: 'RunMaintenanceStep' | 'Incompatible';
  readonly command: BoundedCommand | null;
  readonly incompatibilityReason: string | null;
}

export type RecipeSource = 'OwnerSaved' | 'ProposedByAgent' | 'ImportedFromProfile';

export interface RecipeProvenance {
  readonly source: RecipeSource;
  readonly scope: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export type RecipeVerificationResult = 'NeverVerified' | 'Verified' | 'Failed';

export interface RecipeVerificationRecord {
  readonly result: RecipeVerificationResult;
  readonly verifiedAt: string | null;
  /** Repository revision the verification observed. */
  readonly verifiedRevision: string | null;
  /** Dependency digest the setup was last verified against, or null when never verified. */
  readonly dependencyDigest: Fingerprint | null;
}

/** The part of a recipe that describes the environment; everything else is bookkeeping. */
export interface RecipeVersionContent {
  readonly requirements: EnvironmentRequirements;
  readonly dependencyInstall: readonly RecipeStep[];
  readonly serviceStartup: readonly RecipeStep[];
  readonly checks: readonly CheckCommand[];
  readonly ports: readonly PortAllocation[];
  readonly dataLocations: readonly DataLocation[];
  readonly testAccess: readonly TestAccessReference[];
  /** Names only. Values live in the credential store and are never recorded here. */
  readonly requiredSecrets: readonly string[];
  readonly declaredCapabilities: readonly RecipeCapability[];
  readonly maintenance: MaintenancePolicy;
}

export interface RecipeVersion extends RecipeVersionContent {
  readonly recipeId: string;
  readonly version: number;
  readonly supersedesVersion: number | null;
  readonly provenance: RecipeProvenance;
  readonly lastVerification: RecipeVerificationRecord;
}

interface FieldError {
  readonly path: string;
  readonly message: string;
}

function isNonEmpty(value: string): boolean {
  return value.trim() !== '';
}

/** A recorded data path is safe only when it cannot resolve outside the attempt root. */
function escapesAttemptRoot(relativePath: string): boolean {
  if (!isNonEmpty(relativePath) || posix.isAbsolute(relativePath)) return true;
  const resolved = posix.resolve(ATTEMPT_ROOT, relativePath);
  return resolved !== ATTEMPT_ROOT && !resolved.startsWith(`${ATTEMPT_ROOT}/`);
}

function validateRequirements(requirements: EnvironmentRequirements, fields: FieldError[]): void {
  if (requirements.runtime === null) {
    fields.push({
      path: 'requirements.runtime',
      message: 'The recipe must state the runtime the application needs (F04-AC1).',
    });
  } else {
    if (!isNonEmpty(requirements.runtime.name)) {
      fields.push({ path: 'requirements.runtime.name', message: 'Name the runtime, for example node.' });
    }
    if (!isNonEmpty(requirements.runtime.minVersion)) {
      fields.push({ path: 'requirements.runtime.minVersion', message: 'State the lowest runtime version that works.' });
    }
    if (requirements.runtime.maxVersionExclusive !== null && !isNonEmpty(requirements.runtime.maxVersionExclusive)) {
      fields.push({
        path: 'requirements.runtime.maxVersionExclusive',
        message: 'Leave the exclusive upper bound null instead of recording an empty value.',
      });
    }
  }
  if (requirements.cpu === null) {
    fields.push({
      path: 'requirements.cpu',
      message: 'The recipe must state the CPU/architecture constraint (F04-AC1).',
    });
  } else {
    if (!isNonEmpty(requirements.cpu.architecture)) {
      fields.push({ path: 'requirements.cpu.architecture', message: 'Name the required architecture, for example x64.' });
    }
    if (!Number.isInteger(requirements.cpu.minCores) || requirements.cpu.minCores < 1) {
      fields.push({ path: 'requirements.cpu.minCores', message: 'A minimum core count must be a positive integer.' });
    }
  }
}

function validateBoundedCommand(command: BoundedCommand, path: string, fields: FieldError[]): void {
  if (command.argv.length === 0) {
    fields.push({
      path: `${path}.argv`,
      message: 'A command needs a non-empty argument array; commands are never run through a shell.',
    });
  }
  if (command.argv.some((argument) => argument.length === 0 || argument.includes('\0'))) {
    fields.push({
      path: `${path}.argv`,
      message: 'Command arguments must be non-empty and contain no NUL byte.',
    });
  }
  if (
    command.timeoutMs === null ||
    !Number.isInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > MAX_COMMAND_TIMEOUT_MS
  ) {
    fields.push({
      path: `${path}.timeoutMs`,
      message: `Every command needs a timeout of 1 to ${MAX_COMMAND_TIMEOUT_MS} ms; an unbounded command can hang a run forever.`,
    });
  }
  if (
    !Number.isInteger(command.maxOutputBytes) ||
    command.maxOutputBytes < 1 ||
    command.maxOutputBytes > MAX_COMMAND_OUTPUT_BYTES
  ) {
    fields.push({
      path: `${path}.maxOutputBytes`,
      message: `Every command needs an output limit of 1 to ${MAX_COMMAND_OUTPUT_BYTES} bytes.`,
    });
  }
  if (command.cwd !== null && escapesAttemptRoot(command.cwd)) {
    fields.push({
      path: `${path}.cwd`,
      message: `A command working directory must stay inside the attempt root; "${command.cwd}" leaves it.`,
    });
  }
}

function validateSteps(recipe: RecipeVersion, path: string, steps: readonly RecipeStep[], fields: FieldError[]): void {
  steps.forEach((step, index) => {
    const stepPath = `${path}[${index}]`;
    if (!isNonEmpty(step.id)) {
      fields.push({ path: `${stepPath}.id`, message: 'Every step needs a stable id so its output can be attributed.' });
    }
    validateBoundedCommand(step.command, `${stepPath}.command`, fields);
    if (!recipe.declaredCapabilities.includes(step.requiredCapability)) {
      fields.push({
        path: `${stepPath}.requiredCapability`,
        message: `This step requires ${step.requiredCapability}, which the recipe does not declare. Add it to declaredCapabilities or change the step.`,
      });
    }
    if (step.kind === 'StartService' && !isNonEmpty(step.serviceId ?? '')) {
      fields.push({ path: `${stepPath}.serviceId`, message: 'A service startup step must name the service it starts.' });
    }
    if (step.port !== null && !recipe.ports.some((allocation) => allocation.port === step.port)) {
      fields.push({
        path: `${stepPath}.port`,
        message: `Port ${step.port} is not one of this recipe's isolated port allocations.`,
      });
    }
  });
}

function validateChecks(checks: readonly CheckCommand[], fields: FieldError[]): void {
  checks.forEach((check, index) => {
    const checkPath = `checks[${index}]`;
    if (!isNonEmpty(check.id)) {
      fields.push({ path: `${checkPath}.id`, message: 'Every check needs a stable id.' });
    }
    if (!isNonEmpty(check.name)) {
      fields.push({ path: `${checkPath}.name`, message: 'Every check needs a name the owner can read.' });
    }
    validateBoundedCommand(check.command, `${checkPath}.command`, fields);
  });
}

function validatePorts(recipe: RecipeVersion, fields: FieldError[]): void {
  const claimed = new Map<number, string>();
  recipe.ports.forEach((allocation, index) => {
    const portPath = `ports[${index}].port`;
    if (!isNonEmpty(allocation.serviceId)) {
      fields.push({ path: `ports[${index}].serviceId`, message: 'A port allocation must name the service that owns it.' });
    }
    if (
      !Number.isInteger(allocation.port) ||
      allocation.port < MIN_PORT ||
      allocation.port > MAX_PORT
    ) {
      fields.push({
        path: portPath,
        message: `A port must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
      });
      return;
    }
    const owner = claimed.get(allocation.port);
    if (owner !== undefined) {
      fields.push({
        path: portPath,
        message: `Port ${allocation.port} is already allocated to "${owner}" in this recipe; a collision would attach to an unrelated service (F14-AC3).`,
      });
      return;
    }
    claimed.set(allocation.port, allocation.serviceId);
  });
}

function validateDataLocations(dataLocations: readonly DataLocation[], fields: FieldError[]): void {
  const seen = new Set<string>();
  dataLocations.forEach((location, index) => {
    const locationPath = `dataLocations[${index}]`;
    if (!isNonEmpty(location.id)) {
      fields.push({ path: `${locationPath}.id`, message: 'Every data location needs a stable id.' });
    }
    if (seen.has(location.path)) {
      fields.push({ path: `${locationPath}.path`, message: `Two data locations share the path "${location.path}".` });
    }
    seen.add(location.path);
    if (escapesAttemptRoot(location.path)) {
      fields.push({
        path: `${locationPath}.path`,
        message: `Data must live inside the attempt root; "${location.path}" reaches shared project data, which cleanup must never delete (F04-AC5, F14-AC5).`,
      });
    }
  });
}

function validateTestAccess(testAccess: readonly TestAccessReference[], fields: FieldError[]): void {
  testAccess.forEach((reference, index) => {
    const accessPath = `testAccess[${index}]`;
    if (!isNonEmpty(reference.id)) {
      fields.push({ path: `${accessPath}.id`, message: 'Every test-access reference needs a stable id.' });
    }
    if (!isNonEmpty(reference.target)) {
      fields.push({
        path: `${accessPath}.target`,
        message: 'Name what the test access points at. Record a secret name, never its value (N02-AC2).',
      });
    }
  });
}

function validateSecrets(requiredSecrets: readonly string[], fields: FieldError[]): void {
  const seen = new Set<string>();
  requiredSecrets.forEach((secret, index) => {
    if (!isNonEmpty(secret)) {
      fields.push({ path: `requiredSecrets[${index}]`, message: 'A required secret needs a name.' });
      return;
    }
    if (seen.has(secret)) {
      fields.push({ path: `requiredSecrets[${index}]`, message: `Secret "${secret}" is required more than once.` });
    }
    seen.add(secret);
  });
}

function validateCapabilities(recipe: RecipeVersion, fields: FieldError[]): void {
  recipe.declaredCapabilities.forEach((capability, index) => {
    if (!RECIPE_CAPABILITIES.includes(capability)) {
      fields.push({
        path: `declaredCapabilities[${index}]`,
        message: `${capability} is not a known recipe capability.`,
      });
    }
  });
}

function validateMaintenance(maintenance: MaintenancePolicy, fields: FieldError[]): void {
  if (maintenance.action === 'RunMaintenanceStep') {
    if (maintenance.command === null) {
      fields.push({
        path: 'maintenance.command',
        message: 'This policy promises a maintenance step, so the command that performs it must be recorded (F04-AC4).',
      });
    } else {
      validateBoundedCommand(maintenance.command, 'maintenance.command', fields);
    }
  }
  if (maintenance.action === 'Incompatible' && !isNonEmpty(maintenance.incompatibilityReason ?? '')) {
    fields.push({
      path: 'maintenance.incompatibilityReason',
      message: 'An incompatibility result needs a reason the owner can act on (F04-AC4).',
    });
  }
}

/**
 * Validates a recipe and returns it unchanged, or every field problem at once.
 *
 * Returning all problems rather than the first is deliberate: a profile form has
 * to show the whole set of missing inputs before the owner can fix them, and an
 * early return would let a caller treat "the first thing I noticed" as the truth
 * about the recipe (F02-AC4).
 */
export function validateRecipe(recipe: RecipeVersion): Result<RecipeVersion, DomainError> {
  const fields: FieldError[] = [];
  if (!Number.isInteger(recipe.version) || recipe.version < 1) {
    fields.push({ path: 'version', message: 'A recipe version must be a positive integer.' });
  }
  validateRequirements(recipe.requirements, fields);
  validateSteps(recipe, 'dependencyInstall', recipe.dependencyInstall, fields);
  validateSteps(recipe, 'serviceStartup', recipe.serviceStartup, fields);
  validateChecks(recipe.checks, fields);
  validatePorts(recipe, fields);
  validateDataLocations(recipe.dataLocations, fields);
  validateTestAccess(recipe.testAccess, fields);
  validateSecrets(recipe.requiredSecrets, fields);
  validateCapabilities(recipe, fields);
  validateMaintenance(recipe.maintenance, fields);

  if (fields.length > 0) {
    return err(
      invalid(`The recipe has ${fields.length} field problem(s) that must be corrected before it can be used.`, fields),
    );
  }
  return ok(recipe);
}

/**
 * Appends a new version of a recipe.
 *
 * There is no in-place edit on purpose. A proposed improvement must become a new
 * version an owner saved, so the instructions a future run receives cannot change
 * without leaving the earlier version readable (F05-AC4). A new version starts
 * unverified, because the previous verification described different content.
 */
export function nextVersion(
  previous: RecipeVersion,
  content: RecipeVersionContent,
  provenance: RecipeProvenance,
): Result<RecipeVersion, DomainError> {
  const candidate: RecipeVersion = {
    ...content,
    recipeId: previous.recipeId,
    version: previous.version + 1,
    supersedesVersion: previous.version,
    provenance,
    lastVerification: {
      result: 'NeverVerified',
      verifiedAt: null,
      verifiedRevision: null,
      dependencyDigest: null,
    },
  };
  return validateRecipe(candidate);
}

export interface RecipeVerification {
  readonly result: 'Verified' | 'Failed';
  readonly verifiedAt: string;
  /** Repository revision the verification observed. */
  readonly revision: string;
  readonly dependencyDigest: Fingerprint;
}

/**
 * Records an observed verification against a recipe version.
 *
 * A verification is an observation, not new configuration, so it does not create
 * a version; it still returns a new value and leaves the argument untouched, so a
 * stored recipe cannot be mutated after the fact.
 */
export function recordVerification(recipe: RecipeVersion, verification: RecipeVerification): RecipeVersion {
  return {
    ...recipe,
    lastVerification: {
      result: verification.result,
      verifiedAt: verification.verifiedAt,
      verifiedRevision: verification.revision,
      dependencyDigest: verification.dependencyDigest,
    },
  };
}

/**
 * The environment identity of a recipe version.
 *
 * This is what a candidate records as its environment fingerprint, so a change
 * to any part of the recorded environment yields a different value (mvp-spec 3).
 * Provenance and the verification record are excluded: they describe who wrote
 * the recipe and when it last ran, not the environment it describes.
 */
export function recipeFingerprint(recipe: RecipeVersion): Fingerprint {
  return fingerprint({
    recipeId: recipe.recipeId,
    version: recipe.version,
    requirements: recipe.requirements,
    dependencyInstall: recipe.dependencyInstall,
    serviceStartup: recipe.serviceStartup,
    checks: recipe.checks,
    ports: recipe.ports,
    dataLocations: recipe.dataLocations,
    testAccess: recipe.testAccess,
    requiredSecrets: recipe.requiredSecrets,
    declaredCapabilities: recipe.declaredCapabilities,
    maintenance: recipe.maintenance,
  });
}

/** What was actually observed about the workspace the recipe is about to be used in. */
export interface ObservedEnvironment {
  readonly observedAt: string;
  /** Digest of the current code's dependency declaration, e.g. its lockfile. */
  readonly dependencyDigest: Fingerprint;
}

export type EnvironmentDisposition = 'Reusable' | 'MaintenanceRequired' | 'Incompatible';

export interface EnvironmentAssessment {
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeFingerprint: Fingerprint;
  readonly verifiedDependencyDigest: Fingerprint | null;
  readonly observedDependencyDigest: Fingerprint;
  readonly observedAt: string;
  readonly disposition: EnvironmentDisposition;
  /** The maintenance command that must run before the recipe may be reused. */
  readonly requiredMaintenance: BoundedCommand | null;
  readonly detail: string;
}

/**
 * Decides whether a recorded recipe may be used against the workspace as it is
 * now.
 *
 * A successful setup from an earlier run is only evidence about the dependencies
 * of that run. When the current dependency digest differs, the answer is never a
 * silent reuse: either the recipe's recorded maintenance step must run, or the
 * change is reported as an explicit incompatibility (F04-AC4). A recipe that has
 * never been verified is treated the same way, because there is no earlier
 * success to lean on at all.
 */
export function effectiveEnvironment(
  recipe: RecipeVersion,
  observed: ObservedEnvironment,
): Result<EnvironmentAssessment, DomainError> {
  const base = {
    recipeId: recipe.recipeId,
    recipeVersion: recipe.version,
    recipeFingerprint: recipeFingerprint(recipe),
    verifiedDependencyDigest: recipe.lastVerification.dependencyDigest,
    observedDependencyDigest: observed.dependencyDigest,
    observedAt: observed.observedAt,
  } as const;

  if (recipe.lastVerification.dependencyDigest === null) {
    return err(
      blocked(
        `Recipe ${recipe.recipeId} v${recipe.version} has never been verified, so no earlier setup can be trusted (F04-AC4).`,
        [
          {
            name: `Recipe ${recipe.recipeId} v${recipe.version} verification`,
            detail: 'No dependency digest has ever been recorded for this recipe version.',
            remedy: 'Run the recipe once against a prepared workspace and record the verification.',
          },
        ],
      ),
    );
  }

  if (recipe.lastVerification.dependencyDigest === observed.dependencyDigest) {
    return ok({
      ...base,
      disposition: 'Reusable',
      requiredMaintenance: null,
      detail: `Dependencies still match the digest verified at ${recipe.lastVerification.verifiedAt ?? 'an unrecorded time'}.`,
    });
  }

  const driftDetail = `Dependencies were verified against ${recipe.lastVerification.dependencyDigest} but the workspace now declares ${observed.dependencyDigest}.`;

  if (recipe.maintenance.action === 'Incompatible') {
    return err(
      blocked(`Recipe ${recipe.recipeId} v${recipe.version} is incompatible with the current dependencies.`, [
        {
          name: 'Dependency change',
          detail: `${driftDetail} ${recipe.maintenance.incompatibilityReason ?? 'The recipe declares this change incompatible.'}`,
          remedy: 'Save a new recipe version that supports the current dependencies, or record a maintenance step.',
        },
      ]),
    );
  }

  const maintenance = recipe.maintenance.command;
  if (maintenance === null) {
    return err(
      blocked(`Recipe ${recipe.recipeId} v${recipe.version} records no maintenance step for changed dependencies.`, [
        {
          name: 'Dependency change',
          detail: driftDetail,
          remedy: 'Record the command that reconciles this dependency change, or declare it an explicit incompatibility.',
        },
      ]),
    );
  }

  return ok({
    ...base,
    disposition: 'MaintenanceRequired',
    requiredMaintenance: maintenance,
    detail: `${driftDetail} The recorded maintenance step must run before this recipe is reused.`,
  });
}

export interface CapabilityProfile {
  readonly kind: 'ReadOnly' | 'Full';
  readonly capabilities: readonly RecipeCapability[];
  readonly readOnly: readonly RecipeCapability[];
  readonly mutating: readonly RecipeCapability[];
}

function buildProfile(capabilities: readonly RecipeCapability[], kind: CapabilityProfile['kind']): CapabilityProfile {
  const unique = [...new Set(capabilities)];
  return {
    kind,
    capabilities: unique,
    readOnly: unique.filter((capability) => capabilityEffect(capability) === 'ReadOnly'),
    mutating: unique.filter((capability) => capabilityEffect(capability) === 'Mutating'),
  };
}

/** Everything the recipe's steps actually need, classified by effect. */
export function requiredCapabilityProfile(recipe: RecipeVersion): CapabilityProfile {
  const needed: RecipeCapability[] = [...recipe.declaredCapabilities];
  for (const step of [...recipe.dependencyInstall, ...recipe.serviceStartup]) {
    if (!needed.includes(step.requiredCapability)) needed.push(step.requiredCapability);
  }
  if (recipe.checks.length > 0) needed.push('Check:Execute');
  return buildProfile(needed, 'Full');
}

/**
 * The same recipe's capabilities with every mutating capability removed.
 *
 * This is the profile a clarification run may hold. Deriving it from the recipe
 * rather than from a hand-written list is what makes F07-AC5 checkable: a step
 * that installs dependencies, starts a service, runs a check or writes the
 * workspace is refused by the profile, not merely discouraged.
 */
export function readOnlyCapabilityProfile(recipe: RecipeVersion): CapabilityProfile {
  const full = requiredCapabilityProfile(recipe);
  return buildProfile(full.readOnly, 'ReadOnly');
}

export function permitsCapability(profile: CapabilityProfile, capability: RecipeCapability): boolean {
  return profile.capabilities.includes(capability);
}

/**
 * Whether a profile permits a step, as a typed refusal rather than a boolean.
 *
 * The refusal names the capability and why it was excluded so the denial reaches
 * the owner as a specific reason (F02-AC4, N02-AC3).
 */
export function permitsStep(profile: CapabilityProfile, step: RecipeStep): Result<void, DomainError> {
  if (permitsCapability(profile, step.requiredCapability)) return ok(undefined);
  const refusal: ForbiddenError = {
    code: 'Forbidden',
    reason: `The ${profile.kind === 'ReadOnly' ? 'read-only' : 'current'} capability profile does not permit step "${step.id}", which requires ${step.requiredCapability}, a ${capabilityEffect(step.requiredCapability).toLowerCase()} capability.`,
  };
  return err(refusal);
}
