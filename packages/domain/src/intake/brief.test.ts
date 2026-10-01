/**
 * Regression proof for the concise brief and proposal validation (F07-AC1, F05-AC5).
 *
 * Two things this file protects. The brief has to carry exactly the seven
 * sections the specification names, because a missing section is a question the
 * agent cannot answer and an invented one is scope nobody agreed to. And a
 * structured model proposal has to be validated at its boundary before it becomes
 * a brief: an acceptance criterion like "the system is fast" is the specific
 * failure that lets unbuildable work into a run, and a model must not be able to
 * set acceptance or release state by naming such a field (F05-AC5).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fingerprint } from '../fingerprint.ts';
import type { IdeaId } from '../ids.ts';
import type { DomainError } from '../result.ts';
import { createIdea } from './idea.ts';
import type { IdeaDraft } from './idea.ts';
import {
  BRIEF_SECTION_NAMES,
  agreeBrief,
  applyProposal,
  assessObservability,
  bindProposalToRequest,
  draftBrief,
  isObservable,
} from './brief.ts';
import type { AcceptanceCriterion, Brief, BriefProposal, BriefSections, ValidatedBriefProposal } from './brief.ts';

const CAPTURED_AT = '2026-09-30T09:00:00.000Z';
const DRAFTED_AT = '2026-09-30T10:00:00.000Z';
const OWNER = 'owner-1';
const BRIEF_ID = 'brief-1';

function ideaId(value: string): IdeaId {
  return value as IdeaId;
}

function draft(rawRequest = 'Sign-in is unreliable and I lose my session'): IdeaDraft {
  const result = createIdea({ ideaId: ideaId('idea-1'), rawRequest, capturedAt: CAPTURED_AT, kind: 'FeatureRequest' });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

const REJECTED: readonly string[] = [
  'the system is fast',
  'The retry behaviour should be robust',
  'The user experience is nice',
  'Performance must be reasonable',
  'checkout handles coupons well',
];

const ACCEPTED: readonly string[] = [
  'sign-in completes in under 2s at p95',
  'the summary shows a warning when an attachment name contains a separator',
  'a failed save does not display Saved',
  'the queue retries at most 3 times and records each attempt in the delivery receipt',
  'the health endpoint returns 503 while a run is starting',
];

const COMPLETE_SECTIONS: BriefSections = {
  problem: 'Signing in with a valid account returns a 500 and the owner loses the session.',
  desiredOutcome: 'A valid owner can sign in and stays signed in for the working session.',
  includedBehaviour: ['A valid account receives a session cookie.',
    'The session survives a page reload.'],
  excludedBehaviour: ['Password reset is out of scope for this idea.'],
  assumptions: ['Session storage is already configured for the owner project.'],
  acceptanceCriteria: [
    { id: 'ac-1', text: ACCEPTED[0] ?? '', verification: 'Timed browser run at p95.' },
    { id: 'ac-2', text: ACCEPTED[1] ?? '', verification: 'Browser evidence screenshot.' },
  ],
  unresolvedQuestions: [],
};

function proposal(overrides: Partial<BriefSections> = {}): BriefProposal {
  return {
    kind: 'BriefProposal',
    ideaId: ideaId('idea-1'),
    authoredBy: 'ClarificationModel',
    authoredAt: DRAFTED_AT,
    basedOnBriefVersion: null,
    sections: { ...COMPLETE_SECTIONS, ...overrides },
  };
}

function invalidFields(error: DomainError): ReadonlyArray<{ path: string; message: string }> {
  assert.equal(error.code, 'Invalid');
  if (error.code !== 'Invalid') throw new Error('unreachable');
  return error.fields;
}

function fieldDetails(error: DomainError): readonly string[] {
  return invalidFields(error).map((field) => `${field.path}: ${field.message}`);
}

function refuse(result: { readonly ok: boolean; readonly error?: DomainError }): DomainError {
  assert.equal(result.ok, false, 'expected the command to be refused');
  if (result.ok || result.error === undefined) throw new Error('unreachable');
  return result.error;
}

function validated(input: BriefProposal = proposal()): ValidatedBriefProposal {
  const result = applyProposal(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function brief(input: BriefProposal = proposal()): Brief {
  const result = draftBrief({ briefId: BRIEF_ID, idea: draft(), proposal: validated(input) });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function criterion(id: string, text: string): AcceptanceCriterion {
  return { id, text, verification: null };
}

/*
 * Compile-time structural assertions. Exported so the type checker evaluates them
 * and nothing reports them as unused.
 */
