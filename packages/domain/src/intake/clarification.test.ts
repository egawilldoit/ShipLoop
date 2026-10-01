/**
 * Regression proof for clarification (F07-AC2, F07-AC3, F07-AC4, F07-AC5).
 *
 * The failure modes here are conversational and therefore easy to introduce by
 * accident. An interview the owner already sat through, a correction that edits
 * the brief in place so the previous reasoning cannot be re-read, a confident
 * claim about code that was never inspected, and a capability profile that quietly
 * grew a write. Each test names the criterion it protects.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CapabilityKind } from '../capability.ts';
import type { CommitSha, IdeaId } from '../ids.ts';
import { asCommitSha } from '../ids.ts';
import type { DomainError } from '../result.ts';
import type { Brief, BriefProposal, BriefSections } from './brief.ts';
import { agreeBrief, applyProposal, bindProposalToRequest, isObservable } from './brief.ts';
import { createIdea } from './idea.ts';
import {
  CLARIFICATION_CAPABILITIES,
  MUTATING_CAPABILITIES,
  applyCorrection,
  assessMateriality,
  codeGroundedClaim,
  generateClarifyingQuestions,
  isMaterial,
  isMutatingCapability,
  rawRequestOf,
  readOnlyCapabilityProfile,
} from './clarification.ts';
import type {
  Ambiguity,
  ClarificationConversation,
  ClarificationInput,
  CodeClaim,
  OwnerCorrection,
  ReadOnlyCapability,
} from './clarification.ts';

const CAPTURED_AT = '2026-09-30T09:00:00.000Z';
const ASKED_AT = '2026-09-30T10:00:00.000Z';
const CORRECTED_AT = '2026-09-30T12:00:00.000Z';
const OWNER = 'owner-1';
const BRIEF_ID = 'brief-1';
const RAW_REQUEST = 'Signing in with a valid account returns a 500';

const REVISION: CommitSha = asCommitSha('0123456789abcdef0123456789abcdef01234567');
const OTHER_REVISION: CommitSha = asCommitSha('fedcba9876543210fedcba9876543210fedcba98');

function ideaId(value: string): IdeaId {
  return value as IdeaId;
}

const COMPLETE_SECTIONS: BriefSections = {
  problem: RAW_REQUEST,
  desiredOutcome: 'A valid owner can sign in and reach the workspace.',
  includedBehaviour: ['A valid account receives a session cookie.'],
  excludedBehaviour: ['Password reset is out of scope.'],
  assumptions: ['The owner project already stores sessions server-side.'],
  acceptanceCriteria: [
    { id: 'ac-1', text: 'sign-in completes in under 2s at p95', verification: 'Timed browser run.' },
    { id: 'ac-2', text: 'the failure case returns 500 and the session is not created', verification: 'Browser evidence.' },
  ],
  unresolvedQuestions: [],
};

const FAILURE_CASE_CRITERION = COMPLETE_SECTIONS.acceptanceCriteria[1];
assert.ok(FAILURE_CASE_CRITERION !== undefined, 'the fixture brief must carry a failure-case criterion');

const VAGUE_SECTIONS: BriefSections = {
  ...COMPLETE_SECTIONS,
  acceptanceCriteria: [{ id: 'ac-1', text: 'sign-in is fast', verification: null }],
};

function proposal(sections: BriefSections, basedOnBriefVersion: number | null = null): BriefProposal {
  return {
    kind: 'BriefProposal',
    ideaId: ideaId('idea-1'),
    authoredBy: 'ClarificationModel',
    authoredAt: ASKED_AT,
    basedOnBriefVersion,
    sections,
  };
}

function validated(input: BriefProposal) {
  const result = applyProposal(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function brief(sections: BriefSections = COMPLETE_SECTIONS): Brief {
  const result = bindProposalToRequest({
    briefId: BRIEF_ID,
    ideaId: ideaId('idea-1'),
    rawRequest: RAW_REQUEST,
    proposal: validated(proposal(sections)),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function conversation(): ClarificationConversation {
  return {
    conversationId: 'conversation-1',
    ideaId: ideaId('idea-1'),
    turns: [{ kind: 'RawRequest', at: CAPTURED_AT, text: RAW_REQUEST }],
  };
}

function clarificationInput(overrides: Partial<ClarificationInput> = {}): ClarificationInput {
  return {
    briefId: BRIEF_ID,
    ideaId: ideaId('idea-1'),
    sections: COMPLETE_SECTIONS,
    ambiguities: [],
    ...overrides,
  };
}

const MATERIAL_AMBIGUITY: Ambiguity = {
  kind: 'UnspecifiedSubject',
  topic: 'which session store the sign-in flow should use',
  readings: ['the existing cookie session', 'a new server-side session table'],
  answeredBy: [],
  impact: 'ChangesBehaviour',
  evidence: 'The request says only that sign-in returns a 500.',
};

function refuse(result: { readonly ok: boolean; readonly error?: DomainError }): DomainError {
  assert.equal(result.ok, false, 'expected the command to be refused');
  if (result.ok || result.error === undefined) throw new Error('unreachable');
  return result.error;
}

/*
 * Compile-time structural assertions, exported so the type checker evaluates them.
 */
