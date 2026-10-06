/**
 * The implementation packet for one approved revision, and the optional external tool beside it
 * (mvp-spec L02, L02-AC1, L02-AC2, L02-AC3, F02-AC2, F24-AC5, N03-AC1, N03-AC3, N02-AC2).
 *
 * This page renders the controller's packet bytes and offers two ways to leave with them. It does not
 * decide anything, and it starts nothing.
 *
 * ## Which revision is shown, and where that fact comes from
 *
 * The packet exists only for an **approved** revision, and the page names the exact one it read:
 * the revision number, and the contract's `contentFingerprint` alongside the packet's own fingerprint.
 * Two different digests of two different things, and conflating them would be the kind of small
 * substitution that makes a handoff unverifiable — the content fingerprint is the identity of the
 * approved *text*, the packet fingerprint the identity of the rendered *document*. The content
 * fingerprint is read from `getContract`, and a contract that cannot be read is reported rather than
 * guessed: the packet still renders, because the packet is the product (mvp-spec 7, N02-AC2).
 *
 * ## `Open T3` opens a page in another tool. That is the whole of it.
 *
 * T3 is an external tool the owner may or may not use. ShipLoop holds a contract and evidence; it
 * holds no T3 session, no T3 API connection and no observation of anything happening inside T3. The
 * handoff route's own contract is that it "contacts nothing" — it renders a document and does not
 * reach out. So the control here is an anchor with `target="_blank"` and one sentence of
 * explanation, and the wording is chosen so no reader can infer a fact this product does not have:
 *
 *   - it never says **Started**, **Running**, **Connected**, **Launching**, **Executing** or
 *     **Session**. Each of those asserts that ShipLoop did something to T3, and nothing did. A page
 *     that said "Running" would be telling the owner their work had begun when the only thing that
 *     happened is that a browser tab opened somewhere;
 *   - it states what *does* happen, so the button is not merely silent: the address opens in a new
 *     tab, and what the owner does there is theirs until they come back with a pull request;
 *   - it says plainly that ShipLoop watches nothing there, because "watching" is what an owner would
 *     otherwise assume about a button inside a tool that reports on their code.
 *
 * ## With no external tool configured, the packet is still the product
 *
 * `NotConfigured` is a normal state, not an error — it is what a fresh deployment answers — so this
 * page renders the packet in full either way and never gates the copy on the tool existing. The
 * `Open T3` control in that state is replaced by an actionable pointer at Settings, carrying the
 * prerequisites the server named with their remedies, rather than a disabled control that would be a
 * dead end. A page showing an empty panel where the button would be would read as "there is nothing
 * to hand off", which is the opposite of the truth (L02-AC3).
 *
 * ## The bytes are the controller's
 *
 * `packet.markdown` is rendered inside a focusable `<pre>` and copied verbatim. Nothing in this layer
 * reformats, trims, re-escapes or re-wraps it: one approved contract must produce one document, and
 * the property that makes a handoff trustworthy is that a client cannot make two packets differ for a
 * reason nobody chose (N02-AC2). `packet.fingerprint` is shown so the owner can prove the clipboard
 * holds the bytes the server rendered.
 *
 * No secret is in that text: the packet is rendered by the controller from the contract content, and
 * this page adds nothing to it. It also reads no credential to do its job — the T3 state is a
 * configured-or-not fact, not a key (L02-AC2).
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { isHttpUrl } from './external-url.ts';
import {
  fetchHandoff,
  getContract,
  type HandoffT3View,
  type HandoffView,
  type ProjectScope,
} from '../mvp-client/index.ts';

export interface HandoffPageProps {
  /** The active project, or null when none is selected (F02-AC1). */
  readonly projectId: string | null;
  /** The approved revision to hand off, or null when none is in view. */
  readonly contractId: string | null;
  readonly contractRevision: number | null;
  /** Sends the owner to Settings, where the external tool's address is configured (L02-AC3). */
  readonly onOpenSettings: () => void;
  /**
   * Bumped by the shell's retry control so this page refetches without prop-drilling.
   *
   * Optional because the page reads its packet on mount regardless, and because it is rendered
   * inside the contract screen as well as from a shell — where the shell's connection epoch is not
   * in scope and where a made-up number would be a fabricated fact about a connection (N03-AC3).
   */
  readonly epoch?: number;
  /**
   * The project scope this page reads through, when the shell has one.
   *
   * Optional so the props other surfaces already pass keep working: every call takes a `ProjectScope`
   * rather than a bare id, and with no scope the client answers `NoProjectSelected` and sends nothing,
   * which is the behaviour a page with no project must have (F02-AC1, F02-AC2).
   */
  readonly scope?: ProjectScope | null;
}

