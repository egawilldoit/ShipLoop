/**
 * Behavioural proof for the read-only context packet (F07-AC4, F07-AC5, F07-AC2, F18-AC2).
 *
 * The packet's whole job is to be honest about what was and was not inspected, so the
 * cases here are about absences:
 *
 *   - a repository fact nobody read is `Unknown` with a reason, and carries no evidence
 *     and no revision to make it look grounded (F07-AC4);
 *   - `codeGroundedClaim` in the domain, not this layer, decides that label — the test
 *     reads the domain's own verdict back off each claim to prove the inputs were right;
 *   - a fact without a stated reason is refused rather than filed as a gap, because an
 *     unexplained gap is how an unexamined guess becomes an answer (F07-AC4);
 *   - two repository facts read at different commits cannot form one picture of a
 *     codebase (F07-AC4);
 *   - the render budget names the facts it dropped (F07-AC2);
 *   - the profile the packet carries exposes no mutating capability (F07-AC5).
 *
 * Every case runs against a real SQLite file opened by the real `openDatabase` and
 * migrated by the real `migrate`, so the idea this packet describes is a row the
 * production schema accepts rather than a fixture object (F06-AC2).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codeGroundedClaim, createIdea, isCommitSha, isMutatingCapability } from '@shiploop/domain';
import type { CodeClaim, IdeaDraft, IdeaId, ProjectId } from '@shiploop/domain';
import { IntakeRepository, ProjectProfileRepository, migrate, openDatabase } from '@shiploop/storage';
import {
  MAX_PACKET_CHARACTERS,
  REPOSITORY_CONTEXT_SOURCES,
  UNKNOWN_MARKER,
  assembleContextPacket,
  renderContextPacket,
} from './context-packet.ts';
import type { CapturedFact, ContextPacket } from './context-packet.ts';

const NOW = '2026-10-02T09:00:00.000Z';
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = '99887766554433221100ffeeddccbbaa99887766';

function inspected(
  factId: string,
  kind: CapturedFact['kind'],
  subject: string,
  reference: string,
  observed: string,
  revision: string | null,
): CapturedFact {
  return {
    factId,
    kind,
    subject,
    reference,
    observation: { observed, inspectedRevision: revision, observedAt: NOW },
    unknownReason: null,
  };
}

function uninspected(
  factId: string,
  kind: CapturedFact['kind'],
  subject: string,
  reference: string,
  unknownReason: string,
): CapturedFact {
  return { factId, kind, subject, reference, observation: null, unknownReason };
}

/** A packet over one project with one inspected guidance file and one absent fact. */
function packetFor(facts: readonly CapturedFact[], target: IdeaDraft): ContextPacket {
  const assembled = assembleContextPacket({
    packetId: 'packet-context-packet',
    ideaId: target.ideaId,
    projectId: target.projectId,
    assembledAt: NOW,
    facts,
  });
  assert.ok(assembled.ok, `the context packet assembled: ${JSON.stringify(assembled.ok ? [] : assembled.error)}`);
  return assembled.value;
}

/**
 * A real project, a real store and a real migrated database.
 *
 * The project row exists because the idea's `project_id` is a foreign key into it, and
 * a profile version is what makes a project exist in ShipLoop's terms — so the request
 * this packet describes belongs to a selected project that the production schema
 * accepted, rather than to a project id nothing backs (F06-AC2).
 */
