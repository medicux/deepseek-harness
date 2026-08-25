import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopCarrier, resetDesktopCarrier } from '../src/carrier.ts'
import { FrameChannel } from '../src/frames.ts'

interface FrameHarness {
  channel: FrameChannel
  requests: Promise<Array<Record<string, unknown>>>
  reply: (lines: string[]) => void
}

/** Wire a real FrameChannel to a scripted child over PassThrough pipes. */
function makeFrameHarness(): FrameHarness {
  const toChild = new PassThrough()
  const fromChild = new PassThrough()
  const channel = new FrameChannel(toChild, fromChild)
  const promise = new Promise<Array<Record<string, unknown>>>((resolve) => {
    let buffer = ''
    toChild.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n').filter(line => line.trim() !== '')
      if (lines.length > 0) resolve(lines.map(line => JSON.parse(line) as Record<string, unknown>))
    })
  })
  return {
    channel,
    requests: promise,
    reply: (lines) => { fromChild.write(lines.join('\n') + '\n') },
  }
}

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const listeners = new Map<string, Handler[]>()
const sent: Array<{ channel: string; data: string }> = []

/** Dialog mock wired through the factory so tests drive one shared vi.fn. */
const showDialog = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (_channel: string, handler: Handler): void => { handlers.set(_channel, handler) },
    on: (_channel: string, handler: Handler): void => {
      const existing = listeners.get(_channel) ?? []
      existing.push(handler)
      listeners.set(_channel, existing)
    },
    removeHandler: (channel: string): void => { handlers.delete(channel) },
    removeAllListeners: (channel: string): void => { listeners.delete(channel) },
  },
  dialog: { showOpenDialog: (...args: unknown[]): unknown => showDialog(...args) },
  BrowserWindow: {
    getFocusedWindow: (): undefined => undefined,
    getAllWindows: (): unknown[] => [],
  },
}))

function makeSender(): { send: (channel: string, data: string) => void; isDestroyed: () => boolean } {
  return {
    send: (channel, data) => { sent.push({ channel, data }) },
    isDestroyed: () => false,
  }
}

/** The first `.on` listener registered under an IPC channel. */
const listener = (channel: string): Handler | undefined => listeners.get(channel)?.[0]

function sseResponse(chunks: string[], options: { status?: number } = {}): Response {
  const encoder = new TextEncoder()
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index] ?? ''))
        index += 1
      } else {
        controller.close()
      }
    },
  })
  return new Response(body, { status: options.status ?? 200 })
}

afterEach(() => {
  resetDesktopCarrier()
  handlers.clear()
  listeners.clear()
  sent.length = 0
  vi.unstubAllGlobals()
})

