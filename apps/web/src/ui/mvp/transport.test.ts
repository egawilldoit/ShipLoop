/**
 * What the remaining transport in this directory is allowed to send, and how it reads an answer.
 *
 * These tests read the source of `transport.ts`, because the claims worth protecting are not
 * observable from a rendered page — they are claims about what leaves the browser:
 *
 *   1. **The verification call states no verdict.** `routes/verification.ts` accepts a `strictObject`
 *      with one optional member and refuses `result`, `outcome`, `checkId`, `criterionId` and
 *      `headSha` by name. A client that grew one of those would be refused, and worse, a client that
 *      *tried* to would be trying. So the body is asserted to be exactly `{ method }`, and the test
 *      names every field that must never appear, so adding one is a visible edit to a list of
 *      forbidden things (F20-AC2, F23-AC1).
 *   2. **Every path is project-scoped.** The previous wave's shipped defect was a UI built against
 *      spellings the backend did not have. "Does the URL begin with /api/projects/<id>/" is therefore a
 *      test rather than a convention (F02-AC2).
 *   3. **No handoff spelling survives here.** The handoff half of this flow now reads through
 *      `../mvp-client/index.ts`, so the old packet types and reader are asserted gone rather than
 *      quietly left beside the new ones (mvp-spec 7, N02-AC2).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('./transport.ts', import.meta.url));
const source = await readFile(SOURCE, 'utf8');

/**
 * The source with its comments removed.
 *
 * The header deliberately *names* what was deleted and where it moved, so the "no handoff here" test
 * below has to read code rather than prose — otherwise this file's own explanation of the migration
 * would fail the assertion that performs it (mvp-spec 7).
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/[^\n]*$/gm, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

/**
 * The members `routes/verification.ts` refuses by name.
 *
 * Read out of that route's own schema rather than this client's opinion: each one would be a way for the
 * browser to say what a check concluded, which is the one thing the browser may not do. `candidateId`
 * and `evidenceId` appear legitimately in *responses*, which is why each test matches a body member
 * rather than the bare word (F20-AC2, F23-AC1).
 */
const FORBIDDEN_IN_A_BODY: readonly string[] = [
  'result',
  'outcome',
  'checkId',
  'criterionId',
  'headSha',
  'candidateId',
  'evidenceId',
];

test('the verification call sends `method` and nothing else', () => {
  // The body is written inline at the call site, so the assertion is on the source rather than on a
  // parsed request: this cannot be satisfied by a helper that happens to strip extra fields at runtime,
  // because there is nothing to strip — the object literal is the whole body.
  const call = /send\('POST', `\$\{path\.value\}\/verify`, \{([^}]*)\}\)/.exec(source);
  assert.notEqual(call, null, 'the verify call must send an explicit body, not rely on an absent one');
  const body = call?.[1] ?? '';
  assert.deepEqual(
    [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((match) => match[1]),
    ['method'],
    `the verify body must carry exactly one member and it must be method, found: ${body}`,
  );
});

test('the verification call names the one method this deployment runs', () => {
  // The route's enum has a single case, `github_checks`. Naming it is the client being clear about where
  // a verdict will come from rather than letting the server guess (F20-AC2).
  assert.match(source, /\{ method: 'github_checks' \}/);
});

test('no forbidden verdict member appears in any request body this module builds', () => {
  for (const member of FORBIDDEN_IN_A_BODY) {
    const inNamedBody = new RegExp(`body: \\{[^}]*\\b${member}\\s*:`);
    const inVerifyBody = new RegExp('/verify`,\\s*\\{[^}]*\\b' + member + '\\s*:');
    assert.equal(
      inNamedBody.test(source) || inVerifyBody.test(source),
      false,
      `"${member}" must never be sent as part of a request body; the server derives it (F20-AC2, F23-AC1)`,
    );
  }
});

test('the refresh sends no body at all', () => {
  // `routes/candidates.ts` types the refresh body as `strictObject({}).nullish`, and a body that tried
  // to say what changed would be refused rather than dropped. So there is nothing to send and the call
  // passes only a path (mvp-spec F20-AC3).
  assert.match(source, /send\('POST', `\$\{path\.value\}\/refresh`\)/);
});

