/**
 * Settings: every piece of technical configuration the product needs, in one place.
 *
 * The MVP has four sections — Project, GitHub, optional Linear, optional T3 address — and the point
 * of collecting them here is that **normal work never routes through configuration**. There is no
 * connector page in the journey any more: an owner records a request, writes a contract, hands it
 * off and reviews a candidate without ever being sent somewhere to configure a provider first.
 *
 * Three decisions are visible on this page rather than buried:
 *
 *   - **GitHub is required, Linear and T3 are not.** The page says so. A missing optional connector
 *     must never make Request -> Contract -> PR -> Review -> Decision impossible, so neither
 *     optional section can gate anything, and Linear being absent is stated as a fact rather than
 *     rendered as an empty form that looks unfinished.
 *   - **No secret is ever typed into this page.** The GitHub field is a *credential reference* —
 *     the name of where the secret lives, such as `env:REPO_TOKEN` — never the secret itself. A
 *     product that accepted a token into a browser form would have it in browser history, in a
 *     screenshot and in whatever this form posts.
 *   - **The T3 address is the server's to validate.** It is stored here and validated on save. The
 *     browser does not re-check it: a second, weaker check in the client could only ever disagree
 *     with the one that will actually be followed, and the disagreement would be invisible.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { createProject, type ProjectSummary } from '../../api-client.ts';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge.tsx';
import { fetchSettings, saveSettings } from '../client.ts';
import { Panel, StateLine, type ViewState } from '../components/StateLine.tsx';
import type { ConnectorSetting, ProjectSettings } from '../wire.ts';

export interface SettingsPageProps {
  readonly projects: readonly ProjectSummary[];
  readonly selectedProjectId: string | null;
  readonly epoch: number;
  readonly onSelectProject: (projectId: string) => void;
  readonly onProjectsChanged: () => void;
}

const CONNECTOR_TONES: Readonly<Record<ConnectorSetting['state'], StatusTone>> = {
  Configured: 'healthy',
  NotConfigured: 'unconfigured',
  Error: 'revoked',
};

const CONNECTOR_MEANING: Readonly<Record<ConnectorSetting['state'], string>> = {
  Configured: 'A credential reference is recorded and the last check succeeded.',
  NotConfigured: 'No credential reference is recorded, so this provider cannot be read or written.',
  Error: 'The last check against this provider failed. The detail below says what.',
};

interface Draft {
  readonly name: string;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly githubCredentialReference: string;
  readonly linearTeamKey: string;
  readonly t3Url: string;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  repositoryUrl: '',
  baseBranch: 'main',
  githubCredentialReference: '',
  linearTeamKey: '',
  t3Url: '',
};

function draftFrom(settings: ProjectSettings): Draft {
  return {
    name: settings.name,
    repositoryUrl: settings.github.repositoryUrl,
    baseBranch: settings.github.baseBranch,
    githubCredentialReference: settings.github.connector.credentialReference ?? '',
    linearTeamKey: settings.linear?.teamKey ?? '',
    t3Url: settings.t3Url ?? '',
  };
}

/**
 * A null-or-empty value, as the save body needs it.
 *
 * Optional fields are sent as `null` when the owner cleared them. Sending `""` instead would leave
 * the server to decide whether a blank team key means "unconfigured" or "configured with a blank
 * team", and those are two different records.
 */