async function withStoredIdea(body: (stored: IdeaDraft) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-context-packet-'));
  const opened = openDatabase(join(directory, 'shiploop.sqlite'));
  assert.ok(opened.ok, 'the real database opened');
  assert.ok(migrate(opened.value).ok, 'the real schema migrated');
  const profiles = new ProjectProfileRepository(opened.value);
  const intake = new IntakeRepository(opened.value);
  try {
    const saved = profiles.saveVersion({
      projectId: 'project_web' as ProjectId,
      content: {
        references: {
          repository: 'fixture/shiploop-web',
          ticketProvider: 'linear',
          ticketTeamKey: 'FIX',
          baseBranch: 'main',
          targetBranch: 'main',
          deploymentProvider: 'fixture-deployment',
          engine: 'codex',
          previewComponents: [],
        },
        policy: {
          requiredChecks: ['pnpm check'],
          deliveryBehavior: 'ManualAuthorizationOnly',
          maxFixPasses: 2,
          workspaceIsolation: 'WorktreeAndDataDirectory',
          capabilityVersion: 1,
        },
        recipe: 'node24 recipe v1',
        environment: { runtime: 'node24', ports: [4100], secretReferences: [] },
      },
      note: null,
      createdAt: NOW,
      createdBy: 'owner_context_packet',
      expectedVersionNumber: null,
    });
    assert.ok(saved.ok, `the project profile saved: ${JSON.stringify(saved.ok ? null : saved.error)}`);

    const captured = createIdea({
      ideaId: 'idea-context-packet' as IdeaId,
      rawRequest: 'the run list has no search box, so I scroll to find a run by name',
      capturedAt: NOW,
      kind: 'FeatureRequest',
      projectId: 'project_web',
    });
    assert.ok(captured.ok, 'the request captured');
    const stored = intake.capture(captured.value);
    assert.ok(stored.ok, 'the request was stored through the real repository');
    assert.equal(stored.value.projectId, 'project_web', 'the stored request belongs to the selected project');
    await body(stored.value);
  } finally {
    opened.value.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('a repository fact nobody inspected is Unknown, with no evidence and no revision to make it look grounded (F07-AC4)', async () => {
  await withStoredIdea((stored) => {
    const packet = packetFor(
      [
        inspected(
          'guidance-root',
          'RepositoryGuidance',
          'the repository agent guide',
          'AGENTS.md',
          'Run commands from this checkout; never paste set -e into the parent SSH shell.',
          HEAD_SHA,
        ),
        uninspected(
          'guidance-runs',
          'RepositoryGuidance',
          'the run-list page guidance',
          'apps/web/AGENTS.md',
          'This deployment never captured the file, so nothing is known about it.',
        ),
      ],
      stored,
    );

    assert.equal(packet.revision, HEAD_SHA);
    assert.ok(isCommitSha(packet.revision ?? ''), 'the recorded revision is a full commit SHA');

    const absent = packet.claims.find((claim) => claim.claimId === 'guidance-runs');
    assert.ok(absent !== undefined, 'the uninspected fact is a claim on the packet');
    assert.equal(absent.availability, 'Unknown');
    assert.equal(absent.observed, null, 'an Unknown claim carries no observed text to quote');
    assert.equal(absent.revision, null);
    assert.deepEqual([...absent.evidence], [], 'an Unknown claim has no evidence to cite');
    assert.deepEqual([...absent.unknowns].sort(), ['Evidence', 'Revision']);
    assert.match(absent.reason ?? '', /no evidence/i);
    assert.deepEqual([...packet.unknownSubjects], ['the run-list page guidance']);

    const read = packet.claims.find((claim) => claim.claimId === 'guidance-root');
    assert.ok(read !== undefined);
    assert.equal(read.availability, 'Grounded');
    assert.equal(read.revision, HEAD_SHA);
    assert.equal(read.observed, 'Run commands from this checkout; never paste set -e into the parent SSH shell.');
    assert.equal(read.evidence.length, 1);
    assert.equal(read.evidence[0]?.reference, 'AGENTS.md');

    const rendered = renderContextPacket(packet);
    assert.match(rendered.text, new RegExp(UNKNOWN_MARKER));
    assert.match(rendered.text, /never captured the file/);
    assert.match(rendered.text, new RegExp(HEAD_SHA));
  });
});

test('a repository fact read at a branch name is Unknown, because a ref identifies no code (F07-AC4)', async () => {
  await withStoredIdea((stored) => {
    const packet = packetFor(
      [
        // A branch name is not a revision, so the domain must call this claim unknown
        // even though an observation was recorded against it (F07-AC4).
        inspected('guidance-branch', 'RepositoryGuidance', 'the deploy runbook', 'docs/runbook.md', 'Promote main.', 'main'),
      ],
      stored,
    );

    assert.equal(packet.revision, null, 'no revision that identifies a commit was recorded');
    const claim = packet.claims[0];
    assert.ok(claim !== undefined);
    assert.equal(claim.availability, 'Unknown');
    assert.deepEqual([...claim.unknowns], ['Revision']);
    assert.match(claim.reason ?? '', /missing revision/i);

    // The same inputs, handed straight to the domain, produce the same verdict. If this
    // ever diverged, the packet would be deciding something the domain owns.
    const asDomainInput: CodeClaim = {
      claimId: 'guidance-branch',
      statement: 'Promote main.',
      subject: 'the deploy runbook',
      inspectedRevision: 'main',
      evidence: [{ kind: 'CodeLocation', reference: 'docs/runbook.md', observedAt: NOW }],
    };
    const verdict = codeGroundedClaim(asDomainInput);
    assert.equal(verdict.state, claim.availability);
    assert.deepEqual([...verdict.unknowns], [...claim.unknowns]);
    assert.equal(verdict.reason, claim.reason);
    assert.match(renderContextPacket(packet).text, new RegExp(UNKNOWN_MARKER));
  });
});

test('a fact nobody inspected and cannot explain is refused rather than filed as a gap (F07-AC4)', async () => {
  await withStoredIdea((stored) => {
    const refused = assembleContextPacket({
      packetId: 'packet-context-packet',
      ideaId: stored.ideaId,
      projectId: stored.projectId,
      assembledAt: NOW,
      facts: [uninspected('guidance-tests', 'RepositoryGuidance', 'the test strategy', 'docs/testing.md', '   ')],
    });

    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, 'Invalid');
    const paths = refused.error.code === 'Invalid' ? refused.error.fields.map((field) => field.path) : [];
    assert.ok(paths.includes('facts[0].unknownReason'), `the missing reason is named: ${paths.join(', ')}`);
  });
});

test('repository facts read at two different commits cannot form one picture of a codebase (F07-AC4)', async () => {
  await withStoredIdea((stored) => {
    const refused = assembleContextPacket({
      packetId: 'packet-context-packet',
      ideaId: stored.ideaId,
      projectId: stored.projectId,
      assembledAt: NOW,
      facts: [
        inspected('guidance-root', 'RepositoryGuidance', 'the agent guide', 'AGENTS.md', 'Read the spec first.', HEAD_SHA),
        inspected('state-head', 'RepositoryState', 'the head commit', 'git rev-parse HEAD', 'main is clean.', OTHER_SHA),
      ],
    });

    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, 'Invalid');
    const message =
      refused.error.code === 'Invalid' ? refused.error.fields.map((field) => field.message).join(' ') : '';
    assert.match(message, /more than one revision/);
    assert.match(message, /guidance-root/);
    assert.match(message, /state-head/);
  });
});