/**
 * The states this page distinguishes, which are four different things to the owner.
 *
 * `unreachable` is separate from `refused` because "the server could not be reached" and "the server
 * received this and declined it" are different facts, and telling the owner their view had stopped
 * being current when it actually answered is the confusion the connection banner exists to prevent
 * (N03-AC1, N03-AC3).
 */
type ViewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly handoff: HandoffView; readonly contentFingerprint: string | null }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unreachable'; readonly reason: string };

/**
 * The scope this page reads through.
 *
 * Derived from the scope when the shell supplied one and from `projectId` otherwise, because every
 * call needs a `ProjectScope` and a bare id is not one. A `projectId` with no name produces a scope
 * carrying that id and no display name, which is enough to address the project and is not a guess
 * about anything else (F02-AC1).
 */
function scopeOf(props: HandoffPageProps): ProjectScope | null {
  if (props.scope !== undefined) return props.scope;
  if (props.projectId === null) return null;
  return { kind: 'project', projectId: props.projectId, projectName: props.projectId };
}

export function HandoffPage(props: HandoffPageProps): ReactElement {
  const { projectId, contractId, contractRevision, onOpenSettings, epoch } = props;
  const [view, setView] = useState<ViewState>({ kind: 'idle' });
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'refused'>('idle');
  const [copyDetail, setCopyDetail] = useState<string>('');

  const scope = scopeOf(props);
  const addressable =
    projectId !== null && contractId !== null && contractRevision !== null && contractRevision >= 1;

  const load = useCallback((): void => {
    if (!addressable || scope === null || contractId === null || contractRevision === null) {
      setView({ kind: 'idle' });
      return;
    }
    setView({ kind: 'loading' });
    setCopyState('idle');
    setCopyDetail('');
    void readPacket(scope, contractId, contractRevision).then(setView);
  }, [addressable, scope, contractId, contractRevision]);

  useEffect(load, [load, epoch]);

  if (!addressable) {
    return (
      <section className="page page--narrow" aria-labelledby="handoff-heading">
        <h2 className="page__title" id="handoff-heading">
          Implementation packet
        </h2>
        <p className="state-line" role="status" data-state="empty">
          {projectId === null
            ? 'No project is selected, so there is no contract to hand off. Choose a project in the header.'
            : 'No approved contract revision is in view, so there is nothing to hand off. Open a request and approve its contract first.'}
        </p>
      </section>
    );
  }

  return (
    <section className="page" aria-labelledby="handoff-heading">
      <header className="page__header">
        <h2 className="page__title" id="handoff-heading">
          Implementation packet
        </h2>
        <p className="panel__note">
          {`Contract ${contractId} revision ${contractRevision ?? 0}, approved. The text below is the packet the ` +
            `server rendered; ShipLoop does not change it, and copying it sends exactly these bytes.`}
        </p>
      </header>

      {renderView(view, load)}

      {view.kind === 'ready' ? (
        <>
          <PacketPanel
            markdown={view.handoff.packet.markdown}
            fingerprint={view.handoff.packet.fingerprint}
            contentFingerprint={view.contentFingerprint}
            revision={view.handoff.revision}
            copyState={copyState}
            copyDetail={copyDetail}
            onCopy={(text) => {
              void copyToClipboard(text).then((result) => {
                if (result.ok) {
                  setCopyState('copied');
                  setCopyDetail(
                    'The packet is on your clipboard. It is the same text shown below, byte for byte.',
                  );
                  return;
                }
                // A clipboard refusal is reported as a refusal. Claiming a copy that did not happen
                // would leave the owner pasting stale text into the next tool and believing the
                // product had handed it over (N03-AC3).
                setCopyState('refused');
                setCopyDetail(result.reason);
              });
            }}
          />
          <ExternalToolPanel tool={view.handoff.t3} onOpenSettings={onOpenSettings} />
        </>
      ) : null}
    </section>
  );
}

/**
 * Reads the packet, and the approved text's own fingerprint beside it.
 *
 * Two reads because they are two facts about two different things, and the second one is not allowed
 * to take the packet down with it: the packet is the product, so a contract that will not read is
 * reported next to a packet that rendered rather than replacing it with an error. The content
 * fingerprint is what lets the owner see that the sealed text is the text they approved, and that it
 * is not the same value as the packet's own digest (mvp-spec 7, N02-AC2).
 */
