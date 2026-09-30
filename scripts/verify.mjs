import { verify } from './lib/verification.mjs';

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => abort.abort());
}
const profileName = process.argv[2] || 'foundation';
try {
  const { report, reportPath, exitCode } = await verify({
    cwd: process.cwd(), profileName, signal: abort.signal
  });
  console.log(`${report.status}: ${report.profile} (${report.stage})`);
  if (report.reason) console.log(report.reason);
  for (const command of report.commands) console.log(`${command.id}: ${command.status} (${command.durationMs} ms)`);
  console.log(`Private report: ${reportPath}`);
  process.exitCode = exitCode;
} catch (error) {
  console.error(`Blocked: report could not be written: ${error.message}`);
  process.exitCode = 2;
}
