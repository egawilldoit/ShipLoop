/**
 * Regression proof for the recorded readiness decision (F09).
 *
 * Readiness is the answer to "can this start without wasting a session", and the two
 * ways it goes wrong in practice are both covered here. A verdict that invents a
 * blocker turns an owner away from work that could have started (F09-AC5). A verdict
 * that treats a status as a delivery, or a "ready" as a standing truth, wastes the
 * session instead (F09-AC3, F09-AC4). The verdict itself comes from the shared
 * `deriveReadiness`, so what is proved here is that every area F09-AC1 names is
 * actually looked at, that the permission to start follows from the areas rather than
 * from a second opinion, and that a change in prerequisites leaves a record of what
 * moved rather than a number.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dependencyAvailable, deriveReadiness } from '../readiness.ts';
import type { ReadinessArea, ReadinessStatus } from '../readiness.ts';
import type { DomainError, Result } from '../result.ts';
import {
  BUILD_REQUIRED_AREAS,
  FORBIDDEN_CONFIDENCE_FIELDS,
  READINESS_AREAS,
  assessReadiness,
  compareAssessments,
  orderedAreas,
} from './readiness.ts';
import type {
  AreaObservation,
  AssessmentComparison,
  AreaReport,
  BlockedReadinessDecision,
  DependencyObservation,
  NeedsInformationReadinessDecision,
  ReadinessDecision,
  ReadinessObservation,
} from './readiness.ts';

const SUBJECT = 'work-1';
const FIRST_ASSESSMENT = '2026-10-01T09:00:00.000Z';
const SECOND_ASSESSMENT = '2026-10-01T10:00:00.000Z';

const AREA_REASON: Readonly<Record<ReadinessArea, string>> = {
  Scope: 'The agreed brief states the behaviour in scope.',
  Criteria: 'Two observable acceptance criteria are recorded.',
  Repository: 'The repository is connected at a known head commit.',
  Target: 'The target is the main branch of that repository.',
  Dependencies: 'No dependency is referenced.',
  Verification: 'The project verification command is configured.',
  Access: 'The engine capability profile permits writing to the workspace.',
};

function satisfied(area: ReadinessArea, reason = AREA_REASON[area]): AreaObservation {
  return { status: 'Satisfied', reason, remedy: null };
}

function open(area: ReadinessArea, status: Exclude<ReadinessStatus, 'Satisfied'>, reason: string): AreaObservation {
  return { status, reason, remedy: `Resolve the ${area.toLowerCase()} gap, then assess again.` };
}

function observation(overrides: Partial<ReadinessObservation> = {}): ReadinessObservation {
  return {
    subjectId: SUBJECT,
    assessedAt: FIRST_ASSESSMENT,
    scope: satisfied('Scope'),
    criteria: satisfied('Criteria'),
    repository: satisfied('Repository'),
    target: satisfied('Target'),
    verification: satisfied('Verification'),
    access: satisfied('Access'),
    dependencies: [],
    investigationSupported: [...READINESS_AREAS],
    ...overrides,
  };
}

function dependency(overrides: Partial<DependencyObservation> = {}): DependencyObservation {
  return { id: 'LIN-7', status: 'Done', releaseReceiptRecorded: true, requiresRelease: false, ...overrides };
}

function unwrap<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    const detail =
      result.error.code === 'Invalid'
        ? result.error.fields.map((field) => `${field.path}: ${field.message}`).join(' | ')
        : result.error.reason;
    assert.fail(`expected the command to succeed, got ${result.error.code}: ${detail}`);
  }
  return result.value;
}

function refuse<T>(result: Result<T, DomainError>): DomainError {
  assert.equal(result.ok, false, 'expected the command to be refused');
  if (result.ok || result.error === undefined) throw new Error('unreachable');
  return result.error;
}

function fieldDetails(error: DomainError): readonly string[] {
  assert.equal(error.code, 'Invalid');
  if (error.code !== 'Invalid') throw new Error('unreachable');
  return error.fields.map((field) => `${field.path}: ${field.message}`);
}

function assessed(input: ReadinessObservation = observation()): ReadinessDecision {
  return unwrap(assessReadiness(input));
}

function areaOf(decision: ReadinessDecision, area: ReadinessArea): AreaReport {
  return decision.areas[area];
}

/*
 * Compile-time structural assertions. Exported so the type checker evaluates them
 * and nothing reports them as unused.
 */
