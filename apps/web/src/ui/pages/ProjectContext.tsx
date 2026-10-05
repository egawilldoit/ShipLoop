/**
 * The two screens that answer "which project is this?", for the two states in which that
 * question has to be asked.
 *
 * They live in one file because they are one fact seen from two sides: `NoProjectState` is
 * what the shell renders *instead of* a project-scoped surface when the session has no
 * project, and `SettingsSurface` is the primary navigation's home for the same fact when it
 * does. Splitting them would put the wording about project identity in two files that could
 * disagree about it.
 *
 * Why there is a no-project state at all, rather than a page that quietly loads:
 *
 *   - Every MVP surface is project-scoped, and the project comes from
 *     `session.owner.activeProject` with a state of `Selected` or `NoProjectSelected`. There
 *     is no placeholder project and no default project id, so an unselected session has
 *     nothing to address a request with. Rendering a board anyway would mean inventing one -
 *     which is precisely how this product ended up asking about a project named `undefined`
 *     and reporting the server's honest 404 as "that project has no saved profile yet"
 *     (F02-AC1, F02-AC4).
 *   - "Not read yet" and "read, and there is none" are different facts. The first is a gap in
 *     what this client knows and the second is a statement about the session, so they get
 *     different words and different controls: a gap offers a re-read, and a real absence
 *     offers a choice.
 *
 * `SettingsSurface` also carries a slot for the project settings surface, which reads
 * `GET /api/projects/:projectId/settings`. The slot is empty here on purpose: this shell owns
 * project identity, not project settings, and rendering a settings panel that reads a route
 * no one has wired a screen to would be a control promising content it cannot deliver.
 */

import type { ReactElement } from 'react';
import { ProjectSelector } from '../components/ProjectSelector.tsx';
import type { ProjectSummary } from '../api-client.ts';
import type { ActiveProject, MvpFailure } from '../mvp-client.ts';

export interface NoProjectStateProps {
  /**
   * The session's selection, or null when it has not been read.
   *
   * Both states are accepted here rather than at the call site so this component can say which
   * of the two it is showing, instead of one caller rendering "no project selected" for a
   * request that never completed.
   */
  readonly activeProject: ActiveProject | null;
  readonly projects: readonly ProjectSummary[];
  readonly onSelect: (projectId: string) => Promise<MvpFailure | null>;
  readonly onCreated: () => void;
  readonly onReload: () => void;
}

export function NoProjectState({
  activeProject,
  projects,
  onSelect,
  onCreated,
  onReload,
}: NoProjectStateProps): ReactElement {
  if (activeProject === null) {
    return (
      <section className="page page--narrow" aria-labelledby="no-project-title">
        <h2 className="page__title" id="no-project-title">
          ShipLoop
        </h2>
        <p className="state-line state-line--warn" role="status" data-state="unread">
          This browser has not been able to read which project the session is in, so there is nothing to show. No
          request has been sent for a project this client cannot name.
        </p>
        <div className="form__actions">
          <button className="button" type="button" onClick={onReload}>
            Read again
          </button>
        </div>
      </section>
    );
  }

  // Narrowed once, because both arms of this screen are about the `NoProjectSelected` arm and
  // reading the count off the union without narrowing would be the one place a client could
  // invent a project count (F02-AC1).
  if (activeProject.state !== 'NoProjectSelected') {
    return (
      <section className="page page--narrow" aria-labelledby="no-project-title">
        <h2 className="page__title" id="no-project-title">
          Choose a project
        </h2>
        <p className="state-line" role="status" data-state="ready">
          This session is already in {activeProject.activeProjectName}. Use the project control to change it.
        </p>
        <ProjectSelector
          projects={projects}
          activeProject={activeProject}
          onSelect={onSelect}
          onCreated={onCreated}
          idPrefix="onboarding"
        />
      </section>
    );
  }

  const none = activeProject.selectableProjectCount === 0;

  return (
    <section className="page page--narrow" aria-labelledby="no-project-title">
      <h2 className="page__title" id="no-project-title">
        Choose a project
      </h2>
      {none ? (
        <>
          <p className="state-line" role="status" data-state="empty">
            This deployment holds no projects yet. Create the first one below; every request, contract and candidate
            belongs to exactly one project, so there is nothing to show until one exists.
          </p>
          <ProjectSelector
            projects={projects}
            activeProject={activeProject}
            onSelect={onSelect}
            onCreated={onCreated}
            idPrefix="onboarding"
          />
        </>
      ) : (
        <>
          <p className="state-line" role="status" data-state="empty">
            This session is signed in but has no project selected, so there is nothing to show. Choose one of the{' '}
            {activeProject.selectableProjectCount}{' '}
            {activeProject.selectableProjectCount === 1 ? 'project' : 'projects'} below, or create another. The
            choice is stored on the server, so it survives a reload.
          </p>
          <ProjectSelector
            projects={projects}
            activeProject={activeProject}
            onSelect={onSelect}
            onCreated={onCreated}
            idPrefix="onboarding"
          />
        </>
      )}
    </section>
  );
}

export interface SettingsSurfaceProps {
  readonly activeProject: ActiveProject;
  readonly projects: readonly ProjectSummary[];
  readonly onSelect: (projectId: string) => Promise<MvpFailure | null>;
  readonly onCreated: () => void;
}

/**
 * The project context, as the primary navigation's Settings surface.
 *
 * Scoped to what this shell can answer truthfully: which project the session addresses, read
 * from `session.owner.activeProject` rather than assembled here, and how to change it. The
 * settings a project itself carries - its repository, its required checks, the address of the
 * external tool - belong to a surface that reads `GET /api/projects/:projectId/settings`, and
 * the slot for it is marked below rather than filled with a panel that would have nothing to
 * show.
 */
export function SettingsSurface({ activeProject, projects, onSelect, onCreated }: SettingsSurfaceProps): ReactElement {
  return (
    <section className="page" aria-labelledby="settings-title">
      <h2 className="page__title" id="settings-title">
        Settings
      </h2>
      <section className="panel" aria-labelledby="settings-project-title">
        <h3 className="panel__title" id="settings-project-title">
          Project
        </h3>
        <p className="panel__note">
          Which project this session addresses is read from the session and stored on the server, so a reload or a
          second tab acts on the same project rather than on whatever a page last had in memory.
        </p>
        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>Selected project</dt>
            <dd>
              {activeProject.state === 'Selected'
                ? `${activeProject.activeProjectName} (${activeProject.activeProjectId})`
                : 'No project is selected. Choose one below.'}
            </dd>
          </div>
          <div className="detail-list__row">
            <dt>Projects available</dt>
            <dd>
              {activeProject.state === 'NoProjectSelected'
                ? `${activeProject.selectableProjectCount} ${
                    activeProject.selectableProjectCount === 1 ? 'project' : 'projects'
                  } available to choose.`
                : `${projects.length} ${projects.length === 1 ? 'project' : 'projects'} read from the server.`}
            </dd>
          </div>
        </dl>
        <ProjectSelector
          projects={projects}
          activeProject={activeProject}
          onSelect={onSelect}
          onCreated={onCreated}
          idPrefix="settings"
        />
      </section>
      {/*
        Slot for the project settings surface, which reads
        `GET /api/projects/:projectId/settings`. Nothing is rendered here: a panel whose only
        content would be a route no screen reads is a control that promises content it cannot
        deliver, and its absence says so.
      */}
    </section>
  );
}