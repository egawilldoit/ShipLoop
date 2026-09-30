import { spawn } from 'node:child_process';

export function offlineEnv(source = process.env) {
  const env = { TZ: 'UTC', LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export function validateCommand(command) {
  if (!command || !Array.isArray(command.argv) || !command.argv.length ||
      command.argv.some(value => typeof value !== 'string' || value.includes('\0')) ||
      !command.argv[0]) throw new Error('Command argv must be a nonempty string array.');
  for (const [key, cap] of [['timeoutMs', 3600000], ['maxOutputBytes', 1048576]]) {
    if (!Number.isInteger(command[key]) || command[key] < 1 || command[key] > cap) {
      throw new Error(`${key} must be an integer between 1 and ${cap}.`);
    }
  }
}

export async function runCommand(argv, {
  cwd = process.cwd(), timeoutMs = 30000, maxOutputBytes = 65536,
  env = offlineEnv(), signal
} = {}) {
  validateCommand({ argv, timeoutMs, maxOutputBytes });
  if (process.platform !== 'linux') throw new Error('This runner requires Linux process groups.');
  const started = Date.now();
  if (signal?.aborted) return { status: 'Interrupted', exitCode: null, signal: null,
    durationMs: 0, output: '', outputTruncated: false };
  return new Promise(resolve => {
    let child;
    let deadline, cleanupTimer;
    let finished = false, timedOut = false, interrupted = false;
    let exitCode = null, exitSignal = null;
    let bytes = 0, truncated = false;
    const output = [];
    const cleanupErrors = [];
    function killOwned(kind) {
      if (!child?.pid) return;
      try { process.kill(-child.pid, kind); }
      catch (error) {
        if (error.code !== 'ESRCH') cleanupErrors.push(`${kind}: ${error.code}`);
      }
    }
    function finish(status, error) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', interrupt);
      killOwned('SIGKILL');
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      resolve({ status: cleanupErrors.length && status === 'Passed' ? 'Failed' : status,
        exitCode, signal: exitSignal, durationMs: Date.now() - started,
        output: Buffer.concat(output).toString('utf8'), outputTruncated: truncated,
        ...(cleanupErrors.length ? { cleanupErrors } : {}),
        ...(error ? { error } : {}) });
    }
    function capture(chunk) {
      const buffer = Buffer.from(chunk);
      const remaining = maxOutputBytes - bytes;
      if (remaining > 0) {
        output.push(buffer.subarray(0, remaining));
        bytes += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) truncated = true;
    }
    function stop() {
      killOwned('SIGTERM');
      cleanupTimer = setTimeout(() => {
        killOwned('SIGKILL');
        finish(timedOut ? 'TimedOut' : 'Interrupted');
      }, 750);
    }
    function interrupt() {
      interrupted = true;
      stop();
    }
    try {
      child = spawn(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), {
        cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish('Blocked', error.message);
      return;
    }
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', error => finish('Blocked', `${error.code}: ${error.message}`));
    // Descendants can keep stdio open after the leader exits. Settle them by ownership,
    // then bound the wait for pipe closure, independently of the command deadline.
    child.once('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      killOwned('SIGKILL');
      clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(() => finish(
        timedOut ? 'TimedOut' : interrupted ? 'Interrupted' : code === 0 ? 'Passed' : 'Failed'
      ), 200);
    });
    child.once('close', (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      finish(timedOut ? 'TimedOut' : interrupted ? 'Interrupted' : code === 0 ? 'Passed' : 'Failed');
    });
    deadline = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', interrupt, { once: true });
    if (signal?.aborted) interrupt();
  });
}