type AreasRecord = ReadinessDecision['areas'];
export const EVERY_NAMED_AREA_IS_REPRESENTED: Exclude<ReadinessArea, keyof AreasRecord> extends never ? true : false = true;

type RecordKeys = keyof AreasRecord;
export const THE_AREA_RECORD_HOLDS_NOTHING_ELSE: Exclude<RecordKeys, ReadinessArea> extends never ? true : false = true;

export const BLOCKED_NEVER_PERMITS_BUILD: BlockedReadinessDecision['mayStartBuild'] extends false ? true : false = true;

type NeedsInformationWithPermission = Extract<NeedsInformationReadinessDecision, { readonly mayStartBuild: true }>;
export const A_STARTABLE_NEEDS_INFORMATION_NAMES_NO_BLOCKING_AREA: NeedsInformationWithPermission['buildBlockingAreas'] extends
  readonly []
  ? true
  : false = true;

type ScoreKeys = 'confidence' | 'confidencePercent' | 'confidenceScore' | 'percentReady' | 'readinessPercent' | 'score';
export const NO_SCORE_FIELD_ON_THE_DECISION: Extract<keyof ReadinessDecision, ScoreKeys> extends never ? true : false = true;
export const NO_SCORE_FIELD_ON_THE_COMPARISON: Extract<keyof AssessmentComparison, ScoreKeys> extends never
  ? true
  : false = true;
export const NO_AREA_REPORT_FIELD_IS_A_NUMBER: Extract<AreaReport[keyof AreaReport], number> extends never
  ? true
  : false = true;
export const NO_DECISION_FIELD_IS_A_NUMBER: Extract<ReadinessDecision[keyof ReadinessDecision], number> extends never
  ? true
  : false = true;

describe('F09-AC1 every area the specification names is assessed, with a reason', () => {
  test('F09-AC1 the assessed areas are exactly the seven F09-AC1 names', () => {
    assert.deepEqual([...READINESS_AREAS], [
      'Scope',
      'Criteria',
      'Repository',
      'Target',
      'Dependencies',
      'Verification',
      'Access',
    ]);
    assert.equal(EVERY_NAMED_AREA_IS_REPRESENTED, true);
    assert.equal(THE_AREA_RECORD_HOLDS_NOTHING_ELSE, true);
  });

  test('F09-AC1 a decision reports every area with the reason it stands where it does', () => {
    const areas = orderedAreas(assessed());

    assert.deepEqual(areas.map((area) => area.area), [...READINESS_AREAS]);
    for (const area of areas) {
      assert.equal(area.reason.trim().length > 0, true, `${area.area} must carry a reason`);
    }
  });

  test('F09-AC1 an area is not one of the report, because a report can be short', () => {
    const decision = assessed(
      observation({
        subjectId: 'work-2',
        access: open('Access', 'Unmet', 'The engine capability profile permits no writes.'),
      }),
    );

    assert.equal(Object.keys(decision.areas).includes('Dependencies'), true);
    assert.equal(decision.areas.Dependencies.status, 'Satisfied');
  });

  test('F09-AC1 an open area is a finding and a satisfied area is not', () => {
    const decision = assessed(
      observation({
        subjectId: 'work-3',
        repository: open('Repository', 'Unknown', 'The repository has not been read yet.'),
        access: open('Access', 'Unmet', 'The engine capability profile permits no writes.'),
      }),
    );

    assert.deepEqual(decision.findings.map((finding) => finding.area), ['Repository', 'Access']);
    assert.deepEqual(decision.reasons.map((reason) => reason.status), ['Unknown', 'Unmet']);
    assert.equal(decision.findings.every((finding) => (finding.remedy ?? '').trim().length > 0), true);
  });

  test('F09-AC1 an observation that omits an area is refused, naming the area to observe', () => {
    const raw: Record<string, unknown> = { ...observation() };
    delete raw['access'];

    const details = fieldDetails(refuse(assessReadiness(raw)));

    assert.deepEqual(
      details.filter((detail) => detail.startsWith('access')),
      ['access: The access area must carry a status and a reason (F09-AC1).'],
    );
  });

  test('F09-AC1 an area observed without a reason is refused, naming the field', () => {
    const raw: Record<string, unknown> = { ...observation(), target: { status: 'Satisfied', remedy: null } };

    assert.deepEqual(
      fieldDetails(refuse(assessReadiness(raw))).filter((detail) => detail.startsWith('target.reason')),
      ['target.reason: The target area must state a reason (F09-AC1).'],
    );
  });

  test('F09-AC1 an open area observed with no remedy is refused, because there is nothing to act on', () => {
    const raw: Record<string, unknown> = {
      ...observation(),
      access: { status: 'Unmet', reason: 'The engine capability profile permits no writes.', remedy: null },
    };

    assert.match(
      fieldDetails(refuse(assessReadiness(raw))).join(' '),
      /An open access area must name a remedy, or the owner has nothing to act on\./,
    );
  });

  test('F09-AC1 an area status outside the three known ones is refused by name', () => {
    const raw: Record<string, unknown> = { ...observation(), scope: { status: 'Probably', reason: 'Looks fine.', remedy: null } };

    assert.match(fieldDetails(refuse(assessReadiness(raw))).join(' '), /The scope status is one of Satisfied, Unmet, Unknown\./);
  });

  test('F09-AC1 an observation carrying a field the decision does not have is refused', () => {
    const raw: Record<string, unknown> = { ...observation(), lastCheckedAt: FIRST_ASSESSMENT };

    assert.match(fieldDetails(refuse(assessReadiness(raw))).join(' '), /A readiness observation has no field "lastCheckedAt"\./);
  });

  test('F09-AC1 an observation with no subject or no time is refused', () => {
    const noSubject: Record<string, unknown> = { ...observation(), subjectId: '  ' };
    const noTime: Record<string, unknown> = { ...observation(), assessedAt: '' };

    assert.match(fieldDetails(refuse(assessReadiness(noSubject))).join(' '), /An assessment must name the work it assesses\./);
    assert.match(fieldDetails(refuse(assessReadiness(noTime))).join(' '), /An assessment must record when it was made\./);
  });

  test('F09-AC1 the verdict is the shared one, not a second opinion held here', () => {
    const blocked = assessed(
      observation({ subjectId: 'work-4', access: open('Access', 'Unmet', 'The engine capability profile permits no writes.') }),
    );
    const unknown = assessed(
      observation({ subjectId: 'work-5', target: open('Target', 'Unknown', 'The target branch has not been resolved.') }),
    );

    assert.equal(blocked.verdict, deriveReadiness(blocked.findings));
    assert.equal(unknown.verdict, deriveReadiness(unknown.findings));
  });
});