async function readPacket(
  scope: ProjectScope,
  contractId: string,
  revision: number,
): Promise<ViewState> {
  const [handoff, contract] = await Promise.all([
    fetchHandoff(scope, contractId, revision),
    getContract(scope, contractId, revision),
  ]);
  const contentFingerprint = contract.ok ? contract.value.contentFingerprint : null;
  if (handoff.ok) {
    // The revision the packet names is what this page reports, not the one it asked for: a server
    // answering a different revision than the one requested would otherwise be rendered under the
    // number the owner is looking at (mvp-spec 7).
    return { kind: 'ready', handoff: handoff.value, contentFingerprint };
  }
  if (handoff.failure.code === 'Disconnected') {
    return { kind: 'unreachable', reason: handoff.failure.reason };
  }
  return { kind: 'refused', reason: handoff.failure.reason };
}

function renderView(view: ViewState, reload: () => void): ReactElement {
  switch (view.kind) {
    case 'idle':
      return (
        <p className="state-line" role="status" data-state="empty">
          Nothing is in view to hand off.
        </p>
      );
    case 'loading':
      return (
        <p className="state-line" role="status" aria-live="polite" data-state="loading">
          Reading the approved contract and rendering its packet…
        </p>
      );
    case 'ready':
      return (
        <p className="state-line" role="status" data-state="ready">
          Packet rendered. Nothing was sent anywhere and nothing was started.
        </p>
      );
    case 'unreachable':
      return (
        <div className="connector__problem" role="alert" data-state="disconnected">
          <p className="connector__problem-line">{`The server could not be reached, so no packet is shown: ${view.reason}`}</p>
          <p className="connector__problem-line">
            Nothing was requested from any external tool. An unreachable server says nothing about
            whether the contract was approved.
          </p>
          <div className="connector__actions">
            <button className="button" type="button" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      );
    case 'refused':
      return (
        <div className="connector__problem" role="alert" data-state="failed">
          <p className="connector__problem-line">{`No packet is available: ${view.reason}`}</p>
          <p className="connector__problem-line">
            A revision renders a packet only once it has been approved. An unapproved draft is not a
            permission slip, so nothing is shown for it (mvp-spec 3).
          </p>
          <div className="connector__actions">
            <button className="button" type="button" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      );
  }
}

interface PacketPanelProps {
  readonly markdown: string;
  readonly fingerprint: string;
  readonly contentFingerprint: string | null;
  readonly revision: number;
  readonly copyState: 'idle' | 'copied' | 'refused';
  readonly copyDetail: string;
  readonly onCopy: (text: string) => void;
}

/**
 * The packet itself: the exact bytes, a copy control, and the fingerprints that prove them.
 *
 * The text sits in a focusable `<pre>` so the fallback is real — an owner whose browser refuses the
 * clipboard can select the text and copy it by hand, which is why the copy control's refusal names
 * that route rather than only reporting failure (L02-AC3, F24-AC5).
 *
 * Two fingerprints are shown and labelled, because they answer two different questions: the content
 * fingerprint is which text was approved, and the packet fingerprint is which document was rendered
 * from it. Two reads of the same approved revision produce the same packet, so the packet fingerprint
 * is what the clipboard can be checked against (N02-AC2).
 */