type SectionKeysMatchTheList = Exclude<keyof BriefSections, (typeof BRIEF_SECTION_NAMES)[number]> extends never
  ? keyof BriefSections extends (typeof BRIEF_SECTION_NAMES)[number]
    ? true
    : false
  : false;
export const BRIEF_SECTIONS_ARE_EXACTLY_THE_NAMED_SEVEN: SectionKeysMatchTheList = true;

type ProposalLifecycleKeys = Extract<
  keyof BriefProposal,
  'acceptance' | 'acceptanceState' | 'delivery' | 'deliveryState' | 'release' | 'releaseState' | 'status' | 'state'
>;
export const PROPOSAL_CANNOT_SET_LIFECYCLE_STATE: ProposalLifecycleKeys extends never ? true : false = true;

type ProposedBriefKeys = keyof Extract<Brief, { readonly state: 'Proposed' }>;
export const PROPOSED_BRIEF_HAS_NO_AGREEMENT_RECORD: Extract<
  ProposedBriefKeys,
  'agreedBy' | 'agreedAt'
> extends never
  ? true
  : false = true;

type AcceptedBriefRecordsAgreement = Extract<Brief, { readonly state: 'Agreed' }> extends {
  readonly agreedBy: string;
  readonly agreedAt: string;
}
  ? true
  : false;
export const AGREED_BRIEF_RECORDS_WHO_AND_WHEN: AcceptedBriefRecordsAgreement = true;

type DraftBriefProposalParameter = Parameters<typeof draftBrief>[0]['proposal'];
export const DRAFT_BRIEF_REQUIRES_A_VALIDATED_PROPOSAL: DraftBriefProposalParameter extends {
  readonly validated: true;
}
  ? true
  : false = true;

type ProposalProvenanceKeys = Extract<keyof BriefProposal, 'rawRequestFingerprint' | 'rawRequest'>;
export const PROPOSAL_CANNOT_ASSERT_PROVENANCE: ProposalProvenanceKeys extends never ? true : false = true;

describe('brief sections', () => {
  test('F07-AC1 - the brief carries exactly the seven named sections', () => {
    assert.deepEqual([...BRIEF_SECTION_NAMES], [
      'problem',
      'desiredOutcome',
      'includedBehaviour',
      'excludedBehaviour',
      'assumptions',
      'acceptanceCriteria',
      'unresolvedQuestions',
    ]);
    assert.deepEqual(Object.keys(COMPLETE_SECTIONS).sort(), [...BRIEF_SECTION_NAMES].sort());
    assert.equal(BRIEF_SECTIONS_ARE_EXACTLY_THE_NAMED_SEVEN, true);
  });

  test('F07-AC1 - a draft brief carries every section the owner was asked for', () => {
    const result = brief();

    assert.equal(result.state, 'Proposed');
    assert.equal(result.version, 1);
    assert.equal(result.supersedesVersion, null);
    assert.deepEqual(Object.keys(result.sections).sort(), [...BRIEF_SECTION_NAMES].sort());
    assert.equal(result.sections.problem, COMPLETE_SECTIONS.problem);
    assert.equal(result.sections.acceptanceCriteria.length, 2);
    assert.deepEqual(result.sections.excludedBehaviour, ['Password reset is out of scope for this idea.']);
  });

  test('F06-AC1, F07-AC1 - the brief is traceable to the exact raw request, not to the proposal', () => {
    const rawRequest = 'Sign-in is unreliable and I lose my session';
    const result = brief();

    assert.equal(result.rawRequestFingerprint, fingerprint(rawRequest));
    assert.equal(result.ideaId, ideaId('idea-1'));
  });

  test('F07-AC1 - a proposal produced for another idea is a conflict, not a silent rebinding', () => {
    const foreign = validated(proposal());
    const wrongIdea = { ...foreign, ideaId: ideaId('idea-99') };
    const result = draftBrief({ briefId: BRIEF_ID, idea: draft(), proposal: wrongIdea });

    const error = refuse(result);
    assert.equal(error.code, 'Conflict');
    assert.equal(error.expected, 'idea-1');
    assert.equal(error.actual, 'idea-99');
  });

  test('F07-AC1 - a blank problem or outcome is refused, naming the field to correct', () => {
    const noProblem = refuse(applyProposal(proposal({ problem: '   ' })));
    assert.deepEqual(
      fieldDetails(noProblem).filter((detail) => detail.startsWith('sections.problem')),
      ['sections.problem: The brief needs the problem it solves.'],
    );

    const noOutcome = refuse(applyProposal(proposal({ desiredOutcome: '' })));
    assert.match(fieldDetails(noOutcome).join(' '), /sections\.desiredOutcome: The brief needs the outcome/);
  });

  test('F07-AC1 - a brief with no acceptance criteria is still a brief; the question is what to ask', () => {
    const result = applyProposal(proposal({ acceptanceCriteria: [] }));

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.deepEqual(result.value.sections.acceptanceCriteria, []);
  });

  test('F07-AC3 - the sections a brief stores are frozen, so a consumer cannot edit a criterion in place', () => {
    const result = brief();

    assert.equal(Object.isFrozen(result.sections), true);
    assert.equal(Object.isFrozen(result.sections.acceptanceCriteria), true);
    assert.equal(Object.isFrozen(result.sections.acceptanceCriteria[0]), true);
    assert.equal(Object.isFrozen(result), true);
  });
});