describe('F09-AC2 build is disabled by an absent prerequisite while investigation stays possible', () => {
  const BLOCKED_BY_ACCESS = observation({
    subjectId: 'work-blocked',
    access: open('Access', 'Unmet', 'The engine capability profile permits no writes.'),
  });

  test('F09-AC2 an Unmet required area blocks the build and names the area', () => {
    const decision = assessed(BLOCKED_BY_ACCESS);

    assert.equal(decision.verdict, 'Blocked');
    assert.equal(decision.mayStartBuild, false);
    assert.deepEqual([...decision.buildBlockingAreas], ['Access']);
    assert.equal(BLOCKED_NEVER_PERMITS_BUILD, true);
  });

  test('F09-AC2 a Blocked verdict still permits the read-only investigation that resolves it', () => {
    const decision = assessed(BLOCKED_BY_ACCESS);

    assert.equal(decision.mayStartInvestigation, true);
    assert.equal(decision.mayStartBuild, false);
  });

  test('F09-AC2 investigation is refused only where read-only work cannot resolve the open area', () => {
    const decision = assessed({ ...BLOCKED_BY_ACCESS, investigationSupported: ['Repository'] });

    assert.equal(decision.mayStartInvestigation, false);
    assert.equal(decision.mayStartBuild, false);
  });

  test('F09-AC2 an Unknown required area asks for information and does not permit a build', () => {
    const decision = assessed(
      observation({ subjectId: 'work-unknown', scope: open('Scope', 'Unknown', 'The scope of the change is not settled.') }),
    );

    assert.equal(decision.verdict, 'NeedsInformation');
    assert.equal(decision.mayStartBuild, false);
    assert.deepEqual([...decision.buildBlockingAreas], ['Scope']);
  });

  test('F09-AC2 an undecided verification method does not stop a build, because it blocks completion instead', () => {
    const decision = assessed(
      observation({
        subjectId: 'work-verification',
        verification: open('Verification', 'Unknown', 'No verification command has been chosen yet.'),
      }),
    );

    assert.equal(decision.verdict, 'NeedsInformation');
    assert.equal(decision.mayStartBuild, true);
    assert.deepEqual([...decision.buildBlockingAreas], []);
    assert.equal(BUILD_REQUIRED_AREAS.includes('Verification'), false);
    assert.equal(A_STARTABLE_NEEDS_INFORMATION_NAMES_NO_BLOCKING_AREA, true);
  });

  test('F09-AC2 an undecided required area is what stops a build, and verification is not one of them', () => {
    for (const area of READINESS_AREAS) {
      if (area === 'Dependencies') continue;
      const decision = assessed(
        observation({
          subjectId: `work-${area}`,
          [area.toLowerCase()]: open(area, 'Unknown', `The ${area.toLowerCase()} is not settled.`),
        }),
      );

      assert.equal(decision.mayStartBuild, !BUILD_REQUIRED_AREAS.includes(area), `${area} must gate the build`);
      assert.deepEqual([...decision.buildBlockingAreas], BUILD_REQUIRED_AREAS.includes(area) ? [area] : []);
    }
  });

  test('F09-AC2 a known-absent area blocks the build whatever its name, because Unmet outranks the area list', () => {
    for (const area of READINESS_AREAS) {
      if (area === 'Dependencies') continue;
      const decision = assessed(
        observation({
          subjectId: `work-unmet-${area}`,
          [area.toLowerCase()]: open(area, 'Unmet', `The ${area.toLowerCase()} is absent.`),
        }),
      );

      assert.equal(decision.verdict, 'Blocked');
      assert.equal(decision.mayStartBuild, false, `${area} absent must not permit a build`);
    }
  });

  test('F09-AC2 a decision states both permissions whatever the verdict', () => {
    for (const input of [
      observation(),
      BLOCKED_BY_ACCESS,
      observation({ subjectId: 'work-v', verification: open('Verification', 'Unknown', 'Not chosen yet.') }),
    ]) {
      const decision = assessed(input);
      assert.equal(typeof decision.mayStartBuild, 'boolean');
      assert.equal(typeof decision.mayStartInvestigation, 'boolean');
    }
  });
});

