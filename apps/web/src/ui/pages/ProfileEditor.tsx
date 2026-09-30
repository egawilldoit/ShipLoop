import { useState, type FormEvent, type ReactElement } from 'react';
import { createProfile, fieldMessages, type CreateProfileResponse } from '../api-client.ts';
import { Field } from '../components/Field.tsx';

interface ProfileFormState {
  readonly name: string;
  readonly provider: string;
  readonly repositoryUrl: string;
  readonly repositoryFullName: string;
  readonly ticketTeamKey: string;
  readonly ticketStateMapping: string;
  readonly targetBranch: string;
  readonly engineImage: string;
  readonly engineSandbox: 'Restricted' | 'Standard';
  readonly requiredChecks: string;
  readonly previewEnvironment: string;
  readonly deliveryStrategy: 'PullRequest' | 'DraftThenMerge';
  readonly deliveryRequiresAcceptance: boolean;
}

const EMPTY_FORM: ProfileFormState = {
  name: '',
  provider: '',
  repositoryUrl: '',
  repositoryFullName: '',
  ticketTeamKey: '',
  ticketStateMapping: 'Todo,In Progress,Done',
  targetBranch: 'main',
  engineImage: '',
  engineSandbox: 'Restricted',
  requiredChecks: '',
  previewEnvironment: '',
  deliveryStrategy: 'PullRequest',
  deliveryRequiresAcceptance: true,
};

export interface ProfileEditorProps {
  readonly projectId: string;
  readonly onSaved: (created: CreateProfileResponse) => void;
  readonly onCancel: () => void;
}

/**
 * The form that creates a saved profile (F02-AC1).
 *
 * Its whole purpose is that a rejected save costs the owner nothing: the typed values stay
 * exactly as they were, the server's per-field messages land beside the inputs they name,
 * and a refusal with no field attached is reported separately rather than being folded into
 * a generic banner (F02-AC4, N03-AC3).
 *
 * Missing required fields are reported before a request is sent, but the client never
 * decides that a value is acceptable on the owner's behalf: an unsupported capability or a
 * provider the server does not know is answered by the server, which is the only side that
 * knows what it supports.
 */
