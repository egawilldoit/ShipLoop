/**
 * The recorded readiness decision for work that is about to start (F09).
 *
 * Readiness is an assessment against live facts, never a standing boolean and never a
 * number, so this module produces a record rather than a flag: it names what it
 * looked at, which area is open and why, and whether a build may start while
 * supported read-only investigation may still be started (F09-AC2, F09-AC4).
 *
 * The verdict itself is not decided here. `deriveReadiness` and
 * `dependencyAvailable` from the shared readiness module own those rules, and this
 * module's job is to gather every area F09-AC1 names, hand the findings over, and
 * record what came back.
 */

import { fingerprint } from '../fingerprint.ts';
import type { Fingerprint } from '../ids.ts';
import { dependencyAvailable, deriveReadiness } from '../readiness.ts';
import type { ReadinessArea, ReadinessFinding, ReadinessStatus, ReadinessVerdict } from '../readiness.ts';
import type { DomainError, Result } from '../result.ts';
import { err, invalid, ok } from '../result.ts';

/**
 * Every area F09-AC1 names, in the order the specification lists them.
 *
 * The list is explicit so an assessment cannot silently omit an area: a readiness
 * decision that never looked at access has not checked a prerequisite, it has only
 * avoided mentioning it.
 */
export const READINESS_AREAS: readonly ReadinessArea[] = Object.freeze([
  'Scope',
  'Criteria',
  'Repository',
  'Target',
  'Dependencies',
  'Verification',
  'Access',
]);

/**
 * The areas whose absence or uncertainty makes writing code premature.
 *
 * Verification is excluded because an undecided verification method blocks completion,
 * not implementation: refusing to build until someone has named the test would waste
 * the session F09 exists to protect. Every other area is a prerequisite of the code
 * itself.
 */
export const BUILD_REQUIRED_AREAS: readonly ReadinessArea[] = Object.freeze([
  'Scope',
  'Criteria',
  'Repository',
  'Target',
  'Dependencies',
  'Access',
]);

/**
 * Keys that would express readiness as a number.
 *
 * Readiness is a judgement about named prerequisites (F09-AC4). A confidence
 * percentage has no denominator, cannot be recomputed from the findings and invites
 * treating a guess as a measurement, so one is refused at the boundary rather than
 * quietly ignored.
 */
export const FORBIDDEN_CONFIDENCE_FIELDS: readonly string[] = Object.freeze([
  'confidence',
  'confidenceScore',
  'confidencePercent',
  'percentReady',
  'readinessPercent',
  'readinessScore',
  'score',
  'probability',
]);

/** What was observed for one area, with the reason that observation supports. */
export interface AreaObservation {
  readonly status: ReadinessStatus;
  readonly reason: string;
  /** What the owner or operator can do about it. Required when status is not Satisfied. */
  readonly remedy: string | null;
}

export type DependencyStatus = 'Done' | 'InProgress' | 'Todo' | 'Canceled';

/**
 * One referenced dependency as the provider actually reports it.
 *
 * `requiresRelease` is the caller's claim about what the work needs, not the
 * provider's state: a dependency marked Done whose release the work actually consumes
 * is not available until the receipt exists (F09-AC3).
 */
export interface DependencyObservation {
  readonly id: string;
  readonly status: DependencyStatus;
  readonly releaseReceiptRecorded: boolean;
  readonly requiresRelease: boolean;
}

/**
 * Everything an assessment observed.
 *
 * `assessedAt` is injected rather than read from the clock, so a recorded assessment
 * is reproducible in a test and comparable with the one that preceded it (F09-AC4).
 */
export interface ReadinessObservation {
  readonly subjectId: string;
  readonly assessedAt: string;
  readonly scope: AreaObservation;
  readonly criteria: AreaObservation;
  readonly repository: AreaObservation;
  readonly target: AreaObservation;
  readonly verification: AreaObservation;
  readonly access: AreaObservation;
  readonly dependencies: readonly DependencyObservation[];
  /** Areas whose uncertainty supported read-only investigation can actually resolve. */
  readonly investigationSupported: readonly ReadinessArea[];
}

const OBSERVATION_FIELDS: readonly string[] = Object.freeze([
  'subjectId',
  'assessedAt',
  'scope',
  'criteria',
  'repository',
  'target',
  'verification',
  'access',
  'dependencies',
  'investigationSupported',
]);