describe('F09-AC3 a Done dependency is not a delivery', () => {
  test('F09-AC3 a Done dependency with no release receipt is unmet when the release is required', () => {
    const decision = assessed(
      observation({
        subjectId: 'work-release',
        dependencies: [dependency({ requiresRelease: true, releaseReceiptRecorded: false })],
      }),
    );

    assert.equal(decision.verdict, 'Blocked');
    assert.equal(decision.mayStartBuild, false);
    assert.deepEqual([...decision.buildBlockingAreas], ['Dependencies']);
    assert.match(areaOf(decision, 'Dependencies').reason, /LIN-7: .*no release receipt/);
  });

  test('F09-AC3 the same dependency is satisfied once the receipt exists', () => {
    const decision = assessed(
      observation({
        subjectId: 'work-released',
        dependencies: [dependency({ requiresRelease: true, releaseReceiptRecorded: true })],
      }),
    );

    assert.equal(decision.verdict, 'Ready');
    assert.equal(areaOf(decision, 'Dependencies').status, 'Satisfied');
  });

  test('F09-AC3 a Done dependency that needs no release is available without a receipt', () => {
    const decision = assessed(
      observation({
        subjectId: 'work-no-release',
        dependencies: [dependency({ requiresRelease: false, releaseReceiptRecorded: false })],
      }),
    );

    assert.equal(decision.verdict, 'Ready');
  });

  test('F09-AC3 a canceled or unfinished dependency is unmet whatever the receipt says', () => {
    const canceled = assessed(
      observation({ subjectId: 'work-canceled', dependencies: [dependency({ status: 'Canceled', requiresRelease: true })] }),
    );
    const running = assessed(
      observation({ subjectId: 'work-running', dependencies: [dependency({ status: 'InProgress', requiresRelease: true })] }),
    );

    assert.equal(canceled.verdict, 'Blocked');
    assert.equal(running.verdict, 'Blocked');
    assert.match(areaOf(canceled, 'Dependencies').reason, /canceled/);
    assert.match(areaOf(running, 'Dependencies').reason, /InProgress/);
  });

  test('F09-AC3 the area reason is the one the shared availability rule gives, not a rewrite', () => {
    const observed = dependency({ requiresRelease: true, releaseReceiptRecorded: false });
    const shared = dependencyAvailable(observed);
    const decision = assessed(observation({ subjectId: 'work-shared', dependencies: [observed] }));

    assert.equal(areaOf(decision, 'Dependencies').reason.includes(shared.reason), true);
  });

  test('F09-AC3 work with no referenced dependency says so rather than reporting a gap', () => {
    const decision = assessed(observation({ subjectId: 'work-alone' }));

    assert.equal(areaOf(decision, 'Dependencies').status, 'Satisfied');
    assert.match(areaOf(decision, 'Dependencies').reason, /No dependency is referenced/);
  });

  test('F09-AC3 every unavailable dependency is named in the reason', () => {
    const decision = assessed(
      observation({
        subjectId: 'work-many',
        dependencies: [
          dependency({ id: 'LIN-1', status: 'Todo', requiresRelease: false }),
          dependency({ id: 'LIN-2', status: 'Done', requiresRelease: true, releaseReceiptRecorded: false }),
        ],
      }),
    );
    const reason = areaOf(decision, 'Dependencies').reason;

    assert.equal(reason.includes('LIN-1'), true);
    assert.equal(reason.includes('LIN-2'), true);
  });

  test('F09-AC3 a dependency observation with a status or flag that is not one of the known ones is refused', () => {
    const badStatus: Record<string, unknown> = {
      ...observation(),
      dependencies: [{ id: 'LIN-7', status: 'Shipped', releaseReceiptRecorded: true, requiresRelease: false }],
    };
    const badFlag: Record<string, unknown> = {
      ...observation(),
      dependencies: [{ id: 'LIN-7', status: 'Done', releaseReceiptRecorded: 'yes', requiresRelease: false }],
    };

    assert.match(fieldDetails(refuse(assessReadiness(badStatus))).join(' '), /A dependency status is one of Done, InProgress, Todo, Canceled\./);
    assert.match(fieldDetails(refuse(assessReadiness(badFlag))).join(' '), /"releaseReceiptRecorded" must state whether it holds\./);
  });
});