test('the link body carries exactly the four fields the route accepts', () => {
  // `linkCandidateBody` in `routes/candidates.ts` is `strictObject` with `requestId`, `contractId`,
  // `contractRevision` and `pullRequestUrl`. There is no head-SHA field, no branch field and no
  // pull-request-number field to send, because identity is the provider's to state (mvp-spec 3).
  const body = /send\('POST', `\/api\/projects\/\$\{project\.value\}\/candidates`, \{([\s\S]*?)\}\);/.exec(
    source,
  );
  assert.notEqual(body, null, 'the link body must be written at the call site so it can be read');
  const members = [...(body?.[1] ?? '').matchAll(/([A-Za-z_][A-Za-z0-9_]*):/g)].map((match) => match[1]);
  assert.deepEqual(members, ['requestId', 'contractId', 'contractRevision', 'pullRequestUrl']);
});

test('every route this module calls is project-scoped', () => {
  const paths = [...source.matchAll(/`(\/api\/[^`]*)`/g)]
    .map((match) => match[1])
    .filter((path): path is string => path !== undefined);
  assert.ok(paths.length > 0, 'expected at least one path template to check');
  for (const path of paths) {
    assert.match(
      path,
      /^\/api\/projects\/\$\{/,
      `${path} addresses something without naming the project it belongs to (F02-AC2)`,
    );
  }
});

test('the settings save sends exactly `t3Url`, and it is nullable', () => {
  // `routes/settings.ts` types the field as nullable rather than merely optional, because "there is no
  // T3 deployment" and "I did not say" are different states and a body that has to omit the field to
  // mean the second cannot also say the first (L02-AC3).
  assert.match(source, /\{ t3Url \}/);
});

test('this module holds no handoff route, reader or type any more', () => {
  // The handoff half was re-pointed at `../mvp-client/index.ts`, which owns `fetchHandoff`, the
  // `HandoffView` read model and the URL gate. Leaving the old spellings here would leave two
  // definitions of one wire shape, and the second is free to drift from the route with nothing
  // noticing (mvp-spec 7, N02-AC2). Asserted here so a later re-add is a visible edit to a list of
  // forbidden things rather than an accident.
  for (const name of [
    'fetchHandoff',
    'interface Handoff',
    'HandoffPacket',
    'HandoffExternalTool',
    'HandoffPrerequisite',
    '/handoff',
  ]) {
    assert.equal(
      code.includes(name),
      false,
      `${name} belongs to ../mvp-client/index.ts; this module must not carry a second spelling of it`,
    );
  }
});

test('the header names the two surfaces that still read this module', () => {
  // What remains here belongs to `CandidatePage.tsx` and `ExternalToolSetting.tsx`, which have not been
  // re-pointed. The header says so, and this fails if the file grows a route that comment does not
  // mention — which is the moment this module should have been deleted instead (mvp-spec 7).
  assert.match(source, /CandidatePage\.tsx/);
  assert.match(source, /ExternalToolSetting\.tsx/);
});

test('a state-changing call carries the session token, and says so when it cannot', () => {
  assert.match(source, /if \(method !== 'GET'\)/);
  assert.match(source, /csrfTokenForRequests\(\)/);
  assert.match(source, /CSRF_HEADER\] = token/);
});

test('a refusal is not reported as an unreachable server', () => {
  // The connection banner's whole job is separating these. A transport that marked every refusal as a
  // lost connection would tell the owner their view had stopped being current when it answered
  // (N03-AC1, N03-AC3).
  assert.match(source, /if \(!response\.ok\) return refused\(readRefusal\(parsed, response\.status\)\)/);
});

test('the transport parses wire data defensively rather than casting it', () => {
  // A card with three of its four identity fields missing reads as complete to the person looking at it,
  // so an unreadable shape has to produce a stated refusal rather than a partially-filled card
  // (mvp-spec F24-AC2).
  assert.doesNotMatch(source, /as CandidateReport\b/);
  assert.doesNotMatch(source, /as Handoff\b/);
  assert.doesNotMatch(source, /as VerificationReport\b/);
});

test('nothing in this module merges, closes, approves or deploys at the provider', () => {
  // The candidate port has no such method, and a control that would call one cannot exist here even by
  // accident (mvp-spec F03-AC5).
  for (const verb of ['merge', 'close', 'deploy', 'release', '/publish']) {
    const asCall = new RegExp(`send\\('(?:POST|PATCH)', \`[^']*${verb}`);
    assert.equal(asCall.test(source), false, `no request may be sent to a ${verb} route (F03-AC5)`);
  }
});