function PacketPanel({
  markdown,
  fingerprint,
  contentFingerprint,
  revision,
  copyState,
  copyDetail,
  onCopy,
}: PacketPanelProps): ReactElement {
  return (
    <section className="panel" aria-labelledby="packet-heading">
      <h3 className="panel__title" id="packet-heading">
        The packet
      </h3>
      <p className="panel__note" data-testid="packet-revision">
        {`Revision ${revision}. ` +
          (contentFingerprint === null
            ? 'The approved contract text could not be read, so this page shows the packet only and claims nothing about which text it came from.'
            : `The approved text has content fingerprint ${contentFingerprint}, and this packet has fingerprint ` +
              `${fingerprint}. They are digests of two different things — the agreed text and the document ` +
              'rendered from it — so the first is the identity of what you approved and the second is the identity ' +
              'of what you are about to paste. Two reads of this revision render these same bytes, so either value is ' +
              'what lets you check the copy rather than trust it (N02-AC2, mvp-spec 7).')}
      </p>
      <div className="form__actions">
        <button className="button" type="button" onClick={() => onCopy(markdown)} data-testid="copy-packet">
          Copy implementation packet
        </button>
      </div>
      <p
        className={copyState === 'refused' ? 'state-line state-line--error' : 'state-line'}
        role="status"
        aria-live="polite"
        data-state={copyState === 'copied' ? 'copied' : copyState === 'refused' ? 'failed' : 'idle'}
        data-testid="copy-state"
      >
        {copyDetail === ''
          ? 'Nothing has been copied yet. The packet below is selectable either way.'
          : copyDetail}
      </p>
      <pre
        className="connector__problem-line"
        tabIndex={0}
        aria-label="Implementation packet text"
        data-testid="packet-markdown"
        style={{ maxHeight: '28rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}
      >
        {markdown}
      </pre>
    </section>
  );
}

interface ExternalToolPanelProps {
  readonly tool: HandoffT3View;
  readonly onOpenSettings: () => void;
}

/**
 * What the owner may do with the external tool, and — mostly — what they may not conclude from it.
 *
 * The three states are kept apart because a nullable URL cannot tell them apart and the difference
 * changes what the owner is told. `NotConfigured` is normal and the packet works anyway; `Unusable`
 * is an operator error with a different remedy; `Configured` is the only state in which a link is
 * rendered at all, and even then only if the address is one this browser will open (L02-AC3, N02-AC2).
 */
function ExternalToolPanel({ tool, onOpenSettings }: ExternalToolPanelProps): ReactElement {
  if (tool.state === 'Configured' && isHttpUrl(tool.url)) {
    return (
      <section className="panel" aria-labelledby="external-tool-heading">
        <h3 className="panel__title" id="external-tool-heading">
          Open the external tool
        </h3>
        <p className="panel__note">
          T3 is a separate tool you may or may not use. This button opens its address in a new tab and
          nothing else: ShipLoop does not start, watch or follow anything inside it, so nothing here
          reports on what you do there. Implementation happens outside ShipLoop; come back and link
          the pull request when there is one (mvp-spec L02, L02-AC1).
        </p>
        <div className="form__actions">
          <a
            className="button"
            href={tool.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="open-external-tool"
          >
            Open T3 (opens in a new tab)
          </a>
        </div>
      </section>
    );
  }

  const configuredButUnopenable = tool.state === 'Configured';
  return (
    <section className="panel" aria-labelledby="external-tool-heading">
      <h3 className="panel__title" id="external-tool-heading">
        Open the external tool
      </h3>
      {configuredButUnopenable ? (
        <p className="connector__problem-line" data-testid="external-tool-unopenable">
          A T3 address is configured for this project, but it is not an address this browser will
          open, so no link is rendered. The packet above is unaffected — it is text you can paste
          anywhere. Fix the address in Settings (L02-AC2, N02-AC2).
        </p>
      ) : (
        <>
          <p className="connector__problem-line" data-testid="external-tool-not-configured">
            {tool.reason}
          </p>
          <p className="connector__problem-line">
            The implementation packet above is complete without it. Copy the packet and use whatever
            tool you already work in — the packet, the contract and the evidence are the product, and
            T3 is one option for implementing against them (L02-AC3).
          </p>
          {tool.prerequisites.length === 0 ? null : (
            <ul className="capability-list" data-testid="external-tool-prerequisites">
              {tool.prerequisites.map((prerequisite) => (
                <li className="capability-list__item" key={prerequisite.name}>
                  <span className="profile-list__name">{prerequisite.name}</span>
                  <span className="profile-list__detail">{prerequisite.detail}</span>
                  <p className="connector__problem-line">{prerequisite.remedy}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="form__actions">
            <button className="button" type="button" onClick={onOpenSettings} data-testid="open-settings">
              Set the T3 address in Settings
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Writes text to the clipboard, or explains why it could not.
 *
 * `navigator.clipboard` is absent on an insecure origin and refused without a user gesture or a
 * permission, and each of those is a different message an owner can act on. The result is a value
 * rather than a thrown error so a caller cannot forget to handle the refusal — a copy control that
 * says "Copied" without knowing is the failure mode this whole page exists to avoid.
 */
export async function copyToClipboard(text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    return {
      ok: false,
      reason:
        'This browser would not let the page use the clipboard, so nothing was copied. The packet is shown below: ' +
        'select it and copy it by hand, and check the fingerprint afterwards to confirm the bytes match (N03-AC3).',
    };
  }
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason:
        'The clipboard refused the write, so the packet was not copied. The text below is still complete: ' +
        'select it and copy it by hand (N03-AC3).',
    };
  }
}