describe('F09-AC4 a new assessment records what changed', () => {
  const READY = observation({ subjectId: 'work-compare' });
  const BLOCKED_BY_ACCESS = observation({
    subjectId: 'work-compare',
    access: open('Access', 'Unmet', 'The engine capability profile permits no writes.'),
  });
  const BLOCKED_BY_REPOSITORY = observation({
    subjectId: 'work-compare',
    repository: open('Repository', 'Unmet', 'The repository is not connected.'),
  });
  const UNKNOWN_TARGET = observation({
    subjectId: 'work-compare',
    target: open('Target', 'Unknown', 'The target branch has not been resolved.'),
  });

  test('F09-AC4 an area that opened is reported as opened, with the reason', () => {
    const comparison = unwrap(compareAssessments(assessed(READY), assessed(BLOCKED_BY_ACCESS)));

    assert.deepEqual([...comparison.opened], ['Access']);
    assert.deepEqual([...comparison.resolved], []);
    const access = comparison.areas.find((delta) => delta.area === 'Access');
    assert.equal(access?.change, 'Opened');
    if (access?.change !== 'Opened') throw new Error('unreachable');
    assert.equal(access.from, 'Satisfied');
    assert.equal(access.to, 'Unmet');
    assert.equal(access.reason, 'The engine capability profile permits no writes.');
  });

  test('F09-AC4 an area that resolved is reported as resolved, with what it was', () => {
    const comparison = unwrap(compareAssessments(assessed(BLOCKED_BY_ACCESS), assessed(READY)));

    assert.deepEqual([...comparison.resolved], ['Access']);
    const access = comparison.areas.find((delta) => delta.area === 'Access');
    assert.equal(access?.change, 'Resolved');
    if (access?.change !== 'Resolved') throw new Error('unreachable');
    assert.equal(access.from, 'Unmet');
  });

  test('F09-AC4 the verdict delta names the transition, so Ready to Ready cannot be spelled', () => {
    const same = unwrap(compareAssessments(assessed(READY), assessed(READY)));
    const ready = unwrap(compareAssessments(assessed(BLOCKED_BY_ACCESS), assessed(READY)));
    const blocked = unwrap(compareAssessments(assessed(READY), assessed(BLOCKED_BY_ACCESS)));
    const hardened = unwrap(compareAssessments(assessed(UNKNOWN_TARGET), assessed(BLOCKED_BY_REPOSITORY)));
    const softened = unwrap(compareAssessments(assessed(BLOCKED_BY_REPOSITORY), assessed(UNKNOWN_TARGET)));

    assert.deepEqual(same.verdict, { change: 'Unchanged', verdict: 'Ready' });
    assert.deepEqual(ready.verdict, { change: 'BecameReady', from: 'Blocked', to: 'Ready' });
    assert.deepEqual(blocked.verdict, { change: 'NoLongerReady', from: 'Ready', to: 'Blocked' });
    assert.deepEqual(hardened.verdict, { change: 'Hardened', from: 'NeedsInformation', to: 'Blocked' });
    assert.deepEqual(softened.verdict, { change: 'Softened', from: 'Blocked', to: 'NeedsInformation' });
  });

  test('F09-AC4 the build permission delta names the transition', () => {
    const lost = unwrap(compareAssessments(assessed(READY), assessed(BLOCKED_BY_ACCESS)));
    const gained = unwrap(compareAssessments(assessed(BLOCKED_BY_ACCESS), assessed(READY)));
    const unchanged = unwrap(compareAssessments(assessed(READY), assessed(READY)));

    assert.deepEqual(lost.buildPermission, { permission: 'Lost', from: true, to: false });
    assert.deepEqual(gained.buildPermission, { permission: 'Gained', from: false, to: true });
    assert.deepEqual(unchanged.buildPermission, { permission: 'Unchanged', mayStartBuild: true });
  });

  test('F09-AC4 a satisfied area whose reason moved is reexplained, not reported as no change', () => {
    const moved = observation({ subjectId: 'work-compare', target: satisfied('Target', 'The target is release, not main.') });
    const comparison = unwrap(compareAssessments(assessed(READY), assessed(moved)));
    const target = comparison.areas.find((delta) => delta.area === 'Target');

    assert.equal(target?.change, 'Reexplained');
    if (target?.change !== 'Reexplained') throw new Error('unreachable');
    assert.equal(target.previousReason, AREA_REASON.Target);
    assert.equal(comparison.summary.join(' ').includes('Satisfied -> Satisfied'), false);
    assert.match(comparison.summary.join(' '), /still Satisfied/);
  });

  test('F09-AC4 an area that stayed at one status with a new reason is a change between open statuses', () => {
    const before = assessmentWithAccess('Unmet', 'The engine capability profile permits no writes.');
    const after = assessmentWithAccess('Unknown', 'The capability profile has not been read.');
    const comparison = unwrap(compareAssessments(before, after));
    const access = comparison.areas.find((delta) => delta.area === 'Access');

    assert.equal(access?.change, 'Changed');
    if (access?.change !== 'Changed') throw new Error('unreachable');
    assert.equal(access.from, 'Unmet');
    assert.equal(access.to, 'Unknown');
  });

  test('F09-AC4 the summary has one line per area that moved and names no figure', () => {
    const comparison = unwrap(compareAssessments(assessed(READY), assessed(BLOCKED_BY_ACCESS)));

    assert.deepEqual([...comparison.summary], [
      'Access: Satisfied -> Unmet (The engine capability profile permits no writes.)',
    ]);
    for (const line of comparison.summary) {
      assert.equal(/\d/.test(line), false, `"${line}" must carry no number`);
    }
  });

  test('F09-AC4 two identical assessments produce no change at all', () => {
    const comparison = unwrap(compareAssessments(assessed(READY), assessed(READY)));

    assert.deepEqual([...comparison.summary], []);
    assert.deepEqual([...comparison.opened], []);
    assert.deepEqual([...comparison.resolved], []);
    assert.equal(comparison.areas.every((delta) => delta.change === 'Unchanged'), true);
  });

  test('F09-AC4 a comparison across two different works is refused', () => {
    const error = refuse(compareAssessments(assessed(READY), assessed(observation({ subjectId: 'work-other' }))));

    assert.equal(error.code, 'Conflict');
    assert.equal(error.expected, 'work-compare');
    assert.equal(error.actual, 'work-other');
  });

  test('F09-AC4 the comparison names which two assessments it differs', () => {
    const comparison = unwrap(
      compareAssessments(assessed(READY), assessed({ ...BLOCKED_BY_ACCESS, assessedAt: SECOND_ASSESSMENT })),
    );

    assert.equal(comparison.previousAssessedAt, FIRST_ASSESSMENT);
    assert.equal(comparison.currentAssessedAt, SECOND_ASSESSMENT);
    assert.equal(comparison.subjectId, 'work-compare');
  });

  test('F09-AC4 the same observation produces the same digest, and a different one does not', () => {
    const first = assessed(READY);
    const again = assessed(READY);
    const different = assessed(observation({ subjectId: SUBJECT, assessedAt: SECOND_ASSESSMENT }));

    assert.equal(first.observationDigest, again.observationDigest);
    assert.notEqual(first.observationDigest, different.observationDigest);
  });

  test('F09-AC4 a recorded decision is frozen, so nothing can revise what was assessed', () => {
    const decision = assessed(BLOCKED_BY_ACCESS);

    assert.equal(Object.isFrozen(decision), true);
    assert.equal(Object.isFrozen(decision.areas), true);
    assert.equal(Object.isFrozen(decision.findings), true);
  });
});

