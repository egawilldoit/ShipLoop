/**
 * Regression proof for idea and bug intake (F06).
 *
 * The failures guarded here are silent ones. A generated summary that replaces the
 * owner's own words, an attachment name that escapes the artifact root, a bug the
 * product refuses to capture because detail was missing, and a resemblance score
 * that quietly becomes a merge all produce plausible-looking output while destroying
 * the record the request should have produced. Each test names the criterion it
 * protects so a future change has to argue with the criterion rather than with the
 * assertion.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fingerprint } from '../fingerprint.ts';
import type { IdeaId } from '../ids.ts';
import type { DomainError } from '../result.ts';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_LENGTH,
  appendAttachment,
  archiveIdea,
  createIdea,
  deferIdea,
  isSupportedMediaType,
  rankRelatedness,
  recordProducedWork,
  relatedness,
  summarizeDraft,
} from './idea.ts';
import type { CreateIdeaInput, IdeaDraft } from './idea.ts';

/*
 * Compile-time structural assertions.
 *
 * These hold the shapes the domain promises where a runtime test could only
 * sample them: a feature request cannot carry bug detail, a summary input has no
 * field that could carry replacement raw text, an archived disposition can only
 * exist when there is no produced work, and a resemblance report has no decision
 * key at all. They are exported so the type checker evaluates them and nothing
 * reports them as unused.
 */
type FeatureRequestKeys = keyof Extract<IdeaDraft['request'], { readonly kind: 'FeatureRequest' }>;
export const FEATURE_REQUEST_HAS_NO_DETAIL: Extract<FeatureRequestKeys, 'detail'> extends never ? true : false = true;

type SummaryInputKeys = keyof Parameters<typeof summarizeDraft>[1];
type SummaryInputReplacesRawRequest = Extract<SummaryInputKeys, 'rawRequest' | 'rawRequestText'> extends never
  ? true
  : false;
export const SUMMARY_INPUT_CANNOT_CARRY_RAW_REQUEST: SummaryInputReplacesRawRequest = true;

type ProducedWorkEvidence = Extract<IdeaDraft['disposition'], { readonly state: 'Published' }> extends {
  readonly workItemIds: readonly string[];
  readonly codingRunIds: readonly string[];
}
  ? true
  : false;
export const PUBLISHED_CARRIES_WORK_EVIDENCE: ProducedWorkEvidence = true;

type RelatednessDecisionKeys = Extract<
  keyof ReturnType<typeof relatedness>,
  'merge' | 'mergeNow' | 'discard' | 'discardNow' | 'action' | 'actionTaken' | 'decision'
>;
export const RELATEDNESS_TYPE_HAS_NO_DECISION_KEY: RelatednessDecisionKeys extends never ? true : false = true;

const CAPTURED_AT = '2026-09-30T09:00:00.000Z';
const LATER = '2026-09-30T11:30:00.000Z';
const OWNER = 'owner-1';

function ideaId(value: string): IdeaId {
  return value as IdeaId;
}

const FEATURE_INPUT: CreateIdeaInput = {
  ideaId: ideaId('idea-1'),
  rawRequest: 'Add a retry budget to the delivery queue',
  capturedAt: CAPTURED_AT,
  kind: 'FeatureRequest',
};

const BUG_INPUT: CreateIdeaInput = {
  ideaId: ideaId('idea-2'),
  rawRequest: 'Signing in with a valid account returns a 500',
  capturedAt: CAPTURED_AT,
  kind: 'Bug',
};

