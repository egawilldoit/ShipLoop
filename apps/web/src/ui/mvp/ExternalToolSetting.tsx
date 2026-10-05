/**
 * The external tool's deployment URL, and what is on screen about it (mvp-spec L02-AC2, L02-AC3).
 *
 * One editable field, and the surrounding text is most of the feature. The owner needs to know three
 * things that are easy to conflate:
 *
 *   - **The address is not a credential and never will be.** A URL carrying a username, password or
 *     token is refused before it is stored, and a refused value is never echoed back — so what is on
 *     screen here can never be a secret, and a browser extension reading this DOM learns nothing
 *     (L02-AC2, N02-AC2).
 *   - **Configuring it does not start anything.** Storing an address is a fact about this project's
 *     configuration. It connects to nothing, launches nothing, and makes no claim about any T3
 *     session. The copy that would make an owner believe otherwise is the failure `Open T3` is worded
 *     to avoid, and it is avoided here too (mvp-spec L02).
 *   - **Clearing it is a real state.** `null` means "this project has no external tool configured",
 *     which is different from "I did not change it", and the form offers an explicit clear rather
 *     than an ambiguous "remove".
 *
 * A refused save preserves what was typed. Discarding an address because it was refused would force
 * the owner to retype it to see the error again, and the error is what they need (F02-AC4, N03-AC3).
 */

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { formatTimestamp } from '../api-client.ts';
import { Field } from '../components/Field.tsx';
import { isHttpUrl } from './external-url.ts';
import { fetchSettings, saveExternalToolUrl, type ProjectSettings } from './transport.ts';

export interface ExternalToolSettingProps {
  readonly projectId: string | null;
  /** Bumped by the shell's retry control so this panel refetches. */
  readonly epoch: number;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'refused';

export function ExternalToolSetting({ projectId, epoch }: ExternalToolSettingProps): ReactElement {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveMessage, setSaveMessage] = useState<string>('');

  useEffect(() => {
    if (projectId === null) {
      setSettings(null);
      setLoadFailure(null);
      return;
    }
    let current = true;
    void fetchSettings(projectId).then((outcome) => {
      if (!current) return;
      if (outcome.ok) {
        setSettings(outcome.value);
        setLoadFailure(null);
        return;
      }
      setSettings(null);
      setLoadFailure(outcome.failure.reason);
    });
    return () => {
      current = false;
    };
  }, [projectId, epoch]);

  if (projectId === null) {
    return (
      <p className="state-line" role="status" data-state="empty">
        No project is selected, so there are no settings to configure.
      </p>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saveState === 'saving' || projectId === null) return;
    const trimmed = url.trim();
    // Checked here as well as on the server because the difference matters to the owner: the server
    // refuses a credential-bearing URL without echoing it, and this tells them what to fix before the
    // value ever leaves the browser (L02-AC2, N02-AC2).
    if (trimmed !== '' && !isHttpUrl(trimmed)) {
      setUrlError(
        'That address is not an http or https URL this browser can open. Paste the deployment address, for example https://example.invalid.',
      );
      return;
    }
    setUrlError(undefined);
    setSaveState('saving');
    setSaveMessage('');
    const outcome = await saveExternalToolUrl(projectId, trimmed === '' ? null : trimmed);
    // The typed value is left in place either way. A refusal that also cleared the field would make
    // the owner retype the address to see the same message again (N03-AC3).
    if (!outcome.ok) {
      setSaveState('refused');
      setSaveMessage(`The address was not saved: ${outcome.failure.reason}`);
      return;
    }
    setSettings(outcome.value);
    setSaveState('saved');
    setSaveMessage(
      outcome.value.t3.configured
        ? 'Saved. This records an address and nothing else: no tool was contacted, opened or started.'
        : 'Cleared. This project has no external tool configured, and the implementation packet works either way.',
    );
    setUrl('');
  };

  return (
    <section className="panel" aria-labelledby="external-tool-setting-heading">
      <h3 className="panel__title" id="external-tool-setting-heading">
        External tool (T3)
      </h3>
      {loadFailure === null ? null : (
        <p className="state-line state-line--error" role="alert" data-state="failed">
          {`These settings could not be read: ${loadFailure}`}
        </p>
      )}
      <p className="panel__note" data-testid="external-tool-state">
        {settings === null
          ? 'No address is shown.'
          : settings.t3.configured
            ? `This project has an external tool address configured: ${settings.t3.url ?? 'an address this page cannot display'}.`
            : 'No external tool address is configured for this project. The implementation packet works without one, so this is a normal state rather than something to fix.'}
      </p>
      {settings?.updatedAt === null || settings?.updatedAt === undefined ? null : (
        <p className="panel__note">Last written {formatTimestamp(settings.updatedAt)}.</p>
      )}
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="t3-url"
          label="T3 deployment address"
          type="url"
          value={url}
          onChange={setUrl}
          hint="An http or https address, for example https://example.invalid. Leave it empty and save to clear it. This is an address, not a credential: a URL carrying a username, password or token is refused and never stored."
          error={urlError}
          disabled={saveState === 'saving'}
        />
        <div className="form__actions">
          <button className="button" type="submit" disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'Saving…' : 'Save address'}
          </button>
          <button
            className="button button--secondary"
            type="button"
            disabled={saveState === 'saving'}
            onClick={() => {
              // Clearing the field is not clearing the setting. The two are different acts and
              // conflating them would leave an owner believing they had unset something they had
              // only stopped typing (L02-AC3).
              setUrl('');
              setUrlError(undefined);
              setSaveState('idle');
              setSaveMessage('Cleared from this form. Nothing was saved until you save.');
            }}
          >
            Clear the field
          </button>
        </div>
      </form>
      <p
        className={saveState === 'refused' ? 'state-line state-line--error' : 'state-line'}
        role="status"
        aria-live="polite"
        data-state={saveState === 'saved' ? 'copied' : saveState === 'refused' ? 'failed' : 'idle'}
      >
        {saveMessage === '' ? 'Nothing has been saved from this form yet.' : saveMessage}
      </p>
    </section>
  );
}