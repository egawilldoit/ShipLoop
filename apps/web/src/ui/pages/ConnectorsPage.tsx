import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  LIVE_REFRESH_MS,
  createConnector,
  fetchConnectors,
  formatRelativeTime,
  formatTimestamp,
  revokeConnector,
  type ConnectorState,
  type ConnectorType,
  type ConnectorView,
} from '../api-client.ts';
import { StatusBadge, type StatusTone } from '../components/StatusBadge.tsx';

export interface ConnectorsPageProps {
  /** The selected project, or null when none is selected (F02-AC1). */
  readonly projectId: string | null;
  readonly profileId: string;
  readonly profileName: string;
  readonly epoch: number;
}

const STATE_TONES: Readonly<Record<ConnectorState, StatusTone>> = {
  Healthy: 'healthy',
  Degraded: 'degraded',
  Revoked: 'revoked',
  Unconfigured: 'unconfigured',
};

const CONNECTOR_TYPES: readonly ConnectorType[] = ['RepositoryHost', 'TicketTracker', 'DeploymentTarget', 'EngineHost'];

interface ConnectorFormState {
  readonly provider: string;
  readonly connectorType: ConnectorType;
  readonly credentialReference: string;
}

const EMPTY_FORM: ConnectorFormState = { provider: '', connectorType: 'RepositoryHost', credentialReference: '' };

/**
 * The access the project actually has, and what it is allowed to do with it.
 *
 * Each connector states its own read and write capabilities, when it was last checked and
 * when it last succeeded, and what to do when access has expired or is missing. Those four
 * facts are what let an owner tell "the provider says no" from "we have not asked yet"
 * (F03-AC2), and a failing connector is presented with its remedy rather than as a bare
 * error.
 *
 * There is no control anywhere on this page that accepts a secret. The add form collects a
 * reference label - where the credential is stored - because a credential that reaches a
 * browser response is a credential that ends up in a screenshot, a log or a bundle (F03-AC3).
 *
 * Revoking is two-step and names its target, because revocation blocks new work and the
 * owner should not be able to do it to the wrong provider by accident (F03-AC4).
 */
