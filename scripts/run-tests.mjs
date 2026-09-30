import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEADLINE_MS = 900_000;

async function testFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files.sort();
}

const suites = [
  { name: 'foundation', argv: ['--test', 'scripts/tests/runner.test.mjs', 'scripts/tests/verify.test.mjs'] },
];
for (const group of ['packages', 'apps']) {
  for (const pkg of await readdir(join(root, group), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const files = await testFiles(join(root, group, pkg.name, 'src'));
    if (files.length > 0) suites.push({ name: `${pkg.name}`, argv: ['--test', ...files] });
  }
}

let failed = 0;
for (const suite of suites) {
  const started = Date.now();
  const child = spawn(process.execPath, suite.argv, {
    cwd: root,
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, TZ: 'UTC' },
  });
  const group = child.pid ? `NODE_TEST_PGID=${child.pid}` : '';
  let timer;
  const expired = new Promise((resolveExit) => {
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      resolveExit('timeout');
    }, DEADLINE_MS);
  });
  const exited = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => resolveExit(signal ? `signal ${signal}` : `exit ${code}`));
  });
  const outcome = await Promise.race([exited, expired]);
  clearTimeout(timer);
  const ok = outcome === 'exit 0';
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${suite.name} (${outcome}, ${((Date.now() - started) / 1000).toFixed(1)}s) ${group}`);
}

console.log(failed ? `Failed: ${failed} of ${suites.length} test suite(s)` : `Passed: ${suites.length} test suite(s)`);
process.exit(failed ? 1 : 0);