export function ProfileEditor({ projectId, onSaved, onCancel }: ProfileEditorProps): ReactElement {
  const [form, setForm] = useState<ProfileFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]): void {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function validate(candidate: ProfileFormState): Record<string, string> {
    const found: Record<string, string> = {};
    if (candidate.name.trim() === '') found['name'] = 'Give the profile a name you will recognise later.';
    if (candidate.provider.trim() === '') found['provider'] = 'Name the repository provider, for example GitHub.';
    if (candidate.repositoryUrl.trim() === '') {
      found['repositoryUrl'] = 'Enter the repository URL new work will clone.';
    } else if (!/^https:\/\/\S+$/.test(candidate.repositoryUrl.trim())) {
      found['repositoryUrl'] = 'Enter a full https URL, for example https://github.com/owner/repo.';
    }
    if (candidate.repositoryFullName.trim() === '') {
      found['repositoryFullName'] = 'Enter the owner and repository name, for example owner/repo.';
    }
    if (candidate.ticketTeamKey.trim() === '') {
      found['ticketTeamKey'] = 'Map a ticket team key so work can be published to the right team.';
    }
    if (candidate.targetBranch.trim() === '') found['targetBranch'] = 'Enter the branch new work targets.';
    if (candidate.engineImage.trim() === '') found['engineImage'] = 'Name the engine image work runs inside.';
    return found;
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;

    const local = validate(form);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      setSummary('This profile was not saved because required fields are missing or malformed.');
      return;
    }

    setSaving(true);
    setSummary(null);
    const result = await createProfile({
      projectId,
      name: form.name.trim(),
      provider: form.provider.trim(),
      repositoryUrl: form.repositoryUrl.trim(),
      repositoryFullName: form.repositoryFullName.trim(),
      ticketTeamKey: form.ticketTeamKey.trim(),
      ticketStateMapping: form.ticketStateMapping.trim(),
      targetBranch: form.targetBranch.trim(),
      engineImage: form.engineImage.trim(),
      engineSandbox: form.engineSandbox,
      requiredChecks: form.requiredChecks.split(',').map((check) => check.trim()).filter((check) => check !== ''),
      previewEnvironment: form.previewEnvironment.trim(),
      deliveryStrategy: form.deliveryStrategy,
      deliveryRequiresAcceptance: form.deliveryRequiresAcceptance,
    });
    setSaving(false);

    if (!result.ok) {
      setErrors(fieldMessages(result.error));
      setSummary(result.error.reason);
      return;
    }
    setErrors({});
    onSaved(result.value);
  };

  return (
    <section className="panel" aria-labelledby="profile-editor-title">
      <h3 className="panel__title" id="profile-editor-title">
        Add a profile
      </h3>
      <p
        className={summary === null ? 'state-line' : 'state-line state-line--error'}
        role={summary === null ? 'status' : 'alert'}
        aria-live={summary === null ? 'polite' : 'assertive'}
        data-state={summary === null ? 'idle' : 'error'}
      >
        {summary ?? (saving ? 'Saving the profile…' : 'Nothing has been saved yet.')}
      </p>
      <form className="form form--grid" noValidate onSubmit={(event) => void submit(event)}>
        <Field
          id="name"
          label="Profile name"
          value={form.name}
          onChange={(value) => set('name', value)}
          error={errors['name']}
          required
          disabled={saving}
        />
        <Field
          id="provider"
          label="Repository provider"
          value={form.provider}
          onChange={(value) => set('provider', value)}
          hint="The provider that hosts the repository."
          error={errors['provider']}
          required
          disabled={saving}
        />
        <Field
          id="repositoryUrl"
          label="Repository URL"
          type="url"
          value={form.repositoryUrl}
          onChange={(value) => set('repositoryUrl', value)}
          error={errors['repositoryUrl']}
          required
          disabled={saving}
        />
        <Field
          id="repositoryFullName"
          label="Repository full name"
          value={form.repositoryFullName}
          onChange={(value) => set('repositoryFullName', value)}
          hint="owner/repo, as the provider spells it."
          error={errors['repositoryFullName']}
          required
          disabled={saving}
        />
        <Field
          id="ticketTeamKey"
          label="Ticket team key"
          value={form.ticketTeamKey}
          onChange={(value) => set('ticketTeamKey', value)}
          hint="The team new issues are published to."
          error={errors['ticketTeamKey']}
          required
          disabled={saving}
        />
        <Field
          id="ticketStateMapping"
          label="Ticket state mapping"
          value={form.ticketStateMapping}
          onChange={(value) => set('ticketStateMapping', value)}
          hint="Provider states mapped to the shipped lifecycle, comma separated."
          error={errors['ticketStateMapping']}
          disabled={saving}
        />
        <Field
          id="targetBranch"
          label="Target branch"
          value={form.targetBranch}
          onChange={(value) => set('targetBranch', value)}
          error={errors['targetBranch']}
          required
          disabled={saving}
        />
        <Field
          id="engineImage"
          label="Engine image"
          value={form.engineImage}
          onChange={(value) => set('engineImage', value)}
          hint="The image coding work runs in."
          error={errors['engineImage']}
          required
          disabled={saving}
        />

        <div className="field">
          <label className="field__label" htmlFor="engineSandbox">
            Engine sandbox policy
          </label>
          <select
            className="field__input"
            id="engineSandbox"
            name="engineSandbox"
            value={form.engineSandbox}
            aria-invalid={errors['engineSandbox'] === undefined ? undefined : 'true'}
            aria-describedby={
              errors['engineSandbox'] === undefined ? 'engineSandbox-hint' : 'engineSandbox-hint engineSandbox-error'
            }
            disabled={saving}
            onChange={(event) => set('engineSandbox', event.target.value === 'Standard' ? 'Standard' : 'Restricted')}
          >
            <option value="Restricted">Restricted</option>
            <option value="Standard">Standard</option>
          </select>
          <p className="field__hint" id="engineSandbox-hint">
            Restricted keeps the coding engine unable to reach the host.
          </p>
          {errors['engineSandbox'] === undefined ? null : (
            <p className="field__error" id="engineSandbox-error">
              <span className="field__error-mark" aria-hidden="true" />
              Error: {errors['engineSandbox']}
            </p>
          )}
        </div>

        <Field
          id="requiredChecks"
          label="Required checks"
          value={form.requiredChecks}
          onChange={(value) => set('requiredChecks', value)}
          hint="Check names that must pass before delivery, comma separated."
          error={errors['requiredChecks']}
          disabled={saving}
        />
        <Field
          id="previewEnvironment"
          label="Preview environment"
          value={form.previewEnvironment}
          onChange={(value) => set('previewEnvironment', value)}
          hint="Where preview components are deployed."
          error={errors['previewEnvironment']}
          disabled={saving}
        />

        <div className="field">
          <label className="field__label" htmlFor="deliveryStrategy">
            Delivery behaviour
          </label>
          <select
            className="field__input"
            id="deliveryStrategy"
            name="deliveryStrategy"
            value={form.deliveryStrategy}
            aria-invalid={errors['deliveryStrategy'] === undefined ? undefined : 'true'}
            aria-describedby={
              errors['deliveryStrategy'] === undefined
                ? 'deliveryStrategy-hint'
                : 'deliveryStrategy-hint deliveryStrategy-error'
            }
            disabled={saving}
            onChange={(event) =>
              set('deliveryStrategy', event.target.value === 'DraftThenMerge' ? 'DraftThenMerge' : 'PullRequest')
            }
          >
            <option value="PullRequest">PullRequest</option>
            <option value="DraftThenMerge">DraftThenMerge</option>
          </select>
          <p className="field__hint" id="deliveryStrategy-hint">
            DraftThenMerge writes a draft first and merges only after delivery is authorized.
          </p>
          {errors['deliveryStrategy'] === undefined ? null : (
            <p className="field__error" id="deliveryStrategy-error">
              <span className="field__error-mark" aria-hidden="true" />
              Error: {errors['deliveryStrategy']}
            </p>
          )}
        </div>

        <div className="field field--check">
          <input
            className="field__checkbox"
            id="deliveryRequiresAcceptance"
            name="deliveryRequiresAcceptance"
            type="checkbox"
            checked={form.deliveryRequiresAcceptance}
            aria-invalid={errors['deliveryRequiresAcceptance'] === undefined ? undefined : 'true'}
            aria-describedby={
              errors['deliveryRequiresAcceptance'] === undefined ? undefined : 'deliveryRequiresAcceptance-error'
            }
            disabled={saving}
            onChange={(event) => set('deliveryRequiresAcceptance', event.target.checked)}
          />
          <label className="field__label" htmlFor="deliveryRequiresAcceptance">
            Require owner acceptance before delivery
          </label>
        </div>
        {errors['deliveryRequiresAcceptance'] === undefined ? null : (
          <p className="field__error" id="deliveryRequiresAcceptance-error">
            <span className="field__error-mark" aria-hidden="true" />
            Error: {errors['deliveryRequiresAcceptance']}
          </p>
        )}

        <div className="form__actions">
          <button className="button" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
          <button className="button button--secondary" type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
