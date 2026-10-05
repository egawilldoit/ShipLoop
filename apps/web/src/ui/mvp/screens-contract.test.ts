/**
 * What the two new screens promise at their own boundary.
 *
 * The behaviour of the flows themselves is proved in `request-intake.test.ts` and
 * `contract-agreement.test.ts` against a recording `fetch`, where the assertions are about the bytes
 * that would leave the browser and the sentences a reader would see. This file covers the claims that
 * are only visible in the components themselves, and it reads their source because Node strips types
 * but does not transform JSX — so `node --test` cannot mount them (the same reason
 * `handoff-copy.test.ts` reads source).
 *
 * The claims worth protecting:
 *
 *   - **the screens are written against the seam.** `RequestScreen` and `ContractScreen` take exactly
 *     `ScreenProps` and nothing else, because two other surfaces are coded against that shape and a
 *     screen that grew its own props would be a third contract (mvp-spec 3).
 *   - **neither screen assembles a URL or calls `fetch`.** The previous wave shipped a complete UI
 *     against routes the backend does not have, and the reason nothing caught it was that URL strings
 *     were scattered through components. Every call goes through `request-intake.ts` /
 *     `contract-agreement.ts` / `mvp-client`, and that is mechanical here rather than a convention
 *     (F02-AC2, mvp-spec 3).
 *   - **no screen re-derives an eligibility or verification judgement.** Nothing computes whether a
 *     contract is approvable or whether a check passed; every such answer is read off a server
 *     response. The names checked here are the vocabulary a client would have to invent to do that
 *     (F23-AC1, F24-AC3, F25-AC3).
 *   - **the shared states are used.** `NoProjectSelected`, `ScreenFailure`, `ScreenLoading` and
 *     `ScreenEmpty` exist so "no project", "refused", "loading" and "nothing here" cannot render the
 *     same way on two screens (N03-AC1, N03-AC3).
 *   - **unsaved text is stated, not implied.** The contract screen says a reload loses unsaved edits
 *     rather than letting the owner discover it (N03-AC3).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REQUEST = fileURLToPath(new URL('./RequestScreen.tsx', import.meta.url));
const CONTRACT = fileURLToPath(new URL('./ContractScreen.tsx', import.meta.url));
const request = await readFile(REQUEST, 'utf8');
const contract = await readFile(CONTRACT, 'utf8');

/**
 * Source with comments removed.
 *
 * Both files *discuss* the words checked below in order to forbid them, so a test scanning the raw
 * text would fail on its own explanation. Only the block comments and line comments go; string
 * literals and JSX children stay, because those are what a browser renders (N03-AC1).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const requestCode = stripComments(request);
const contractCode = stripComments(contract);

test('both screens are written against the shared ScreenProps seam and export that shape', () => {
  for (const [name, code] of [
    ['RequestScreen', requestCode],
    ['ContractScreen', contractCode],
  ] as const) {
    assert.match(code, /export function \w+\(\{ scope, epoch \}: ScreenProps\): ReactElement/, `${name} must take ScreenProps only`);
    assert.match(code, /import type \{ ScreenProps \} from '\.\/screen\.tsx'/, `${name} must import the seam type`);
  }
});

test('neither screen exports a props interface of its own', () => {
  // Two other surfaces are coded against `ScreenProps`. An exported props interface per screen is how
  // three contracts start to disagree, and the disagreement is invisible until someone wires them
  // together. Internal sub-components may take whatever props they need; only the exported shape is
  // the seam.
  for (const [name, code] of [
    ['RequestScreen', requestCode],
    ['ContractScreen', contractCode],
  ] as const) {
    assert.doesNotMatch(code, /export (interface|type) \w*Props/, `${name} must not export its own props shape`);
  }
});

test('neither screen calls fetch or assembles a URL', () => {
  for (const [name, code] of [
    ['RequestScreen', requestCode],
    ['ContractScreen', contractCode],
  ] as const) {
    assert.doesNotMatch(code, /\bfetch\(/, `${name} must reach the server through the typed client (mvp-spec 3)`);
    assert.doesNotMatch(code, /['"`]\/api\//, `${name} must not name a route; the client owns every path (F02-AC2)`);
  }
});

test('the screens reach the server only through the modules that own those calls', () => {
  // Named explicitly so a screen that grew its own call site would have to remove one of these lines,
  // which is a reviewable edit rather than a silent one.
  assert.match(requestCode, /from '\.\/request-intake\.ts'/);
  assert.match(requestCode, /createRequestFromWords/);
  assert.match(requestCode, /readRequestDetail/);
  assert.match(contractCode, /from '\.\/contract-agreement\.ts'/);
  assert.match(contractCode, /saveContractDraft/);
  assert.match(contractCode, /approveContractText/);
});

test('neither screen decides eligibility or a verification verdict', () => {
  // The vocabulary a client would need to reach these conclusions is named explicitly: if any of them
  // appears, a screen is judging the product rather than reporting it (F23-AC1, F24-AC3, F25-AC3).
  for (const [name, code] of [
    ['RequestScreen', requestCode],
    ['ContractScreen', contractCode],
  ] as const) {
    for (const judgement of [
      /\beligible\b/i,
      /\breviewReadiness\b/,
      /\bchecksReady\b/,
      /\bisBlocking\b/,
      /\breadyForAcceptance\b/,
      /\bcountsForCurrentCandidate\b/,
    ]) {
      assert.equal(judgement.test(code), false, `${name} must not derive ${judgement} — the server owns it`);
    }
  }
});

test('neither screen renders a verdict about a check', () => {
  // A green or red mark for a check, computed in the browser, is a claim this product cannot support:
  // only a provider read says what a check concluded, and only the server decides what that means.
  for (const [name, code] of [
    ['RequestScreen', requestCode],
    ['ContractScreen', contractCode],
  ] as const) {
    assert.doesNotMatch(code, />\s*(Passed|Failed|Missing|Waiting|Stale|NotApplicable)\s*</, `${name} must not render a check verdict (F20-AC2)`);
  }
});

test('both screens use the shared states rather than inventing their own', () => {
  for (const [name, code] of [
    ['RequestScreen', requestCode],
    ['ContractScreen', contractCode],
  ] as const) {
    assert.match(code, /NoProjectSelected/, `${name} must render the shared no-project state (F02-AC1)`);
    assert.match(code, /ScreenFailure/, `${name} must render refusals the shared way (N03-AC3)`);
    assert.match(code, /ScreenLoading|ScreenEmpty/, `${name} must distinguish loading from empty (N03-AC1)`);
  }
});

test('the request screen asks for one sentence and nothing else', () => {
  // The route accepts `title` and `description`; a form that asked for scope, criteria, a category or
  // a priority would be collecting contract content at intake, which is where the two-tab and
  // one-current-draft rules do not yet exist (mvp-spec 3, F06-AC1).
  assert.match(request, /What do you want changed\?/);
  assert.match(request, /Short label \(optional\)/);
  for (const field of ['Acceptance criteri', 'Out of scope', 'Verif', 'Priorit', 'Categor']) {
    assert.equal(
      new RegExp(`label[^>]*>\\s*[^<]*${field}`, 'i').test(request),
      false,
      `"${field}" is delivery-contract content and must not be asked for at intake (mvp-spec 3)`,
    );
  }
});

test('the request screen re-reads the request after creating it', () => {
  // Rendering the create response would show a request whose contract state nobody has read yet, and
  // "no contract" would be an assumption rather than an answer (F24-AC2).
  const created = request.indexOf('createRequestFromWords');
  const reread = request.indexOf('readRequestDetail', created);
  assert.ok(created !== -1, 'the screen must create the request');
  assert.ok(reread > created, 'the created request must be read back from the server after the create');
});

test('the contract screen offers the server\'s check names, never a free-text binding', () => {
  // A text box here would let a criterion bind to a check nobody runs, which approval refuses anyway —
  // so the field could only ever collect a value that cannot become one (F23-AC1, F24-AC3).
  assert.match(contract, /CriterionEditor/);
  assert.match(contract, /read\.checks\.choices/);
  assert.match(contract, /contract-no-profile/, 'a project with no profile must be explained, not silently empty');
  assert.doesNotMatch(
    contract,
    /verificationCheckId[\s\S]{0,120}<input/,
    'the binding must be a picker over configured names, not a text field',
  );
});

test('a conflict region requires a reload and offers no retry', () => {
  // Retrying submits the same stale fingerprint and is refused again; the only useful action is to read
  // the contract and reconcile (F24-AC4).
  assert.match(contract, /data-testid="contract-conflict"/);
  assert.match(contract, /data-testid="contract-conflict-reload"/);
  assert.match(contract, /Reload the contract and reconcile/);
  assert.doesNotMatch(
    contractCode,
    /data-testid="contract-conflict"[\s\S]{0,400}Retry/,
    'a retry against the same fingerprint must not be offered (F24-AC4)',
  );
});

test('the contract screen states that a reload loses unsaved edits', () => {
  // Reload re-reads from the server, so unsaved typing is gone. Saying so is the honest report; the
  // alternative is a form that appears to have kept something it did not (N03-AC3).
  assert.match(contract, /Anything typed but not saved is lost on reload/);
});

test('the contract screen shows the approved revision and its content fingerprint', () => {
  // "The approved text is exactly what you reviewed" has to be checkable rather than asserted, and the
  // fingerprint is the identity of the sealed text (N02-AC2).
  assert.match(contract, /data-testid="contract-approved-revision"/);
  assert.match(contract, /data-testid="contract-approved-fingerprint"/);
  assert.match(contract, /Content fingerprint \$\{contract\.contentFingerprint\}/);
});

test('the contract screen does not offer approve with unsaved text', () => {
  // An approval seals what the server holds, so approving with unsaved edits would seal something other
  // than what is on screen. The control is disabled and the reason is stated rather than hidden.
  assert.match(contract, /hasUnsavedChanges\(read, draft\)/);
  assert.match(contract, /disabled=\{busy \|\| dirty\}/);
  assert.match(contract, /Save them before approving/);
});

test('an agreed revision offers a new revision rather than an edit in place', () => {
  // `routes/contracts.ts` answers 400 to a PATCH of an approved revision; `/revise` is the route
  // forward, and it retires the approval it replaces in one step (mvp-spec 3).
  assert.match(contract, /revision\.status !== 'draft'[^\n]*\?/s);
  assert.match(contract, /data-testid="contract-revise"/);
  assert.match(contract, /Start revision \$\{revision\.revision \+ 1\}/);
});

test('no screen makes an affirmative claim that anything started, is running or was launched', () => {
  // Neither of these screens starts or watches anything. The positive half of that rule matters as much
  // as the negative: the contract screen says "Nothing was started or sent anywhere", and that sentence
  // has to keep its negation, so this matches an *affirmative* claim rather than the bare word. A
  // dropped "Nothing" in that line is the regression worth catching (mvp-spec L02, F25-AC4).
  const AFFIRMATIVE = /\b(has started|have started|is running|are running|was launched|were launched|is executing)\b/i;
  for (const [name, code] of [
    ['RequestScreen', requestCode],
    ['ContractScreen', contractCode],
  ] as const) {
    assert.doesNotMatch(code, AFFIRMATIVE, `${name} must not claim anything started or is running (mvp-spec L02)`);
  }
  assert.match(
    contractCode,
    /Nothing was started or sent/,
    'the contract screen must keep saying that approving started nothing',
  );
});
