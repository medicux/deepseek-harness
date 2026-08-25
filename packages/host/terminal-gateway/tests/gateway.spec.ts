// @vitest-environment node
/**
 * Terminal gateway route account: real HTTP dispatch over a loopback server
 * with a fake PTY handle behind the subprocess seam — spawn spec shape,
 * rolling output history replayed on every attach, live SSE chunks and the exit event, write/resize
 * passthrough with bounds, close/dispose teardown, and unknown-session 404s.
 */
import { PassThrough } from 'node:stream'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GatewayError, MAX_WRITE_BYTES, TerminalGateway, TerminalGatewaySessionId, createRoutes,
} from '@deepseek-ai/dsh-host-terminal-gateway/src/index.ts'
import type { SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

interface FakeHandle extends SubprocessTerminalHandle {
  readonly output: PassThrough
  readonly writes: string[]
  readonly resizes: Array<[number, number]>
  readonly terminated: number
  settle(): void
}

function fakeHandle(): FakeHandle {
  let exit!: () => void
  const done = new Promise<SubprocessOutcome>((resolve) => { exit = () => { resolve({ exitCode: 0, signal: null }) } })
  const state = { writes: [] as string[], resizes: [] as Array<[number, number]>, terminated: 0 }
  const handle = {
    pid: 4242,
    output: new PassThrough(),
    done,
    async write(data: string): Promise<void> { state.writes.push(data) },
    async resize(cols: number, rows: number): Promise<void> { state.resizes.push([cols, rows]) },
    async inspectForeground(): Promise<undefined> { return undefined },
    async signalForeground(): Promise<number> { return 4242 },
    async terminate(): Promise<void> { state.terminated += 1; exit() },
    settle: () => { exit() },
    get writes(): string[] { return state.writes },
    get resizes(): Array<[number, number]> { return state.resizes },
    get terminated(): number { return state.terminated },
  }
  return handle
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('terminal gateway routes', () => {
  let handles: FakeHandle[]
  let spawnSpecs: Array<{ argv: readonly string[]; cwd: string; rows: number; cols: number; graceMs: number }>
  let gateway: TerminalGateway
  let server: Server
  let base: string

  const openSession = async (): Promise<string> => {
    const response = await fetch(`${base}/api/terminal.open`, {
      method: 'POST',
      body: JSON.stringify({ cols: 120, rows: 40 }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { session: string }
    return body.session
  }

  /** A unit-level gateway over the shared fake-handle pool, for seam tests below. */
  const makeGateway = (overrides: Partial<{ maxSessions: number }> = {}): TerminalGateway =>
    new TerminalGateway(
      async () => {
        const handle = fakeHandle()
        handles.push(handle)
        return handle
      },
      { shell: ['/bin/fish'], graceMs: 250, trustedHosts: [], maxSessions: 8, ...overrides },
    )

  beforeEach(async () => {
    handles = []
    spawnSpecs = []
    gateway = new TerminalGateway(
      async (spec) => {
        spawnSpecs.push(spec)
        const handle = fakeHandle()
        handles.push(handle)
        return handle
      },
      { shell: ['/bin/fish', '-l'], graceMs: 250, trustedHosts: [], maxSessions: 8 },
    )
    server = createServer((req, res) => {
      void (async () => {
        for (const route of createRoutes(gateway)) {
          if (route.path === new URL(req.url ?? '/', 'http://x').pathname) {
            await route.handler(req, res)
            return
          }
        }
        res.writeHead(404).end()
      })()
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no loopback port')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await gateway.dispose()
  })

  it('open spawns the configured shell at the client viewport and mints a session id', async () => {
    const session = await openSession()
    expect(TerminalGatewaySessionId(session)).toBe(session)
    expect(spawnSpecs[0]).toEqual({
      argv: ['/bin/fish', '-l'],
      cwd: process.env.HOME,
      rows: 40,
      cols: 120,
      graceMs: 250,
    })
  })

  it('an empty shell override resolves the environment login shell', async () => {
    // Schemastery normalizes absent config input to []; that shape must not
    // reach the PTY seam as a program-less argv.
    const original = process.env.SHELL
    process.env.SHELL = '/bin/checked-shell'
    try {
      const fallbackGateway = new TerminalGateway(
        async (spec) => {
          spawnSpecs.push(spec)
          return fakeHandle()
        },
        { shell: [], graceMs: 250, trustedHosts: [], maxSessions: 8 },
      )
      await fallbackGateway.open(80, 24)
      await fallbackGateway.dispose()
      expect(spawnSpecs.at(-1)!.argv).toEqual(['/bin/checked-shell'])
    } finally {
      if (original === undefined) delete process.env.SHELL
      else process.env.SHELL = original
    }
  })

  it('open adopts a live session id instead of spawning a second shell', async () => {
    const first = await openSession()
    const response = await fetch(`${base}/api/terminal.open`, {
      method: 'POST',
      body: JSON.stringify({ cols: 100, rows: 30, session: first }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { session: string }
    expect(body.session).toBe(first)
    expect(spawnSpecs, 'adoption must not spawn').toHaveLength(1)
  })

  it('an unknown reattach id falls through to a fresh spawn in the same request', async () => {
    await openSession()
    const response = await fetch(`${base}/api/terminal.open`, {
      method: 'POST',
      body: JSON.stringify({ cols: 100, rows: 30, session: 'stale-or-forged' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { session: string }
    expect(body.session).not.toBe('stale-or-forged')
    expect(spawnSpecs).toHaveLength(2)
  })

  it('a reload-shaped reattach replays output buffered while detached', async () => {
    const first = await openSession()
    handles[0]!.output.write(Buffer.from('while you were away $ ', 'utf8'))
    const adopt = await fetch(`${base}/api/terminal.open`, {
      method: 'POST',
      body: JSON.stringify({ cols: 100, rows: 30, session: first }),
    })
    expect(((await adopt.json()) as { session: string }).session).toBe(first)
    const streamResponse = await fetch(`${base}/api/terminal.stream?session=${first}`)
    const reader = streamResponse.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe(`data: ${Buffer.from('while you were away $ ').toString('base64')}\n\n`)
    await reader.cancel()
  })

  it('output emitted while one subscriber was attached still reaches the next', async () => {
    // The reload path depends on this: history is retained across subscriber
    // generations, not cleared when the first page goes away.
    const session = await openSession()
    handles[0]!.output.write(Buffer.from('while attached $ ', 'utf8'))
    const first = await fetch(`${base}/api/terminal.stream?session=${session}`)
    const firstReader = first.body!.getReader()
    await firstReader.read().then(({ value }) => {
      expect(new TextDecoder().decode(value)).toBe(`data: ${Buffer.from('while attached $ ').toString('base64')}\n\n`)
    })
    await firstReader.cancel()

    handles[0]!.output.write(Buffer.from('while detached $ ', 'utf8'))
    const second = await fetch(`${base}/api/terminal.stream?session=${session}`)
    const decoder = new TextDecoder()
    let received = ''
    const secondReader = second.body!.getReader()
    // SSE writes may coalesce into one flush, so poll by content, not by count.
    while (!received.includes('while detached')) {
      const result = await Promise.race([
        secondReader.read(),
        new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, 2000) }),
      ])
      if (result === 'timeout' || result.done) break
      received += decoder.decode(result.value)
    }
    await secondReader.cancel()
    expect(received).toContain(`data: ${Buffer.from('while attached $ ').toString('base64')}`)
    expect(received).toContain(`data: ${Buffer.from('while detached $ ').toString('base64')}`)
  })

  it('a malformed reattach id answers 400 without touching the PTY seam', async () => {
    const response = await fetch(`${base}/api/terminal.open`, {
      method: 'POST',
      body: JSON.stringify({ cols: 80, rows: 24, session: '' }),
    })
    expect(response.status).toBe(400)
    expect(spawnSpecs).toHaveLength(0)
  })

  it('output emitted before the stream attaches is replayed first', async () => {
    const session = await openSession()
    handles[0]!.output.write(Buffer.from('early prompt $ ', 'utf8'))
    const response = await fetch(`${base}/api/terminal.stream?session=${session}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe(`data: ${Buffer.from('early prompt $ ').toString('base64')}\n\n`)
    await reader.cancel()
  })

  it('live output streams as base64 chunks and session exit ends the stream with an exit event', async () => {
    const session = await openSession()
    const response = await fetch(`${base}/api/terminal.stream?session=${session}`)
    const reader = response.body!.getReader()
    let streamText = ''
    const pumped = new Promise<void>((resolve) => {
      void (async () => {
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) { resolve(); return }
          streamText += decoder.decode(value)
        }
      })()
    })
    // The subscriber must be registered before any post-attach output; the
    // headers arriving means the synchronous stream() body already ran.
    handles[0]!.output.write(Buffer.from('hello', 'utf8'))
    await waitFor(
      () => streamText.includes(Buffer.from('hello').toString('base64')),
      'the live chunk',
    )
    handles[0]!.settle()
    await waitFor(() => streamText.includes('event: exit'), 'the exit event')
    await pumped
  })

  it('write delivers raw keystroke text and enforces the payload bound', async () => {
    const session = await openSession()
    const ok = await fetch(`${base}/api/terminal.write`, {
      method: 'POST',
      body: JSON.stringify({ session, data: 'ls -la\r' }),
    })
    expect(ok.status).toBe(200)
    expect(handles[0]!.writes).toEqual(['ls -la\r'])

    const oversize = await fetch(`${base}/api/terminal.write`, {
      method: 'POST',
      body: JSON.stringify({ session, data: 'x'.repeat(MAX_WRITE_BYTES + 1) }),
    })
    expect(oversize.status).toBe(413)
  })

  it('resize forwards the viewport to the PTY handle', async () => {
    const session = await openSession()
    const response = await fetch(`${base}/api/terminal.resize`, {
      method: 'POST',
      body: JSON.stringify({ session, cols: 200, rows: 50 }),
    })
    expect(response.status).toBe(200)
    expect(handles[0]!.resizes).toEqual([[200, 50]])
  })

  it('close terminates the session and its id stops answering', async () => {
    const session = await openSession()
    const response = await fetch(`${base}/api/terminal.close`, {
      method: 'POST',
      body: JSON.stringify({ session }),
    })
    expect(response.status).toBe(200)
    expect(handles[0]!.terminated).toBe(1)
    const gone = await fetch(`${base}/api/terminal.write`, {
      method: 'POST',
      body: JSON.stringify({ session, data: 'x' }),
    })
    expect(gone.status).toBe(404)
  })

  it('spoofed cross-site Host answers 403 on every route', async () => {
    const spoofed = { headers: { host: 'rebound.example' } }
    for (const route of createRoutes(gateway)) {
      if (route.path === '/api/terminal.stream') continue
      const req = { method: 'POST', ...spoofed } as unknown as import('node:http').IncomingMessage
      const res = new PassThrough() as unknown as import('node:http').ServerResponse
      let status: number | undefined
      res.writeHead = (code: number) => { status = code; return res }
      await route.handler(req, res)
      expect(status).toBe(403)
    }
  })

  it('unknown sessions answer 404 on every route', async () => {
    const missing = TerminalGatewaySessionId('00000000-0000-4000-8000-000000000000')
    const write = await fetch(`${base}/api/terminal.write`, {
      method: 'POST',
      body: JSON.stringify({ session: missing, data: 'x' }),
    })
    expect(write.status).toBe(404)
    const stream = await fetch(`${base}/api/terminal.stream?session=${missing}`)
    expect(stream.status).toBe(404)
  })

  it('dispose terminates every live session', async () => {
    await openSession()
    await openSession()
    await gateway.dispose()
    expect(handles.map(handle => handle.terminated)).toEqual([1, 1])
    expect([...new Set(handles)]).toHaveLength(2)
  })

  it('a stream whose response closes without its request stops receiving frames', async () => {
    // The stdio carrier can only surface cancellation on the response half;
    // this pins the detach there instead of through real HTTP.
    const { EventEmitter } = await import('node:events')
    const unit = makeGateway()
    const session = await unit.open(80, 24)
    const writes: string[] = []
    const req = new EventEmitter()
    const res = new EventEmitter() as unknown as import('node:http').ServerResponse
    Object.assign(res as unknown as Record<string, unknown>, {
      write: (s: string): boolean => { writes.push(s); return true },
      writeHead: (): void => {},
      flushHeaders: (): void => {},
      end: (): void => {},
      writableEnded: false,
      destroyed: false,
    })
    unit.stream(req as unknown as import('node:http').IncomingMessage, res, TerminalGatewaySessionId(session))
    handles[0]!.output.write('before\n')
    await waitFor(() => writes.some(line => line.startsWith('data: ')), 'first chunk')
    res.emit('close')
    handles[0]!.output.write('after\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(writes.some(line => line.includes(Buffer.from('after').toString('base64')))).toBe(false)
  })

  it('opening past maxSessions terminates the oldest detached session', async () => {
    const unit = makeGateway({ maxSessions: 2 })
    const first = await unit.open(80, 24)
    await unit.open(80, 24)
    expect(handles).toHaveLength(2)
    const third = await unit.open(80, 24)
    expect(handles).toHaveLength(3)
    expect(handles[0]!.terminated).toBe(1)
    expect(third).not.toBe(first)
  })

  it('opening past maxSessions with every session attached fails loud', async () => {
    const { EventEmitter } = await import('node:events')
    const unit = makeGateway({ maxSessions: 1 })
    const id = await unit.open(80, 24)
    const res = new EventEmitter() as unknown as import('node:http').ServerResponse
    Object.assign(res as unknown as Record<string, unknown>, {
      write: (): boolean => true,
      writeHead: (): void => {},
      flushHeaders: (): void => {},
      end: (): void => {},
      writableEnded: false,
      destroyed: false,
    })
    unit.stream(new EventEmitter() as unknown as import('node:http').IncomingMessage, res, id)
    await expect(unit.open(80, 24)).rejects.toThrow(/attached sessions/u)
  })

  it('GatewayError carries its HTTP status for route answers', () => {
    expect(new GatewayError('nope', 418).status).toBe(418)
  })

  it('replays a rolling window, not unbounded history, after a chunk flood', async () => {
    const unit = makeGateway()
    const id = await unit.open(80, 24)
    const handle = handles[0]!
    // ~5.6MB of small chunks against the ~700k-char ceiling: the retained
    // replay must stay bounded and end on the freshest output.
    for (let i = 0; i < 70_000; i++) handle.output.write('abcdefgh')
    await new Promise(resolve => setTimeout(resolve, 30))

    const replayed: string[] = []
    const { EventEmitter } = await import('node:events')
    const res = new EventEmitter() as unknown as import('node:http').ServerResponse
    Object.assign(res as unknown as Record<string, unknown>, {
      writeHead: (): void => {},
      flushHeaders: (): void => {},
      write: (line: string): boolean => {
        if (line.startsWith('data: ')) replayed.push(line.slice('data: '.length))
        return true
      },
      end: (): void => {},
      writableEnded: false,
      destroyed: false,
    })
    unit.stream(new EventEmitter() as unknown as import('node:http').IncomingMessage, res, id)
    // 700_000 / 8 chunks = 87_500 max; anything unbounded blows far past this.
    expect(replayed.length).toBeLessThanOrEqual(88_000)
    expect(replayed.length).toBeGreaterThan(0)
  })

  it('refuses new work once disposal has run', async () => {
    const unit = makeGateway()
    const id = await unit.open(80, 24)
    await unit.dispose()
    // `open` checks liveness before touching sessions; id-addressed routes
    // resolve the (now removed) session first, so they answer 404.
    await expect(unit.open(80, 24)).rejects.toThrow(/disposing/u)
    await expect(unit.write(id, 'ls')).rejects.toThrow(/unknown terminal session/u)
  })

  it('forwards client resize calls onto the PTY handle', async () => {
    const unit = makeGateway()
    const id = await unit.open(80, 24)
    await unit.resize(id, 100, 30)
    expect(handles[0]!.resizes).toEqual([[100, 30]])
  })
})
