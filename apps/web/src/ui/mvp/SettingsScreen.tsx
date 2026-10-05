/**
 * Settings: the one thing the MVP writes, and everything else it only reads.
 *
 * The MVP's writable configuration is a single optional field — the T3 deployment URL. Everything
 * else on this screen is a *projection* of configuration the server already holds, and it is
 * labelled as read-only rather than offered as a form, because two write paths for one fact give
 * the product two answers to "what is this project's repository" (F02-AC2, L02-AC2).
 *
 * Four rules, each with a wrong answer it prevents:
 *
 *   - **The T3 URL is validated by the server, not by this form.** A malformed, non-http(s) or
 *     credential-bearing URL comes back as a 422 naming a prerequisite and its remedy. The form
 *     submits it and renders that refusal, so the validation the owner meets is the product's
 *     rather than a second, weaker opinion that might disagree with it (L02-AC2).
 *   - **A refusal never echoes the value.** A value bad enough to be refused may itself be the
 *     secret, so the refusal is rendered from the server's words and never from what was typed. What
 *     the owner typed stays in the field, because a refusal must not cost a retype (L02-AC2, N03-AC3).
 *   - **Nothing here runs or observes anything at the configured address.** The URL is external and
 *     optional; this screen stores a pointer and says so, so no owner reads a saved URL as an agent
 *     that is running (mvp-spec 3, F03-AC2).
 *   - **No credential is ever rendered.** The response carries a digest, not a reference, and this
 *     screen shows the digest exactly as the server sent it and nothing more (F03-AC3, F32-AC2).
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { ProjectSettingsView } from '../../server/contracts.ts';
import { formatTimestamp } from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';
import { readProjectSettings, writeProjectSettings, type MvpFailure } from './mvp-client.ts';
import { domId } from './review-model.ts';

export interface SettingsScreenProps {
  /** The session's active project, or null when the owner has chosen none (F02-AC1). */
  readonly projectId: string | null;
  /** Bumped by the shell when the owner asks everything to reload. */
  readonly epoch?: number;
}

type SettingsState =
  | { readonly kind: 'no-project' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly settings: ProjectSettingsView }
  | { readonly kind: 'refused'; readonly failure: MvpFailure };

/** Why a save was refused, held beside the field so the message lands where the input is. */
interface SaveRefusal {
  readonly action: 'save' | 'clear';
  readonly failure: MvpFailure;
}

