import { useEffect, useState, type ReactElement } from 'react';
import {
  LIVE_REFRESH_MS,
  fetchProfiles,
  fetchProfileVersions,
  formatRelativeTime,
  formatTimestamp,
  type ProfileSummary,
  type ProfileVerificationState,
  type ProfileVersion,
} from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';
import { ProfileEditor } from './ProfileEditor.tsx';

export interface ProfilesPageProps {
  readonly projectId: string;
  readonly activeProfileId: string;
  readonly onSelectProfile: (profileId: string, label: string) => void;
  readonly epoch: number;
}

const VERIFICATION_TONES: Readonly<Record<ProfileVerificationState, StatusTone>> = {
  Verified: 'healthy',
  Pending: 'pending',
  Unverified: 'degraded',
};

function versionOf(versions: readonly ProfileVersion[], versionId: string): ProfileVersion | null {
  return versions.find((version) => version.versionId === versionId) ?? null;
}

/**
 * The saved profiles and the context new work will run under.
 *
 * Switching profiles here is the only thing that changes the context for new work, so the
 * chosen profile is stated explicitly - repository, branch, version - rather than left for
 * the owner to infer from a highlight (F02-AC2). Version history is shown with each
 * version's verification state, because a profile that is merely saved is not the same as
 * a profile known to be usable, and a run references the version that was selected (F02-AC3).
 *
 * The list polls rather than waiting for a manual refresh, so a milestone persisted
 * elsewhere becomes visible inside the five second budget N04-AC2 sets. A failed poll
 * leaves the previous list on screen and reports the failure: blanking the list would
 * destroy context the owner already had.
 */
