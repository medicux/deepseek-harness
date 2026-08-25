/** Stdio carrier end to end: the SSE event downlink and the trust fence over frames. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { StdioResponseFrame } from '@deepseek-ai/dsh-host-webserver'
import { serveStdio, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, inject, MUX_EVENTS_PATH } from '../src/index.ts'

/**
 * The supervised desktop child has no listening socket: WebSocket upgrades
 * cannot exist, so the event downlink must stream as SSE over the frame
 * pipes. These specs drive the production chain — frame lines → serveStdio →
 * route dispatch (trust fence included) → shared fetch handler → apiproxy SSE
 * response — so a regression to the TCP-only 426 wall or a fence that reads
 * no Host fails here instead of on every live desktop session.
 */

interface Collected {
  frames(): StdioResponseFrame[]
}

function collect(output: PassThrough): Collected {
  const frames: StdioResponseFrame[] = []
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      frames.push(JSON.parse(line) as StdioResponseFrame)
    }
  })
  return { frames: () => frames }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface Harness {
  input: PassThrough
  output: PassThrough
  collected: Collected
  dispose: () => void
}

async function harness(apiProxy: ApiProxy): Promise<Harness> {
  const ctx = new Context()
  const server = new WebServer(new Context(), { host: '127.0.0.1', port: 0, carrier: 'stdio' })
  ctx.provide('webServer', server)
  ctx.provide('apiProxy', apiProxy)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const input = new PassThrough()
  const output = new PassThrough()
  serveStdio(server, input, output)
  return {
    input,
    output,
    collected: collect(output),
    dispose: () => { void fiber.dispose() },
  }
}

describe('stdio event downlink and trust fence', () => {
  it('streams the mux events SSE over frames and unwinds on cancel', async () => {
    let aborted = false
    async function * mux(signal: AbortSignal): AsyncGenerator<RpcRequest<MuxFrame>> {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      yield { rpcId: RpcId('m1'), payload: { type: 'stream/opened' } as unknown as MuxFrame }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }
    const harness_ = await harness({
      events: { mux: (_request: unknown, signal: AbortSignal) => mux(signal), host: () => { throw new Error('not under test') } },
    } as unknown as ApiProxy)
    try {
      harness_.input.write(JSON.stringify({ id: 1, method: 'GET', url: MUX_EVENTS_PATH, headers: {} }) + '\n')
      // Headless Host binding + route fence pass: the request is not 403'd
      // and reaches the SSE response instead of the TCP-only 426 wall.
      await until(() => harness_.collected.frames().some(frame => frame.t === 'head'))
      expect(harness_.collected.frames()[0]).toMatchObject({ id: 1, t: 'head', status: 200 })
      await until(() => harness_.collected.frames().some(frame =>
        frame.t === 'chunk' && Buffer.from(frame.data, 'base64').toString('utf8').includes(': connected'),
      ))
      // The stub's yielded frame crosses as one data line of the same stream.
      await until(() => harness_.collected.frames().some(frame =>
        frame.t === 'chunk' && Buffer.from(frame.data, 'base64').toString('utf8').includes('"rpcId":"m1"'),
      ))
      harness_.input.write(JSON.stringify({ id: 1, t: 'cancel' }) + '\n')
      await until(() => harness_.collected.frames().some(frame => frame.id === 1 && frame.t === 'destroy'))
      await until(() => aborted)
    } finally {
      harness_.dispose()
    }
  })

  it('refuses an explicitly spoofed non-loopback authority at the fence', async () => {
    const harness_ = await harness({} as unknown as ApiProxy)
    try {
      harness_.input.write(JSON.stringify({
        id: 2,
        method: 'GET',
        url: '/api/session.list',
        headers: { host: 'rebound.example' },
      }) + '\n')
      await until(() => harness_.collected.frames().some(frame => frame.t === 'head'))
      expect(harness_.collected.frames()[0]).toMatchObject({ id: 2, t: 'head', status: 403 })
    } finally {
      harness_.dispose()
    }
  })
})
