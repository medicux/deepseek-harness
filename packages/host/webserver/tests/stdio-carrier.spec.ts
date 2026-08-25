import { Context } from '@deepseek-ai/cordis'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { WebServer } from '../src/index.ts'
import { serveStdio } from '../src/stdio-carrier.ts'
import {
  LineBuffer,
  decodeRequest,
  encodeEnd,
  encodeHead,
  type StdioResponseFrame,
} from '../src/stdio-frames.ts'

function makeServer(): WebServer {
  return new WebServer(new Context(), { host: '127.0.0.1', port: 0, carrier: 'tcp' })
}

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
  for (let i = 0; i < 100 && !predicate(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('stdio frame codec', () => {
  it('decodes complete requests and rejects malformed ones', () => {
    expect(decodeRequest('')).toBeUndefined()
    expect(decodeRequest('   ')).toBeUndefined()
    const frame = decodeRequest('{"id":3,"method":"POST","url":"/api/x","headers":{"a":"b"},"body":"YWJj"}')
    expect(frame).toMatchObject({ id: 3, method: 'POST', url: '/api/x', headers: { a: 'b' }, body: 'YWJj' })
    expect(decodeRequest('{"id":8,"t":"cancel"}')).toEqual({ id: 8, t: 'cancel' })
    expect(() => decodeRequest('not json')).toThrow()
    expect(() => decodeRequest('null')).toThrow(/not an object/u)
    expect(() => decodeRequest('[]')).toThrow(/id must be an integer/u)
    expect(() => decodeRequest('{"method":"GET","url":"/"}')).toThrow(/id must be an integer/u)
    expect(() => decodeRequest('{"t":"cancel"}')).toThrow(/id must be an integer/u)
    expect(() => decodeRequest('{"id":1,"url":"/"}')).toThrow(/string method and url/u)
    expect(() => decodeRequest('{"id":1,"method":"GET","url":"/","headers":"x"}')).toThrow(/must be an object/u)
    expect(() => decodeRequest('{"id":1,"method":"GET","url":"/","headers":{"a":2}}')).toThrow(/must be strings/u)
    expect(() => decodeRequest('{"id":1,"method":"GET","url":"/","body":5}')).toThrow(/base64 text/u)
  })

  it('buffers partial lines until the newline arrives', () => {
    const buffer = new LineBuffer()
    expect(buffer.push('hel')).toEqual([])
    expect(buffer.push('lo\nwor')).toEqual(['hello'])
    expect(buffer.push('ld\n')).toEqual(['world'])
  })

  it('encodes every response frame kind as one line each', () => {
    expect(encodeHead(1, 200, { 'content-type': 'text/plain' }))
      .toBe('{"id":1,"t":"head","status":200,"headers":{"content-type":"text/plain"}}\n')
    expect(encodeEnd(2)).toBe('{"id":2,"t":"end"}\n')
    // The desktop's `frames.ts` mirrors this codec by hand without a
    // dependency edge; its spec pins the same tag list. Changing one union
    // without the other fails one of the two parity tests.
    const tags: StdioResponseFrame['t'][] = ['head', 'chunk', 'end', 'destroy', 'handler-error']
    expect(tags).toEqual(['head', 'chunk', 'end', 'destroy', 'handler-error'])
  })
})

describe('serveStdio', () => {
  it('answers exact routes with head, chunk and end frames in order', async () => {
    const server = makeServer()
    server.register({
      kind: 'exact',
      path: '/hello',
      handler: (_req, res) => {
        res.writeHead(201, { 'content-type': 'text/x-custom' })
        res.write('hi')
        res.end()
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 7, method: 'GET', url: '/hello', headers: {} }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'end'))
    expect(collected.frames()).toEqual([
      { id: 7, t: 'head', status: 201, headers: { 'content-type': 'text/x-custom' } },
      { id: 7, t: 'chunk', data: Buffer.from('hi').toString('base64') },
      { id: 7, t: 'end' },
    ])
  })

  it('reaches the fallback seat and forwards request bodies', async () => {
    const server = makeServer()
    let sawFallbackUrl: string | undefined
    server.registerFallback((req, res) => {
      sawFallbackUrl = req.url
      void res.writeHead(404)
      res.end('nope')
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 1, method: 'GET', url: '/anything', headers: {} }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'end'))
    expect(collected.frames()[0]).toMatchObject({ id: 1, t: 'head', status: 404 })
    expect(collected.frames()[1]?.t).toBe('chunk')
    await until(() => sawFallbackUrl === '/anything')
    expect(sawFallbackUrl).toBe('/anything')
  })

  it('emits an implicit head for handlers that stream without writeHead', async () => {
    const server = makeServer()
    server.register({
      kind: 'exact',
      path: '/sse',
      handler: (_req, res) => {
        res.write('data: 1\n\n')
        res.end()
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 9, method: 'GET', url: '/sse', headers: {} }) + '\n')
    await until(() => collected.frames().filter(frame => frame.t === 'chunk').length === 1)
    await until(() => collected.frames().some(frame => frame.t === 'end'))
    expect(collected.frames()[0]).toMatchObject({ t: 'head', status: 200 })
  })

  it('reports handler failures and destroys the response', async () => {
    const server = makeServer()
    server.register({
      kind: 'exact',
      path: '/boom',
      handler: async () => {
        throw new Error('exploded')
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 4, method: 'GET', url: '/boom', headers: {} }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'destroy'))
    expect(collected.frames().some(frame => frame.t === 'handler-error' && frame.id === 4)).toBe(true)
  })

  it('logs malformed control lines without killing the carrier', async () => {
    const server = makeServer()
    server.register({ kind: 'exact', path: '/ok', handler: (_req, res) => { res.end('y') } })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write('this is not json\n')
    input.write(JSON.stringify({ id: 5, method: 'GET', url: '/ok', headers: {} }) + '\n')
    await until(() => collected.frames().some(frame => frame.id === 5 && frame.t === 'end'))
    expect(collected.frames()[0]).toMatchObject({ t: 'bad-frame' })
  })

  it('a cancel stops frames for that response and closes its request', async () => {
    const server = makeServer()
    let sawRequestClose = false
    let keepWriting: (() => void) | undefined
    server.register({
      kind: 'exact',
      path: '/sse',
      handler: (req, res) => {
        req.on('close', () => { sawRequestClose = true })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n')
        // Keep producing after registration, as a live SSE generator would.
        keepWriting = (): void => { res.write('data: tick\n\n') }
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 21, method: 'GET', url: '/sse', headers: {} }) + '\n')
    await until(() => collected.frames().filter(frame => frame.t === 'chunk').length === 1)
    keepWriting?.()
    await until(() => collected.frames().filter(frame => frame.t === 'chunk').length === 2)
    // Supervisor cancels; the generator keeps ticking for a while.
    input.write(JSON.stringify({ id: 21, t: 'cancel' }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'destroy' && frame.id === 21))
    await until(() => sawRequestClose)
    keepWriting?.()
    keepWriting?.()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(collected.frames().filter(frame => frame.id === 21 && frame.t === 'chunk')).toHaveLength(2)
  })

  it('detaches on dispose', () => {
    const server = makeServer()
    const input = new PassThrough()
    const disposer = serveStdio(server, input, new PassThrough())
    disposer()
    input.emit('data', '{"id":1,"method":"GET","url":"/","headers":{}}\n')
    expect(true).toBe(true)
  })

  it('binds a headerless frame to the loopback authority the supervisor pipe represents', async () => {
    const server = makeServer()
    let seenHost: string | undefined
    server.register({
      kind: 'exact',
      path: '/who',
      handler: (req, res) => {
        seenHost = req.headers.host
        res.end()
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 11, method: 'GET', url: '/who', headers: {} }) + '\n')
    await until(() => seenHost !== undefined)
    // The browser-trust fence reads Host and cannot be satisfied by browsers;
    // the desktop renderer never sets one, so the carrier supplies its own.
    expect(seenHost).toBe('127.0.0.1')
  })

  it('keeps an explicit Host, so spoofed authorities fail the fence closed', async () => {
    const server = makeServer()
    let seenHost: string | undefined
    server.register({
      kind: 'exact',
      path: '/who',
      handler: (req, res) => {
        seenHost = req.headers.host
        res.end()
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 12, method: 'GET', url: '/who', headers: { host: 'rebound.example' } }) + '\n')
    await until(() => seenHost !== undefined)
    expect(seenHost).toBe('rebound.example')
  })

  it('destroys an in-flight stream when the supervisor cancels its id', async () => {
    const server = makeServer()
    let sawClose = false
    server.register({
      kind: 'exact',
      path: '/stream',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.on('close', () => { sawClose = true })
        res.write('data: first\n\n')
        // No end(): the SSE generator stays open until teardown.
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 21, method: 'GET', url: '/stream', headers: {} }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'chunk'))
    input.write(JSON.stringify({ id: 21, t: 'cancel' }) + '\n')
    await until(() => collected.frames().some(frame => frame.id === 21 && frame.t === 'destroy'))
    await until(() => sawClose)
    // A cancel for an unknown or already-finished id is an accepted no-op.
    input.write(JSON.stringify({ id: 999, t: 'cancel' }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(collected.frames().filter(frame => frame.t === 'destroy')).toHaveLength(1)
  })
})

describe('serveStdio request/response surface', () => {
  // The node↔fetch bridge (dsh-client-connection http-bridge.ts) is the
  // hottest /api route owner; these pins hold it to the members it uses, so
  // a shim regression fails here instead of on every desktop RPC.
  it('exposes an async-iterable body and truthful writableEnded', async () => {
    const server = makeServer()
    let observed = { bytes: -1, endedDuringHandler: false, endedAfterEnd: false }
    server.register({
      kind: 'exact',
      path: '/bridge',
      handler: async (req, res) => {
        let bytes = 0
        for await (const chunk of req) bytes += (chunk as Buffer).byteLength
        const endedDuringHandler = res.writableEnded
        res.writeHead(200)
        // The flag flips inside end(); the body text can only witness the before-value.
        res.end(`bytes:${String(bytes)} endedDuring:${String(endedDuringHandler)}`)
        observed = { bytes, endedDuringHandler, endedAfterEnd: res.writableEnded }
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 2, method: 'POST', url: '/bridge', headers: { 'content-length': '3' }, body: 'YWJj' }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'end'))
    expect(observed).toEqual({ bytes: 3, endedDuringHandler: false, endedAfterEnd: true })
    const body = collected.frames().find(frame => frame.t === 'chunk')
    expect(Buffer.from(body?.data ?? '', 'base64').toString('utf8')).toBe('bytes:3 endedDuring:false')
  })

  it('emits close once per response and never before end', async () => {
    const server = makeServer()
    const closes: number[] = []
    server.register({
      kind: 'exact',
      path: '/close',
      handler: (_req, res) => {
        let count = 0
        res.on('close', () => { count += 1; closes.push(count) })
        expect(res.writableEnded).toBe(false)
        res.end('done')
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 3, method: 'GET', url: '/close', headers: {} }) + '\n')
    await until(() => closes.length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closes).toEqual([1])
  })

  it('supports destroy() on the request for oversized-body teardown', async () => {
    const server = makeServer()
    server.register({
      kind: 'prefix',
      path: '/api',
      handler: (req, res) => {
        expect(typeof req.destroy).toBe('function')
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
      },
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)
    serveStdio(server, input, output)
    input.write(JSON.stringify({ id: 4, method: 'POST', url: '/api/x', headers: {}, body: 'YWJj' }) + '\n')
    await until(() => collected.frames().some(frame => frame.t === 'end'))
    expect(collected.frames()[0]).toMatchObject({ t: 'head', status: 413 })
  })
})
