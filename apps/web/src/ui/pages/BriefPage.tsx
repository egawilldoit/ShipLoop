import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  agreeIntakeBrief,
  answerIntakeQuestion,
  applyIntakeCorrection,
  askIntakeQuestions,
  draftIntakeBrief,
  fetchIntakeIdea,
  fieldMessages,
  formatTimestamp,
  type BriefSections,
  type BriefVersion,
  type ClarifyingQuestion,
  type IntakeDetail,
  type IntakeAmbiguity,
} from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

export interface BriefPageProps {
  readonly ideaId: string;
  readonly onBackToIntake: () => void;
  readonly epoch: number;
}

type FormState = 'idle' | 'saving' | 'done' | 'refused';

type ViewState = 'loading' | 'empty' | 'ready' | 'error';

const SECTION_LABELS: Readonly<Record<keyof BriefSections, string>> = {
  problem: 'Problem',
  desiredOutcome: 'Desired outcome',
  includedBehaviour: 'Included behaviour',
  excludedBehaviour: 'Excluded behaviour',
  assumptions: 'Assumptions',
  acceptanceCriteria: 'Acceptance criteria',
  unresolvedQuestions: 'Unresolved questions',
};

/**
 * The seven sections in the order F07-AC1 names them.
 *
 * An explicit list rather than an object's key order, because the order is part of what
 * the specification asks for and a brief that rendered in whatever order a map happened
 * to iterate would not be the same artefact on every run.
 */
const SECTION_ORDER: readonly (keyof BriefSections)[] = [
  'problem',
  'desiredOutcome',
  'includedBehaviour',
  'excludedBehaviour',
  'assumptions',
  'acceptanceCriteria',
  'unresolvedQuestions',
];

const BRIEF_TONES: Readonly<Record<BriefVersion['state'], StatusTone>> = {
  Proposed: 'pending',
  Agreed: 'healthy',
};

const QUESTION_TONES: Readonly<Record<ClarifyingQuestion['state'], StatusTone>> = {
  Open: 'degraded',
  Answered: 'healthy',
};

interface SectionForm {
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly includedBehaviour: string;
  readonly excludedBehaviour: string;
  readonly assumptions: string;
  readonly acceptanceCriteria: string;
  readonly unresolvedQuestions: string;
}

const EMPTY_SECTIONS: SectionForm = {
  problem: '',
  desiredOutcome: '',
  includedBehaviour: '',
  excludedBehaviour: '',
  assumptions: '',
  acceptanceCriteria: '',
  unresolvedQuestions: '',
};

/** One acceptance criterion per line, as `AC-1 | what it must show`. */
function criterionLines(criteria: BriefSections['acceptanceCriteria']): string {
  return criteria.map((criterion) => `${criterion.id} | ${criterion.text}`).join('\n');
}

function linesToCriteria(value: string): { id: string; text: string; verification: string | null }[] {
  const criteria: { id: string; text: string; verification: string | null }[] = [];
  for (const raw of value.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const separator = line.indexOf('|');
    if (separator < 0) {
      criteria.push({ id: `AC-${criteria.length + 1}`, text: line, verification: null });
      continue;
    }
    criteria.push({ id: line.slice(0, separator).trim(), text: line.slice(separator + 1).trim(), verification: null });
  }
  return criteria;
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function toBriefSections(form: SectionForm): BriefSections {
  return {
    problem: form.problem.trim(),
    desiredOutcome: form.desiredOutcome.trim(),
    includedBehaviour: splitLines(form.includedBehaviour),
    excludedBehaviour: splitLines(form.excludedBehaviour),
    assumptions: splitLines(form.assumptions),
    acceptanceCriteria: linesToCriteria(form.acceptanceCriteria),
    unresolvedQuestions: splitLines(form.unresolvedQuestions),
  };
}

function fromBriefSections(sections: BriefSections): SectionForm {
  return {
    problem: sections.problem,
    desiredOutcome: sections.desiredOutcome,
    includedBehaviour: sections.includedBehaviour.join('\n'),
    excludedBehaviour: sections.excludedBehaviour.join('\n'),
    assumptions: sections.assumptions.join('\n'),
    acceptanceCriteria: criterionLines(sections.acceptanceCriteria),
    unresolvedQuestions: sections.unresolvedQuestions.join('\n'),
  };
}

function blank(value: string | null): string {
  return value ?? '';
}

function SectionTextArea({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  rows,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly disabled: boolean;
  readonly rows: number;
}): ReactElement {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter((part) => part !== undefined).join(' ');
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        className="field__input"
        id={id}
        name={id}
        rows={rows}
        value={value}
        aria-invalid={error === undefined ? undefined : 'true'}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {hintId === undefined ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {errorId === undefined ? null : (
        <p className="field__error" id={errorId}>
          <span className="field__error-mark" aria-hidden="true" />
          Error: {error}
        </p>
      )}
    </div>
  );
}

/**
 * The first message recorded against a section, whatever index it carries.
 *
 * The domain names a problem inside a section with its index - `sections.
 * acceptanceCriteria[0].text` - so looking the section up by its bare name would find
 * nothing and the refusal would collapse into a banner the owner cannot act on. Both
 * separators are matched because the index uses brackets and a nested criterion member
 * uses a dot (F07-AC1, N03-AC3).
 */
function sectionError(errors: Readonly<Record<string, string>>, section: string): string | undefined {
  const exact = errors[`sections.${section}`];
  if (exact !== undefined) return exact;
  const prefix = `sections.${section}`;
  for (const [path, message] of Object.entries(errors)) {
    if (path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)) return message;
  }
  return undefined;
}