function assessmentWithAccess(status: Exclude<ReadinessStatus, 'Satisfied'>, reason: string): ReadinessDecision {
  return assessed(observation({ subjectId: 'work-compare', access: open('Access', status, reason) }));
}

describe('F09-AC4 readiness is not a percentage confidence score', () => {
  test('F09-AC4 no score field is representable on the decision or its comparison', () => {
    assert.equal(NO_SCORE_FIELD_ON_THE_DECISION, true);
    assert.equal(NO_SCORE_FIELD_ON_THE_COMPARISON, true);
    assert.equal(NO_AREA_REPORT_FIELD_IS_A_NUMBER, true);
    assert.equal(NO_DECISION_FIELD_IS_A_NUMBER, true);
  });

  test('F09-AC4 a score field on the observation is refused rather than dropped', () => {
    for (const key of FORBIDDEN_CONFIDENCE_FIELDS) {
      const raw: Record<string, unknown> = { ...observation(), [key]: 82 };
      assert.match(
        fieldDetails(refuse(assessReadiness(raw))).join(' '),
        new RegExp(`"${key}" is not a readiness field: readiness is a recorded judgement, not a percentage confidence score \\(F09-AC4\\)`),
      );
    }
  });

  test('F09-AC4 a score smuggled into an area observation is refused there too', () => {
    const raw: Record<string, unknown> = {
      ...observation(),
      scope: { status: 'Unknown', reason: 'The scope is not settled.', remedy: 'Ask the owner.', confidence: 0.6 },
    };

    assert.match(fieldDetails(refuse(assessReadiness(raw))).join(' '), /scope\.confidence: "confidence" is not a readiness field/);
  });

  test('F09-AC4 the recorded verdict is one of the three words the specification allows', () => {
    for (const input of [
      observation(),
      observation({ subjectId: 'work-a', access: open('Access', 'Unmet', 'No writes permitted.') }),
      observation({ subjectId: 'work-b', target: open('Target', 'Unknown', 'Branch unresolved.') }),
    ]) {
      assert.deepEqual(['Ready', 'NeedsInformation', 'Blocked'].includes(assessed(input).verdict), true);
    }
  });
});

describe('F09-AC5 a complete small task is Ready without a fabricated blocker', () => {
  test('F09-AC5 a complete, accessible, unblocked small task is Ready with no findings', () => {
    const decision = assessed(observation({ subjectId: 'work-small' }));

    assert.equal(decision.verdict, 'Ready');
    assert.deepEqual(decision.findings, []);
    assert.deepEqual(decision.reasons, []);
    assert.deepEqual([...decision.buildBlockingAreas], []);
    assert.equal(decision.mayStartBuild, true);
  });

  test('F09-AC5 all seven areas are reported as satisfied on that decision', () => {
    const areas = orderedAreas(assessed(observation({ subjectId: 'work-small' })));

    assert.equal(areas.every((area) => area.status === 'Satisfied'), true);
    assert.equal(areas.every((area) => area.remedy === null), true);
    assert.equal(areas.every((area) => area.reason.trim().length > 0), true);
  });

  test('F09-AC5 one unmet area produces exactly one finding, not a list of consequences', () => {
    const decision = assessed(
      observation({ subjectId: 'work-one-gap', access: open('Access', 'Unmet', 'The engine capability profile permits no writes.') }),
    );

    assert.equal(decision.findings.length, 1);
    assert.equal(decision.reasons.length, 1);
  });
});