function captured(input: CreateIdeaInput): IdeaDraft {
  const result = createIdea(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function refused(result: { readonly ok: boolean; readonly error?: DomainError }): DomainError {
  assert.equal(result.ok, false, 'expected the command to be refused');
  if (result.ok || result.error === undefined) throw new Error('unreachable');
  return result.error;
}

function invalidFields(error: DomainError): ReadonlyArray<{ path: string; message: string }> {
  assert.equal(error.code, 'Invalid');
  if (error.code !== 'Invalid') throw new Error('unreachable');
  return error.fields;
}

function fieldMessages(error: DomainError): readonly string[] {
  return invalidFields(error).map((field) => field.message);
}

function fieldDetails(error: DomainError): readonly string[] {
  return invalidFields(error).map((field) => `${field.path}: ${field.message}`);
}

describe('idea capture', () => {
  test('F06-AC3 - a feature request captures with no project, notes or detail supplied', () => {
    const draft = captured(FEATURE_INPUT);

    assert.equal(draft.rawRequest, 'Add a retry budget to the delivery queue');
    assert.equal(draft.projectId, null);
    assert.equal(draft.notes, null);
    assert.equal(draft.request.kind, 'FeatureRequest');
    assert.deepEqual(draft.attachments, []);
    assert.equal(draft.summary, null);
    assert.equal(draft.disposition.state, 'Unpublished');
  });

  test('F06-AC3 - a bug with no expected, actual or reproduction detail still captures', () => {
    const draft = captured(BUG_INPUT);

    assert.equal(draft.request.kind, 'Bug');
    if (draft.request.kind !== 'Bug') throw new Error('unreachable');
    assert.deepEqual(draft.request.detail, { expected: null, actual: null, reproduction: null });
    assert.equal(draft.attachments.length, 0);
  });

  test('F06-AC3 - partial bug detail captures without requiring the remaining fields', () => {
    const draft = captured({ ...BUG_INPUT, detail: { expected: 'a session cookie', actual: null, reproduction: null } });

    assert.equal(draft.request.kind, 'Bug');
    if (draft.request.kind !== 'Bug') throw new Error('unreachable');
    assert.equal(draft.request.detail.expected, 'a session cookie');
    assert.equal(draft.request.detail.actual, null);
    assert.equal(draft.request.detail.reproduction, null);
  });

  test('F06-AC3 - a blank raw request is the one required-field failure, reported per field', () => {
    const error = refused(createIdea({ ...FEATURE_INPUT, rawRequest: '   \n ' }));

    assert.equal(error.code, 'Invalid');
    assert.deepEqual(
      fieldMessages(error).filter((message) => message.includes('raw request')),
      ['The raw request is required and cannot be blank.'],
    );
  });

  test('F06-AC3 - bug detail supplied for a feature request is refused rather than stored', () => {
    const error = refused(
      createIdea({ ...FEATURE_INPUT, detail: { expected: 'a', actual: 'b', reproduction: 'c' } }),
    );

    assert.equal(error.code, 'Invalid');
    assert.match(fieldMessages(error).join(' '), /belongs to a bug, not a feature request/);
  });

  test('F06-AC1 - a feature request cannot express bug detail at the type level', () => {
    assert.equal(FEATURE_REQUEST_HAS_NO_DETAIL, true);
  });
});

describe('generated summaries', () => {
  const RAW = 'Add a retry budget to the delivery queue';

  test('F06-AC1 - the raw request is preserved verbatim after a summary is recorded', () => {
    const original = captured(FEATURE_INPUT);
    const result = summarizeDraft(original, {
      text: 'The owner wants a bounded retry budget on the delivery queue.',
      generatedAt: LATER,
      generatedBy: 'clarification-model',
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.rawRequest, RAW);
    assert.equal(original.rawRequest, RAW);
    assert.notEqual(result.value.summary?.text, result.value.rawRequest);
  });

  test('F06-AC1 - a summary records the fingerprint of the exact raw text it came from', () => {
    const draft = captured(FEATURE_INPUT);
    const result = summarizeDraft(draft, {
      text: 'A bounded retry budget on the delivery queue.',
      generatedAt: LATER,
      generatedBy: 'clarification-model',
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.summary?.rawRequestFingerprint, fingerprint(draft.rawRequest));
    assert.notEqual(result.value.summary?.rawRequestFingerprint, fingerprint('a different request'));
  });

  test('F06-AC1 - re-summarising replaces derived data and still cannot alter the raw request', () => {
    const once = captured(FEATURE_INPUT);
    const first = summarizeDraft(once, { text: 'First summary.', generatedAt: LATER, generatedBy: 'model-a' });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('unreachable');

    const second = summarizeDraft(first.value, {
      text: 'Second, sharper summary.',
      generatedAt: LATER,
      generatedBy: 'model-b',
    });
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error('unreachable');

    assert.equal(second.value.rawRequest, RAW);
    assert.equal(second.value.summary?.text, 'Second, sharper summary.');
    assert.equal(second.value.summary?.generatedBy, 'model-b');
  });

  test('F06-AC1 - a blank summary or an uncredited summary is refused', () => {
    const draft = captured(FEATURE_INPUT);

    assert.match(
      fieldMessages(refused(summarizeDraft(draft, { text: '  ', generatedAt: LATER, generatedBy: 'model' }))).join(' '),
      /summary cannot be blank/,
    );
    assert.match(
      fieldMessages(refused(summarizeDraft(draft, { text: 'A summary.', generatedAt: LATER, generatedBy: '' }))).join(' '),
      /records what generated it/,
    );
  });

  test('F06-AC1 - summarizeDraft has no parameter through which raw text could be replaced', () => {
    assert.equal(SUMMARY_INPUT_CANNOT_CARRY_RAW_REQUEST, true);
  });
});

describe('attachment names', () => {
  const draft = () => captured(FEATURE_INPUT);

  const REFUSED_NAMES: ReadonlyArray<{ readonly label: string; readonly name: string; readonly pattern: RegExp }> = [
    { label: 'parent traversal', name: '../escape.txt', pattern: /escape the artifact root/ },
    { label: 'nested traversal', name: 'nested/../../escape.txt', pattern: /path separator|could escape the artifact root/ },
    { label: 'bare relative segment', name: '..', pattern: /relative path segment/ },
    { label: 'posix separator', name: 'notes/plan.txt', pattern: /path separator/ },
    { label: 'windows separator', name: 'notes\\plan.txt', pattern: /path separator/ },
    { label: 'absolute posix path', name: '/etc/passwd', pattern: /path separator/ },
    { label: 'absolute windows path', name: 'C:\\windows\\system32\\config', pattern: /absolute path/ },
    { label: 'home-relative path', name: '~/.ssh/authorized_keys', pattern: /path separator|absolute path/ },
    { label: 'embedded NUL', name: 'evil\u0000.txt', pattern: /NUL character/ },
    { label: 'newline', name: 'plan\n.txt', pattern: /control characters/ },
    { label: 'empty name', name: '', pattern: /needs a file name/ },
  ];

  for (const { label, name, pattern } of REFUSED_NAMES) {
    test(`F06-AC1 - an attachment name with ${label} is refused`, () => {
      const result = appendAttachment(draft(), {
        name,
        mediaType: 'text/plain',
        byteSize: 120,
        addedAt: LATER,
      });

      assert.match(fieldMessages(refused(result)).join(' '), pattern);
      assert.match(
        fieldDetails(refused(result)).join(' '),
        /attachment\.name:/,
        'the refusal must name the field the owner has to correct',
      );
    });
  }

  test('F06-AC1 - an over-long or whitespace-padded name is refused', () => {
    assert.match(
      fieldMessages(
        refused(
          appendAttachment(draft(), {
            name: 'a'.repeat(MAX_ATTACHMENT_NAME_LENGTH + 1),
            mediaType: 'text/plain',
            byteSize: 10,
            addedAt: LATER,
          }),
        ),
      ).join(' '),
      /limited to 255 characters/,
    );
    assert.match(
      fieldMessages(
        refused(appendAttachment(draft(), { name: ' plan.txt', mediaType: 'text/plain', byteSize: 10, addedAt: LATER })),
      ).join(' '),
      /begin or end with whitespace/,
    );
  });

  test('F06-AC1 - an attachment is referenced by name and carries no embedded content', () => {
    const result = appendAttachment(draft(), {
      name: 'screenshot.png',
      mediaType: 'image/png',
      byteSize: 2048,
      addedAt: LATER,
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    const [attachment] = result.value.attachments;
    assert.ok(attachment !== undefined);
    assert.deepEqual(Object.keys(attachment).sort(), ['addedAt', 'byteSize', 'mediaType', 'name']);
    assert.equal(attachment.name, 'screenshot.png');
    assert.equal(attachment.mediaType, 'image/png');
    assert.equal(attachment.byteSize, 2048);
  });

  test('F06-AC1 - a plausible name inside the artifact root is accepted', () => {
    const result = appendAttachment(draft(), {
      name: 'plan.v2.txt',
      mediaType: 'text/plain',
      byteSize: 512,
      addedAt: LATER,
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.value.attachments.length, 1);
    assert.equal(result.value.rawRequest, 'Add a retry budget to the delivery queue');
  });

  test('F06-AC1 - an oversized or impossible size is refused alongside the name check', () => {
    const oversized = appendAttachment(draft(), {
      name: 'huge.bin',
      mediaType: 'text/plain',
      byteSize: MAX_ATTACHMENT_BYTES + 1,
      addedAt: LATER,
    });
    const messages = fieldMessages(refused(oversized)).join(' ');
    assert.match(messages, /limited to 20971520 bytes/);

    const zero = appendAttachment(draft(), { name: 'empty.txt', mediaType: 'text/plain', byteSize: 0, addedAt: LATER });
    assert.match(fieldMessages(refused(zero)).join(' '), /positive whole byte count/);
  });

  test('F06-AC1 - the same name cannot be referenced twice, which would hide a replaced file', () => {
    const first = appendAttachment(draft(), {
      name: 'plan.txt',
      mediaType: 'text/plain',
      byteSize: 100,
      addedAt: LATER,
    });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('unreachable');

    const second = appendAttachment(first.value, {
      name: 'plan.txt',
      mediaType: 'text/plain',
      byteSize: 200,
      addedAt: LATER,
    });
    assert.match(fieldMessages(refused(second)).join(' '), /already referenced by this draft/);
  });

  test('F06-AC1 - only text and image media types are supported', () => {
    assert.equal(isSupportedMediaType('text/plain'), true);
    assert.equal(isSupportedMediaType('image/png'), true);
    assert.equal(isSupportedMediaType('image/jpeg'), true);
    assert.equal(isSupportedMediaType('application/pdf'), false);
    assert.equal(isSupportedMediaType('text/html'), false);
  });
});

describe('deferring and archiving', () => {
  test('F06-AC5 - an unpublished idea archives without a ticket or a coding run', () => {
    const result = archiveIdea(captured(FEATURE_INPUT), { by: OWNER, at: LATER, reason: 'Not now' });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.deepEqual(result.value.disposition, {
      state: 'Archived',
      archivedAt: LATER,
      archivedBy: OWNER,
      reason: 'Not now',
    });
    assert.equal(result.value.rawRequest, 'Add a retry budget to the delivery queue');
  });

  test('F06-AC5 - an unpublished idea can be deferred instead of archived', () => {
    const result = deferIdea(captured(FEATURE_INPUT), { at: LATER, reason: 'After the release' });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.deepEqual(result.value.disposition, { state: 'Deferred', deferredAt: LATER, reason: 'After the release' });
  });

  test('F06-AC5 - archiving an idea that produced work is refused, naming the work', () => {
    const published = recordProducedWork(captured(FEATURE_INPUT), {
      workItemIds: ['work-item-7'],
      codingRunIds: ['run-3'],
    }, LATER);
    assert.equal(published.ok, true);
    if (!published.ok) throw new Error('unreachable');

    const result = archiveIdea(published.value, { by: OWNER, at: LATER, reason: 'Changed my mind' });

    const error = refused(result);
    assert.equal(error.code, 'Forbidden');
    assert.match(error.reason, /1 work item\(s\), 1 coding run\(s\)/);
    assert.equal(published.value.disposition.state, 'Published');
  });

  test('F06-AC5 - a deferred idea that produced work is also refused', () => {
    const deferred = deferIdea(captured(FEATURE_INPUT), { at: LATER, reason: null });
    assert.equal(deferred.ok, true);
    if (!deferred.ok) throw new Error('unreachable');

    const published = recordProducedWork(deferred.value, { workItemIds: ['work-item-8'], codingRunIds: [] }, LATER);
    assert.equal(published.ok, true);
    if (!published.ok) throw new Error('unreachable');

    assert.equal(refused(archiveIdea(published.value, { by: OWNER, at: LATER, reason: null })).code, 'Forbidden');
    assert.equal(refused(deferIdea(published.value, { at: LATER, reason: null })).code, 'Forbidden');
  });

  test('F06-AC5 - archiving twice is a conflict, not a second archive', () => {
    const once = archiveIdea(captured(FEATURE_INPUT), { by: OWNER, at: LATER, reason: null });
    assert.equal(once.ok, true);
    if (!once.ok) throw new Error('unreachable');

    const twice = archiveIdea(once.value, { by: OWNER, at: LATER, reason: null });
    assert.equal(refused(twice).code, 'Conflict');
    assert.equal(refused(deferIdea(once.value, { at: LATER, reason: null })).code, 'Conflict');
  });

  test('F06-AC5 - an archived idea cannot later acquire work', () => {
    const archived = archiveIdea(captured(FEATURE_INPUT), { by: OWNER, at: LATER, reason: null });
    assert.equal(archived.ok, true);
    if (!archived.ok) throw new Error('unreachable');

    const result = recordProducedWork(
      archived.value,
      { workItemIds: ['work-item-9'], codingRunIds: [] },
      LATER,
    );
    assert.equal(refused(result).code, 'Conflict');
  });

  test('F06-AC5 - the disposition variant carries the produced work, so the refusal is a type fact', () => {
    assert.equal(PUBLISHED_CARRIES_WORK_EVIDENCE, true);
  });
});

describe('relatedness', () => {
  test('F06-AC4 - two identical ideas reach a perfect score and still produce no merge or discard', () => {
    const left = captured(FEATURE_INPUT);
    const right = captured({ ...FEATURE_INPUT, ideaId: ideaId('idea-1-copy') });

    const report = relatedness(left, right);

    assert.equal(report.score, 1);
    assert.deepEqual(report.reasons, ['IdenticalRawRequest']);
    assert.equal(report.mergeable, false);
    assert.equal(report.discardable, false);
    assert.equal(report.disposition, 'OwnerChoiceRequired');
    assert.deepEqual(report.ownerChoices, ['LinkToExisting', 'ExtendExisting', 'CreateNewIssue']);
  });

  test('F06-AC4 - a perfect resemblance report exposes no action, only the owner choices', () => {
    const left = captured(FEATURE_INPUT);
    const report = relatedness(left, captured({ ...FEATURE_INPUT, ideaId: ideaId('idea-1-copy') }));

    const keys = Object.keys(report).sort();
    assert.equal(keys.includes('merged'), false);
    assert.equal(keys.includes('discarded'), false);
    assert.equal(keys.includes('actionTaken'), false);
    assert.equal(keys.includes('action'), false);
    assert.deepEqual(keys, [
      'discardable',
      'disposition',
      'leftIdeaId',
      'mergeable',
      'ownerChoices',
      'reasons',
      'rightIdeaId',
      'score',
    ]);
  });

  test('F06-AC4 - the report type cannot express a merge or discard decision', () => {
    assert.equal(RELATEDNESS_TYPE_HAS_NO_DECISION_KEY, true);
  });

  test('F06-AC4 - overlapping ideas score between zero and one and name the overlapping signals', () => {
    const left = captured({
      ...FEATURE_INPUT,
      projectId: 'project-1',
      notes: 'Bounded by the queue budget',
    });
    const right = captured({
      ...FEATURE_INPUT,
      ideaId: ideaId('idea-3'),
      projectId: 'project-1',
      notes: 'Bounded by the queue budget',
      rawRequest: 'Add a retry budget to the delivery queue, bounded by the queue',
    });

    const report = relatedness(left, right);

    assert.ok(report.score > 0, 'overlapping subject terms must be visible');
    assert.ok(report.score < 1, 'a non-identical request must not read as a duplicate');
    assert.ok(report.reasons.includes('SharedSubjectTerms'));
    assert.ok(report.reasons.includes('SameProject'));
    assert.ok(report.reasons.includes('SharedNotes'));
  });

  test('F06-AC4 - unrelated ideas score zero and report no overlap', () => {
    const left = captured(FEATURE_INPUT);
    const right = captured({
      ideaId: ideaId('idea-4'),
      rawRequest: 'Rotate the customer support inbox rota',
      capturedAt: CAPTURED_AT,
      kind: 'FeatureRequest',
    });

    const report = relatedness(left, right);

    assert.equal(report.score, 0);
    assert.deepEqual(report.reasons, ['NoOverlap']);
    assert.equal(report.mergeable, false);
  });

  test('F06-AC4 - a shared reproduction detail is a reported signal for two bugs', () => {
    const detail = { expected: null, actual: 'a blank page', reproduction: 'open /settings then press save twice' };
    const left = captured({ ...BUG_INPUT, detail });
    const right = captured({
      ...BUG_INPUT,
      ideaId: ideaId('idea-5'),
      rawRequest: 'Settings save shows nothing',
      detail,
    });

    const report = relatedness(left, right);

    assert.ok(report.reasons.includes('SharedReproductionDetail'));
    assert.ok(report.score > 0);
    assert.equal(report.mergeable, false);
  });

  test('F06-AC4 - related work is ranked for display and never merged by ranking', () => {
    const draft = captured(FEATURE_INPUT);
    const identical = captured({ ...FEATURE_INPUT, ideaId: ideaId('idea-6') });
    const unrelated = captured({
      ideaId: ideaId('idea-7'),
      rawRequest: 'Rotate the customer support inbox rota',
      capturedAt: CAPTURED_AT,
      kind: 'FeatureRequest',
    });

    const ranked = rankRelatedness(draft, [unrelated, identical, draft]);

    assert.deepEqual(ranked.map((report) => report.rightIdeaId), [ideaId('idea-6')]);
    assert.equal(ranked[0]?.disposition, 'OwnerChoiceRequired');
    assert.equal(ranked[0]?.mergeable, false);
  });

  test('F06-AC4 - the score is a pure function of the two drafts', () => {
    const left = captured(FEATURE_INPUT);
    const right = captured({ ...FEATURE_INPUT, ideaId: ideaId('idea-8'), rawRequest: 'Bound delivery retries' });

    assert.deepEqual(relatedness(left, right), relatedness(left, right));
    assert.notDeepEqual(relatedness(left, right), relatedness(left, captured(FEATURE_INPUT)));
  });
});