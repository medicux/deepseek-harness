import { describe, expect, it } from 'vitest'
import { resolveLaunchTarget } from '../src/launch.ts'
import { WATCHDOG_SCRIPT, wrapWithParentDeathWatchdog } from '../src/watchdog.ts'

describe('wrapWithParentDeathWatchdog', () => {
  it('runs the stock Node binary with the watchdog script and forwards the target', () => {
    const base = resolveLaunchTarget({})
    const wrapped = wrapWithParentDeathWatchdog(base, {})
    const [program, flag, script] = wrapped.command
    expect(program).toBe('node')
    expect(flag).toBe('-e')
    expect(script).toBe(WATCHDOG_SCRIPT)
    const forwarded = JSON.parse(wrapped.env?.DSH_WATCHDOG_COMMAND ?? 'null') as unknown
    expect(forwarded).toEqual(base.command)
  })

  it('forwards the launch target working directory so packaged deploys resolve beside their entry', () => {
    const wrapped = wrapWithParentDeathWatchdog({ command: ['/opt/dsh'], cwd: '/deploy/root' }, {})
    expect(wrapped.cwd).toBe('/deploy/root')
    const unwrapped = wrapWithParentDeathWatchdog({ command: ['/opt/dsh'] }, {})
    expect(unwrapped.cwd).toBeUndefined()
  })

  it('merges the base target environment into the watchdog environment', () => {
    const wrapped = wrapWithParentDeathWatchdog(
      { command: ['/opt/dsh'], env: { TSX_TSCONFIG_PATH: '/repo/tsconfig.base.json' } },
      {},
    )
    expect(wrapped.env?.TSX_TSCONFIG_PATH).toBe('/repo/tsconfig.base.json')
  })
})

describe('watchdog script (real process)', () => {
  it('passes child output through and terminates the child when the watchdog is signaled', { timeout: 30_000 }, async () => {
    const { spawn } = await import('node:child_process')
    // The fake server prints its pid on stdout and lives until killed; the
    // marker proves passthrough, the pid lets the test verify its death.
    const fakeServer = 'console.log("MARKER:" + process.pid); setInterval(() => {}, 60_000)'
    const env = {
      ...process.env,
      DSH_WATCHDOG_COMMAND: JSON.stringify([process.execPath, '-e', fakeServer]),
    }
    // The five stdio slots mirror DshServerProcess's spawn: the watchdog's
    // 5-slot inherit needs its own fds 3/4 open, or the inner spawn fails
    // synchronously with EBADF before any child exists.
    const watchdog = spawn(process.execPath, ['-e', WATCHDOG_SCRIPT], {
      env,
      stdio: ['ignore', 'pipe', 'inherit', 'pipe', 'pipe'],
    })
    const marker = new Promise<number>((resolve) => {
      watchdog.stdout?.setEncoding('utf8')
      watchdog.stdout?.on('data', (chunk: string) => {
        const match = /MARKER:(\d+)/u.exec(chunk)
        if (match) resolve(Number(match[1]))
      })
    })
    const serverPid = await marker
    watchdog.kill('SIGTERM')
    await new Promise((resolve) => { setTimeout(resolve, 1_000) })
    expect(() => { process.kill(serverPid, 0) }).toThrow()
    expect(watchdog.killed || watchdog.exitCode !== null || watchdog.signalCode !== null).toBe(true)
  })

  it('terminates the child after its parent disappears without any signal', { timeout: 30_000 }, async () => {
    const { spawn } = await import('node:child_process')
    // A middle process spawns the watchdog and then exits hard, simulating an
    // Electron crash: the watchdog must notice within its one-second poll and
    // tear the server down without receiving any signal itself.
    const middle = `const cp=require('node:child_process');
      // Five slots like the real supervisor: the watchdog's inherit needs
      // fds 3/4 to exist, or it dies at spawn instead of polling.
      const w=cp.spawn(process.execPath,['-e',process.env.WATCHDOG],{stdio:['ignore','inherit','inherit','inherit','inherit'],env:{...process.env,DSH_WATCHDOG_COMMAND:process.env.CHILD}});
      console.log('UP:'+w.pid); setInterval(()=>{},60_000);`
    const fakeServer = 'setInterval(() => {}, 60_000)'
    const env = {
      ...process.env,
      WATCHDOG: WATCHDOG_SCRIPT,
      CHILD: JSON.stringify([process.execPath, '-e', fakeServer]),
    }
    const outer = spawn(process.execPath, ['-e', middle], {
      env,
      // Five slots mirror the real supervisor: both the middle process and
      // the watchdog need fds 3/4 open to hand them down by inherit.
      stdio: ['ignore', 'pipe', 'inherit', 'pipe', 'pipe'],
    })
    const up = new Promise<number>((resolve) => {
      outer.stdout?.setEncoding('utf8')
      outer.stdout?.on('data', (chunk: string) => {
        const match = /UP:(\d+)/u.exec(chunk)
        if (match) resolve(Number(match[1]))
      })
    })
    const watchdogPid = await up
    // Hard-kill the middle process only; the watchdog survives it orphaned.
    process.kill(outer.pid!, 'SIGKILL')
    await new Promise((resolve) => { setTimeout(resolve, 3_500) })
    let watchdogGone = false
    try { process.kill(watchdogPid, 0) } catch { watchdogGone = true }
    expect(watchdogGone).toBe(true)
  })
})