const AREA_OBSERVATION_FIELDS: readonly string[] = Object.freeze(['status', 'reason', 'remedy']);
const DEPENDENCY_OBSERVATION_FIELDS: readonly string[] = Object.freeze([
  'id',
  'status',
  'releaseReceiptRecorded',
  'requiresRelease',
]);

const READINESS_STATUSES: readonly ReadinessStatus[] = Object.freeze(['Satisfied', 'Unmet', 'Unknown']);
const DEPENDENCY_STATUSES: readonly DependencyStatus[] = Object.freeze(['Done', 'InProgress', 'Todo', 'Canceled']);

interface FieldError {
  readonly path: string;
  readonly message: string;
}

/** The outcome for one area, whether it is satisfied or not (F09-AC1). */
export interface AreaReport {
  readonly area: ReadinessArea;
  readonly status: ReadinessStatus;
  readonly reason: string;
  readonly remedy: string | null;
}

/** One open area and the reason it is open. */
export interface ReadinessReason {
  readonly area: ReadinessArea;
  readonly status: Exclude<ReadinessStatus, 'Satisfied'>;
  readonly reason: string;
}

interface DecisionBase {
  readonly subjectId: string;
  readonly assessedAt: string;
  /**
   * Every area F09-AC1 names, keyed by area, each with the reason it stands where it
   * does.
   *
   * A record rather than a list, because a list can be short: an assessment that never
   * looked at access has not checked a prerequisite, it has only avoided mentioning
   * it, and the type is where that mistake becomes impossible.
   */
  readonly areas: Readonly<Record<ReadinessArea, AreaReport>>;
  /** The open areas, in order. Empty for a Ready assessment. */
  readonly reasons: readonly ReadinessReason[];
  /** Only the open areas; a satisfied area is not a finding. */
  readonly findings: readonly ReadinessFinding[];
  readonly observationDigest: Fingerprint;
}

/**
 * Nothing is absent and nothing is undecided, so the work may start (F09-AC5).
 */
export type ReadyReadinessDecision = DecisionBase & {
  readonly verdict: 'Ready';
  readonly mayStartBuild: true;
  readonly mayStartInvestigation: boolean;
  readonly buildBlockingAreas: readonly [];
};

/**
 * Something is undecided, and whether a build may start depends on where.
 *
 * An open area outside `BUILD_REQUIRED_AREAS` — an undecided verification method, say —
 * leaves the work startable with an empty `buildBlockingAreas`; an open required area
 * does not. The two are separate variants rather than one boolean because "you may
 * start" and "nothing is blocking" must not be able to disagree (F09-AC2).
 */
export type NeedsInformationReadinessDecision =
  | (DecisionBase & {
      readonly verdict: 'NeedsInformation';
      readonly mayStartBuild: true;
      readonly mayStartInvestigation: boolean;
      readonly buildBlockingAreas: readonly [];
    })
  | (DecisionBase & {
      readonly verdict: 'NeedsInformation';
      readonly mayStartBuild: false;
      readonly mayStartInvestigation: boolean;
      readonly buildBlockingAreas: readonly ReadinessArea[];
    });

/**
 * A required prerequisite is absent, so the build is disabled (F09-AC2).
 *
 * `mayStartBuild` is the literal `false` rather than a computed boolean: the one
 * conclusion F09-AC2 forbids being derived wrongly is unrepresentable here. Build is
 * disabled whatever else is true, and investigation is separately permitted because
 * finding out what is missing is usually read-only work.
 */
export type BlockedReadinessDecision = DecisionBase & {
  readonly verdict: 'Blocked';
  readonly mayStartBuild: false;
  readonly mayStartInvestigation: boolean;
  readonly buildBlockingAreas: readonly ReadinessArea[];
};

/**
 * The recorded decision.
 *
 * Four variants rather than one interface with two booleans, because the combination
 * "build may start" with "something required is missing" has to be impossible to
 * construct, not merely discouraged (F09-AC2).
 */
export type ReadinessDecision =
  | ReadyReadinessDecision
  | NeedsInformationReadinessDecision
  | BlockedReadinessDecision;

/**
 * The assessed areas in the order the specification lists them.
 *
 * The record is keyed so no area can be missing, and this is how a reader gets that
 * back in a stable order without having to know the key order (F09-AC1).
 */
export function orderedAreas(decision: ReadinessDecision): readonly AreaReport[] {
  return Object.freeze(READINESS_AREAS.map((area) => decision.areas[area]));
}