test('a claim the owner cannot check keeps the operator\'s own reason beside the domain\'s verdict (F07-AC4)', async () => {
  await withStoredIdea((stored) => {
    const packet = packetFor(
      [
        uninspected(
          'profile-checks',
          'ProjectProfile',
          'the required checks for this project',
          'profile:1',
          'The deployment this process read never captured a check list.',
        ),
      ],
      stored,
    );

    const claim = packet.claims[0];
    assert.ok(claim !== undefined);
    assert.equal(claim.availability, 'Unknown');
    assert.equal(claim.capturedReason, 'The deployment this process read never captured a check list.');
    assert.equal(claim.observed, null, 'no text is attributed to a fact nobody read');

    const rendered = renderContextPacket(packet);
    assert.match(rendered.text, /never captured a check list/, 'the render shows why, not just that it is unknown');
    assert.match(rendered.text, /no inspectable repository revision and no evidence/);
    assert.equal(packet.revision, null, 'a profile fact contributes no repository revision');
  });
});

test('an empty packet is refused: record that nothing is known rather than sending no context at all (F07-AC4)', async () => {
  await withStoredIdea((stored) => {
    const refused = assembleContextPacket({
      packetId: 'packet-context-packet',
      ideaId: stored.ideaId,
      projectId: stored.projectId,
      assembledAt: NOW,
      facts: [],
    });

    assert.equal(refused.ok, false);
    if (refused.ok) return;
    const paths = refused.error.code === 'Invalid' ? refused.error.fields.map((field) => field.path) : [];
    assert.ok(paths.includes('facts'), `the absence of facts is named: ${paths.join(', ')}`);
  });
});

