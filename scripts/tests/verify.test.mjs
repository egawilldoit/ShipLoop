import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../lib/command.mjs';
import { validateConfig, verify } from '../lib/verification.mjs';

const cli = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const command = (id, code) => ({ id, argv: ['node', '-e', code], timeoutMs: 5000, maxOutputBytes: 4096 });
function config(commands) {
  return { version: 1, profiles: {
    foundation: { stage: 'foundation', commands },
    application: { stage: 'application', blockedReason: 'Application not implemented.', commands: [] }
  }};
}
async function repo(t, commands) {
  const cwd = await mkdtemp(join(tmpdir(), 'shiploop-fixture-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, '.gitignore'), '.shiploop-artifacts/\n');
  await writeFile(join(cwd, 'verification.json'), JSON.stringify(config(commands)));
  await writeFile(join(cwd, 'fixture.txt'), 'synthetic test data\n');
  for (const args of [
    ['init', '-b', 'main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture']
  ]) {
    const result = await runCommand(['git', ...args], { cwd });
    assert.equal(result.status, 'Passed', result.output || result.error);
  }
  return cwd;
}
async function cliReport(cwd, profile) {
  const result = await runCommand(['node', cli, profile], { cwd });
  const [id] = await readdir(join(cwd, '.shiploop-artifacts', 'verify'));
  const report = JSON.parse(await readFile(join(cwd, '.shiploop-artifacts', 'verify', id, 'report.json'), 'utf8'));
  return { result, report };
}

test('invalid and empty verification profiles cannot silently pass', () => {
  assert.throws(() => validateConfig(config([])), /Empty profile/);
  const duplicate = command('same', '');
  assert.throws(() => validateConfig(config([duplicate, duplicate])), /duplicate/);
  assert.throws(() => validateConfig(config([{ ...duplicate, timeoutMs: -1 }])), /timeoutMs/);
});

test('registered CLI writes a foundation report for the actual Git inputs', async t => {
  const cwd = await repo(t, [command('proof', 'console.log(process.env.TZ); console.log(process.env.HOME)')]);
  const { result, report } = await cliReport(cwd, 'foundation');
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(report.status, 'Passed');
  assert.equal(report.stage, 'foundation');
  assert.match(report.before.head, /^[0-9a-f]{40}$/);
  assert.equal(report.before.dirty, false);
  assert.deepEqual(report.before, report.after);
  assert.match(report.commands[0].output, /UTC/);
  assert.match(report.commands[0].output, /shiploop-check-/);
});

test('application profile is blocked at the CLI, with an explicit report', async t => {
  const cwd = await repo(t, [command('proof', '')]);
  const { result, report } = await cliReport(cwd, 'application');
  assert.equal(result.exitCode, 2);
  assert.equal(report.status, 'Blocked');
  assert.match(report.reason, /not implemented/);
  assert.equal(report.commands.length, 0);
});

test('first failed check is retained and later checks do not run', async t => {
  const cwd = await repo(t, [command('broken', 'console.error("root cause"); process.exit(9)'),
    command('must-not-run', 'require("node:fs").writeFileSync("unexpected.txt", "wrong")')]);
  const { report, exitCode } = await verify({ cwd, profileName: 'foundation' });
  assert.equal(exitCode, 1);
  assert.equal(report.status, 'Failed');
  assert.equal(report.commands.length, 1);
  assert.match(report.commands[0].output, /root cause/);
  assert.equal((await readdir(cwd)).includes('unexpected.txt'), false);
});

test('a changed working tree makes otherwise green checks stale', async t => {
  const cwd = await repo(t, [command('mutates-input', 'require("node:fs").writeFileSync("fixture.txt", "changed")')]);
  const { report, exitCode } = await verify({ cwd, profileName: 'foundation' });
  assert.equal(exitCode, 3);
  assert.equal(report.status, 'Stale');
  assert.notEqual(report.before.contentDigest, report.after.contentDigest);
});

test('unknown profile and missing executable block instead of pass', async t => {
  const cwd = await repo(t, [{ id: 'absent', argv: ['shiploop-definitely-missing-executable'],
    timeoutMs: 5000, maxOutputBytes: 4096 }]);
  const unknown = await verify({ cwd, profileName: 'unknown' });
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.report.reason, /Unknown/);
  const missing = await verify({ cwd, profileName: 'foundation' });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.report.commands[0].status, 'Blocked');
});