function SectionFields({
  form,
  onChange,
  errors,
  disabled,
  prefix,
}: {
  readonly form: SectionForm;
  readonly onChange: (next: SectionForm) => void;
  readonly errors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly prefix: string;
}): ReactElement {
  const rowsFor = (key: keyof SectionForm): number => (key === 'problem' || key === 'desiredOutcome' ? 3 : 4);
  const hintFor = (key: keyof SectionForm): string | undefined => {
    if (key === 'includedBehaviour' || key === 'excludedBehaviour' || key === 'assumptions') {
      return 'One statement per line.';
    }
    if (key === 'acceptanceCriteria') {
      return 'One criterion per line, written as id | what must be observable. A criterion that only states a quality is refused.';
    }
    if (key === 'unresolvedQuestions') {
      return 'One question per line. These become candidates for clarification.';
    }
    return undefined;
  };
  return (
    <>
      {SECTION_ORDER.map((key) => (
        <SectionTextArea
          key={key}
          id={`${prefix}-${key}`}
          label={SECTION_LABELS[key]}
          value={form[key]}
          onChange={(value) => onChange({ ...form, [key]: value })}
          rows={rowsFor(key)}
          hint={hintFor(key)}
          error={sectionError(errors, key)}
          disabled={disabled}
        />
      ))}
    </>
  );
}

function renderSections(sections: BriefSections, headingLevel: 'h4' | 'h5', headingIdPrefix: string): ReactElement {
  const Heading = headingLevel;
  return (
    <div className="detail-list">
      {SECTION_ORDER.map((key) => (
        <div className="detail-list__row" key={`${headingIdPrefix}-${key}`}>
          <dt>
            <Heading className="connector__subtitle" id={`${headingIdPrefix}-${key}`}>
              {SECTION_LABELS[key]}
            </Heading>
          </dt>
          <dd>
            {key === 'acceptanceCriteria'
              ? sections.acceptanceCriteria.length === 0
                ? 'No acceptance criteria yet.'
                : sections.acceptanceCriteria.map((criterion) => (
                    <span key={criterion.id}>
                      <strong>{criterion.id}</strong>: {criterion.text}
                      {criterion.verification === null ? '' : ` (verified by ${criterion.verification})`}
                      <br />
                    </span>
                  ))
              : key === 'problem' || key === 'desiredOutcome'
                ? sections[key]
                : sections[key].length === 0
                  ? 'Nothing recorded in this section.'
                  : sections[key].map((statement) => (
                      <span key={statement}>
                        {statement}
                        <br />
                      </span>
                    ))}
          </dd>
        </div>
      ))}
    </div>
  );
}

/**
 * The brief, the questions worth asking, and the owner's correction (F07-AC1, F07-AC2,
 * F07-AC3).
 *
 * The seven sections F07-AC1 names are the whole artefact, and each is a labelled
 * control with its own error slot, so a proposal the domain refuses for a missing or
 * unobservable part names that part beside its input rather than collapsing into one
 * banner (F07-AC1, N03-AC3).
 *
 * Clarification is deliberately ask-only on this screen. Each question states why the
 * answer changes the work, so an owner can see it is not an interview, and the
 * candidates the domain declined are listed with the reason it declined them: a
 * candidate that was considered and not put to the owner is a fact worth showing
 * (F07-AC2).
 *
 * A correction appends a version. The prior versions stay on screen, each with the
 * state it was left in, so an owner can read what they agreed to before the change as
 * readily as what the change produced (F07-AC3). Agreeing is about scope only and the
 * copy says so, because agreement reads like acceptance of the delivered product and
 * is not (F05-AC5).
 */