describe('observable acceptance criteria', () => {
  for (const text of ACCEPTED) {
    test(`F07-AC1 - an observable criterion is accepted: "${text}"`, () => {
      assert.equal(isObservable(text), true);
      const result = applyProposal(proposal({ acceptanceCriteria: [criterion('ac-1', text)] }));
      assert.equal(result.ok, true);
    });
  }

  for (const text of REJECTED) {
    test(`F07-AC1 - an unobservable criterion is refused: "${text}"`, () => {
      assert.equal(isObservable(text), false);
      const error = refuse(applyProposal(proposal({ acceptanceCriteria: [criterion('ac-1', text)] })));

      assert.deepEqual(
        fieldDetails(error).filter((detail) => detail.startsWith('sections.acceptanceCriteria[0].text')).length,
        1,
      );
      assert.match(fieldDetails(error).join(' '), /is not observable/);
    });
  }

  test('F07-AC1 - an evaluative word does not disqualify a criterion that is also measurable', () => {
    const text = 'checkout is fast (<500ms p95)';
    const verdict = assessObservability(text);

    assert.equal(verdict.observable, true);
    assert.ok(verdict.signals.includes('MeasuredQuantity'));
    assert.deepEqual(verdict.unobservableTerms, ['fast']);
  });

  test('F07-AC1 - the verdict names which observable signal made a criterion acceptable', () => {
    assert.deepEqual(assessObservability('sign-in completes in under 2s at p95').signals, [
      'MeasuredQuantity',
      'ConcreteStateChange',
    ]);
    assert.deepEqual(assessObservability('the summary shows a warning').signals, ['ConcreteStateChange']);
    assert.deepEqual(assessObservability('the summary shows `LoginError`').signals, [
      'ConcreteStateChange',
      'ExplicitArtifact',
    ]);
    assert.deepEqual(assessObservability('the system is fast').signals, []);
    assert.deepEqual(assessObservability('the system is fast').unobservableTerms, ['fast']);
  });

  test('F07-AC1 - a repeated criterion id is refused, so a criterion cannot be silently replaced', () => {
    const error = refuse(
      applyProposal(
        proposal({
          acceptanceCriteria: [criterion('ac-1', ACCEPTED[0] ?? ''), criterion('ac-1', ACCEPTED[1] ?? '')],
        }),
      ),
    );

    assert.match(fieldDetails(error).join(' '), /id "ac-1" is used twice/);
  });

  test('F07-AC1 - every unobservable criterion is reported at once, so the refusal is recoverable in one pass', () => {
    const error = refuse(
      applyProposal(
        proposal({
          acceptanceCriteria: [
            criterion('ac-1', 'the system is fast'),
            criterion('ac-2', 'the retry behaviour should be robust'),
            criterion('ac-3', ACCEPTED[0] ?? ''),
          ],
        }),
      ),
    );

    assert.deepEqual(
      fieldDetails(error).filter((detail) => detail.includes('is not observable')).map((detail) => detail.split(':')[0]),
      ['sections.acceptanceCriteria[0].text', 'sections.acceptanceCriteria[1].text'],
    );
  });
});

