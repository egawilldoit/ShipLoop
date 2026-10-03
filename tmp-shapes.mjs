import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'shape-'));
process.env.SHIPLOOP_DUMP = dir;
await import('./apps/web/src/server/routes/shape-probe.ts');
await rm(dir, { recursive: true, force: true });