type ReadOnlyExcludesMutating = Extract<(typeof MUTATING_CAPABILITIES)[number], ReadOnlyCapability> extends never
  ? true
  : false;
export const READ_ONLY_CAPABILITY_EXCLUDES_EVERY_MUTATING_KIND: ReadOnlyExcludesMutating = true;

type ProfileMutatingKey = Extract<keyof typeof readOnlyCapabilityProfile, 'writes' | 'mutatingCapabilities' | 'sideEffects'>;
export const PROFILE_HAS_NO_MUTATING_CAPABILITY_FIELD: ProfileMutatingKey extends never ? true : false = true;

type ClaimKeys = keyof ReturnType<typeof codeGroundedClaim>;
export const UNKNOWN_IS_REPRESENTABLE: Extract<
  ClaimKeys,
  'state' | 'unknowns' | 'reason' | 'revision'
> extends 'state' | 'unknowns' | 'reason' | 'revision'
  ? true
  : false = true;

describe('material ambiguity', () => {
  test('F07-AC2 - a supplied complete request produces zero clarifying questions', () => {
    const round = generateClarifyingQuestions(clarificationInput());

    assert.deepEqual(round.questions, []);
    assert.deepEqual(round.rejected, []);
  });

  test('F07-AC2 - a material ambiguity with two open readings produces exactly one question', () => {
    const round = generateClarifyingQuestions(clarificationInput({ ambiguities: [MATERIAL_AMBIGUITY] }));

    assert.equal(round.questions.length, 1);
    const [question] = round.questions;
    assert.ok(question !== undefined);
    assert.equal(question.origin, 'Ambiguity');
    assert.equal(question.topic, MATERIAL_AMBIGUITY.topic);
    assert.deepEqual(question.readings, MATERIAL_AMBIGUITY.readings);
    assert.match(question.prompt, /which is intended/);
    assert.deepEqual(round.rejected, []);
  });

  test('F07-AC2 - a question about something the request already answered is rejected', () => {
    const answered: Ambiguity = {
      ...MATERIAL_AMBIGUITY,
      topic: 'how long operational logs are retained',
      readings: ['30 days', '90 days'],
      answeredBy: ['The request says operational logs are retained for 30 days.'],
      impact: 'ChangesAcceptance',
    };

    const verdict = assessMateriality(answered);
    const round = generateClarifyingQuestions(clarificationInput({ ambiguities: [answered] }));

    assert.equal(isMaterial(answered), false);
    assert.equal(verdict.material, false);
    assert.equal(verdict.material === false ? verdict.rejection : null, 'AlreadyAnswered');
    assert.deepEqual(round.questions, []);
    assert.deepEqual(round.rejected.map((entry) => entry.topic), ['how long operational logs are retained']);
    assert.match(round.rejected[0]?.explanation ?? '', /already answers what could be asked/);
  });

  test('F07-AC2 - one reading is not an ambiguity, so nothing is asked', () => {
    const single: Ambiguity = { ...MATERIAL_AMBIGUITY, readings: ['the existing cookie session'] };

    const round = generateClarifyingQuestions(clarificationInput({ ambiguities: [single] }));

    assert.equal(isMaterial(single), false);
    assert.deepEqual(round.questions, []);
    assert.equal(round.rejected[0]?.rejection, 'SingleReading');
  });

  test('F07-AC2 - a cosmetic ambiguity is not worth the owner asking about', () => {
    const cosmetic: Ambiguity = { ...MATERIAL_AMBIGUITY, impact: 'Cosmetic' };

    const round = generateClarifyingQuestions(clarificationInput({ ambiguities: [cosmetic] }));

    assert.equal(isMaterial(cosmetic), false);
    assert.equal(round.rejected[0]?.rejection, 'CosmeticOnly');
    assert.deepEqual(round.questions, []);
  });

  test('F07-AC2 - an ambiguity with no quoted request evidence or no topic is refused', () => {
    const unevidenced: Ambiguity = { ...MATERIAL_AMBIGUITY, evidence: '  ' };
    const untopiced: Ambiguity = { ...MATERIAL_AMBIGUITY, topic: '' };

    const unevidencedVerdict = assessMateriality(unevidenced);
    const untopicedVerdict = assessMateriality(untopiced);

    assert.equal(unevidencedVerdict.material, false);
    assert.equal(untopicedVerdict.material, false);
    if (!unevidencedVerdict.material) assert.equal(unevidencedVerdict.rejection, 'NoEvidence');
    if (!untopicedVerdict.material) assert.equal(untopicedVerdict.rejection, 'NoTopic');
  });

  test('F07-AC1, F07-AC2 - an unobservable acceptance criterion is itself a material question', () => {
    const round = generateClarifyingQuestions(clarificationInput({ sections: VAGUE_SECTIONS }));

    assert.equal(round.questions.length, 1);
    const [question] = round.questions;
    assert.ok(question !== undefined);
    assert.equal(question.origin, 'UnobservableCriterion');
    assert.equal(question.topic, 'acceptanceCriteria.ac-1');
    assert.match(question.prompt, /cannot be checked/);
    assert.match(question.whyMaterial, /without a target/);
  });

  test('F07-AC2 - clarification reads proposed sections, because a validated brief cannot hold a vague criterion', () => {
    assert.equal(isObservable(VAGUE_SECTIONS.acceptanceCriteria[0]?.text ?? ''), false);
    assert.equal(refuse(applyProposal(proposal(VAGUE_SECTIONS))).code, 'Invalid');
  });

  test('F07-AC2 - one question is produced per topic even when both sources raise it', () => {
    const round = generateClarifyingQuestions(
      clarificationInput({
        sections: VAGUE_SECTIONS,
        ambiguities: [
          {
            ...MATERIAL_AMBIGUITY,
            topic: 'acceptanceCriteria.ac-1',
            readings: ['under 500ms', 'under 2s'],
          },
        ],
      }),
    );

    assert.equal(round.questions.length, 1);
    assert.equal(round.questions[0]?.origin, 'Ambiguity');
  });

  test('F07-AC2 - materiality is a pure function of the ambiguity it is given', () => {
    assert.deepEqual(assessMateriality(MATERIAL_AMBIGUITY), assessMateriality(MATERIAL_AMBIGUITY));
    assert.equal(isMaterial(MATERIAL_AMBIGUITY), true);
  });
});