describe('structured proposal validation', () => {
  test('F05-AC5 - a valid structured proposal is accepted and frozen', () => {
    const result = applyProposal(proposal());

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.validated, true);
    assert.equal(result.value.ideaId, ideaId('idea-1'));
    assert.equal(Object.isFrozen(result.value.sections), true);
    assert.equal(Object.isFrozen(result.value.sections.includedBehaviour), true);
  });

  test('F05-AC5 - an invalid structured proposal is refused with a recoverable, per-field error', () => {
    const result = applyProposal(
      proposal({
        problem: '',
        desiredOutcome: '',
        acceptanceCriteria: [criterion('ac-1', 'the system is fast')],
      }),
    );

    const error = refuse(result);
    assert.equal(error.code, 'Invalid');
    assert.ok(invalidFields(error).length >= 3, 'every failing field must be reported, not just the first');
  });

  test('F05-AC5 - a rejected proposal can be corrected and resubmitted unchanged elsewhere', () => {
    const rejected = applyProposal(proposal({ problem: '' }));
    assert.equal(rejected.ok, false);

    const repaired = applyProposal(proposal({ problem: COMPLETE_SECTIONS.problem }));

    assert.equal(repaired.ok, true);
    if (!repaired.ok) throw new Error('unreachable');
    assert.equal(repaired.value.sections.problem, COMPLETE_SECTIONS.problem);
    assert.equal(repaired.value.sections.acceptanceCriteria.length, 2);
  });

  test('F05-AC5 - a missing section is refused at the decoded-JSON boundary', () => {
    const incomplete = { ...COMPLETE_SECTIONS } as Record<string, unknown>;
    delete incomplete.assumptions;
    const decoded = {
      kind: 'BriefProposal',
      ideaId: ideaId('idea-1'),
      authoredBy: 'ClarificationModel',
      authoredAt: DRAFTED_AT,
      basedOnBriefVersion: null,
      sections: incomplete,
    } as unknown as BriefProposal;

    const error = refuse(applyProposal(decoded));

    assert.deepEqual(
      fieldDetails(error).filter((detail) => detail.includes('must carry the')),
      ['sections.assumptions: A brief must carry the "assumptions" section.'],
    );
  });

  test('F05-AC5 - a section the brief does not define is refused rather than stored', () => {
    const decoded = {
      ...proposal(),
      sections: { ...COMPLETE_SECTIONS, estimatedEffort: 'three days' },
    } as unknown as BriefProposal;

    const error = refuse(applyProposal(decoded));

    assert.deepEqual(
      fieldDetails(error).filter((detail) => detail.includes('no section named')),
      ['sections.estimatedEffort: A brief has no section named "estimatedEffort".'],
    );
  });

  test('F05-AC5 - a section holding the wrong kind of value is refused, not thrown on', () => {
    const decoded = {
      ...proposal(),
      sections: { ...COMPLETE_SECTIONS, includedBehaviour: 'add retry', acceptanceCriteria: { id: 'ac-1' } },
    } as unknown as BriefProposal;

    const error = refuse(applyProposal(decoded));

    assert.deepEqual(
      fieldDetails(error).filter((detail) => /must be a list|criterion must carry/.test(detail)),
      [
        'sections.includedBehaviour: The "includedBehaviour" section must be a list of statements.',
        'sections.acceptanceCriteria: The "acceptanceCriteria" section must be a list of criteria.',
      ],
    );
  });

  test('F05-AC5 - a criterion whose id or text is not text is refused by field path', () => {
    const decoded = {
      ...proposal(),
      sections: { ...COMPLETE_SECTIONS, acceptanceCriteria: [{ id: 'ac-1', text: 42 }] },
    } as unknown as BriefProposal;

    const error = refuse(applyProposal(decoded));

    assert.deepEqual(
      fieldDetails(error).filter((detail) => /must carry string/.test(detail)),
      ['sections.acceptanceCriteria[0]: A criterion must carry string id and text fields.'],
    );
  });

  test('F05-AC5 - structured output tagged as something other than a brief proposal is refused', () => {
    const misTagged = { ...proposal(), kind: 'ImplementationPlan' } as unknown as BriefProposal;

    const error = refuse(applyProposal(misTagged));

    assert.deepEqual(
      fieldDetails(error),
      ['kind: A brief proposal must be tagged as a BriefProposal.'],
    );
  });

  test('F05-AC5 - a proposal cannot carry acceptance, delivery or release state', () => {
    assert.equal(PROPOSAL_CANNOT_SET_LIFECYCLE_STATE, true);

    const decoded = {
      ...proposal(),
      acceptance: 'Accepted',
      delivery: 'Merged',
      release: 'Released',
    } as unknown as BriefProposal;

    const error = refuse(applyProposal(decoded));

    assert.deepEqual(
      fieldDetails(error).filter((detail) => /has no field/.test(detail)),
      [
        'acceptance: A brief proposal has no field "acceptance"; owner decisions such as acceptance and release are not proposed.',
        'delivery: A brief proposal has no field "delivery"; owner decisions such as acceptance and release are not proposed.',
        'release: A brief proposal has no field "release"; owner decisions such as acceptance and release are not proposed.',
      ],
    );
  });

  test('F05-AC5 - only a validated proposal can reach a brief', () => {
    assert.equal(DRAFT_BRIEF_REQUIRES_A_VALIDATED_PROPOSAL, true);
  });

  test('F07-AC1 - a proposal cannot assert its own raw-request fingerprint', () => {
    assert.equal(PROPOSAL_CANNOT_ASSERT_PROVENANCE, true);
  });
});

