import { Context } from '@deepseek-ai/cordis'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { StdioResponseFrame } from '@deepseek-ai/dsh-host-webserver'
import { serveStdio, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { bridge } from '../src/http-bridge.ts'

/**
 * The supervised desktop child answers every renderer surface through this
 * exact stack: frame pipes → serveStdio → WebServer route dispatch → the
 * node↔fetch bridge. The spec drives it end to end so a shim that drops any
 * member the bridge reads (async-iterable body, writableEnded, destroy)
 * fails here rather than on every desktop API call.
 */

function makeCollected(output: PassThrough): { frames(): StdioResponseFrame[] } {
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
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function mountBridgeRoute(server: WebServer, handler: (request: Request) => Promise<Response>): void {
  server.register({
    kind: 'prefix',
    path: '/api',
    handler: (req, res) => bridge(req, res, { fetch: handler }),
  })
}

describe('bridge over the stdio carrier', () => {
  it('carries a unary POST through to the fetch handler and back', async () => {
    const server = new WebServer(new Context(), { host: '127.0.0.1', port: 0, carrier: 'stdio' })
    let seenBody: string | undefined
    mountBridgeRoute(server, async (request) => {
      seenBody = await request.text()
      const parsed = JSON.parse(seenBody ?? '{}') as Record<string, unknown>
      return Response.json({ echo: parsed, method: request.method })
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = makeCollected(output)
    serveStdio(server, input, output)
    const payload = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.prompt', payload: { text: 'hi' } })
    input.write(JSON.stringify({
      id: 1,
      method: 'POST',
      url: '/api/session.prompt',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      body: Buffer.from(payload).toString('base64'),
    }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'end'))
    expect(seenBody).toBe(payload)
    expect(collected.frames()[0]).toMatchObject({ id: 1, t: 'head', status: 200 })
    const body = collected.frames().find(frame => frame.t === 'chunk')
    expect(JSON.parse(Buffer.from(body?.data ?? '', 'base64').toString('utf8'))).toEqual({
      echo: { type: 'client-request', rpcId: 'r1', method: 'session.prompt', payload: { text: 'hi' } },
      method: 'POST',
    })
  })

  it('streams an SSE response as ordered chunk frames before the end frame', async () => {
    const server = new WebServer(new Context(), { host: '127.0.0.1', port: 0, carrier: 'stdio' })
    mountBridgeRoute(server, async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: first\n\n'))
          controller.enqueue(encoder.encode('data: second\n\n'))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = makeCollected(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 2, method: 'GET', url: '/api/events.mux', headers: { accept: 'text/event-stream' } }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'end'))
    expect(collected.frames()[0]).toMatchObject({ id: 2, t: 'head', status: 200, headers: { 'content-type': 'text/event-stream' } })
    const chunks = collected.frames().filter(frame => frame.t === 'chunk')
    expect(chunks.map(frame => Buffer.from(frame.data ?? '', 'base64').toString('utf8')).join(''))
      .toBe('data: first\n\ndata: second\n\n')
    expect(collected.frames().at(-1)).toMatchObject({ t: 'end' })
  })

  it('answers the oversized-body guard with 413 without draining the stream', async () => {
    const server = new WebServer(new Context(), { host: '127.0.0.1', port: 0, carrier: 'stdio' })
    mountBridgeRoute(server, async () => Response.json({ ok: true }))
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = makeCollected(output)
    serveStdio(server, input, output)
    // content-length declares past the default cap; the bridge must reject
    // before touching the body, and req.destroy() must exist to tear down.
    input.write(JSON.stringify({
      id: 3,
      method: 'POST',
      url: '/api/session.prompt',
      headers: { 'content-type': 'application/json', 'content-length': String(160 * 1024 * 1024 + 1) },
      body: Buffer.from('{}').toString('base64'),
    }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'end'))
    expect(collected.frames()[0]).toMatchObject({ id: 3, t: 'head', status: 413 })
    expect(collected.frames().filter(frame => frame.t === 'handler-error')).toEqual([])
  })
})