test('the render budget names the facts it dropped, so a short packet is never read as a whole one (F07-AC2, F18-AC2)', async () => {
  await withStoredIdea((stored) => {
    const long = 'x'.repeat(400);
    const packet = packetFor(
      [
        inspected('guidance-a', 'RepositoryGuidance', 'guide a', 'a.md', long, HEAD_SHA),
        inspected('guidance-b', 'RepositoryGuidance', 'guide b', 'b.md', long, HEAD_SHA),
        inspected('guidance-c', 'RepositoryGuidance', 'guide c', 'c.md', long, HEAD_SHA),
      ],
      stored,
    );

    const rendered = renderContextPacket(packet, 200);
    assert.ok(rendered.characterCount < 900, `the render stayed inside a small budget: ${rendered.characterCount}`);
    assert.ok(rendered.droppedFactIds.length > 0, 'at least one fact was dropped');
    for (const dropped of rendered.droppedFactIds) {
      assert.match(rendered.text, new RegExp(dropped), `the dropped fact ${dropped} is named in the render`);
    }
    assert.equal(rendered.budget, 200);

    const withinBudget = renderContextPacket(packet);
    assert.equal(withinBudget.budget, MAX_PACKET_CHARACTERS);
    assert.deepEqual([...withinBudget.droppedFactIds], [], 'the published budget holds this packet whole');
  });
});

test('the profile the packet carries holds no mutating capability and forbids all three side effects (F07-AC5)', async () => {
  await withStoredIdea((stored) => {
    const packet = packetFor(
      [uninspected('profile-deploy', 'ProjectProfile', 'the deployment target', 'profile:2', 'No profile row was captured.')],
      stored,
    );

    const profile = packet.capability;
    assert.equal(profile.name, 'Clarification');
    assert.equal(profile.mayChangeApplicationCode, false);
    assert.equal(profile.mayPublishTickets, false);
    assert.equal(profile.mayDeploy, false);
    assert.equal(profile.mayStartCodingRun, false);
    assert.deepEqual(
      [...profile.forbiddenSideEffects].sort(),
      ['ChangeApplicationCode', 'ConsumeCodingRun', 'Deploy', 'PublishTicket'],
    );

    assert.ok(profile.capabilities.length > 0, 'the profile is not vacuously empty');
    for (const capability of profile.capabilities) {
      assert.equal(isMutatingCapability(capability), false, `${capability} changes nothing outside clarification`);
    }
    for (const kind of ['Ticket:PublishIssue', 'Git:PushBranch', 'Deployment:Execute', 'Engine:StartScoped'] as const) {
      assert.equal(
        (profile.capabilities as readonly string[]).includes(kind),
        false,
        `${kind} is a coding or delivery capability, not a clarification read`,
      );
    }
    assert.deepEqual(
      [...REPOSITORY_CONTEXT_SOURCES].sort(),
      ['RepositoryGuidance', 'RepositoryState'],
      'only the two code-facing source kinds require a recorded revision',
    );
  });
});