export function ConnectorsPage({
  projectId,
  profileId,
  profileName,
  epoch,
}: ConnectorsPageProps): ReactElement {
  const [connectors, setConnectors] = useState<readonly ConnectorView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectorFormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Readonly<Record<string, string>>>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [formOutcome, setFormOutcome] = useState<'idle' | 'saving' | 'added' | 'refused'>('idle');
  const [saving, setSaving] = useState(false);
  const [awaitingRevoke, setAwaitingRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (projectId === null) return;
    let current = true;
    const load = async (): Promise<void> => {
      const result = await fetchConnectors(projectId);
      if (!current) return;
      if (result.ok) {
        setConnectors(result.value.connectors);
        setListError(null);
      } else {
        setListError(result.error.reason);
      }
    };
    void load();
    const timer = setInterval(() => void load(), LIVE_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [projectId, epoch, reload]);

  const known = connectors ?? [];
  const nowMs = Date.now();

  const listState: 'no-project' | 'loading' | 'empty' | 'ready' | 'error' =
    projectId === null
      ? 'no-project'
      : listError !== null
        ? 'error'
        : connectors === null
          ? 'loading'
          : known.length === 0
            ? 'empty'
            : 'ready';
  const listStateText =
    listState === 'no-project'
      ? 'No project is selected, so there are no connectors to read. Choose or create a project in the header.'
      : listState === 'error'
        ? `The connector list could not be loaded: ${listError ?? 'unknown reason'}`
        : listState === 'loading'
          ? 'Loading connectors…'
          : listState === 'empty'
            ? 'No connectors are configured for this project yet.'
            : `${known.length} ${known.length === 1 ? 'connector is' : 'connectors are'} configured.`;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;

    // A connector belongs to a project. With none selected there is no identity to address, and
    // sending the empty string would build `/api/profiles//connectors` rather than refusing
    // here where the owner can read what to do about it (F02-AC1, F02-AC4).
    if (projectId === null) {
      setFormErrors({});
      setFormMessage('Choose a project in the header before adding a connector: a connector belongs to one project.');
      setFormOutcome('refused');
      return;
    }

    const local: Record<string, string> = {};
    if (form.provider.trim() === '') local['provider'] = 'Name the provider this connector reaches.';
    if (form.credentialReference.trim() === '') {
      local['credentialReference'] =
        'Name where the credential is stored, for example env:REPO_TOKEN. Never paste the secret itself.';
    }
    if (Object.keys(local).length > 0) {
      setFormErrors(local);
      setFormMessage('The connector was not added because required fields are missing.');
      setFormOutcome('refused');
      return;
    }

    setSaving(true);
    setFormMessage(null);
    setFormOutcome('saving');
    const result = await createConnector(projectId, {
      profileId: profileId === '' ? null : profileId,
      provider: form.provider.trim(),
      connectorType: form.connectorType,
      credentialReference: form.credentialReference.trim(),
    });
    setSaving(false);

    if (!result.ok) {
      setFormErrors({});
      setFormMessage(result.error.reason);
      setFormOutcome('refused');
      return;
    }
    setFormErrors({});
    setFormMessage(`Added ${result.value.provider} (${result.value.connectorType}).`);
    setFormOutcome('added');
    setForm(EMPTY_FORM);
    setReload((count) => count + 1);
  };

  const revoke = async (connector: ConnectorView): Promise<void> => {
    setRevoking(connector.connectorId);
    setRevokeError(null);
    const result = await revokeConnector(connector.connectorId);
    setRevoking(null);
    setAwaitingRevoke(null);
    if (!result.ok) {
      setRevokeError(`${connector.provider}: ${result.error.reason}`);
      return;
    }
    setReload((count) => count + 1);
  };

  return (
    <section className="page" aria-labelledby="connectors-title">
      <h2 className="page__title" id="connectors-title">
        Connectors
      </h2>
      <p className="panel__note">
        {profileName === '' ? 'No profile is selected.' : `Connector targets for ${profileName}.`} Selecting a
        different profile changes which connectors new work uses.
      </p>
      <p
        className={listState === 'error' ? 'state-line state-line--error' : 'state-line'}
        role={listState === 'error' ? 'alert' : 'status'}
        aria-live={listState === 'error' ? 'assertive' : 'polite'}
        data-state={listState}
      >
        {listStateText}
      </p>

      {revokeError === null ? null : (
        <p className="state-line state-line--error" role="alert" data-state="error">
          <span className="field__error-mark" aria-hidden="true" />
          Error: {revokeError}
        </p>
      )}

      {known.length === 0 ? null : (
        <ul className="connector-list">
          {known.map((connector) => (
            <li className="panel connector" key={connector.connectorId}>
              <div className="connector__header">
                <h3 className="panel__title">
                  {connector.provider} / {connector.connectorType}
                </h3>
                <StatusBadge tone={STATE_TONES[connector.state]} label={`State: ${connector.state}`} />
              </div>
              <dl className="detail-list">
                <div className="detail-list__row">
                  <dt>Connector id</dt>
                  <dd>{connector.connectorId}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Credential reference</dt>
                  <dd>{connector.credentialReference}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Last checked</dt>
                  <dd>
                    {connector.lastCheckedAt === null ? (
                      'Never checked.'
                    ) : (
                      <>
                        <time dateTime={connector.lastCheckedAt}>{formatRelativeTime(connector.lastCheckedAt, nowMs)}</time>
                        {` (${formatTimestamp(connector.lastCheckedAt)})`}
                      </>
                    )}
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Last success</dt>
                  <dd>
                    {connector.lastSuccessAt === null ? (
                      'Never succeeded.'
                    ) : (
                      <>
                        <time dateTime={connector.lastSuccessAt}>{formatRelativeTime(connector.lastSuccessAt, nowMs)}</time>
                        {` (${formatTimestamp(connector.lastSuccessAt)})`}
                      </>
                    )}
                  </dd>
                </div>
              </dl>

              <div className="connector__capabilities">
                <div>
                  <h4 className="connector__subtitle">Supported reads</h4>
                  {connector.reads.length === 0 ? (
                    <p className="connector__none">No read capability is available.</p>
                  ) : (
                    <ul className="capability-list">
                      {connector.reads.map((capability) => (
                        <li className="capability-list__item" key={capability}>
                          {capability}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h4 className="connector__subtitle">Supported writes</h4>
                  {connector.writes.length === 0 ? (
                    <p className="connector__none">No write capability is available.</p>
                  ) : (
                    <ul className="capability-list">
                      {connector.writes.map((capability) => (
                        <li className="capability-list__item" key={capability}>
                          {capability}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {connector.limitations.length === 0 ? null : (
                <div className="connector__limitations">
                  <h4 className="connector__subtitle">Unsupported capabilities</h4>
                  <ul className="capability-list">
                    {connector.limitations.map((limitation) => (
                      <li className="capability-list__item" key={limitation.kind}>
                        <strong>{limitation.kind}</strong>: {limitation.limitation}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {connector.error === null ? null : (
                <div className="connector__problem">
                  <p className="connector__problem-line">
                    <span className="field__error-mark" aria-hidden="true" />
                    <strong>Action needed:</strong> {connector.error}
                  </p>
                  {connector.remedy === null ? null : (
                    <p className="connector__problem-line">
                      <strong>What to do:</strong> {connector.remedy}
                    </p>
                  )}
                </div>
              )}

              <div className="connector__actions">
                {awaitingRevoke === connector.connectorId ? (
                  <>
                    <button
                      className="button button--danger"
                      type="button"
                      disabled={revoking === connector.connectorId}
                      onClick={() => void revoke(connector)}
                    >
                      {revoking === connector.connectorId
                        ? 'Revoking…'
                        : `Confirm revoking ${connector.provider} access`}
                    </button>
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={revoking === connector.connectorId}
                      onClick={() => setAwaitingRevoke(null)}
                    >
                      Keep {connector.provider} access
                    </button>
                  </>
                ) : (
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={connector.state === 'Revoked'}
                    onClick={() => setAwaitingRevoke(connector.connectorId)}
                  >
                    {connector.state === 'Revoked'
                      ? `${connector.provider} access is already revoked`
                      : `Revoke ${connector.provider} access`}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="panel" aria-labelledby="add-connector-title">
        <h3 className="panel__title" id="add-connector-title">
          Add a connector
        </h3>
        <p className="panel__note">
          Give the reference that names where the credential is stored. ShipLoop never asks a browser to hold a secret
          value.
        </p>
        <p
          className={formOutcome === 'refused' ? 'state-line state-line--error' : 'state-line'}
          role={formOutcome === 'refused' ? 'alert' : 'status'}
          aria-live={formOutcome === 'refused' ? 'assertive' : 'polite'}
          data-state={formOutcome}
        >
          {formOutcome === 'saving'
            ? 'Adding the connector…'
            : formOutcome === 'idle'
              ? 'No connector has been added from this form.'
              : (formMessage ?? '')}
        </p>
        <form className="form form--grid" noValidate onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label className="field__label" htmlFor="connector-provider">
              Provider
            </label>
            <input
              className="field__input"
              id="connector-provider"
              name="connector-provider"
              type="text"
              value={form.provider}
              aria-required="true"
              aria-invalid={formErrors['provider'] === undefined ? undefined : 'true'}
              aria-describedby={formErrors['provider'] === undefined ? undefined : 'connector-provider-error'}
              disabled={saving}
              onChange={(event) => setForm((previous) => ({ ...previous, provider: event.target.value }))}
            />
            {formErrors['provider'] === undefined ? null : (
              <p className="field__error" id="connector-provider-error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {formErrors['provider']}
              </p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="connector-type">
              Connector type
            </label>
            <select
              className="field__input"
              id="connector-type"
              name="connector-type"
              value={form.connectorType}
              disabled={saving}
              onChange={(event) => {
                const chosen = CONNECTOR_TYPES.find((candidate) => candidate === event.target.value);
                if (chosen === undefined) return;
                setForm((previous) => ({ ...previous, connectorType: chosen }));
              }}
            >
              {CONNECTOR_TYPES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="connector-reference">
              Credential reference
            </label>
            <input
              className="field__input"
              id="connector-reference"
              name="connector-reference"
              type="text"
              value={form.credentialReference}
              aria-required="true"
              aria-invalid={formErrors['credentialReference'] === undefined ? undefined : 'true'}
              aria-describedby={
                formErrors['credentialReference'] === undefined
                  ? 'connector-reference-hint'
                  : 'connector-reference-hint connector-reference-error'
              }
              disabled={saving}
              onChange={(event) => setForm((previous) => ({ ...previous, credentialReference: event.target.value }))}
            />
            <p className="field__hint" id="connector-reference-hint">
              A label such as env:REPO_TOKEN. Never the secret itself.
            </p>
            {formErrors['credentialReference'] === undefined ? null : (
              <p className="field__error" id="connector-reference-error">
                <span className="field__error-mark" aria-hidden="true" />
                Error: {formErrors['credentialReference']}
              </p>
            )}
          </div>

          <div className="form__actions">
            <button className="button" type="submit" disabled={saving}>
              {saving ? 'Adding…' : 'Add connector'}
            </button>
          </div>
        </form>
      </section>
    </section>
  );
}
