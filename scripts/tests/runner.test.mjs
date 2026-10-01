import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runCommand, offlineEnv } from '../lib/command.mjs';

test('literal arguments, success, and nonzero failures are reported', async () => {
  const literal = '$(echo should-not-execute)';
  const success = await runCommand(['node', '-e', 'console.log(process.argv[1])', literal]);
  assert.equal(success.status, 'Passed');
  assert.equal(success.output.trim(), literal);
  const failure = await runCommand(['node', '-e', 'console.error("original failure"); process.exit(7)']);
  assert.equal(failure.status, 'Failed');
  assert.equal(failure.exitCode, 7);
  assert.match(failure.output, /original failure/);
});

test('missing executable blocks and invalid deadlines are rejected', async () => {
  const result = await runCommand(['shiploop-definitely-missing-executable']);
  assert.equal(result.status, 'Blocked');
  assert.match(result.error, /ENOENT/);
  await assert.rejects(runCommand(['node'], { timeoutMs: 0 }), /timeoutMs/);
});

test('large output is drained with bounded retained bytes', async () => {
  const result = await runCommand(['node', '-e',
    'process.stdout.write("x".repeat(100000)); process.stderr.write("y".repeat(100000))'],
  { maxOutputBytes: 4096 });
  assert.equal(result.status, 'Passed');
  assert.equal(Buffer.byteLength(result.output), 4096);
  assert.equal(result.outputTruncated, true);
});

test('offline environment excludes provider credentials and stabilizes timezone', () => {
  const env = offlineEnv({ PATH: '/bin', HOME: '/tmp/example', OPENAI_API_KEY: 'synthetic-secret',
    GITHUB_TOKEN: 'synthetic-secret', TZ: 'Elsewhere' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.TZ, 'UTC');
  assert.equal(env.HOME, '/tmp/example');
});

test('deadline stops a SIGTERM-resistant child instead of hanging', async () => {
  const result = await runCommand(['node', '-e',
    'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
  { timeoutMs: 250 });
  assert.equal(result.status, 'TimedOut');
  assert.ok(result.durationMs < 4000, `deadline settlement took ${result.durationMs} ms`);
});

test('owned descendants retaining stdio are stopped after leader exit', async () => {
  const result = await runCommand(['node', '-e', `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'inherit', 'inherit']
    });
    console.log(child.pid);
    child.unref();
  `], { timeoutMs: 4000 });
  assert.equal(result.status, 'Passed');
  const pid = Number(result.output.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  try {
    const state = await readFile(`/proc/${pid}/status`, 'utf8');
    // A reparented zombie has exited; PID 1 owns reaping it, not the test.
    assert.match(state, /^State:\s+Z/m);
  } catch (error) {
    // ESRCH and ENOENT are the same fact about the descendant: it is gone, whether
    // PID 1 has not adopted it yet or has already reaped it. Both mean the runner
    // stopped it. Only a live process is a failure, and a live one reads a status
    // rather than raising.
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
  }
});

test('cancellation settles an active owned command', async () => {
  const controller = new AbortController();
  const pending = runCommand(['node', '-e', 'setInterval(() => {}, 1000)'],
    { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'Interrupted');
  assert.ok(result.durationMs < 4000);
});