function unexpectedField(path: string, key: string): FieldError {
  return FORBIDDEN_CONFIDENCE_FIELDS.includes(key)
    ? {
        path,
        message: `"${key}" is not a readiness field: readiness is a recorded judgement, not a percentage confidence score (F09-AC4).`,
      }
    : { path, message: `A readiness observation has no field "${key}".` };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== 'object' ? null : (value as Record<string, unknown>);
}

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Every reason the observation cannot produce a decision.
 *
 * Unknown keys are checked because the observation arrives as decoded data from the
 * adapters that read providers, and a percentage field has to be refused rather than
 * dropped: accepting it would record a number nobody can justify (F09-AC4).
 */
function observationErrors(observation: unknown): readonly FieldError[] {
  const record = asRecord(observation);
  if (record === null) {
    return [{ path: 'observation', message: 'A readiness observation must be an object.' }];
  }

  const errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!OBSERVATION_FIELDS.includes(key)) errors.push(unexpectedField(key, key));
  }
  if (!isFilledText(record['subjectId'])) {
    errors.push({ path: 'subjectId', message: 'An assessment must name the work it assesses.' });
  }
  if (!isFilledText(record['assessedAt'])) {
    errors.push({ path: 'assessedAt', message: 'An assessment must record when it was made.' });
  }

  for (const area of READINESS_AREAS) {
    if (area === 'Dependencies') continue;
    const field = area.toLowerCase();
    errors.push(...areaObservationErrors(record[field], field));
  }

  const dependencies = record['dependencies'];
  if (!Array.isArray(dependencies)) {
    errors.push({ path: 'dependencies', message: 'The referenced dependencies must be a list.' });
  } else {
    dependencies.forEach((entry: unknown, index: number) => {
      const path = `dependencies[${index}]`;
      const dependency = asRecord(entry);
      if (dependency === null) {
        errors.push({ path, message: 'A dependency observation must be an object.' });
        return;
      }
      for (const key of Object.keys(dependency)) {
        if (!DEPENDENCY_OBSERVATION_FIELDS.includes(key)) errors.push(unexpectedField(`${path}.${key}`, key));
      }
      if (!isFilledText(dependency['id'])) {
        errors.push({ path: `${path}.id`, message: 'A dependency observation needs an id.' });
      }
      const status = dependency['status'];
      if (typeof status !== 'string' || !DEPENDENCY_STATUSES.includes(status as DependencyStatus)) {
        errors.push({ path: `${path}.status`, message: `A dependency status is one of ${DEPENDENCY_STATUSES.join(', ')}.` });
      }
      for (const flag of ['releaseReceiptRecorded', 'requiresRelease'] as const) {
        if (typeof dependency[flag] !== 'boolean') {
          errors.push({ path: `${path}.${flag}`, message: `"${flag}" must state whether it holds.` });
        }
      }
    });
  }

  const supported = record['investigationSupported'];
  if (!Array.isArray(supported)) {
    errors.push({
      path: 'investigationSupported',
      message: 'The assessment must say which uncertainties read-only investigation can resolve (F09-AC2).',
    });
  } else {
    supported.forEach((area: unknown, index: number) => {
      if (typeof area !== 'string' || !READINESS_AREAS.includes(area as ReadinessArea)) {
        errors.push({
          path: `investigationSupported[${index}]`,
          message: `"${String(area)}" is not a readiness area.`,
        });
      }
    });
  }

  return errors;
}

/**
 * Validation for one area's observation.
 *
 * A remedy is required whenever the area is not satisfied: "needs information" with no
 * route to the information is the finding that stalls the owner, so the reason and the
 * remedy travel together.
 */
function areaObservationErrors(value: unknown, area: string): readonly FieldError[] {
  const record = asRecord(value);
  if (record === null) {
    return [{ path: area, message: `The ${area} area must carry a status and a reason (F09-AC1).` }];
  }

  const errors: FieldError[] = [];
  const path = (field: string): string => (field.length === 0 ? area : `${area}.${field}`);

  for (const key of Object.keys(record)) {
    if (!AREA_OBSERVATION_FIELDS.includes(key)) errors.push(unexpectedField(path(key), key));
  }
  const status = record['status'];
  if (typeof status !== 'string' || !READINESS_STATUSES.includes(status as ReadinessStatus)) {
    errors.push({ path: path('status'), message: `The ${area} status is one of ${READINESS_STATUSES.join(', ')}.` });
  }
  if (!isFilledText(record['reason'])) {
    errors.push({ path: path('reason'), message: `The ${area} area must state a reason (F09-AC1).` });
  }
  if (record['remedy'] !== null && !isFilledText(record['remedy'])) {
    errors.push({ path: path('remedy'), message: `The ${area} remedy must be text or null.` });
  }
  if (status !== 'Satisfied' && !isFilledText(record['remedy'])) {
    errors.push({
      path: path('remedy'),
      message: `An open ${area} area must name a remedy, or the owner has nothing to act on.`,
    });
  }
  return errors;
}