export function BriefPage({ ideaId, onBackToIntake, epoch }: BriefPageProps): ReactElement {
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [reload, setReload] = useState(0);

  const [draftForm, setDraftForm] = useState<SectionForm>(EMPTY_SECTIONS);
  const [draftErrors, setDraftErrors] = useState<Readonly<Record<string, string>>>({});
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<FormState>('idle');

  const [agreeMessage, setAgreeMessage] = useState<string | null>(null);
  const [agreeState, setAgreeState] = useState<FormState>('idle');

  const [questionForm, setQuestionForm] = useState<SectionForm>(EMPTY_SECTIONS);
  const [ambiguity, setAmbiguity] = useState({ topic: '', readingA: '', readingB: '', impact: 'ChangesBehaviour', evidence: '' });
  const [ambiguityErrors, setAmbiguityErrors] = useState<Readonly<Record<string, string>>>({});
  const [askErrors, setAskErrors] = useState<Readonly<Record<string, string>>>({});
  const [askMessage, setAskMessage] = useState<string | null>(null);
  const [askState, setAskState] = useState<FormState>('idle');

  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const [answerErrors, setAnswerErrors] = useState<Readonly<Record<string, string>>>({});
  const [answerMessage, setAnswerMessage] = useState<string | null>(null);
  const [answerState, setAnswerState] = useState<FormState>('idle');

  const [correctionText, setCorrectionText] = useState('');
  const [correctionForm, setCorrectionForm] = useState<SectionForm>(EMPTY_SECTIONS);
  const [correctionErrors, setCorrectionErrors] = useState<Readonly<Record<string, string>>>({});
  const [correctionMessage, setCorrectionMessage] = useState<string | null>(null);
  const [correctionState, setCorrectionState] = useState<FormState>('idle');

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    if (ideaId === '') {
      setDetail(null);
      setViewState('empty');
      return;
    }
    let current = true;
    setViewState('loading');
    void fetchIntakeIdea(ideaId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setDetail(null);
        setViewError(result.error.reason);
        setViewState('error');
        return;
      }
      setDetail(result.value);
      setViewError(null);
      setViewState('ready');
      const currentSections = result.value.brief.current?.sections ?? null;
      if (currentSections !== null) {
        setQuestionForm(fromBriefSections(currentSections));
        setCorrectionForm(fromBriefSections(currentSections));
      }
    });
    return () => {
      current = false;
    };
  }, [ideaId, epoch, reload]);

  const submitDraft = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (draftState === 'saving') return;

    const local: Record<string, string> = {};
    if (draftForm.problem.trim() === '') local['sections.problem'] = 'The brief needs the problem it solves.';
    if (draftForm.desiredOutcome.trim() === '') {
      local['sections.desiredOutcome'] = 'The brief needs the outcome wanted.';
    }
    if (Object.keys(local).length > 0) {
      setDraftErrors(local);
      setDraftMessage('The brief was not drafted because some sections need attention.');
      setDraftState('refused');
      return;
    }

    setDraftState('saving');
    setDraftMessage(null);
    const result = await draftIntakeBrief(ideaId, {
      authoredBy: 'Owner',
      sections: toBriefSections(draftForm),
      basedOnBriefVersion: null,
    });
    if (!result.ok) {
      setDraftErrors(fieldMessages(result.error));
      setDraftMessage(result.error.reason);
      setDraftState('refused');
      return;
    }
    setDraftErrors({});
    setDraftMessage(`Brief version ${result.value.brief.version} recorded as a proposal. It is not agreed yet.`);
    setDraftState('done');
    refresh();
  };

  const agree = async (): Promise<void> => {
    setAgreeState('saving');
    setAgreeMessage(null);
    const result = await agreeIntakeBrief(ideaId);
    if (!result.ok) {
      setAgreeMessage(`The brief was not agreed: ${result.error.reason}`);
      setAgreeState('refused');
      return;
    }
    setAgreeMessage(
      `Version ${result.value.brief.version} is agreed as the scope. Agreement is not product acceptance, delivery or release.`,
    );
    setAgreeState('done');
    refresh();
  };

  const submitQuestions = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (askState === 'saving') return;

    const local: Record<string, string> = {};
    const usesAmbiguity = ambiguity.topic.trim() !== '' || ambiguity.readingA.trim() !== '' || ambiguity.readingB.trim() !== '';
    if (usesAmbiguity) {
      if (ambiguity.topic.trim() === '') local['ambiguity.topic'] = 'Name what the ambiguity is about.';
      if (ambiguity.readingA.trim() === '') local['ambiguity.readingA'] = 'Name the first possible reading.';
      if (ambiguity.readingB.trim() === '') local['ambiguity.readingB'] = 'Name the second possible reading.';
      if (ambiguity.evidence.trim() === '') {
        local['ambiguity.evidence'] = 'Quote the request text that shows the ambiguity exists.';
      }
    }
    if (Object.keys(local).length > 0) {
      setAmbiguityErrors(local);
      setAskMessage('No question was asked because the ambiguity is incomplete.');
      setAskState('refused');
      return;
    }

    setAmbiguityErrors({});
    setAskState('saving');
    setAskMessage(null);
    const ambiguities: IntakeAmbiguity[] = usesAmbiguity
      ? [
          {
            kind: 'UnspecifiedSubject',
            topic: ambiguity.topic.trim(),
            readings: [ambiguity.readingA.trim(), ambiguity.readingB.trim()],
            answeredBy: [],
            impact: ambiguity.impact === 'Cosmetic' ? 'Cosmetic' : 'ChangesBehaviour',
            evidence: ambiguity.evidence.trim(),
          },
        ]
      : [];
    const result = await askIntakeQuestions(ideaId, {
      sections: toBriefSections(questionForm),
      ambiguities,
    });
    if (!result.ok) {
      setAskErrors(fieldMessages(result.error));
      setAskMessage(result.error.reason);
      setAskState('refused');
      return;
    }
    setAskErrors({});
    setAskMessage(
      `${result.value.questions.length} ${result.value.questions.length === 1 ? 'question was' : 'questions were'} asked and ${result.value.rejected.length} ${result.value.rejected.length === 1 ? 'candidate was' : 'candidates were'} considered and not asked.`,
    );
    setAskState('done');
    refresh();
  };

  const submitAnswer = async (event: FormEvent<HTMLFormElement>, question: ClarifyingQuestion): Promise<void> => {
    event.preventDefault();
    if (answerState === 'saving') return;
    const answer = answers[question.questionId] ?? '';
    if (answer.trim() === '') {
      setAnswerErrors({ [question.questionId]: 'An answer must say something; an empty answer leaves the question open.' });
      setAnswerMessage('No answer was recorded because the answer was empty.');
      setAnswerState('refused');
      return;
    }
    setAnswerState('saving');
    setAnswerMessage(null);
    const result = await answerIntakeQuestion(ideaId, question.questionId, answer);
    if (!result.ok) {
      setAnswerErrors(fieldMessages(result.error));
      setAnswerMessage(`The answer was not recorded: ${result.error.reason}`);
      setAnswerState('refused');
      return;
    }
    setAnswerErrors({});
    setAnswerMessage(`Recorded your answer to "${question.topic}". It cannot be changed once recorded.`);
    setAnswerState('done');
    setAnswers((previous) => ({ ...previous, [question.questionId]: '' }));
    refresh();
  };

  const submitCorrection = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (correctionState === 'saving') return;

    const local: Record<string, string> = {};
    if (correctionText.trim() === '') local['correction.text'] = 'A correction must record your own words.';
    if (Object.keys(local).length > 0) {
      setCorrectionErrors(local);
      setCorrectionMessage('The correction was not recorded because some fields need attention.');
      setCorrectionState('refused');
      return;
    }

    const currentVersion = detail?.brief.currentVersion ?? null;
    if (currentVersion === null) {
      setCorrectionMessage('There is no brief to correct yet.');
      setCorrectionState('refused');
      return;
    }

    setCorrectionState('saving');
    setCorrectionMessage(null);
    const result = await applyIntakeCorrection(ideaId, {
      text: correctionText.trim(),
      sections: toBriefSections(correctionForm),
      basedOnBriefVersion: currentVersion,
    });
    if (!result.ok) {
      setCorrectionErrors(fieldMessages(result.error));
      setCorrectionMessage(result.error.reason);
      setCorrectionState('refused');
      return;
    }
    setCorrectionErrors({});
    const withdrawn = result.value.withdrawnCriterionIds;
    setCorrectionMessage(
      `Version ${result.value.currentVersion.version} was appended. Version ${result.value.priorVersion.version} stays readable${
        withdrawn.length === 0 ? '.' : ` and withdrew ${withdrawn.join(', ')}.`
      }`,
    );
    setCorrectionState('done');
    setCorrectionText('');
    refresh();
  };

  const view: ViewState =
    viewError !== null ? 'error' : ideaId === '' ? 'empty' : viewState;
  const viewText =
    view === 'error'
      ? `This brief could not be loaded: ${viewError ?? 'unknown reason'}`
      : view === 'empty'
        ? 'No request is selected.'
        : view === 'loading'
          ? 'Loading the brief…'
          : 'The brief and its conversation are loaded.';

  const brief = detail?.brief ?? null;
  const questions = detail?.questions ?? [];
  const rejected = detail?.rejected ?? [];

  return (
    <section className="page" aria-labelledby="brief-title">
      <h2 className="page__title" id="brief-title">
        Brief and clarification
      </h2>
      <div className="form__actions">
        <button className="button button--secondary" type="button" onClick={onBackToIntake}>
          Back to intake
        </button>
      </div>
      <p
        className={view === 'error' ? 'state-line state-line--error' : 'state-line'}
        role={view === 'error' ? 'alert' : 'status'}
        aria-live={view === 'error' ? 'assertive' : 'polite'}
        data-state={view}
      >
        {viewText}
      </p>

      {detail === null ? null : (
        <>
          <section className="panel" aria-labelledby="brief-request-title">
            <h3 className="panel__title" id="brief-request-title">
              The request this brief is about
            </h3>
            <div className="detail-list">
              <div className="detail-list__row">
                <dt>Raw request</dt>
                <dd data-testid="brief-raw-request">{detail.idea.rawRequest}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Request kind</dt>
                <dd>{detail.idea.kind === 'Bug' ? 'Bug' : 'Feature request'}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Current version</dt>
                <dd>{brief?.currentVersion === null || brief === null ? 'No brief yet.' : `Version ${brief.currentVersion}`}</dd>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="brief-current-title">
            <h3 className="panel__title" id="brief-current-title">
              The brief
            </h3>
            {brief === null || brief.current === null ? (
              <p className="state-line" role="status" data-state="empty">
                No brief has been drafted for this request yet.
              </p>
            ) : (
              <>
                <div className="connector__header">
                  <h4 className="connector__subtitle">Version {brief.current.version}</h4>
                  <StatusBadge
                    tone={BRIEF_TONES[brief.current.state]}
                    label={`State: ${brief.current.state}`}
                    detail={
                      brief.current.state === 'Agreed'
                        ? `Agreed by ${blank(brief.current.agreedBy)} at ${blank(brief.current.agreedAt)}. Agreement is about scope only.`
                        : 'Proposed, not yet agreed by the owner.'
                    }
                  />
                </div>
                {renderSections(brief.current.sections, 'h5', 'brief-current')}
                <p className="panel__note">
                  Derived from request {brief.current.rawRequestFingerprint}. Supersedes version{' '}
                  {brief.current.supersedesVersion === null ? 'nothing' : brief.current.supersedesVersion}.
                </p>
              </>
            )}
          </section>

          <section className="panel" aria-labelledby="brief-versions-title">
            <h3 className="panel__title" id="brief-versions-title">
              Every brief version
            </h3>
            <p className="state-line" role="status" data-state={brief === null || brief.versions.length === 0 ? 'empty' : 'ready'}>
              {brief === null || brief.versions.length === 0
                ? 'No brief version has been recorded.'
                : `${brief.versions.length} ${brief.versions.length === 1 ? 'version is' : 'versions are'} readable, oldest first.`}
            </p>
            {brief === null || brief.versions.length === 0
              ? null
              : brief.versions.map((version) => (
                  <div className="panel" key={version.version} data-testid={`brief-version-${version.version}`}>
                    <div className="connector__header">
                      <h4 className="connector__subtitle">Version {version.version}</h4>
                      <StatusBadge tone={BRIEF_TONES[version.state]} label={`State: ${version.state}`} />
                    </div>
                    <p className="panel__note">
                      Authored by {version.authoredBy} at {formatTimestamp(version.authoredAt)}
                      {version.supersedesVersion === null ? '' : `, superseding version ${version.supersedesVersion}`}
                      {version.withdrawnCriterionIds.length === 0
                        ? '.'
                        : `. Withdrew ${version.withdrawnCriterionIds.join(', ')}.`}
                    </p>
                    {renderSections(version.sections, 'h5', `brief-v${version.version}`)}
                  </div>
                ))}
          </section>

          <section className="panel" aria-labelledby="brief-draft-title">
            <h3 className="panel__title" id="brief-draft-title">
              Draft the first brief
            </h3>
            <p className="panel__note">
              All seven sections are required; a list may be empty. Once a brief exists, changes are made by recording a
              correction, so every version stays readable.
            </p>
            <p
              className={draftState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={draftState === 'refused' ? 'alert' : 'status'}
              aria-live={draftState === 'refused' ? 'assertive' : 'polite'}
              data-state={draftState}
            >
              {draftState === 'saving' ? 'Recording the brief…' : (draftMessage ?? 'No brief has been drafted from this form.')}
            </p>
            <form className="form form--grid" noValidate onSubmit={(event) => void submitDraft(event)}>
              <SectionFields
                form={draftForm}
                onChange={setDraftForm}
                errors={draftErrors}
                disabled={draftState === 'saving'}
                prefix="draft"
              />
              <div className="form__actions">
                <button
                  className="button"
                  type="submit"
                  disabled={draftState === 'saving' || (brief !== null && brief.versions.length > 0)}
                >
                  {brief !== null && brief.versions.length > 0
                    ? 'A brief already exists; record a correction instead'
                    : draftState === 'saving'
                      ? 'Recording…'
                      : 'Record this brief'}
                </button>
              </div>
            </form>
          </section>

          <section className="panel" aria-labelledby="brief-agree-title">
            <h3 className="panel__title" id="brief-agree-title">
              Agree the scope
            </h3>
            <p className="panel__note">
              Agreeing says the scope is right. It is not product acceptance, and it says nothing about delivery or
              release.
            </p>
            <p
              className={agreeState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={agreeState === 'refused' ? 'alert' : 'status'}
              aria-live={agreeState === 'refused' ? 'assertive' : 'polite'}
              data-state={agreeState}
            >
              {agreeState === 'saving' ? 'Recording agreement…' : (agreeMessage ?? 'No agreement has been recorded from this form.')}
            </p>
            <div className="form__actions">
              <button
                className="button"
                type="button"
                disabled={agreeState === 'saving' || brief === null || brief.current === null}
                onClick={() => void agree()}
              >
                {brief === null || brief.current === null ? 'No brief to agree yet' : `Agree version ${brief.current.version}`}
              </button>
            </div>
          </section>

          <section className="panel" aria-labelledby="brief-ask-title">
            <h3 className="panel__title" id="brief-ask-title">
              Ask the questions worth asking
            </h3>
            <p className="panel__note">
              Only a material ambiguity earns a question. A candidate the request has already answered, a candidate with a
              single reading and a cosmetic one are all declined, and the decline is shown with its reason.
            </p>
            <p
              className={askState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={askState === 'refused' ? 'alert' : 'status'}
              aria-live={askState === 'refused' ? 'assertive' : 'polite'}
              data-state={askState}
            >
              {askState === 'saving' ? 'Asking…' : (askMessage ?? 'No questions have been asked from this form.')}
            </p>
            <form className="form form--grid" noValidate onSubmit={(event) => void submitQuestions(event)}>
              <SectionFields
                form={questionForm}
                onChange={setQuestionForm}
                errors={askErrors}
                disabled={askState === 'saving'}
                prefix="ask"
              />
              <div className="field">
                <label className="field__label" htmlFor="ask-ambiguity-topic">
                  One ambiguity you think is open (optional)
                </label>
                <input
                  className="field__input"
                  id="ask-ambiguity-topic"
                  name="ask-ambiguity-topic"
                  type="text"
                  value={ambiguity.topic}
                  aria-describedby="ask-ambiguity-topic-hint"
                  disabled={askState === 'saving'}
                  onChange={(event) => setAmbiguity((previous) => ({ ...previous, topic: event.target.value }))}
                />
                <p className="field__hint" id="ask-ambiguity-topic-hint">
                  Leave every field below blank to ask about unobservable criteria only.
                </p>
                {ambiguityErrors['ambiguity.topic'] === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {ambiguityErrors['ambiguity.topic']}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="ask-ambiguity-reading-a">
                  First possible reading
                </label>
                <input
                  className="field__input"
                  id="ask-ambiguity-reading-a"
                  name="ask-ambiguity-reading-a"
                  type="text"
                  value={ambiguity.readingA}
                  aria-invalid={ambiguityErrors['ambiguity.readingA'] === undefined ? undefined : 'true'}
                  disabled={askState === 'saving'}
                  onChange={(event) => setAmbiguity((previous) => ({ ...previous, readingA: event.target.value }))}
                />
                {ambiguityErrors['ambiguity.readingA'] === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {ambiguityErrors['ambiguity.readingA']}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="ask-ambiguity-reading-b">
                  Second possible reading
                </label>
                <input
                  className="field__input"
                  id="ask-ambiguity-reading-b"
                  name="ask-ambiguity-reading-b"
                  type="text"
                  value={ambiguity.readingB}
                  aria-invalid={ambiguityErrors['ambiguity.readingB'] === undefined ? undefined : 'true'}
                  disabled={askState === 'saving'}
                  onChange={(event) => setAmbiguity((previous) => ({ ...previous, readingB: event.target.value }))}
                />
                {ambiguityErrors['ambiguity.readingB'] === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {ambiguityErrors['ambiguity.readingB']}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="ask-ambiguity-impact">
                  Does the answer change the work?
                </label>
                <select
                  className="field__input"
                  id="ask-ambiguity-impact"
                  name="ask-ambiguity-impact"
                  value={ambiguity.impact}
                  disabled={askState === 'saving'}
                  onChange={(event) => setAmbiguity((previous) => ({ ...previous, impact: event.target.value }))}
                >
                  <option value="ChangesBehaviour">It changes what is built</option>
                  <option value="ChangesAcceptance">It changes what counts as done</option>
                  <option value="Cosmetic">It is cosmetic, so it should not be asked</option>
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="ask-ambiguity-evidence">
                  Request text that shows the ambiguity exists
                </label>
                <textarea
                  className="field__input"
                  id="ask-ambiguity-evidence"
                  name="ask-ambiguity-evidence"
                  rows={3}
                  value={ambiguity.evidence}
                  aria-invalid={ambiguityErrors['ambiguity.evidence'] === undefined ? undefined : 'true'}
                  disabled={askState === 'saving'}
                  onChange={(event) => setAmbiguity((previous) => ({ ...previous, evidence: event.target.value }))}
                />
                {ambiguityErrors['ambiguity.evidence'] === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {ambiguityErrors['ambiguity.evidence']}
                  </p>
                )}
              </div>
              <div className="form__actions">
                <button className="button" type="submit" disabled={askState === 'saving'}>
                  {askState === 'saving' ? 'Asking…' : 'Ask clarifying questions'}
                </button>
              </div>
            </form>
          </section>

          <section className="panel" aria-labelledby="brief-questions-title">
            <h3 className="panel__title" id="brief-questions-title">
              Questions asked
            </h3>
            <p className="state-line" role="status" data-state={questions.length === 0 ? 'empty' : 'ready'}>
              {questions.length === 0
                ? 'No clarifying question has been asked about this request.'
                : `${questions.length} ${questions.length === 1 ? 'question has' : 'questions have'} been asked.`}
            </p>
            {questions.map((question) => (
              <div className="panel connector" key={question.questionId} data-testid={`question-${question.questionId}`}>
                <div className="connector__header">
                  <h4 className="connector__subtitle">{question.prompt}</h4>
                  <StatusBadge
                    tone={QUESTION_TONES[question.state]}
                    label={`Question ${question.state}`}
                    detail={`Asked because: ${question.whyMaterial}`}
                  />
                </div>
                <div className="detail-list">
                  <div className="detail-list__row">
                    <dt>Topic</dt>
                    <dd>{question.topic}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Readings separated</dt>
                    <dd>{question.readings.length === 0 ? 'This question asks for a threshold rather than a reading.' : question.readings.join(' or ')}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Why it matters</dt>
                    <dd>{question.whyMaterial}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Earned by</dt>
                    <dd>
                      {question.origin === 'Ambiguity'
                        ? 'An ambiguity you enumerated'
                        : 'An acceptance criterion that cannot be checked'}
                    </dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Answer</dt>
                    <dd>
                      {question.state === 'Answered'
                        ? `${blank(question.answer)} (recorded ${formatTimestamp(question.askedAt)})`
                        : 'Not answered yet.'}
                    </dd>
                  </div>
                </div>
                {question.state === 'Open' ? (
                  <form className="form" noValidate onSubmit={(event) => void submitAnswer(event, question)}>
                    <div className="field">
                      <label className="field__label" htmlFor={`answer-${question.questionId}`}>
                        Your answer
                      </label>
                      <textarea
                        className="field__input"
                        id={`answer-${question.questionId}`}
                        name={`answer-${question.questionId}`}
                        rows={3}
                        value={answers[question.questionId] ?? ''}
                        aria-required="true"
                        aria-invalid={answerErrors[question.questionId] === undefined ? undefined : 'true'}
                        disabled={answerState === 'saving'}
                        onChange={(event) =>
                          setAnswers((previous) => ({ ...previous, [question.questionId]: event.target.value }))
                        }
                      />
                      {answerErrors[question.questionId] === undefined ? null : (
                        <p className="field__error">
                          <span className="field__error-mark" aria-hidden="true" />
                          Error: {answerErrors[question.questionId]}
                        </p>
                      )}
                    </div>
                    <button className="button" type="submit" disabled={answerState === 'saving'}>
                      {answerState === 'saving' ? 'Recording…' : 'Record this answer'}
                    </button>
                  </form>
                ) : null}
              </div>
            ))}
            <p
              className={answerState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={answerState === 'refused' ? 'alert' : 'status'}
              aria-live={answerState === 'refused' ? 'assertive' : 'polite'}
              data-state={answerState}
            >
              {answerState === 'saving' ? 'Recording the answer…' : (answerMessage ?? 'No answer has been recorded from this form.')}
            </p>
          </section>

          <section className="panel" aria-labelledby="brief-declined-title">
            <h3 className="panel__title" id="brief-declined-title">
              Considered and not asked
            </h3>
            <p className="state-line" role="status" data-state={rejected.length === 0 ? 'empty' : 'ready'}>
              {rejected.length === 0
                ? 'No candidate question has been considered and declined.'
                : `${rejected.length} ${rejected.length === 1 ? 'candidate was' : 'candidates were'} considered and not asked.`}
            </p>
            {rejected.length === 0 ? null : (
              <ul className="capability-list">
                {rejected.map((candidate) => (
                  <li className="capability-list__item" key={`${candidate.topic}-${candidate.rejection}`}>
                    <strong>{candidate.topic}</strong>: not asked ({candidate.rejection}). {candidate.explanation}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="brief-correction-title">
            <h3 className="panel__title" id="brief-correction-title">
              Record a correction
            </h3>
            <p className="panel__note">
              A correction appends the next version. The version it supersedes stays readable above, and any criterion it
              drops is named.
            </p>
            <p
              className={correctionState === 'refused' ? 'state-line state-line--error' : 'state-line'}
              role={correctionState === 'refused' ? 'alert' : 'status'}
              aria-live={correctionState === 'refused' ? 'assertive' : 'polite'}
              data-state={correctionState}
            >
              {correctionState === 'saving'
                ? 'Appending the correction…'
                : (correctionMessage ?? 'No correction has been recorded from this form.')}
            </p>
            <form className="form form--grid" noValidate onSubmit={(event) => void submitCorrection(event)}>
              <div className="field">
                <label className="field__label" htmlFor="correction-text">
                  What are you correcting, in your own words?
                </label>
                <textarea
                  className="field__input"
                  id="correction-text"
                  name="correction-text"
                  rows={3}
                  value={correctionText}
                  aria-required="true"
                  aria-invalid={correctionErrors['correction.text'] === undefined ? undefined : 'true'}
                  disabled={correctionState === 'saving'}
                  onChange={(event) => setCorrectionText(event.target.value)}
                />
                {correctionErrors['correction.text'] === undefined ? null : (
                  <p className="field__error">
                    <span className="field__error-mark" aria-hidden="true" />
                    Error: {correctionErrors['correction.text']}
                  </p>
                )}
              </div>
              <SectionFields
                form={correctionForm}
                onChange={setCorrectionForm}
                errors={correctionErrors}
                disabled={correctionState === 'saving'}
                prefix="correction"
              />
              <div className="form__actions">
                <button
                  className="button"
                  type="submit"
                  disabled={correctionState === 'saving' || brief === null || brief.current === null}
                >
                  {brief === null || brief.current === null
                    ? 'There is no brief to correct'
                    : correctionState === 'saving'
                      ? 'Appending…'
                      : `Append version ${brief.current.version + 1}`}
                </button>
              </div>
            </form>
          </section>
        </>
      )}
    </section>
  );
}