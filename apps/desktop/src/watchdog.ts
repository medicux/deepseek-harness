/**
 * Parent-death watchdog for the supervised server.
 *
 * Electron cannot guarantee graceful cleanup: Chromium reaps SIGTERM/SIGINT
 * before Node signal handlers run, so any externally delivered termination
 * (or a crash) would orphan the harness child. Instead of relying on
 * JavaScript teardown, the shell wraps the real launch target in a tiny
 * stock-Node watchdog process. The watchdog owns the server child and polls
 * its own parent liveness once per second; when Electron disappears for any
 * reason — graceful quit, SIGKILL, crash — the kernel reparents the watchdog
 * and the poll notices, terminating the server tree with bounded escalation.
 *
 * The watchdog also bridges signals in the other direction (its own SIGTERM
 * reaches the server first) and passes server stdio straight through, so the
 * supervisor above it keeps reading the readiness line unchanged.
 * @module @deepseek-ai/dsh-desktop/watchdog
 */

import type { LaunchTarget } from './launch.ts'

/**
 * The watchdog body, run through `node -e`. Plain CommonJS, no imports beyond
 * node builtins, no template syntax — it must parse under every supported
 * Node and never depend on the repository.
 */
export const WATCHDOG_SCRIPT = `
// dsh-desktop parent-death watchdog: owns one child, dies with its parent.
'use strict';
const child_process = require('node:child_process');
const command = JSON.parse(process.env.DSH_WATCHDOG_COMMAND);
if (!Array.isArray(command) || typeof command[0] !== 'string') {
  throw new Error('dsh-watchdog: DSH_WATCHDOG_COMMAND must be a JSON argv array');
}
const child = child_process.spawn(command[0], command.slice(1), {
  // stdin stays closed for the server (it never reads it); stdio flows
  // through so the supervisor above keeps seeing readiness and logs. Slots
  // 3/4 forward the frame pipes too: macOS posix_spawn defaults every fd
  // above 2 to close-on-exec, so an explicit pass-through is required for
  // the stdio-carrier server to see them at all.
  stdio: ['ignore', 'inherit', 'inherit', 'inherit', 'inherit'],
  env: process.env,
});
let stopping = false;
function stop(signal, escalateAfterMs) {
  if (stopping || child.exitCode !== null || child.signalCode !== null) return;
  stopping = true;
  child.kill(signal);
  if (escalateAfterMs !== undefined) {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* child already gone */ }
    }, escalateAfterMs);
    timer.unref();
  }
}
process.on('SIGTERM', () => stop('SIGTERM', 4000));
process.on('SIGINT', () => stop('SIGINT', 4000));
child.on('exit', (code, signal) => { process.exit(code === null ? 1 : code); });
const poll = setInterval(() => {
  // A dead parent reparents us to pid 1 (or an equivalent reaper); kill()
  // probing our own parent fails with ESRCH/EPERM exactly when it died.
  let parentAlive = true;
  try { process.kill(process.ppid, 0); } catch { parentAlive = false; }
  if (process.ppid === 1) parentAlive = false;
  if (!parentAlive) {
    stop('SIGTERM', 4000);
    clearInterval(poll);
  }
}, 1000);
`

/**
 * Wrap a resolved launch target so the server cannot outlive the shell.
 * The returned command runs the stock Node binary named by
 * `DSH_DESKTOP_NODE_BIN` (default `node`) as the watchdog; the original
 * command rides in `DSH_WATCHDOG_COMMAND` and all of `base`'s required
 * environment is forwarded. The working directory is forwarded too: a
 * packaged launch target's deploy-root `cwd` is load-bearing for profile
 * resource resolution beside the server entry.
 * @param base - the resolved launch target to protect.
 * @param env - environment providing the optional Node override.
 * @returns the watchdog-wrapped spawn target.
 */
export function wrapWithParentDeathWatchdog(base: LaunchTarget, env: NodeJS.ProcessEnv = process.env): LaunchTarget {
  const nodeBin = env.DSH_DESKTOP_NODE_BIN || 'node'
  return {
    command: [nodeBin, '-e', WATCHDOG_SCRIPT],
    ...(base.cwd === undefined ? {} : { cwd: base.cwd }),
    env: {
      ...(base.env ?? {}),
      DSH_WATCHDOG_COMMAND: JSON.stringify(base.command),
    },
  }
}