function areaReports(observation: ReadinessObservation): Readonly<Record<ReadinessArea, AreaReport>> {
  const observed: Readonly<Record<Exclude<ReadinessArea, 'Dependencies'>, AreaObservation>> = {
    Scope: observation.scope,
    Criteria: observation.criteria,
    Repository: observation.repository,
    Target: observation.target,
    Verification: observation.verification,
    Access: observation.access,
  };

  const reported = (name: Exclude<ReadinessArea, 'Dependencies'>): AreaReport => {
    const { status, reason, remedy } = observed[name];
    return Object.freeze({ area: name, status, reason, remedy });
  };

  return Object.freeze({
    Scope: reported('Scope'),
    Criteria: reported('Criteria'),
    Repository: reported('Repository'),
    Target: reported('Target'),
    Dependencies: dependencyReport(observation),
    Verification: reported('Verification'),
    Access: reported('Access'),
  });
}

/**
 * The dependency area, derived from what each referenced dependency actually offers.
 *
 * A Done dependency whose release the work needs but which has no receipt is Unmet
 * rather than satisfied, which is the whole point of F09-AC3: "done" is a status, not
 * a delivery, and treating it as one wastes a session.
 */
function dependencyReport(observation: ReadinessObservation): AreaReport {
  if (observation.dependencies.length === 0) {
    return Object.freeze({
      area: 'Dependencies',
      status: 'Satisfied',
      reason: 'No dependency is referenced, so nothing external is awaited.',
      remedy: null,
    });
  }

  const unavailable: { readonly reason: string }[] = [];
  for (const dependency of observation.dependencies) {
    const availability = dependencyAvailable({
      status: dependency.status,
      releaseReceiptRecorded: dependency.releaseReceiptRecorded,
      requiresRelease: dependency.requiresRelease,
    });
    if (!availability.available) unavailable.push({ reason: `${dependency.id}: ${availability.reason}` });
  }

  if (unavailable.length === 0) {
    return Object.freeze({
      area: 'Dependencies',
      status: 'Satisfied',
      reason: `All ${observation.dependencies.length} referenced dependency/dependencies are available.`,
      remedy: null,
    });
  }
  return Object.freeze({
    area: 'Dependencies',
    status: 'Unmet',
    reason: unavailable.map((entry) => entry.reason).join(' '),
    remedy: 'Finish or release each unavailable dependency, or record that this work does not need it.',
  });
}

/**
 * An area that is not satisfied.
 *
 * A satisfied area is not a finding: recording it as one would mean every ready
 * assessment carried a list of things that were fine, which is how a real blocker
 * gets lost among them (F09-AC5).
 */
function isOpen(area: AreaReport): area is AreaReport & { readonly status: Exclude<ReadinessStatus, 'Satisfied'> } {
  return area.status !== 'Satisfied';
}

/**
 * Assesses whether work can start (F09-AC1, F09-AC2, F09-AC3, F09-AC5).
 *
 * The verdict comes from `deriveReadiness`, so an Unmet prerequisite outranks an
 * Unknown one and a fully satisfied set is Ready without an invented blocker. What
 * this adds is the record: every area with its reason, the open ones as findings, and
 * a digest of what was observed so a later assessment can be compared against this one.
 */