function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function SettingsPage({
  projects,
  selectedProjectId,
  epoch,
  onSelectProject,
  onProjectsChanged,
}: SettingsPageProps): ReactElement {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [view, setView] = useState<ViewState>('loading');
  const [message, setMessage] = useState('Reading your settings…');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [creating, setCreating] = useState(false);
  const [newProjectId, setNewProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    if (selectedProjectId === null) {
      setSettings(null);
      setDraft(EMPTY_DRAFT);
      setView('empty');
      setMessage(
        projects.length === 0
          ? 'There is no project yet. Create one below; everything else on this page needs one.'
          : 'No project is selected. Choose one below to configure it.',
      );
      return;
    }
    let current = true;
    setView('loading');
    void fetchSettings(selectedProjectId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setSettings(null);
        setDraft(EMPTY_DRAFT);
        setMessage(`These settings could not be read: ${result.error.reason}`);
        setView(result.error.code === 'NotFound' ? 'empty' : 'error');
        return;
      }
      setSettings(result.value.settings);
      setDraft(draftFrom(result.value.settings));
      setView('ready');
      setMessage(`Settings for ${result.value.settings.name} (${result.value.settings.projectId}).`);
    });
    return () => {
      current = false;
    };
  }, [selectedProjectId, epoch, reload, projects.length]);

  const patch = (changes: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...changes }));
  };

  const submitSettings = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving || selectedProjectId === null) return;
    setSaving(true);
    setSaveMessage(null);
    setSaveFailure(null);
    const result = await saveSettings(selectedProjectId, {
      name: draft.name.trim(),
      repositoryUrl: draft.repositoryUrl.trim(),
      baseBranch: draft.baseBranch.trim() === '' ? 'main' : draft.baseBranch.trim(),
      githubCredentialReference: optional(draft.githubCredentialReference),
      linearTeamKey: optional(draft.linearTeamKey),
      t3Url: optional(draft.t3Url),
    });
    setSaving(false);
    if (!result.ok) {
      setSaveFailure(`These settings were not saved: ${result.error.reason}`);
      return;
    }
    setSettings(result.value.settings);
    setDraft(draftFrom(result.value.settings));
    setSaveMessage(
      `Saved. ${result.value.settings.github.connector.configured ? 'GitHub is configured.' : 'GitHub is not configured, so a pull request cannot be linked yet.'}${
        result.value.settings.linear === null ? ' Linear is not configured, which is allowed.' : ' Linear is configured.'
      }`,
    );
    onProjectsChanged();
  };

  const submitProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (creatingBusy) return;
    if (newProjectId.trim() === '') {
      setCreateError('A project needs an id. It is the name every request for that project uses.');
      return;
    }
    if (newProjectName.trim() === '') {
      setCreateError('A project needs a name, so the selector does not offer a bare id.');
      return;
    }
    setCreatingBusy(true);
    setCreateError(null);
    const result = await createProject({ projectId: newProjectId.trim(), name: newProjectName.trim() });
    setCreatingBusy(false);
    if (!result.ok) {
      setCreateError(result.error.reason);
      return;
    }
    setNewProjectId('');
    setNewProjectName('');
    setCreating(false);
    onProjectsChanged();
    onSelectProject(result.value.project.projectId);
    setReload((count) => count + 1);
  };

  return (
    <section className="page" aria-labelledby="settings-title">
      <h2 className="page__title" id="settings-title">
        Settings
      </h2>
      <p className="panel__note">
        Everything technical lives here, so no part of the journey asks you to configure a provider
        before you can do the next thing.
      </p>

      <StateLine view={view} message={message} testId="settings-state" />
      {view === 'error' ? (
        <div className="form__actions">
          <button className="button button--secondary" type="button" data-testid="settings-retry" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}

      <Panel
        id="settings-project"
        title="Project"
        note="A project is the unit every request, contract and candidate belongs to. You can have as many as you need."
      >
        {projects.length === 0 ? (
          <StateLine view="empty" message="No projects exist yet." testId="settings-no-projects" />
        ) : (
          <div className="field">
            <label className="field__label" htmlFor="settings-project-select">
              Project
            </label>
            <select
              className="field__input"
              id="settings-project-select"
              value={selectedProjectId ?? ''}
              onChange={(event) => onSelectProject(event.target.value)}
              data-testid="settings-project-select"
            >
              <option value="">No project selected</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name} ({project.projectId})
                </option>
              ))}
            </select>
          </div>
        )}
        {creating ? (
          <form className="form" noValidate onSubmit={(event) => void submitProject(event)}>
            <div className="field">
              <label className="field__label" htmlFor="settings-new-project-id">
                Project id
              </label>
              <input
                className="field__input"
                id="settings-new-project-id"
                value={newProjectId}
                disabled={creatingBusy}
                placeholder="one-word-id, no slashes"
                onChange={(event) => setNewProjectId(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="settings-new-project-name">
                Project name
              </label>
              <input
                className="field__input"
                id="settings-new-project-name"
                value={newProjectName}
                disabled={creatingBusy}
                onChange={(event) => setNewProjectName(event.target.value)}
              />
            </div>
            {createError === null ? null : (
              <StateLine view="error" message={createError} testId="settings-create-error" />
            )}
            <div className="form__actions">
              <button className="button" type="submit" disabled={creatingBusy} data-testid="settings-create-project">
                {creatingBusy ? 'Creating…' : 'Create project'}
              </button>
              <button
                className="button button--secondary"
                type="button"
                disabled={creatingBusy}
                onClick={() => {
                  setCreating(false);
                  setCreateError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="form__actions">
            <button
              className="button button--secondary"
              type="button"
              data-testid="settings-new-project"
              onClick={() => setCreating(true)}
            >
              New project
            </button>
          </div>
        )}
      </Panel>

      {settings === null ? null : (
        <form className="form form--grid" noValidate onSubmit={(event) => void submitSettings(event)}>
          <Panel id="settings-github" title="GitHub" note="Required. Without a repository and a credential reference, no pull request can be linked and there is nothing to verify.">
            <StatusBadge
              tone={CONNECTOR_TONES[settings.github.connector.state]}
              label={`GitHub: ${settings.github.connector.state}`}
              detail={
                settings.github.connector.detail === null
                  ? CONNECTOR_MEANING[settings.github.connector.state]
                  : `${CONNECTOR_MEANING[settings.github.connector.state]} ${settings.github.connector.detail}`
              }
            />
            <div className="field">
              <label className="field__label" htmlFor="settings-name">
                Project name
              </label>
              <input
                className="field__input"
                id="settings-name"
                value={draft.name}
                disabled={saving}
                aria-required="true"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="settings-repository-url">
                Repository
              </label>
              <input
                className="field__input"
                id="settings-repository-url"
                type="url"
                value={draft.repositoryUrl}
                disabled={saving}
                placeholder="https://github.com/owner/name"
                onChange={(event) => patch({ repositoryUrl: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="settings-base-branch">
                Base branch
              </label>
              <input
                className="field__input"
                id="settings-base-branch"
                value={draft.baseBranch}
                disabled={saving}
                onChange={(event) => patch({ baseBranch: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="settings-github-credential">
                GitHub credential reference
              </label>
              <input
                className="field__input"
                id="settings-github-credential"
                value={draft.githubCredentialReference}
                disabled={saving}
                placeholder="env:REPO_TOKEN"
                aria-describedby="settings-github-credential-hint"
                onChange={(event) => patch({ githubCredentialReference: event.target.value })}
              />
              <p className="field__hint" id="settings-github-credential-hint">
                The name of where the secret lives, not the secret. A token typed into a browser form ends up
                in history, in screenshots and in whatever this form posts, so this field never accepts one.
              </p>
            </div>
          </Panel>

          <Panel
            id="settings-linear"
            title="Linear (optional)"
            note="Optional by design. ShipLoop's journey does not depend on a ticket tracker, and a missing Linear must never stand between a request and a decision."
          >
            <StatusBadge
              tone={settings.linear === null ? 'unconfigured' : CONNECTOR_TONES[settings.linear.connector.state]}
              label={settings.linear === null ? 'Linear: not configured' : `Linear: ${settings.linear.connector.state}`}
              detail={
                settings.linear === null
                  ? 'No Linear configuration is recorded. Every other step still works without one.'
                  : settings.linear.connector.detail === null
                    ? CONNECTOR_MEANING[settings.linear.connector.state]
                    : `${CONNECTOR_MEANING[settings.linear.connector.state]} ${settings.linear.connector.detail}`
              }
            />
            <div className="field">
              <label className="field__label" htmlFor="settings-linear-team">
                Linear team key (optional)
              </label>
              <input
                className="field__input"
                id="settings-linear-team"
                value={draft.linearTeamKey}
                disabled={saving}
                placeholder="ENG"
                onChange={(event) => patch({ linearTeamKey: event.target.value })}
              />
              <p className="field__hint">Leave this empty to record no Linear configuration at all.</p>
            </div>
          </Panel>

          <Panel
            id="settings-t3"
            title="T3 address (optional)"
            note="Optional. With no address configured the handoff offers no T3 link and says so; with one, the handoff offers it and opens it in a new tab."
          >
            <div className="field">
              <label className="field__label" htmlFor="settings-t3-url">
                T3 address
              </label>
              <input
                className="field__input"
                id="settings-t3-url"
                type="url"
                value={draft.t3Url}
                disabled={saving}
                placeholder="https://t3.example.invalid"
                aria-describedby="settings-t3-url-hint"
                onChange={(event) => patch({ t3Url: event.target.value })}
              />
              <p className="field__hint" id="settings-t3-url-hint">
                Checked when you save, and stored only if it passes. Nothing is sent to it and nothing is
                started there: it is a link on your handoff page.
              </p>
            </div>
            <StateLine
              view={settings.t3Url === null ? 'empty' : 'ready'}
              message={
                settings.t3Url === null
                  ? 'No T3 address is configured, so the handoff will state that rather than offering a link.'
                  : `Configured: ${settings.t3Url}`
              }
              testId="settings-t3-state"
            />
          </Panel>

          {saveFailure === null ? null : (
            <StateLine view="error" message={saveFailure} testId="settings-save-failure" />
          )}
          {saveMessage === null ? null : (
            <StateLine view="ready" message={saveMessage} testId="settings-save-message" />
          )}

          <div className="form__actions">
            <button className="button" type="submit" disabled={saving} data-testid="settings-save">
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}