export function SettingsScreen({ projectId, epoch = 0 }: SettingsScreenProps): ReactElement {
  const [state, setState] = useState<SettingsState>({ kind: 'loading' });
  const [refusal, setRefusal] = useState<SaveRefusal | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * What is in the field.
   *
   * Held here rather than defaulted straight onto the input so that a refusal cannot clear it: the
   * owner corrects one character and submits again rather than retyping a URL that may be a secret
   * (N03-AC3, L02-AC2).
   */
  const [draft, setDraft] = useState('');

  /** Adopts the server's answer as the screen's state, including what the field shows. */
  const adopt = useCallback((next: ProjectSettingsView) => {
    setState({ kind: 'ready', settings: next });
    setDraft(next.t3.url ?? '');
  }, []);

  const load = useCallback(async () => {
    if (projectId === null) {
      setState({ kind: 'no-project' });
      return;
    }
    const result = await readProjectSettings(projectId);
    if (result.ok) adopt(result.value);
    else setState({ kind: 'refused', failure: result.error });
  }, [adopt, projectId]);

  useEffect(() => {
    setRefusal(null);
    setNotice(null);
    void load();
  }, [load, epoch]);

  /**
   * Writes the T3 URL, then reads what the server stored.
   *
   * `t3Url: null` clears it. The screen adopts the response rather than patching anything, so what
   * is shown is the server's answer and not an optimistic guess about what it stored — and a PATCH
   * naming nothing is a read, so both paths converge on the same state (mvp-spec 7).
   */
  const save = useCallback(
    async (action: 'save' | 'clear', typed: string) => {
      if (projectId === null) return;
      setSaving(true);
      setRefusal(null);
      setNotice(null);
      // Trimmed here, and an empty box clears rather than storing an empty string: "there is no T3
      // deployment" and "I typed nothing" are different states, and the field is nullable so the
      // first one is sayable at all (L02-AC3).
      const trimmed = typed.trim();
      const t3Url = action === 'clear' || trimmed === '' ? null : trimmed;
      const result = await writeProjectSettings({ projectId, t3Url });
      setSaving(false);
      if (!result.ok) {
        setRefusal({ action, failure: result.error });
        return;
      }
      // The server's own answer becomes the screen's state. A success and a refusal are therefore
      // not two code paths that could drift apart; there is only the response.
      adopt(result.value);
      setNotice(
        action === 'clear' || trimmed === ''
          ? 'The T3 deployment URL was cleared. This project has no T3 deployment configured.'
          : 'The T3 deployment URL was saved, as the server reports it above.',
      );
    },
    [adopt, projectId],
  );

  const settings = state.kind === 'ready' ? state.settings : null;
  const unreachable = state.kind === 'refused' && !state.failure.reachable;
  const urlId = domId('t3-url', projectId ?? 'project');

  return (
    <div className="page" data-testid="settings-screen">
      <header className="page__header">
        <h2 className="page__title">Settings</h2>
        <p className="panel__note">
          One setting this version writes: an optional address for an external T3 deployment. Everything else
          here is read-only configuration, shown so you can see what this project already holds.
        </p>
      </header>

      {state.kind === 'no-project' ? (
        <p className="state-line" data-state="empty">
          No project is selected, so there are no settings to show. Choose a project first.
        </p>
      ) : null}

      {state.kind === 'loading' ? (
        <p className="state-line" role="status" aria-live="polite" data-state="loading">
          Reading this project&rsquo;s settings…
        </p>
      ) : null}

      {state.kind === 'refused' ? (
        <div className="state-line state-line--error" role="alert" data-state="error">
          <p className="panel__note">
            <strong>{unreachable ? 'Disconnected.' : 'The server refused to answer.'}</strong> {state.failure.reason}
          </p>
          <p className="form__actions">
            <button className="button button--secondary" type="button" onClick={() => void load()}>
              Read the settings again
            </button>
          </p>
        </div>
      ) : null}

      {settings === null ? null : (
        <>
          <section className="panel" aria-labelledby="settings-t3-heading">
            <h3 className="panel__title" id="settings-t3-heading">
              T3 deployment
            </h3>
            <p>
              <StatusBadge
                tone={settings.t3.configured ? 'healthy' : 'unconfigured'}
                label={settings.t3.configured ? 'Configured' : 'Not configured'}
              />
            </p>
            <p className="panel__note">
              {settings.t3.configured
                ? `The stored address is ${settings.t3.url ?? '(the server reported an address it could not repeat)'}.`
                : 'This project has no T3 deployment configured, which is a normal state: the implementation packet works without one.'}
            </p>
            <p className="panel__note">
              T3 is external. Saving an address here stores a pointer and nothing else — nothing on this screen
              starts, runs, watches or connects to anything at that address, and there is no fact available to
              this product about whether anything is running there.
            </p>

            <form
              className="form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (saving) return;
                void save('save', draft);
              }}
            >
              <div className="field">
                <label className="field__label" htmlFor={urlId}>
                  T3 deployment URL (optional)
                </label>
                <input
                  className="field__input"
                  id={urlId}
                  name={urlId}
                  type="url"
                  autoComplete="off"
                  value={draft}
                  aria-describedby={`${urlId}-hint`}
                  disabled={saving}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <p className="field__hint" id={`${urlId}-hint`}>
                  An absolute http or https address with no credentials in it. The server decides whether it is
                  acceptable and says why if it is not; this form does not second-guess it.
                </p>
              </div>
              {refusal === null || refusal.failure.fields.length === 0 ? null : (
                <ul className="state-line state-line--error" role="alert">
                  {refusal.failure.fields.map((field) => (
                    <li key={field.path}>{field.message}</li>
                  ))}
                </ul>
              )}
              {refusal === null ? null : (
                <div className="state-line state-line--error" role="alert" data-state="error">
                  <p className="panel__note">
                    <strong>Nothing was saved.</strong> {refusal.failure.reason}
                  </p>
                  {refusal.failure.prerequisites.length === 0 ? null : (
                    <ul>
                      {refusal.failure.prerequisites.map((prerequisite) => (
                        <li key={`${prerequisite.name}:${prerequisite.detail}`}>
                          {`${prerequisite.name}: ${prerequisite.detail} ${prerequisite.remedy}`}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="panel__note">
                    {refusal.action === 'clear'
                      ? 'The address that was already configured is unchanged.'
                      : 'What you typed is still in the field above, so you can correct it and submit again.'}
                  </p>
                </div>
              )}
              {notice === null ? null : (
                <p className="state-line" role="status" aria-live="polite" data-state="ready">
                  {notice}
                </p>
              )}
              <div className="form__actions">
                <button className="button" type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save T3 URL'}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={saving || !settings.t3.configured}
                  onClick={() => void save('clear', '')}
                >                  {saving ? 'Saving…' : 'Clear T3 URL'}
                </button>
              </div>
            </form>
            {settings.updatedAt === null ? null : (
              <p className="panel__note">{`These settings were last written ${formatTimestamp(settings.updatedAt)}.`}</p>
            )}
          </section>

          <RepositoryPanel settings={settings} />
          <ProvidersPanel settings={settings} />
        </>
      )}
    </div>
  );
}

/**
 * Repository configuration, read-only here.
 *
 * Rendered as a projection with its profile version attached rather than as an editable form: the
 * profile route is the only place one is saved, and a second write path would give the product two
 * answers to "what is this project's repository" (F02-AC1, F02-AC2).
 */
function RepositoryPanel({ settings }: { readonly settings: ProjectSettingsView }): ReactElement {
  const repository = settings.repository;
  return (
    <section className="panel" aria-labelledby="settings-repository-heading">
      <h3 className="panel__title" id="settings-repository-heading">
        Repository
      </h3>
      <p className="panel__note">Read-only here. Repository and provider configuration is saved on the project profile screen.</p>
      <p>
        <StatusBadge tone={repository.configured ? 'healthy' : 'unconfigured'} label={repository.configured ? 'Configured' : 'Not configured'} />
      </p>
      <dl className="detail-list">
        <div className="detail-list__row">
          <dt>Repository</dt>
          <dd>{repository.repository ?? 'None recorded.'}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Base branch</dt>
          <dd>{repository.baseBranch ?? 'None recorded.'}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Target branch</dt>
          <dd>{repository.targetBranch ?? 'None recorded.'}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Ticket provider</dt>
          <dd>{repository.ticketProvider ?? 'None recorded.'}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Deployment provider</dt>
          <dd>
            {repository.deploymentProvider ??
              'None recorded. This version has no deployment step, so this field changes nothing.'}
          </dd>
        </div>
        <div className="detail-list__row">
          <dt>Coding engine</dt>
          <dd>{repository.engine ?? 'None recorded.'}</dd>
        </div>
        <div className="detail-list__row">
          <dt>Profile version</dt>
          <dd>
            {repository.profileVersionId === null
              ? 'No profile version has been saved for this project.'
              : `${repository.profileVersionId}${repository.versionNumber === null ? '' : ` (version ${String(repository.versionNumber)})`}`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * How a provider's own state reads.
 *
 * The provider's five states are the server's vocabulary and are rendered as it states them; only
 * the tone is chosen here, so a `Revoked` credential reference never looks like a `Healthy` one.
 * Nothing on this screen changes a provider's state (F32-AC2, N03-AC1).
 */
function connectorTone(state: ProjectSettingsView['providers'][number]['state']): StatusTone {
  switch (state) {
    case 'Healthy':
      return 'healthy';
    case 'Revoked':
      return 'revoked';
    case 'Degraded':
    case 'Unreachable':
      return 'degraded';
    case 'Unconfigured':
      return 'unconfigured';
  }
}

/**
 * Configured providers, read-only, with no credential anywhere in the row.
 *
 * The server sends a digest that identifies a stored reference without carrying it, and there is
 * no field here that could show the reference itself — a settings screen that listed credential
 * pointers would be a place a secret becomes readable (F03-AC3, F32-AC2).
 */
function ProvidersPanel({ settings }: { readonly settings: ProjectSettingsView }): ReactElement {
  return (
    <section className="panel" aria-labelledby="settings-providers-heading">
      <h3 className="panel__title" id="settings-providers-heading">
        Providers
      </h3>
      {settings.providers.length === 0 ? (
        <p className="panel__note" data-state="empty">
          This project has no provider configured. Credentials are added on the project profile screen; nothing
          on this screen can hold one.
        </p>
      ) : (
        <ul className="capability-list">
          {settings.providers.map((provider) => (
            <li className="capability-list__item" key={provider.connectorId}>
              <p>
                <strong>{provider.provider}</strong> ({provider.kind}){' '}
                <StatusBadge tone={connectorTone(provider.state)} label={provider.state} />
              </p>
              <p className="panel__note">{`Scope: ${provider.resourceScope}.`}</p>
              <p className="panel__note">
                {`Stored credential reference digest: ${provider.credentialReferenceDigest}. The reference itself is never returned here.`}
              </p>
              <p className="panel__note">
                {`Last checked ${provider.lastCheckedAt === null ? 'never' : formatTimestamp(provider.lastCheckedAt)}; last success ${
                  provider.lastSuccessAt === null ? 'never' : formatTimestamp(provider.lastSuccessAt)
                }.`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
