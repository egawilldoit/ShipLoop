/**
 * The handoff: everything an owner needs to have an external coding environment implement an
 * approved contract, and the two ShipLoop actions that follow.
 *
 * This surface exists because external execution is **outside** ShipLoop. There is no runtime
 * here, no queue and no job: "Prepare implementation" produces a packet, and the owner takes it to
 * T3 themselves. Everything on this page is therefore worded so that it cannot be read as automatic
 * execution — the button asks for a packet, the link opens a tool, and neither of them starts
 * anything. A control labelled "Run" on a product with no runner is the most damaging thing this
 * screen could contain.
 *
 * Three properties are load-bearing:
 *
 *   - **The packet is the server's, verbatim.** The copy action copies exactly the text the server
 *     produced, and the preview renders that same text. A browser that assembled its own packet
 *     would let the packet drift from what the backend later hands to an auditor, which is the one
 *     artefact in this product that has to survive being quoted.
 *   - **"Open T3" opens T3, not ShipLoop.** It is rendered only when a T3 address was configured and
 *     validated by the server, it opens in a new tab, and its label says what it does. When no
 *     address is configured the control is absent and its absence is stated — Settings is named as
 *     the place to set one, rather than a dead button.
 *   - **A candidate is identified by its full commit SHA.** The link form refuses an abbreviated
 *     one before it is sent, and the linked candidate is then shown with the full SHA it was
 *     recorded under.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { formatTimestamp } from '../../api-client.ts';
import { StatusBadge } from '../../components/StatusBadge.tsx';
import { fetchContract, linkCandidate, prepareImplementation } from '../client.ts';
import { Panel, Sha, StateLine, type ViewState } from '../components/StateLine.tsx';
import { SHA_IDENTITY_NOTE, shaProblem } from '../sha.ts';
import type { Candidate, HandoffPacket } from '../wire.ts';

export interface HandoffPageProps {
  readonly contractId: string;
  readonly epoch: number;
  readonly onLinked: (candidateId: string) => void;
}

type CopyState = 'idle' | 'copied' | 'refused';

export function HandoffPage({ contractId, epoch, onLinked }: HandoffPageProps): ReactElement {
  const [packet, setPacket] = useState<HandoffPacket | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [approved, setApproved] = useState(false);
  const [view, setView] = useState<ViewState>('loading');
  const [viewMessage, setViewMessage] = useState('Reading the approved contract…');
  const [preparing, setPreparing] = useState(false);
  const [prepareFailure, setPrepareFailure] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [repository, setRepository] = useState('');
  const [pullRequestNumber, setPullRequestNumber] = useState('');
  const [pullRequestUrl, setPullRequestUrl] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [headSha, setHeadSha] = useState('');
  const [linking, setLinking] = useState(false);
  const [shaMessage, setShaMessage] = useState<string | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    setReload((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    setView('loading');
    void fetchContract(contractId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setViewMessage(`This contract could not be read: ${result.error.reason}`);
        setView(result.error.code === 'NotFound' ? 'empty' : 'error');
        return;
      }
      setRevision(result.value.contract.revision);
      setApproved(result.value.contract.status === 'approved');
      if (result.value.contract.status !== 'approved') {
        setPacket(null);
        setViewMessage(
          result.value.contract.status === 'stale'
            ? `Revision ${String(result.value.contract.revision)} is stale, so it no longer describes the work and there is nothing to hand off. Approve the current revision first.`
            : `Revision ${String(result.value.contract.revision)} is a draft, so there is nothing to hand off yet. Approve the contract first.`,
        );
        setView(result.value.contract.status === 'stale' ? 'stale' : 'empty');
        return;
      }
      setViewMessage(`Revision ${String(result.value.contract.revision)} is approved and ready to hand off.`);
      setView('ready');
    });
    return () => {
      current = false;
    };
  }, [contractId, epoch, reload]);

  const prepare = async (): Promise<void> => {
    if (preparing) return;
    setPreparing(true);
    setPrepareFailure(null);
    setCopyState('idle');
    setCopyMessage(null);
    const result = await prepareImplementation(contractId);
    setPreparing(false);
    if (!result.ok) {
      setPacket(null);
      setPrepareFailure(`The implementation packet was not produced: ${result.error.reason}`);
      return;
    }
    setPacket(result.value.packet);
    setRevision(result.value.packet.revision);
  };

  const copyPacket = async (): Promise<void> => {
    if (packet === null) return;
    try {
      await navigator.clipboard.writeText(packet.content);
      setCopyState('copied');
      setCopyMessage('The packet is on your clipboard, exactly as the server produced it.');
    } catch {
      // Clipboard access can be refused by the browser, by an insecure context, or by permission
      // policy. Saying so is the honest outcome; the packet is on screen either way, and the page
      // says that rather than leaving a control that appears to have done nothing.
      setCopyState('refused');
      setCopyMessage(
        'The browser refused clipboard access, so nothing was copied. The whole packet is in the box below — select it and copy it by hand.',
      );
    }
  };

  const submitCandidate = async (): Promise<void> => {
    if (linking) return;
    const shaProblemText = shaProblem(headSha);
    if (shaProblemText !== null) {
      setShaMessage(shaProblemText);
      setLinkFailure('The pull request was not linked because the commit could not be identified.');
      return;
    }
    setShaMessage(null);
    if (repository.trim() === '') {
      setLinkFailure('Name the repository the pull request is in, as owner/name.');
      return;
    }
    setLinking(true);
    setLinkFailure(null);
    const result = await linkCandidate({
      contractId,
      repository: repository.trim(),
      pullRequestNumber: pullRequestNumber.trim() === '' ? null : Number.parseInt(pullRequestNumber.trim(), 10),
      pullRequestUrl: pullRequestUrl.trim() === '' ? null : pullRequestUrl.trim(),
      baseBranch: baseBranch.trim() === '' ? 'main' : baseBranch.trim(),
      headSha: headSha.trim(),
    });
    setLinking(false);
    if (!result.ok) {
      setLinkFailure(`The pull request was not linked: ${result.error.reason}`);
      return;
    }
    setCandidate(result.value.candidate);
    setLinkFailure(null);
    onLinked(result.value.candidate.id);
  };

  return (
    <section className="page" aria-labelledby="handoff-title">
      <h2 className="page__title" id="handoff-title">
        Implementation handoff
      </h2>
      <p className="panel__note">
        ShipLoop does not run your implementation. This page hands you the packet, points you at your coding
        environment, and then takes back the one thing it can check: which exact commit is proposed.
      </p>

      <StateLine view={view} message={viewMessage} testId="handoff-state" />

      {view === 'error' || view === 'empty' || view === 'stale' ? (
        <div className="form__actions">
          <button className="button button--secondary" type="button" data-testid="handoff-retry" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}

      <Panel
        id="handoff-revision"
        title="The approved revision"
        note={
          revision === null
            ? 'No revision has been read.'
            : `Revision ${String(revision)}${approved ? ', approved' : ''}. Everything below describes this revision and nothing else.`
        }
      >
        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>State</dt>
            <dd data-testid="handoff-approved">
              {approved ? (
                <StatusBadge tone="healthy" label="Approved" detail="You approved this revision. It is the agreement being handed off." />
              ) : (
                <StatusBadge tone="pending" label="Not approved" detail="An unapproved draft is not an agreement to implement." />
              )}
            </dd>
          </div>
          <div className="detail-list__row">
            <dt>Contract</dt>
            <dd>
              <code>{contractId}</code>
            </dd>
          </div>
        </dl>
        <div className="form__actions">
          <button
            className="button"
            type="button"
            disabled={!approved || preparing}
            data-testid="prepare-implementation-handoff"
            onClick={() => void prepare()}
          >
            {preparing ? 'Preparing…' : packet === null ? 'Prepare implementation' : 'Regenerate the packet'}
          </button>
          {packet?.t3Url == null ? null : (
            <a
              className="button button--secondary"
              href={packet.t3Url}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="open-t3"
            >
              Open T3
            </a>
          )}
        </div>
        <p className="panel__note" data-testid="handoff-t3-note">
          {packet === null
            ? 'No T3 address is offered yet, because the packet has not been prepared. Prepare the packet and the address you configured in Settings will appear here.'
            : packet.t3Url === null
              ? 'No T3 address is configured for this project, so there is nothing to open. Set one in Settings if you want a link here.'
              : `Open T3 opens your coding environment in a new tab at ${packet.t3Url}. It does not send anything, start anything, or report back: you take the packet there yourself.`}
        </p>
        {prepareFailure === null ? null : (
          <StateLine view="error" message={prepareFailure} testId="handoff-prepare-failure" />
        )}
      </Panel>

      <Panel
        id="handoff-packet"
        title="Implementation packet"
        note="Produced by the server from the approved revision, and shown here exactly as it was produced. Nothing ShipLoop does later can change it."
      >
        {packet === null ? (
          <StateLine
            view="empty"
            message="No packet has been produced for this revision yet."
            testId="handoff-packet-empty"
          />
        ) : (
          <>
            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Revision</dt>
                <dd data-testid="packet-revision">{String(packet.revision)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Produced at</dt>
                <dd data-testid="packet-generated-at">{formatTimestamp(packet.generatedAt)}</dd>
              </div>
            </dl>
            <label className="field__label" htmlFor="handoff-packet-content">
              The packet
            </label>
            <textarea
              className="field__input field__input--area packet"
              id="handoff-packet-content"
              readOnly
              value={packet.content}
              data-testid="packet-content"
            />
            <div className="form__actions">
              <button className="button" type="button" data-testid="copy-packet" onClick={() => void copyPacket()}>
                Copy implementation packet
              </button>
            </div>
            {copyMessage === null ? null : (
              <StateLine view={copyState === 'refused' ? 'error' : 'ready'} message={copyMessage} testId="copy-state" />
            )}
          </>
        )}
      </Panel>

      <Panel
        id="handoff-candidate"
        title="Link the GitHub pull request"
        note={`${SHA_IDENTITY_NOTE} Linking a pull request records a candidate: the exact commit, the branch it came from and the revision it claims to satisfy.`}
      >
        {candidate !== null ? (
          <>
            <StateLine
              view="ready"
              message={`Linked candidate ${candidate.id} against contract revision ${String(candidate.contractRevision)}.`}
              testId="candidate-linked"
            />
            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Commit under review</dt>
                <dd>
                  <Sha value={candidate.headSha} testId="candidate-head-sha" />
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Pull request</dt>
                <dd data-testid="candidate-pr">
                  {candidate.pullRequestUrl === null
                    ? candidate.pullRequestNumber === null
                      ? 'No pull request number or address was recorded for this candidate.'
                      : `#${String(candidate.pullRequestNumber)}, with no address to open.`
                    : candidate.pullRequestUrl}
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Base branch</dt>
                <dd>{candidate.baseBranch}</dd>
              </div>
            </dl>
            <div className="form__actions">
              <button className="button" type="button" data-testid="candidate-open-review" onClick={() => onLinked(candidate.id)}>
                Open its review
              </button>
            </div>
          </>
        ) : (
          <form
            className="form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submitCandidate();
            }}
          >
            <div className="field">
              <label className="field__label" htmlFor="candidate-repository">
                Repository
              </label>
              <input
                className="field__input"
                id="candidate-repository"
                value={repository}
                disabled={linking}
                placeholder="owner/name"
                onChange={(event) => setRepository(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="candidate-pr-number">
                Pull request number (optional)
              </label>
              <input
                className="field__input"
                id="candidate-pr-number"
                value={pullRequestNumber}
                disabled={linking}
                onChange={(event) => setPullRequestNumber(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="candidate-pr-url">
                Pull request address (optional)
              </label>
              <input
                className="field__input"
                id="candidate-pr-url"
                type="url"
                value={pullRequestUrl}
                disabled={linking}
                onChange={(event) => setPullRequestUrl(event.target.value)}
              />
              <p className="field__hint">Recorded as given. ShipLoop will not resolve it or claim it has opened it.</p>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="candidate-base-branch">
                Base branch
              </label>
              <input
                className="field__input"
                id="candidate-base-branch"
                value={baseBranch}
                disabled={linking}
                onChange={(event) => setBaseBranch(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="candidate-head-sha">
                Head commit SHA
              </label>
              <input
                className="field__input"
                id="candidate-head-sha"
                value={headSha}
                disabled={linking}
                spellCheck={false}
                autoComplete="off"
                aria-required="true"
                aria-invalid={shaMessage === null ? undefined : 'true'}
                aria-describedby="candidate-head-sha-hint"
                onChange={(event) => setHeadSha(event.target.value)}
              />
              <p className="field__hint" id="candidate-head-sha-hint">
                All 40 characters, pasted from your provider. An abbreviated SHA is refused here rather than
                accepted and discovered later.
              </p>
              {shaMessage === null ? null : (
                <p className="field__error" data-testid="sha-error">
                  <span className="field__error-mark" aria-hidden="true" />
                  Error: {shaMessage}
                </p>
              )}
            </div>
            {linkFailure === null ? null : (
              <StateLine view="error" message={linkFailure} testId="candidate-link-failure" />
            )}
            <div className="form__actions">
              <button className="button" type="submit" disabled={linking} data-testid="link-candidate">
                {linking ? 'Linking…' : 'Link GitHub PR'}
              </button>
            </div>
          </form>
        )}
      </Panel>
    </section>
  );
}