describe('owner corrections', () => {
  const correctedSections: BriefSections = {
    ...COMPLETE_SECTIONS,
    acceptanceCriteria: [{ id: 'ac-2', text: 'the failure case returns 500 and the session is not created', verification: 'Browser evidence.' }],
  };

  function correction(overrides: Partial<OwnerCorrection> = {}): OwnerCorrection {
    return {
      correctionId: 'correction-1',
      text: 'Only the failing case is in scope; drop the latency criterion.',
      at: CORRECTED_AT,
      proposal: proposal(correctedSections, 1),
      ...overrides,
    };
  }

  test('F07-AC3 - a correction appends a new brief version and leaves the prior one readable', () => {
    const first = brief();
    const result = applyCorrection(conversation(), first, correction());

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.brief.version, 2);
    assert.equal(result.value.brief.supersedesVersion, 1);
    assert.equal(result.value.brief.state, 'Proposed');
    assert.equal(result.value.priorBrief.version, 1);
    assert.equal(result.value.priorBrief.state, 'Proposed');
    assert.deepEqual(
      result.value.priorBrief.sections.acceptanceCriteria.map((entry) => entry.id),
      ['ac-1', 'ac-2'],
    );
    assert.deepEqual(
      result.value.brief.sections.acceptanceCriteria.map((entry) => entry.id),
      ['ac-2'],
    );
    assert.deepEqual(result.value.withdrawnCriteria, ['ac-1']);
  });

  test('F07-AC3 - the correction stays in the conversation and earlier turns are untouched', () => {
    const before = conversation();
    const result = applyCorrection(before, brief(), correction());

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    const turns = result.value.conversation.turns;

    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.kind, 'RawRequest');
    assert.equal(rawRequestOf(result.value.conversation), RAW_REQUEST);
    assert.deepEqual(before.turns.length, 1, 'the caller\'s conversation must not be mutated in place');

    const appended = turns[1];
    assert.equal(appended?.kind, 'Correction');
    if (appended?.kind !== 'Correction') throw new Error('unreachable');
    assert.equal(appended.text, 'Only the failing case is in scope; drop the latency criterion.');
    assert.equal(appended.briefVersion, 2);
  });

  test('F07-AC3 - the corrected brief still fingerprints the original raw request', () => {
    const result = applyCorrection(conversation(), brief(), correction());

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.brief.rawRequestFingerprint, brief().rawRequestFingerprint);
  });

  test('F07-AC3 - correcting an agreed brief reopens it, and the agreed version stays readable', () => {
    const agreed = agreeBrief(brief(), { agreedBy: OWNER, at: ASKED_AT });
    assert.equal(agreed.ok, true);
    if (!agreed.ok) throw new Error('unreachable');

    const result = applyCorrection(conversation(), agreed.value, correction());

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.brief.state, 'Proposed');
    assert.equal(result.value.priorBrief.state, 'Agreed');
    assert.equal(result.value.priorBrief.state === 'Agreed' ? result.value.priorBrief.agreedBy : null, OWNER);
  });

  test('F07-AC3 - a correction cannot introduce an unobservable criterion', () => {
    const result = applyCorrection(
      conversation(),
      brief(),
      correction({
        proposal: proposal({ ...correctedSections, acceptanceCriteria: [{ id: 'ac-3', text: 'the system is fast', verification: null }] }, 1),
      }),
    );

    const error = refuse(result);
    assert.equal(error.code, 'Invalid');
    assert.match(JSON.stringify(error.fields), /is not observable/);
  });

  test('F07-AC3 - a correction made against a stale version is a conflict, not an overwrite', () => {
    const accepted = applyCorrection(conversation(), brief(), correction());
    assert.equal(accepted.ok, true);
    if (!accepted.ok) throw new Error('unreachable');

    const result = applyCorrection(
      accepted.value.conversation,
      accepted.value.brief,
      correction({
        correctionId: 'correction-2',
        text: 'A second correction written against version 1.',
        proposal: proposal(correctedSections, 1),
      }),
    );

    const error = refuse(result);
    assert.equal(error.code, 'Conflict');
    assert.equal(error.expected, '2');
    assert.equal(error.actual, '1');
    assert.equal(accepted.value.brief.version, 2, 'the accepted correction must stand');
    assert.equal(accepted.value.conversation.turns.length, 2, 'the refused correction must not be appended');
  });

  test('F07-AC3 - a correction for another idea is refused before anything is appended', () => {
    const foreign = { ...correction(), proposal: { ...correction().proposal, ideaId: ideaId('idea-42') } };
    const result = applyCorrection(conversation(), brief(), foreign);

    assert.equal(refuse(result).code, 'Conflict');
  });

  test('F07-AC3 - an empty correction or one with no raw request turn cannot be applied', () => {
    const empty = applyCorrection(conversation(), brief(), correction({ text: '  ' }));
    assert.equal(refuse(empty).code, 'Invalid');

    const headless = applyCorrection(
      { conversationId: 'conversation-2', ideaId: ideaId('idea-1'), turns: [] },
      brief(),
      correction(),
    );
    assert.equal(refuse(headless).code, 'Blocked');
  });

  test('F07-AC3 - corrections accumulate without rewriting earlier versions', () => {
    const first = applyCorrection(conversation(), brief(), correction());
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('unreachable');

    const second = applyCorrection(
      first.value.conversation,
      first.value.brief,
      correction({
        correctionId: 'correction-2',
        proposal: proposal(
          {
            ...correctedSections,
            acceptanceCriteria: [
              { id: 'ac-2', text: 'the failure case returns 500 and the session is not created', verification: 'Browser evidence.' },
              { id: 'ac-4', text: 'the workspace shows a banner while the session is being repaired', verification: 'Browser evidence.' },
            ],
          },
          2,
        ),
      }),
    );

    assert.equal(second.ok, true);
    if (!second.ok) throw new Error('unreachable');
    assert.equal(second.value.brief.version, 3);
    assert.deepEqual(second.value.withdrawnCriteria, []);
    assert.equal(second.value.conversation.turns.length, 3);
    assert.equal(rawRequestOf(second.value.conversation), RAW_REQUEST);
    assert.deepEqual(
      first.value.brief.sections.acceptanceCriteria.map((entry) => entry.id),
      ['ac-2'],
      'the intermediate version must still read exactly as it was recorded',
    );
  });
});