export function assessReadiness(observation: unknown): Result<ReadinessDecision, DomainError> {
  const errors = observationErrors(observation);
  if (errors.length > 0) {
    return err<DomainError>(invalid('The readiness observation is not usable (F09-AC1).', errors));
  }

  const typed = observation as ReadinessObservation;
  const areas = areaReports(typed);
  const open = READINESS_AREAS.map((area) => areas[area]).filter(isOpen);
  const findings: ReadinessFinding[] = open.map((area) => ({
    area: area.area,
    status: area.status,
    reason: area.reason,
    remedy: area.remedy,
  }));
  const reasons: ReadinessReason[] = open.map((area) => ({ area: area.area, status: area.status, reason: area.reason }));

  const verdict: ReadinessVerdict = deriveReadiness(findings);
  const buildBlockingAreas = READINESS_AREAS.filter(
    (area) => BUILD_REQUIRED_AREAS.includes(area) && findings.some((finding) => finding.area === area),
  );
  const mayStartInvestigation = reasons.every((reason) => typed.investigationSupported.includes(reason.area));

  const base: DecisionBase = {
    subjectId: typed.subjectId,
    assessedAt: typed.assessedAt,
    areas,
    reasons: Object.freeze(reasons),
    findings: Object.freeze(findings),
    observationDigest: fingerprint({
      subjectId: typed.subjectId,
      scope: typed.scope,
      criteria: typed.criteria,
      repository: typed.repository,
      target: typed.target,
      verification: typed.verification,
      access: typed.access,
      dependencies: typed.dependencies,
      investigationSupported: typed.investigationSupported,
    }),
  };

  if (verdict === 'Blocked') {
    return ok<ReadinessDecision>(
      Object.freeze({
        ...base,
        verdict: 'Blocked',
        mayStartBuild: false,
        mayStartInvestigation,
        buildBlockingAreas: Object.freeze([...buildBlockingAreas]),
      }),
    );
  }
  if (verdict === 'NeedsInformation' && buildBlockingAreas.length > 0) {
    return ok<ReadinessDecision>(
      Object.freeze({
        ...base,
        verdict: 'NeedsInformation',
        mayStartBuild: false,
        mayStartInvestigation,
        buildBlockingAreas: Object.freeze([...buildBlockingAreas]),
      }),
    );
  }

  return ok<ReadinessDecision>(
    Object.freeze({
      ...base,
      verdict,
      mayStartBuild: true,
      mayStartInvestigation,
      buildBlockingAreas: Object.freeze([]) as readonly [],
    }),
  );
}

/**
 * What changed for one area between two assessments (F09-AC4).
 *
 * `Reexplained` is separate from `Changed` because a satisfied area whose reason moved
 * has not changed state. Reporting it as `Satisfied -> Satisfied` would read as nothing
 * happened at the one moment a different observation is worth noticing.
 */
export type AreaDelta =
  | { readonly area: ReadinessArea; readonly change: 'Opened'; readonly from: 'Satisfied'; readonly to: Exclude<ReadinessStatus, 'Satisfied'>; readonly reason: string }
  | { readonly area: ReadinessArea; readonly change: 'Resolved'; readonly from: Exclude<ReadinessStatus, 'Satisfied'>; readonly to: 'Satisfied' }
  | { readonly area: ReadinessArea; readonly change: 'Changed'; readonly from: Exclude<ReadinessStatus, 'Satisfied'>; readonly to: Exclude<ReadinessStatus, 'Satisfied'>; readonly reason: string }
  | { readonly area: ReadinessArea; readonly change: 'Reexplained'; readonly status: 'Satisfied'; readonly previousReason: string; readonly reason: string }
  | { readonly area: ReadinessArea; readonly change: 'Unchanged'; readonly status: ReadinessStatus };

/**
 * How the verdict moved, as one case per transition that can happen.
 *
 * An exhaustive set rather than a pair of verdicts, because "the verdict changed" with
 * two arbitrary values in it is a fact a reader has to re-derive; a tagged transition
 * says what happened, and "Ready -> Ready" cannot be spelled.
 */
export type VerdictDelta =
  | { readonly change: 'BecameReady'; readonly from: Exclude<ReadinessVerdict, 'Ready'>; readonly to: 'Ready' }
  | { readonly change: 'NoLongerReady'; readonly from: 'Ready'; readonly to: Exclude<ReadinessVerdict, 'Ready'> }
  | { readonly change: 'Hardened'; readonly from: 'NeedsInformation'; readonly to: 'Blocked' }
  | { readonly change: 'Softened'; readonly from: 'Blocked'; readonly to: 'NeedsInformation' }
  | { readonly change: 'Unchanged'; readonly verdict: ReadinessVerdict };

/**
 * How build permission moved.
 *
 * A tagged transition rather than a boolean pair for the same reason as the verdict:
 * `Lost` is the only way to describe true -> false, so a reader cannot pair the two
 * booleans the wrong way round.
 */
export type BuildPermissionDelta =
  | { readonly permission: 'Gained'; readonly from: false; readonly to: true }
  | { readonly permission: 'Lost'; readonly from: true; readonly to: false }
  | { readonly permission: 'Unchanged'; readonly mayStartBuild: boolean };