describe('binding a brief to a request', () => {
  test('F07-AC1 - a version-1 brief records no superseded version', () => {
    const result = bindProposalToRequest({
      briefId: BRIEF_ID,
      ideaId: ideaId('idea-1'),
      rawRequest: 'anything the owner said',
      proposal: validated(proposal()),
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.version, 1);
    assert.equal(result.value.supersedesVersion, null);
    assert.equal(result.value.state, 'Proposed');
  });

  test('F07-AC3 - a proposal that supersedes a version appends the next one', () => {
    const superseding = validated({ ...proposal(), basedOnBriefVersion: 2 });
    const result = bindProposalToRequest({
      briefId: BRIEF_ID,
      ideaId: ideaId('idea-1'),
      rawRequest: 'anything the owner said',
      proposal: superseding,
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.version, 3);
    assert.equal(result.value.supersedesVersion, 2);
  });
});

describe('owner agreement', () => {
  test('F05-AC5 - agreeing a proposed brief records the owner and the time', () => {
    const result = agreeBrief(brief(), { agreedBy: OWNER, at: DRAFTED_AT });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.state, 'Agreed');
    if (result.value.state !== 'Agreed') throw new Error('unreachable');
    assert.equal(result.value.agreedBy, OWNER);
    assert.equal(result.value.agreedAt, DRAFTED_AT);
    assert.equal(result.value.sections.problem, COMPLETE_SECTIONS.problem);
  });

  test('F05-AC5 - agreeing a brief records no acceptance, delivery or release state', () => {
    const agreed = agreeBrief(brief(), { agreedBy: OWNER, at: DRAFTED_AT });
    assert.equal(agreed.ok, true);
    if (!agreed.ok) throw new Error('unreachable');

    const keys = Object.keys(agreed.value).sort();
    assert.equal(keys.includes('acceptance'), false);
    assert.equal(keys.includes('accepted'), false);
    assert.equal(keys.includes('delivery'), false);
    assert.equal(keys.includes('released'), false);
    assert.equal(AGREED_BRIEF_RECORDS_WHO_AND_WHEN, true);
    assert.equal(PROPOSED_BRIEF_HAS_NO_AGREEMENT_RECORD, true);
  });

  test('F05-AC5 - agreeing the same brief version twice is a conflict', () => {
    const once = agreeBrief(brief(), { agreedBy: OWNER, at: DRAFTED_AT });
    assert.equal(once.ok, true);
    if (!once.ok) throw new Error('unreachable');

    const twice = agreeBrief(once.value, { agreedBy: 'owner-2', at: DRAFTED_AT });

    assert.equal(refuse(twice).code, 'Conflict');
    assert.equal(once.value.state, 'Agreed');
    if (once.value.state !== 'Agreed') throw new Error('unreachable');
    assert.equal(once.value.agreedBy, OWNER);
  });
});