describe('registerDesktopCarrier', () => {
  it('answers unary requests through the frame channel when present', async () => {
    const harness = makeFrameHarness()
    registerDesktopCarrier(() => undefined, () => harness.channel)
    const handler = handlers.get('dsh-desktop:carrier-fetch') as (event: unknown, token: unknown, path: unknown, init: unknown) => Promise<{ status: number; body: string }>
    const pending = handler({}, 't1', '/api/host.describe', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    const [request] = await harness.requests
    expect(request).toMatchObject({ id: 1, method: 'POST', url: '/api/host.describe' })
    harness.reply([
      JSON.stringify({ id: 1, t: 'head', status: 200, headers: { 'content-type': 'application/json' } }),
      JSON.stringify({ id: 1, t: 'chunk', data: Buffer.from(JSON.stringify({ ok: true })).toString('base64') }),
      JSON.stringify({ id: 1, t: 'end' }),
    ])
    await expect(pending).resolves.toEqual({ status: 200, body: JSON.stringify({ ok: true }) })
  })

  it('pumps event streams through frame chunks onto the stream IPC channels', async () => {
    const harness = makeFrameHarness()
    registerDesktopCarrier(() => undefined, () => harness.channel)
    const open = listener('dsh-desktop:carrier-stream-open') as (event: unknown, id: unknown, path: unknown) => void
    open({ sender: makeSender() }, 's1', '/api/connection/events')
    const [request] = await harness.requests
    expect(request).toMatchObject({ method: 'GET', url: '/api/connection/events' })
    harness.reply([
      JSON.stringify({ id: 1, t: 'head', status: 200, headers: {} }),
      JSON.stringify({ id: 1, t: 'chunk', data: Buffer.from('data: hello\n\n').toString('base64') }),
      JSON.stringify({ id: 1, t: 'chunk', data: Buffer.from('data: world\n\n').toString('base64') }),
      JSON.stringify({ id: 1, t: 'end' }),
    ])
    await new Promise(resolve => setTimeout(resolve, 20))
    // Blocks forward verbatim (without their blank-line separator), so named
    // events survive the pump; `data:`-only blocks carry one payload line.
    expect(sent).toEqual([
      { channel: 'dsh-desktop:stream:s1', data: 'data: hello' },
      { channel: 'dsh-desktop:stream:s1', data: 'data: world' },
      { channel: 'dsh-desktop:stream:s1:end', data: undefined },
    ])
  })

  it('forwards unary posts to the current server URL', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: null } }), { status: 200 })
    })
    let base: string | undefined = 'http://127.0.0.1:5001'
    registerDesktopCarrier(() => base)
    const handler = handlers.get('dsh-desktop:carrier-fetch') as (event: unknown, token: unknown, path: unknown, init: unknown) => Promise<{ status: number; body: string }>
    const result = await handler({}, 't1', '/api/host.describe', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(result.status).toBe(200)
    expect(seen[0]).toBe('http://127.0.0.1:5001/api/host.describe')
    base = undefined
    await expect(handler({}, 't2', '/api/host.describe', {})).resolves.toMatchObject({ status: 503 })
  })

  it('rejects non-rooted paths', async () => {
    registerDesktopCarrier(() => 'http://127.0.0.1:5001')
    const handler = handlers.get('dsh-desktop:carrier-fetch') as (event: unknown, token: unknown, path: unknown) => Promise<unknown>
    await expect(handler({}, 't', 'api/relative')).rejects.toThrow(/invalid path/u)
  })

  it('pumps SSE data blocks as IPC frames and sends the end sentinel', async () => {
    const frame = JSON.stringify({ type: 'server-request', rpcId: 'a', method: 'session/event', payload: {} })
    vi.stubGlobal('fetch', async () => {
      const blocks = ['data: ' + frame + '\n\n', 'event: x\ndata: partial\n\n', '\n\n']
      return sseResponse(blocks)
    })
    registerDesktopCarrier(() => 'http://127.0.0.1:5002')
    const opener = listener('dsh-desktop:carrier-stream-open') as (event: unknown, id: string, path: string) => void
    opener({ sender: makeSender() }, 's1', '/api/events.mux')
    await vi.waitFor(() => { expect(sent.some(item => item.channel === 'dsh-desktop:stream:s1:end')).toBe(true) })
    const frames = sent.filter(item => item.channel === 'dsh-desktop:stream:s1')
    expect(frames.length).toBe(2)
    // The named-event block forwards whole, keeping `event:` intact.
    expect(frames[1]?.data).toBe('event: x\ndata: partial')
  })

  it('ends immediately when the server URL is missing and rejects bad opens', () => {
    const sender = makeSender()
    registerDesktopCarrier(() => undefined)
    const opener = listener('dsh-desktop:carrier-stream-open') as (event: unknown, id: string, path: string) => void
    opener({ sender }, 's2', '/api/events.host')
    expect(sent).toEqual([{ channel: 'dsh-desktop:stream:s2:end', data: undefined }])
    try {
      opener({ sender }, 's3', '/etc/passwd')
      expect.unreachable('bad open must throw')
    } catch {
      expect(true).toBe(true)
    }
  })

  it('aborts the upstream pump when the renderer aborts', async () => {
    let aborted = false
    vi.stubGlobal('fetch', async (_url: string | URL, init?: { signal?: AbortSignal }) => {
      init?.signal?.addEventListener('abort', () => { aborted = true })
      return sseResponse([])
    })
    const sender = makeSender()
    registerDesktopCarrier(() => 'http://127.0.0.1:5003')
    ;(listener('dsh-desktop:carrier-stream-open') as (event: unknown, id: string, path: string) => void)({ sender }, 's4', '/api/events.mux')
    ;(listener('dsh-desktop:carrier-stream-abort') as (event: unknown, id: string) => void)({}, 's4')
    ;(listener('dsh-desktop:carrier-stream-abort') as (event: unknown, id: string) => void)({}, 'missing')
    await vi.waitFor(() => { expect(aborted).toBe(true) })
    await vi.waitFor(() => { expect(sent.some(item => item.channel === 'dsh-desktop:stream:s4:end')).toBe(true) })
  })

  it('drops every registration, listener, and pump on reset', () => {
    registerDesktopCarrier(() => undefined)
    expect(handlers.has('dsh-desktop:carrier-fetch')).toBe(true)
    expect(handlers.has('dsh-desktop:pick-directory')).toBe(true)
    expect(listeners.has('dsh-desktop:carrier-stream-open')).toBe(true)
    expect(listeners.has('dsh-desktop:carrier-stream-abort')).toBe(true)
    resetDesktopCarrier()
    expect(handlers.has('dsh-desktop:carrier-fetch')).toBe(false)
    expect(handlers.has('dsh-desktop:pick-directory')).toBe(false)
    expect(listeners.has('dsh-desktop:carrier-stream-open')).toBe(false)
    expect(listeners.has('dsh-desktop:carrier-stream-abort')).toBe(false)
    expect(listeners.has('dsh-desktop:carrier-abort')).toBe(false)
  })

  it('answers the directory picker from the shell dialog: path or null on cancel', async () => {
    vi.mocked(showDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/project'] })
    vi.mocked(showDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    vi.mocked(showDialog).mockResolvedValueOnce({ canceled: false, filePaths: [] })
    registerDesktopCarrier(() => undefined)
    const pick = handlers.get('dsh-desktop:pick-directory')
    expect(pick).toBeDefined()
    await expect(pick?.(undefined)).resolves.toBe('/tmp/project')
    await expect(pick?.(undefined)).resolves.toBeNull()
    // An empty selection is a cancellation too.
    await expect(pick?.(undefined)).resolves.toBeNull()
    expect(showDialog).toHaveBeenCalledTimes(3)
  })

  it('fails loud on a second registration without an intervening reset', () => {
    registerDesktopCarrier(() => undefined)
    expect(() => { registerDesktopCarrier(() => undefined) }).toThrow(/already installed/u)
  })

  it('allows reinstallation after a reset', () => {
    registerDesktopCarrier(() => undefined)
    resetDesktopCarrier()
    expect(() => { registerDesktopCarrier(() => undefined) }).not.toThrow()
  })
})