describe('code-grounded claims', () => {
  function claim(overrides: Partial<CodeClaim> = {}): CodeClaim {
    return {
      claimId: 'claim-1',
      statement: 'Session expiry is checked in the sign-in route handler.',
      subject: 'apps/web/src/server/routes/signIn.ts',
      inspectedRevision: REVISION,
      evidence: [{ kind: 'CodeLocation', reference: 'apps/web/src/server/routes/signIn.ts:42', observedAt: ASKED_AT }],
      ...overrides,
    };
  }

  test('F07-AC4 - a claim with a revision and evidence is grounded', () => {
    const grounded = codeGroundedClaim(claim());

    assert.equal(grounded.state, 'Grounded');
    assert.equal(grounded.revision, REVISION);
    assert.deepEqual(grounded.unknowns, []);
    assert.equal(grounded.reason, null);
    assert.equal(grounded.evidence.length, 1);
  });

  test('F07-AC4 - a claim with neither a revision nor evidence is labelled unknown, not invented', () => {
    const grounded = codeGroundedClaim(claim({ inspectedRevision: null, evidence: [] }));

    assert.equal(grounded.state, 'Unknown');
    assert.equal(grounded.revision, null);
    assert.deepEqual(grounded.unknowns, ['Revision', 'Evidence']);
    assert.match(grounded.reason ?? '', /no inspectable repository revision and no evidence/);
    assert.equal(grounded.statement, 'Session expiry is checked in the sign-in route handler.');
    assert.equal(UNKNOWN_IS_REPRESENTABLE, true);
  });

  test('F07-AC4 - a branch name or abbreviation is not a revision', () => {
    for (const candidate of ['main', 'feature/sign-in', '0123456', 'v2.0.0']) {
      const grounded = codeGroundedClaim(claim({ inspectedRevision: candidate }));

      assert.equal(grounded.state, 'Unknown');
      assert.equal(grounded.revision, null);
      assert.deepEqual(grounded.unknowns, ['Revision']);
      assert.match(grounded.reason ?? '', /missing revision/);
    }
  });

  test('F07-AC4 - a revision without evidence is unknown, and evidence without a revision is unknown', () => {
    const noEvidence = codeGroundedClaim(claim({ evidence: [] }));
    const noRevision = codeGroundedClaim(claim({ inspectedRevision: null }));

    assert.deepEqual(noEvidence.unknowns, ['Evidence']);
    assert.equal(noRevision.unknowns[0], 'Revision');
    assert.equal(noEvidence.state, 'Unknown');
    assert.equal(noRevision.state, 'Unknown');
  });

  test('F07-AC4 - a blank or missing evidence reference does not count as evidence', () => {
    const blank = codeGroundedClaim(claim({ evidence: [{ kind: 'CodeLocation', reference: '   ', observedAt: ASKED_AT }] }));
    const absent = codeGroundedClaim(claim({ evidence: undefined as unknown as CodeClaim['evidence'] }));

    assert.equal(blank.evidence.length, 0);
    assert.deepEqual(blank.unknowns, ['Evidence']);
    assert.equal(absent.evidence.length, 0);
    assert.equal(absent.state, 'Unknown');
  });

  test('F07-AC4 - a different revision produces a different grounding fact', () => {
    assert.equal(codeGroundedClaim(claim({ inspectedRevision: OTHER_REVISION })).revision, OTHER_REVISION);
    assert.notEqual(codeGroundedClaim(claim()).revision, codeGroundedClaim(claim({ inspectedRevision: OTHER_REVISION })).revision);
  });

  test('F07-AC4 - a full 64-character revision is accepted as well as a 40-character one', () => {
    const long = asCommitSha('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

    const grounded = codeGroundedClaim(claim({ inspectedRevision: long }));

    assert.equal(grounded.state, 'Grounded');
    assert.equal(grounded.revision, long);
  });
});

describe('read-only capability profile', () => {
  test('F07-AC5 - the clarification profile exposes no mutating capability', () => {
    for (const capability of CLARIFICATION_CAPABILITIES) {
      assert.equal(isMutatingCapability(capability), false, `${capability} must be read-only`);
      assert.doesNotMatch(capability, /:(?:PublishIssue|Execute|PushBranch|MergeWithPrecondition|StartScoped|UpdateDraft)$/);
    }

    assert.equal(READ_ONLY_CAPABILITY_EXCLUDES_EVERY_MUTATING_KIND, true);
    assert.equal(PROFILE_HAS_NO_MUTATING_CAPABILITY_FIELD, true);
  });

  test('F07-AC5 - the profile cannot change code, publish tickets, deploy or start a run', () => {
    assert.equal(readOnlyCapabilityProfile.mayChangeApplicationCode, false);
    assert.equal(readOnlyCapabilityProfile.mayPublishTickets, false);
    assert.equal(readOnlyCapabilityProfile.mayDeploy, false);
    assert.equal(readOnlyCapabilityProfile.mayStartCodingRun, false);
    assert.deepEqual(readOnlyCapabilityProfile.forbiddenSideEffects, [
      'ChangeApplicationCode',
      'PublishTicket',
      'Deploy',
      'ConsumeCodingRun',
    ]);
    assert.deepEqual(readOnlyCapabilityProfile.capabilities, [
      'Ticket:ReadScope',
      'Git:ReadRepository',
      'Git:ReadChecks',
      'Deployment:ReadIdentity',
    ]);
  });

  test('F07-AC5 - the profile is frozen data with no place to record a write', () => {
    assert.equal(Object.isFrozen(readOnlyCapabilityProfile), true);
    assert.equal(Object.isFrozen(readOnlyCapabilityProfile.capabilities), true);
    assert.deepEqual(
      Object.keys(readOnlyCapabilityProfile).sort(),
      ['capabilities', 'forbiddenSideEffects', 'mayChangeApplicationCode', 'mayDeploy', 'mayPublishTickets', 'mayStartCodingRun', 'name'],
    );
  });

  test('F07-AC5 - every capability that could change something is classified as mutating', () => {
    const mutating: readonly CapabilityKind[] = [
      'Ticket:PublishIssue',
      'Ticket:UpdateManagedProgress',
      'Ticket:RequestTransition',
      'Git:PushBranch',
      'Git:CreateDraft',
      'Git:UpdateDraft',
      'Git:MergeWithPrecondition',
      'Deployment:Execute',
      'Engine:StartScoped',
      'Engine:StopGraceful',
      'Engine:ResumeSession',
    ];

    for (const capability of mutating) {
      assert.equal(isMutatingCapability(capability), true, `${capability} must be classified as mutating`);
    }
    assert.deepEqual([...MUTATING_CAPABILITIES].sort(), [...mutating].sort());
  });
});

describe('intake as a whole', () => {
  test('F06-AC1, F07-AC3 - capture through correction keeps the owner\'s words and the reasoning intact', () => {
    const captured = createIdea({
      ideaId: ideaId('idea-1'),
      rawRequest: RAW_REQUEST,
      capturedAt: CAPTURED_AT,
      kind: 'Bug',
      detail: { expected: 'a session cookie', actual: 'HTTP 500', reproduction: 'sign in with a valid account' },
    });
    assert.equal(captured.ok, true);
    if (!captured.ok) throw new Error('unreachable');

    const first = bindProposalToRequest({
      briefId: BRIEF_ID,
      ideaId: captured.value.ideaId,
      rawRequest: captured.value.rawRequest,
      proposal: validated(proposal(COMPLETE_SECTIONS)),
    });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('unreachable');

    const turns: ClarificationConversation['turns'] = [{ kind: 'RawRequest', at: CAPTURED_AT, text: captured.value.rawRequest }];
    const corrected = applyCorrection(
      { conversationId: 'conversation-1', ideaId: captured.value.ideaId, turns },
      first.value,
      {
        correctionId: 'correction-1',
        text: 'Latency is not part of this idea.',
        at: CORRECTED_AT,
        proposal: proposal(
          {
            ...COMPLETE_SECTIONS,
            acceptanceCriteria: [FAILURE_CASE_CRITERION],
          },
          1,
        ),
      },
    );

    assert.equal(corrected.ok, true);
    if (!corrected.ok) throw new Error('unreachable');
    assert.equal(rawRequestOf(corrected.value.conversation), RAW_REQUEST);
    assert.equal(corrected.value.priorBrief.sections.acceptanceCriteria.length, 2);
    assert.equal(corrected.value.brief.sections.acceptanceCriteria.length, 1);
    assert.deepEqual(corrected.value.withdrawnCriteria, ['ac-1']);
  });
});