export interface AssessmentComparison {
  readonly subjectId: string;
  readonly previousAssessedAt: string;
  readonly currentAssessedAt: string;
  readonly verdict: VerdictDelta;
  readonly buildPermission: BuildPermissionDelta;
  readonly areas: readonly AreaDelta[];
  readonly opened: readonly ReadinessArea[];
  readonly resolved: readonly ReadinessArea[];
  /**
   * The change in words, one line per area that moved.
   *
   * Deliberately free of numbers: a summary that could read "readiness improved by 40%"
   * is exactly the unsupported score F09-AC4 refuses, so no figure reaches it.
   */
  readonly summary: readonly string[];
}

function verdictDelta(previous: ReadinessVerdict, current: ReadinessVerdict): VerdictDelta {
  if (previous === current) return { change: 'Unchanged', verdict: current };
  if (current === 'Ready' && previous !== 'Ready') return { change: 'BecameReady', from: previous, to: 'Ready' };
  if (previous === 'Ready' && current !== 'Ready') return { change: 'NoLongerReady', from: 'Ready', to: current };
  if (current === 'NeedsInformation') return { change: 'Softened', from: 'Blocked', to: 'NeedsInformation' };
  return { change: 'Hardened', from: 'NeedsInformation', to: 'Blocked' };
}

function buildPermissionDelta(previous: boolean, current: boolean): BuildPermissionDelta {
  if (previous === current) return { permission: 'Unchanged', mayStartBuild: current };
  if (current) return { permission: 'Gained', from: false, to: true };
  return { permission: 'Lost', from: true, to: false };
}

function areaDelta(area: ReadinessArea, before: AreaReport, after: AreaReport): AreaDelta {
  if (before.status === after.status && before.reason === after.reason) {
    return { area, change: 'Unchanged', status: after.status };
  }
  if (after.status === 'Satisfied') {
    if (before.status === 'Satisfied') {
      return { area, change: 'Reexplained', status: 'Satisfied', previousReason: before.reason, reason: after.reason };
    }
    return { area, change: 'Resolved', from: before.status, to: 'Satisfied' };
  }
  if (before.status === 'Satisfied') {
    return { area, change: 'Opened', from: 'Satisfied', to: after.status, reason: after.reason };
  }
  return { area, change: 'Changed', from: before.status, to: after.status, reason: after.reason };
}

function describeDelta(delta: AreaDelta): string {
  switch (delta.change) {
    case 'Opened':
      return `${delta.area}: Satisfied -> ${delta.to} (${delta.reason})`;
    case 'Resolved':
      return `${delta.area}: ${delta.from} -> Satisfied`;
    case 'Changed':
      return `${delta.area}: ${delta.from} -> ${delta.to} (${delta.reason})`;
    case 'Reexplained':
      return `${delta.area}: still Satisfied, now "${delta.reason}" rather than "${delta.previousReason}"`;
    case 'Unchanged':
      return `${delta.area}: unchanged`;
  }
}

/**
 * Compares two recorded assessments and returns what changed (F09-AC4).
 *
 * Readiness is a record precisely so that a later assessment has something to differ
 * from. The comparison is refused across subjects because a delta between two unrelated
 * assessments describes nothing.
 */
export function compareAssessments(
  previous: ReadinessDecision,
  current: ReadinessDecision,
): Result<AssessmentComparison, DomainError> {
  if (previous.subjectId !== current.subjectId) {
    return err<DomainError>({
      code: 'Conflict',
      reason: 'These assessments are of different work, so their difference describes nothing.',
      expected: previous.subjectId,
      actual: current.subjectId,
    });
  }

  const areas: AreaDelta[] = READINESS_AREAS.map((area) => areaDelta(area, previous.areas[area], current.areas[area]));

  return ok<AssessmentComparison>(
    Object.freeze({
      subjectId: current.subjectId,
      previousAssessedAt: previous.assessedAt,
      currentAssessedAt: current.assessedAt,
      verdict: verdictDelta(previous.verdict, current.verdict),
      buildPermission: buildPermissionDelta(previous.mayStartBuild, current.mayStartBuild),
      areas: Object.freeze(areas),
      opened: Object.freeze(areas.filter((delta) => delta.change === 'Opened').map((delta) => delta.area)),
      resolved: Object.freeze(areas.filter((delta) => delta.change === 'Resolved').map((delta) => delta.area)),
      summary: Object.freeze(areas.filter((delta) => delta.change !== 'Unchanged').map(describeDelta)),
    }),
  );
}