export function ProfilesPage({
  projectId,
  activeProfileId,
  onSelectProfile,
  epoch,
}: ProfilesPageProps): ReactElement {
  const [profiles, setProfiles] = useState<readonly ProfileSummary[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [versions, setVersions] = useState<readonly ProfileVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (projectId === '') return;
    let current = true;
    const load = async (): Promise<void> => {
      const result = await fetchProfiles(projectId);
      if (!current) return;
      if (result.ok) {
        setProfiles(result.value.profiles);
        setProfilesError(null);
      } else {
        setProfilesError(result.error.reason);
      }
    };
    void load();
    const timer = setInterval(() => void load(), LIVE_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [projectId, epoch, reload]);

  useEffect(() => {
    if (projectId === '') return;
    let current = true;
    const load = async (): Promise<void> => {
      const result = await fetchProfileVersions(projectId);
      if (!current) return;
      if (result.ok) {
        setVersions(result.value.versions);
        setVersionsError(null);
      } else {
        setVersionsError(result.error.reason);
      }
    };
    void load();
    const timer = setInterval(() => void load(), LIVE_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [projectId, epoch, reload]);

  const known = profiles ?? [];
  const selected = known.find((profile) => profile.profileId === activeProfileId) ?? known[0] ?? null;

  useEffect(() => {
    if (selected === null || selected.profileId === activeProfileId) return;
    onSelectProfile(selected.profileId, `${selected.projectName} / ${selected.name}`);
  }, [selected, activeProfileId, onSelectProfile]);
  const selectedVersions =
    versions === null || selected === null
      ? []
      : versions
          .filter((version) => version.profileId === selected.profileId)
          .slice()
          .sort((left, right) => right.revision - left.revision);
  const selectedVersion = selected === null ? null : versionOf(selectedVersions, selected.currentVersionId);
  const laterChanges = selectedVersions.filter((version) => version.revision > (selectedVersion?.revision ?? 0)).length;

  const nowMs = Date.now();

  const profileState: 'loading' | 'empty' | 'ready' | 'error' =
    profilesError !== null ? 'error' : profiles === null ? 'loading' : known.length === 0 ? 'empty' : 'ready';
  const profileStateText =
    profileState === 'error'
      ? `The profile list could not be loaded: ${profilesError ?? 'unknown reason'}`
      : profileState === 'loading'
        ? 'Loading saved profiles…'
        : profileState === 'empty'
          ? 'No profiles are saved for this project yet.'
          : `${known.length} ${known.length === 1 ? 'profile is' : 'profiles are'} saved.`;

  return (
    <section className="page" aria-labelledby="profiles-title">
      <div className="page__header">
        <h2 className="page__title" id="profiles-title">
          Profiles
        </h2>
        <button className="button button--secondary" type="button" onClick={() => setEditorOpen((open) => !open)}>
          {editorOpen ? 'Close the profile form' : 'Add a profile'}
        </button>
      </div>

      <p
        className={profilesError === null ? 'state-line' : 'state-line state-line--error'}
        role={profilesError === null ? 'status' : 'alert'}
        aria-live={profilesError === null ? 'polite' : 'assertive'}
        data-state={profileState}
      >
        {profileStateText}
      </p>

      {known.length === 0 ? null : (
        <fieldset className="panel">
          <legend className="panel__title">Choose the profile new work uses</legend>
          <ul className="profile-list">
            {known.map((profile) => {
              const version = versionOf(versions ?? [], profile.currentVersionId);
              const isSelected = selected !== null && profile.profileId === selected.profileId;
              return (
                <li className="profile-list__item" key={profile.profileId}>
                  <div className="field field--check">
                    <input
                      className="field__radio"
                      id={`profile-${profile.profileId}`}
                      name="active-profile"
                      type="radio"
                      value={profile.profileId}
                      checked={isSelected}
                      onChange={() => onSelectProfile(profile.profileId, `${profile.projectName} / ${profile.name}`)}
                    />
                    <label className="field__label" htmlFor={`profile-${profile.profileId}`}>
                      <span className="profile-list__name">
                        {profile.projectName} / {profile.name}
                      </span>
                      <span className="profile-list__detail">
                        Repository: {profile.repository.provider} {profile.repository.fullName}
                      </span>
                      <span className="profile-list__detail">Target branch: {profile.targetBranch}</span>
                      <span className="profile-list__detail">
                        Version: {profile.currentVersionId} (revision {profile.revision})
                      </span>
                    </label>
                    {version === null ? null : (
                      <StatusBadge
                        tone={VERIFICATION_TONES[version.verificationState]}
                        label={`Verification: ${version.verificationState}`}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      {selected === null ? null : (
        <section className="panel" aria-labelledby="context-title">
          <h3 className="panel__title" id="context-title">
            Context for new work
          </h3>
          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>Profile</dt>
              <dd>
                {selected.projectName} / {selected.name}
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Repository</dt>
              <dd>
                {selected.repository.provider} {selected.repository.fullName} at {selected.repository.repositoryUrl}
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Target branch</dt>
              <dd>{selected.targetBranch}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Ticket team</dt>
              <dd>{selected.ticketTeamKey}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Selected version</dt>
              <dd>
                {selectedVersion === null
                  ? `${selected.currentVersionId} (version record not loaded)`
                  : `${selectedVersion.versionId}, revision ${selectedVersion.revision}, saved ${formatRelativeTime(
                      selectedVersion.createdAt,
                      nowMs,
                    )} (${formatTimestamp(selectedVersion.createdAt)})`}
              </dd>
            </div>
          </dl>
          <p className="panel__note">
            Work started now uses this profile. Choosing another profile above changes the repository, branch and
            connector targets of new work.
          </p>
        </section>
      )}

      {selected === null ? null : (
        <section className="panel" aria-labelledby="versions-title">
          <h3 className="panel__title" id="versions-title">
            Version history
          </h3>
          <p
            className="state-line"
            role="status"
            aria-live="polite"
            data-state={versions === null ? 'loading' : versionsError === null ? 'ready' : 'error'}
          >
            {versionsError !== null
              ? `The version history could not be loaded: ${versionsError}`
              : versions === null
                ? 'Loading version history…'
                : selectedVersions.length === 0
                  ? 'No versions have been recorded for this profile.'
                  : laterChanges === 0
                    ? `Showing all ${selectedVersions.length} versions of this profile.`
                    : `Showing ${selectedVersions.length} versions. ${laterChanges} ${
                        laterChanges === 1 ? 'change is' : 'changes are'
                      } newer than the selected version.`}
          </p>
          {selectedVersions.length === 0 ? null : (
            <ol className="version-list">
              {selectedVersions.map((version) => (
                <li className="version-list__item" key={version.versionId}>
                  <span className="version-list__id">
                    {version.versionId}, revision {version.revision}
                  </span>
                  <StatusBadge
                    tone={VERIFICATION_TONES[version.verificationState]}
                    label={`Verification: ${version.verificationState}`}
                    detail={version.verificationDetail}
                  />
                  <span className="version-list__summary">{version.summary}</span>
                  <span className="version-list__time">
                    Saved by {version.createdBy} at {formatTimestamp(version.createdAt)}
                  </span>
                  {version.versionId === selected.currentVersionId ? (
                    <span className="version-list__flag">Selected version</span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {saved === null ? null : (
        <p className="state-line" role="status" aria-live="polite" data-state="ready">
          {saved}
        </p>
      )}

      {editorOpen ? (
        <ProfileEditor
          projectId={projectId}
          onCancel={() => setEditorOpen(false)}
          onSaved={(created) => {
            setEditorOpen(false);
            setSaved(`Saved ${created.profile.name} as version ${created.version.versionId}.`);
            onSelectProfile(created.profile.profileId, `${created.profile.projectName} / ${created.profile.name}`);
            setReload((count) => count + 1);
          }}
        />
      ) : null}
    </section>
  );
}
