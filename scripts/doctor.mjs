import { readFile, statfs } from 'node:fs/promises';
import { freemem } from 'node:os';
import { runCommand } from './lib/command.mjs';

let failed = false;
function check(label, pass, detail) {
  console.log(`${pass ? 'OK' : 'BLOCKED'} ${label}: ${detail}`);
  if (!pass) failed = true;
}
try {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  check('Node', Number(process.versions.node.split('.')[0]) === 24, `${process.version}; expected 24.x`);
  check('Host', process.platform === 'linux', `${process.platform}/${process.arch}; runner requires Linux`);
  for (const tool of ['git', 'pnpm']) {
    const result = await runCommand([tool, '--version'], { timeoutMs: 5000 });
    const actual = result.output.trim();
    const pass = result.status === 'Passed' && (tool !== 'pnpm' || actual === pkg.packageManager.slice(5));
    check(tool, pass, result.error || `${actual || result.status}; ${tool === 'pnpm' ? 'expected ' + pkg.packageManager : result.status}`);
  }
  const free = freemem();
  console.log(`INFO Available memory: ${Math.round(free / 1024 / 1024)} MiB; app/browser budget not established yet`);
  const disk = await statfs(process.cwd());
  const diskBytes = Number(disk.bavail) * Number(disk.bsize);
  check('Disk', diskBytes >= 256 * 1024 * 1024, `${Math.round(diskBytes / 1024 / 1024)} MiB free; foundation minimum 256 MiB`);
  console.log('INFO App services, browser and engine auth are not configured or checked yet.');
} catch (error) {
  check('Bootstrap', false, error.message);
}
process.exitCode = failed ? 2 : 0;
