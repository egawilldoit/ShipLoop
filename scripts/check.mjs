import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './lib/command.mjs';
import { validateConfig } from './lib/verification.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function fail(message) { console.error(message); failures++; }
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}
try {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.packageManager !== 'pnpm@11.15.0') fail('Preserve the explicit pnpm@11.15.0 pin.');
  for (const script of ['doctor', 'check', 'test', 'verify', 'verify:app']) {
    if (!pkg.scripts?.[script]) fail(`Missing script: ${script}`);
  }
  const config = validateConfig(JSON.parse(await readFile(join(root, 'verification.json'), 'utf8')));
  if (config.profiles.foundation?.stage !== 'foundation' || config.profiles.application?.stage !== 'application') {
    fail('Canonical foundation and application profiles must retain their stages.');
  }
  for (const file of await walk(root)) {
    if (file.endsWith('.mjs')) {
      const result = await runCommand(['node', '--check', file], { cwd: root, timeoutMs: 5000 });
      if (result.status !== 'Passed') fail(`${file}: ${result.error || result.output || result.status}`);
    }
    if (file.endsWith('.md')) {
      const contents = await readFile(file, 'utf8');
      for (const match of contents.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z\d+.-]*:|^#/i.test(target)) continue;
        const path = decodeURIComponent(target.split('#')[0]);
        try { await access(resolve(dirname(file), path)); }
        catch { fail(`Broken local link in ${file}: ${target}`); }
      }
    }
  }
} catch (error) {
  fail(error.message);
}
console.log(failures ? `Failed: ${failures} foundation issue(s)` : 'Passed: foundation config, links and JavaScript syntax');
process.exitCode = failures ? 1 : 0;
