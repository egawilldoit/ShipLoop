import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, lstat, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { offlineEnv, runCommand, validateCommand } from './command.mjs';

export function validateConfig(config) {
  if (config?.version !== 1 || !config.profiles || typeof config.profiles !== 'object' ||
      Array.isArray(config.profiles)) throw new Error('Invalid verification configuration v1.');
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!['foundation', 'application'].includes(profile.stage) || !Array.isArray(profile.commands)) {
      throw new Error(`Invalid profile ${name}.`);
    }
    if (profile.blockedReason !== undefined &&
        (typeof profile.blockedReason !== 'string' || !profile.blockedReason.trim())) {
      throw new Error(`Invalid blocker in ${name}.`);
    }
    if (!profile.commands.length && !profile.blockedReason) {
      throw new Error(`Empty profile ${name} must declare why it is blocked.`);
    }
    const ids = new Set();
    for (const command of profile.commands) {
      if (typeof command.id !== 'string' || !/^[a-z0-9-]+$/.test(command.id) || ids.has(command.id)) {
        throw new Error(`Invalid or duplicate command ID in ${name}.`);
      }
      ids.add(command.id);
      validateCommand(command);
    }
  }
  return config;
}

export async function snapshot(cwd, env) {
  const git = async args => {
    const result = await runCommand(['git', ...args], { cwd, env, timeoutMs: 5000, maxOutputBytes: 262144 });
    if (result.status !== 'Passed' || result.outputTruncated) {
      throw new Error(`Git snapshot unavailable: ${result.error || result.output || result.status}`);
    }
    return result.output;
  };
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const dirty = await git(['status', '--porcelain=v1', '-z']);
  const files = (await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of [...new Set(files)]) {
    hash.update(path).update('\0');
    try {
      const file = join(cwd, path);
      const stat = await lstat(file);
      hash.update(stat.isSymbolicLink() ? 'symlink:' + await readlink(file) :
        stat.isFile() ? await readFile(file) : 'non-file');
      hash.update(String(stat.mode & 0o777));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('deleted');
    }
    hash.update('\0');
  }
  return { head, dirty: Boolean(dirty), statusDigest: createHash('sha256').update(dirty).digest('hex'),
    contentDigest: hash.digest('hex') };
}

export async function verify({ cwd, profileName, signal }) {
  cwd = resolve(cwd);
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
  const reportDir = join(cwd, '.shiploop-artifacts', 'verify', runId);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(tmpdir(), 'shiploop-check-'));
  /**
   * Traversable, unlike the 0700 `mkdtemp` gives.
   *
   * This directory is also the command's `TMPDIR`, so a test that builds a fixture under it and then
   * spawns a child as a *different* uid — the execution-isolation proofs do exactly that — could not
   * traverse into its own fixture. The probe reported a failure that had nothing to do with the code
   * under test: it was refused because it could not write into a tree this harness had made
   * unreachable. Nothing sensitive lives here (it is a fresh empty home for an offline check, and the
   * report is written 0600 beside it), so the isolation this directory provides is "new every run",
   * not "unreadable by another uid".
   */
  await chmod(home, 0o755);
  const env = offlineEnv({ PATH: process.env.PATH, HOME: home, TMPDIR: home,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data') });
  const browsersPath = hostBrowsersPath();
  if (browsersPath !== null) env['PLAYWRIGHT_BROWSERS_PATH'] = browsersPath;
  const report = { version: 1, runId, profile: profileName, stage: 'unknown',
    startedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch,
      node: process.version }, status: 'Blocked', commands: [] };
  try {
    if (process.platform !== 'linux') throw new Error('Linux required; this host is not validated.');
    report.before = await snapshot(cwd, env);
    const config = validateConfig(JSON.parse(await readFile(join(cwd, 'verification.json'), 'utf8')));
    const profile = config.profiles[profileName];
    if (!profile) throw new Error(`Unknown verification profile: ${profileName}`);
    report.stage = profile.stage;
    if (profile.blockedReason) throw new Error(profile.blockedReason);
    report.status = 'Passed';
    for (const command of profile.commands) {
      const result = await runCommand(command.argv, { ...command, cwd, env, signal });
      report.commands.push({ id: command.id, argv: command.argv, timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes, ...result });
      if (result.status !== 'Passed') {
        report.status = result.status === 'Blocked' ? 'Blocked' : 'Failed';
        break;
      }
    }
    report.after = await snapshot(cwd, env);
    if (report.status === 'Passed' && JSON.stringify(report.before) !== JSON.stringify(report.after)) {
      report.status = 'Stale';
      report.reason = 'Git inputs changed during verification; rerun affected checks on the new candidate.';
    }
  } catch (error) {
    report.status = 'Blocked';
    report.reason = error.message;
  } finally {
    report.completedAt = new Date().toISOString();
    await rm(home, { recursive: true, force: true });
  }
  const reportPath = join(reportDir, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const exitCode = { Passed: 0, Failed: 1, Blocked: 2, Stale: 3 }[report.status];
  return { report, reportPath, exitCode };
}

/**
 * Where this host's Playwright browsers are installed, or null when it has none.
 *
 * The private temporary HOME below deliberately hides the developer's own configuration and
 * caches from every command, so Playwright would resolve its browser directory inside a
 * directory that is empty, fail to find the Chromium it was pinned to, and respond by
 * downloading one. That download is exactly what this offline profile must never cause, and a
 * check that silently provisions its own toolchain is no longer proving the repository.
 *
 * So the cache location is resolved from the real environment before HOME is replaced and
 * handed to the browser command explicitly. It is a path, not a secret, and it names installed
 * tooling rather than test state: nothing a command writes there is read back as evidence, and
 * the temporary HOME still isolates every cache, data and config directory a command could
 * otherwise inherit. The value is read at run time rather than written into verification.json
 * because the JSON is shared by every host and a pinned absolute path would be wrong on all
 * but one of them.
 *
 * Returning null on a host with no cached browser is intentional: the browser command then
 * fails and says the executable is missing, which is a named, honest failure. Inventing a
 * directory would only move the download somewhere less visible.
 */
function hostBrowsersPath() {
  const declared = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (typeof declared === 'string' && declared !== '') return declared;
  const hostHome = process.env.HOME;
  if (typeof hostHome !== 'string' || hostHome === '') return null;
  const cached = join(hostHome, '.cache', 'ms-playwright');
  return existsSync(cached) ? cached : null;
}
