import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SERVER_CWD, resolveLaunchTarget } from '../src/launch.ts'
import { DshServerProcess, type ServerExit } from '../src/server-process.ts'
import { wrapWithParentDeathWatchdog } from '../src/watchdog.ts'

/**
 * Real-boot smoke for the supervision contract the Electron shell relies on:
 * the shipped `dsh --profile web` surface boots on the stdio carrier, prints
 * its `dsh web-stdio: ready` line without binding any socket, serves the
 * boot-injected shell through the frame pipes, and exits cleanly on SIGTERM.
 * Keyless by construction — no prompt is sent — and isolated from the
 * developer's machine through a temp `DSH_HOME` and cwd.
 *
 * Opt-in (`DSH_DESKTOP_SMOKE=1`) because it boots the full composition and
 * therefore needs built workspace libs and the frontend dist: unit tests must
 * pass on a clean, unbuilt tree, so this suite stays out of their way and
 * runs explicitly after a build (or from a CI lane that owns one).
 */
const DIST_INDEX = join(SERVER_CWD, 'apps/web/dist/index.html')
const smokeEnabled = process.env.DSH_DESKTOP_SMOKE === '1' && existsSync(DIST_INDEX)

describe.skipIf(!smokeEnabled)('supervised dsh web smoke', () => {
  it('reports readiness, serves the boot-injected shell, and stops cleanly on SIGTERM', { timeout: 300_000 }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-desktop-smoke-'))
    try {
      let resolveExit!: (exit: ServerExit) => void
      const exitPromise = new Promise<ServerExit>((resolve) => { resolveExit = resolve })
      const target = wrapWithParentDeathWatchdog(resolveLaunchTarget())
      const server = new DshServerProcess({
        command: target.command,
        cwd: workspace,
        readyTimeoutMs: 240_000,
        env: {
          ...process.env,
          ...target.env,
          DSH_HOME: join(workspace, 'home'),
          DSH_TELEMETRY_DISABLED: '1',
          DEEPSEEK_API_KEY: '',
        },
        onExit: resolveExit,
      })
      const ready = await server.start()
      expect(ready).toEqual({ kind: 'stdio' })
      const channel = server.channel
      expect(channel).toBeDefined()
      try {
        const { execSync } = await import('node:child_process')
        const listeners = execSync(
          `lsof -a -i -p ${String(server.pid)} -P -n 2>/dev/null | grep LISTEN || true`,
          { encoding: 'utf8' },
        ).trim()
        expect(listeners).toBe('')
        const response = channel === undefined ? undefined : await channel.request({ method: 'GET', url: '/' })
        expect(response?.status).toBe(200)
        expect(response?.headers['content-type']).toContain('text/html')
        expect(response?.body.toString('utf8')).toContain('__DSH_BOOT__')
        // Unary API through the real composition: the trust fence must accept
        // frame-carried requests (loopback Host binding) and answer the
        // handshake RPC the renderer's connection generation opens with.
        const describe = channel === undefined ? undefined : await channel.request({
          method: 'POST',
          url: '/api/host.describe',
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({
            type: 'client-request',
            rpcId: 'smoke-describe',
            method: 'host.describe',
            payload: {},
          }), 'utf8'),
        })
        expect(describe?.status).toBe(200)
        expect(JSON.parse(describe?.body.toString('utf8') ?? '{}')).toMatchObject({ result: { ok: true } })
        // Event downlink over frames: SSE streams instead of the TCP-only
        // 426 wall. Disposing the subscription writes the cancel frame that
        // makes the child destroy the response (pinned child-side in
        // dsh-host-webserver specs); here we assert the live stream opened
        // and the channel stays healthy after the cancel.
        const streamChunks: string[] = []
        const detach = channel?.subscribe(
          { method: 'GET', url: '/api/events.mux', headers: { accept: 'text/event-stream' } },
          (frame) => {
            if (frame.t === 'chunk') streamChunks.push(Buffer.from(frame.data, 'base64').toString('utf8'))
          },
        )
        for (let i = 0; i < 2000 && detach !== undefined && streamChunks.length === 0; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        expect(streamChunks.join('')).toContain(': connected')
        detach?.()
        await new Promise(resolve => setTimeout(resolve, 250))
        const afterCancel = await channel?.request({ method: 'GET', url: '/' })
        expect(afterCancel?.status).toBe(200)
      } finally {
        channel?.close()
        await server.stop()
      }
      expect(await exitPromise).toEqual({ code: 0, signal: null })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
