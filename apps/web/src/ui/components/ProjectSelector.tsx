import { useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react';
import { createProject, type ProjectSummary } from '../api-client.ts';
import type { ActiveProject, MvpFailure } from '../mvp-client.ts';

export interface ProjectSelectorProps {
  readonly projects: readonly ProjectSummary[];
  /**
   * The session's current selection, read from `session.owner.activeProject` (F02-AC1).
   *
   * Null means it has not been read yet, which is different from `NoProjectSelected` and is
   * rendered as its own wording rather than as "no project selected": one is a gap in what
   * this client knows and the other is a fact about the session.
   */
  readonly activeProject: ActiveProject | null;
  /** Writes the choice to the server. Resolves with the refusal if there was one (F02-AC4). */
  readonly onSelect: (projectId: string) => Promise<MvpFailure | null>;
  readonly onCreated: () => void;
  /**
   * Namespaces the control's element ids, so the same selector can appear in the header and
   * on the settings surface without emitting the same `id` twice - which would leave the
   * second label pointing at the first input (F01-AC3).
   */
  readonly idPrefix: string;
}

/**
 * Which project every project-scoped screen addresses (F02-AC1).
 *
 * This component exists because project identity was previously absent rather than chosen.
 * The session response carried no project, the pages took an empty string, and every request
 * they built from it went to `/api/profiles/undefined` - a project literally named
 * "undefined", which answered 404 and was reported as "that project has no saved profile yet".
 * A selector plus an explicit no-project state means a page either has a project to ask about
 * or says it has none, and neither case is a request for a name that does not exist (F02-AC4).
 *
 * Three properties the interaction keeps:
 *
 *   - **The selection is the server's.** Changing it writes
 *     `PUT /api/owner/active-project` and applies only what the server confirms, so a control
 *     cannot display a project the app is not addressing. A refused write snaps the control
 *     back to the project in force and prints the refusal beside it.
 *   - **A refusal destroys nothing.** The creation form keeps both typed fields and both are
 *     re-submittable after a rejection, because a refusal is an answer to what was sent, not
 *     a reason to make the owner retype it (N03-AC3).
 *   - **Creation is offered here** because it is the only project write that needs no
 *     configured provider: a profile save, a connector registration and a procedure append all
 *     refuse by name when no adapter declares the capability, so an owner who has configured
 *     nothing would otherwise have no project to select at all (F03-AC2).
 */
export function ProjectSelector({
  projects,
  activeProject,
  onSelect,
  onCreated,
  idPrefix,
}: ProjectSelectorProps): ReactElement {
  const [creating, setCreating] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);

  const selectedId = activeProject?.state === 'Selected' ? activeProject.activeProjectId : '';
  // A selection the project list does not hold is a disagreement between two server reads,
  // and the control must not resolve it by displaying whichever project happens to be first
  // in the list: that would show one project while every request addresses another, which is
  // the defect this selector was written to close (F02-AC1).
  const selectionMissing =
    activeProject?.state === 'Selected' && !projects.some((project) => project.projectId === activeProject.activeProjectId);

  const select = async (projectIdToSelect: string): Promise<void> => {
    if (projectIdToSelect === '' || selecting !== null) return;
    setSelecting(projectIdToSelect);
    setError(null);
    const failure = await onSelect(projectIdToSelect);
    setSelecting(null);
    // Nothing is applied here: `value` is bound to what the server confirmed, so a refused
    // write leaves the control showing the project that is really in force.
    if (failure !== null) setError(`${failure.reason} This session is still in ${describeSelected(activeProject)}.`);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (saving) return;
    if (projectId.trim() === '') {
      setError('A project needs an id. It is the name every request for that project uses.');
      return;
    }
    if (name.trim() === '') {
      setError('A project needs a name, so the selector does not offer the owner a bare id.');
      return;
    }
    setSaving(true);
    setError(null);
    void createProject({ projectId: projectId.trim(), name: name.trim() }).then((result) => {
      setSaving(false);
      if (!result.ok) {
        // Both fields are deliberately left as typed: the rejection names what was wrong with
        // them, and clearing them would make the owner retype a name they already chose.
        setError(result.error.reason);
        return;
      }
      const created = result.value.project.projectId;
      setProjectId('');
      setName('');
      setCreating(false);
      onCreated();
      void select(created);
    });
  };

  const selectId = `${idPrefix}-project-select`;

  return (
    <div className="project-selector">
      <label className="project-selector__label" htmlFor={selectId}>
        Project
      </label>
      <select
        id={selectId}
        className="project-selector__select"
        value={selectedId}
        disabled={selecting !== null}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => void select(event.target.value)}
      >
        {/*
          The empty option is a real state, not a placeholder: it is what "no project is
          selected" means, and it is the state a signed-in owner with no project is in. It is
          disabled because the selection write refuses null - "no project selected" is reached
          by never choosing one, not by asking to choose nothing (F02-AC4).
        */}
        <option value="" disabled>
          {activeProject === null ? 'Which project this session is in has not been read yet' : 'No project selected'}
        </option>
        {selectionMissing ? (
          <option value={selectedId}>{`${activeProject.activeProjectName} (${selectedId}) — not in the project list`}</option>
        ) : null}
        {projects.map((project) => (
          <option key={project.projectId} value={project.projectId}>
            {project.name} ({project.projectId})
          </option>
        ))}
      </select>
      {selecting !== null ? (
        <span className="state-line" role="status" data-state="loading">
          Selecting…
        </span>
      ) : null}
      {error !== null ? (
        <p className="state-line state-line--error" role="alert" data-state="failed">
          {error}
        </p>
      ) : null}
      {creating ? (
        <form className="project-selector__form" onSubmit={submit} noValidate>
          <label className="project-selector__label" htmlFor={`${idPrefix}-project-id`}>
            Project id
          </label>
          <input
            id={`${idPrefix}-project-id`}
            className="project-selector__input"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="one-word-id, no slashes"
            disabled={saving}
          />
          <label className="project-selector__label" htmlFor={`${idPrefix}-project-name`}>
            Project name
          </label>
          <input
            id={`${idPrefix}-project-name`}
            className="project-selector__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="What this project is called"
            disabled={saving}
          />
          <div className="project-selector__actions">
            <button className="button" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create project'}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={saving}
              onClick={() => {
                setCreating(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          className="button button--secondary"
          type="button"
          onClick={() => {
            setCreating(true);
            setError(null);
          }}
        >
          New project
        </button>
      )}
    </div>
  );
}

/**
 * What the session is in, in words a refusal message can end with.
 *
 * "The project in force is not known yet" rather than a blank or an invented name: this
 * string exists only to finish a sentence about a state the client may not have read (F02-AC1).
 */
function describeSelected(activeProject: ActiveProject | null): string {
  if (activeProject === null) return 'a project that has not been read yet';
  if (activeProject.state === 'Selected') return `${activeProject.activeProjectName} (${activeProject.activeProjectId})`;
  return 'no project';
}