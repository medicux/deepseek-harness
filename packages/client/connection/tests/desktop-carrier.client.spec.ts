import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MuxFrame, RpcRequest } from '../src/client/api.ts'
import {
  DesktopIpcApiClient,
  createDesktopConnectionRpc,
  readDesktopCarrierBridge,
  type DesktopCarrierBridge,
  type DesktopCarrierStream,
} from '../src/client/desktop-carrier.ts'
import { sseDataPayload, sseEventName } from '../src/client/sse-blocks.ts'

/** A scripted stream whose callbacks fire in test order. */
class FakeStream implements DesktopCarrierStream {
  readonly emitted: string[] = []
  #frameCallback: ((data: string) => void) | undefined
  #endCallback: (() => void) | undefined
  aborted = false
  #ended = false

  onFrame(callback: (data: string) => void): void { this.#frameCallback = callback }
  onEnd(callback: () => void): void { this.#endCallback = callback }
  /** Mirrors the main-side pump contract: every abort gets one trailing end. */
  abort(): void {
    this.aborted = true
    queueMicrotask(() => { this.end() })
  }
  /** Deliver one payload wrapped as the pump's `data:`-only SSE block. */
  emit(data: string): void { this.#frameCallback?.(`data: ${data}\n\n`) }
  /** Deliver one raw block verbatim, bypassing the data-only wrapper. */
  emitRaw(block: string): void { this.#frameCallback?.(block) }
  end(): void {
    if (this.#ended) return
    this.#ended = true
    this.#endCallback?.()
  }
}

interface FetchInit {
  method?: string
  body?: string
  headers?: Record<string, string>
  token?: string
}

interface FetchCall {
  path: string
  init: FetchInit
}

type BridgeFetch = (path: string, init: FetchInit) => Promise<{ status: number; body: string }>

function makeBridge(streams: FakeStream[] = []): DesktopCarrierBridge & { calls: FetchCall[]; abortCalls: string[] } {
  const calls: FetchCall[] = []
  const abortCalls: string[] = []
  const fetch: BridgeFetch = async (path, init) => {
    calls.push({ path, init })
    return { status: 200, body: JSON.stringify({ type: 'server-response', rpcId: echoId(), result: { ok: true, value: null } }) }
  }
  const openStream = (_path: string): DesktopCarrierStream => {
    const stream = new FakeStream()
    streams.push(stream)
    return stream
  }
  return {
    fetch,
    openStream,
    abortFetch: (token: string): void => { abortCalls.push(token) },
    calls,
    abortCalls,
  }
}

let nextEcho = 0
function echoId(): string {
  nextEcho += 1
  return `echo-${String(nextEcho)}`
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__DSH_IPC_CARRIER__
})

function frameEnvelope(sessionId = 's-1'): unknown {
  return {
    type: 'server-request',
    rpcId: 'srv-1',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: { type: 'session/title', seq: 1, time: 0, data: { title: 't' } },
    },
  }
}


describe('sse-blocks', () => {
  it('joins multi-line data payloads and reports blocks without one as undefined', () => {
    expect(sseDataPayload('data: hello')).toBe('hello')
    expect(sseDataPayload('data: a\ndata: b')).toBe('a\nb')
    // The one-leading-space rule strips exactly one separator space.
    expect(sseDataPayload('data:  spaced')).toBe(' spaced')
    expect(sseDataPayload('event: exit\nid: 7')).toBeUndefined()
  })

  it('reads event names, treating an empty value as unnamed', () => {
    expect(sseEventName('event: exit\ndata: {}')).toBe('exit')
    expect(sseEventName('data: plain')).toBeUndefined()
    expect(sseEventName('event:')).toBeUndefined()
  })
})

describe('readDesktopCarrierBridge', () => {
  it('returns undefined when the seat is absent or malformed', () => {
    expect(readDesktopCarrierBridge()).toBeUndefined()
    ;(globalThis as Record<string, unknown>).__DSH_IPC_CARRIER__ = 'nope'
    expect(readDesktopCarrierBridge()).toBeUndefined()
    ;(globalThis as Record<string, unknown>).__DSH_IPC_CARRIER__ = {}
    expect(readDesktopCarrierBridge()).toBeUndefined()
  })

  it('returns the injected bridge when both members are functions', () => {
    const bridge = makeBridge()
    ;(globalThis as Record<string, unknown>).__DSH_IPC_CARRIER__ = bridge
    expect(readDesktopCarrierBridge()).toBe(bridge)
  })
})

describe('DesktopIpcApiClient unary transport', () => {
  it('forwards method, headers and body and rebuilds a Response', async () => {
    const bridge = makeBridge()
    const client = new DesktopIpcApiClient(bridge)
    // Drive doFetch through the public callUnary path with a matching echo.
    bridge.fetch = async (path: string, init: FetchInit) => {
      bridge.calls.push({ path, init })
      const request = JSON.parse(init.body ?? '{}') as { rpcId: string }
      return {
        status: 200,
        body: JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }),
      }
    }
    const response = await client.sessions.list({})
    expect(response.result).toEqual({ ok: true, value: { items: [] } })
    expect(bridge.calls.length).toBeGreaterThan(0)
    const call = bridge.calls[0] as FetchCall
    expect(call.path.startsWith('/api/')).toBe(true)
    expect(call.init.method).toBe('POST')
    expect(call.init.headers?.['content-type']).toBe('application/json')
  })

  it('aborts an in-flight fetch through the bridge token', async () => {
    const bridge = makeBridge()
    const seen: FetchCall[] = []
    bridge.fetch = (path: string, init: FetchInit) => new Promise((_resolve, reject) => {
      seen.push({ path, init })
      // Hangs until the renderer-side abort arrives via abortFetch.
      const original = bridge.abortFetch.bind(bridge)
      bridge.abortFetch = (token: string): void => { original(token); reject(new Error('aborted by test')) }
    })
    const client2 = new DesktopIpcApiClient(bridge)
    const controller = new AbortController()
    const pending = client2.host.describe({}, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow('aborted by test')
    expect(seen[0]?.init.token).toEqual(expect.any(String))
    expect(bridge.abortCalls[0]).toBe(seen[0]?.init.token)
  })

  it('rejects a pre-aborted signal before reaching the bridge', async () => {
    const bridge = makeBridge()
    const client2 = new DesktopIpcApiClient(bridge)
    const controller = new AbortController()
    controller.abort()
    await expect(client2.host.describe({}, controller.signal)).rejects.toThrow(/aborted/iu)
    expect(bridge.calls.length).toBe(0)
  })
})

class HeaderProbeClient extends DesktopIpcApiClient {
  public probe(input: URL, init: RequestInit): Promise<Response> {
    return this.doFetch(input, init)
  }

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return super.doFetch(input, init)
  }
}

describe('doFetch mapping and host stream', () => {
  function probeBridge(): { client: HeaderProbeClient; seen: Array<{ path: string; init: FetchInit }> } {
    const seen: Array<{ path: string; init: FetchInit }> = []
    const client = new HeaderProbeClient({
      fetch: async (path, init) => {
        seen.push({ path, init })
        return { status: 201, body: 'raw' }
      },
      abortFetch: () => {},
      openStream: () => new FakeStream(),
    })
    return { client, seen }
  }

  it('maps Headers instances, bodies, signals and query strings', async () => {
    const { client, seen } = probeBridge()
    const controller = new AbortController()
    const response = await client.probe(new URL('https://dsh.internal/api/x?trace=1'), {
      method: 'PUT',
      body: 'payload',
      headers: new Headers({ 'x-a': '1' }),
      signal: controller.signal,
    })
    expect(response.status).toBe(201)
    expect(await response.text()).toBe('raw')
    expect(seen[0]?.path).toBe('/api/x?trace=1')
    expect(seen[0]?.init.method).toBe('PUT')
    expect(seen[0]?.init.body).toBe('payload')
    // A live signal becomes a correlation token; the signal itself stays in
    // the renderer world (contextBridge strips its prototype).
    expect(seen[0]?.init.token).toEqual(expect.any(String))
    expect(typeof (seen[0]?.init.headers as Record<string, string>)['x-a']).toBe('string')
  })

  it('maps tuple-array and plain-record headers and omits absent fields', async () => {
    for (const headers of [[['x-b', '2']] as [string, string][], { 'x-c': '3' }, undefined]) {
      const { client, seen } = probeBridge()
      const requestInit: RequestInit = { method: 'GET', ...(headers === undefined ? {} : { headers }) }
      await client.probe(new URL('https://dsh.internal/api/y'), requestInit)
      expect(seen[0]?.path).toBe('/api/y')
      expect(seen[0]?.init.method).toBe('GET')
      expect(seen[0]?.init.body).toBeUndefined()
      expect(seen[0]?.init.token).toBeUndefined()
      if (headers !== undefined) {
        const mapped = seen[0]?.init.headers as Record<string, string>
        expect(Object.keys(mapped).length).toBe(1)
      }
    }
  })

  it('defaults to GET when init omits every field', async () => {
    const { client, seen } = probeBridge()
    await client.probe(new URL('https://dsh.internal/api/z'), {})
    expect(seen[0]?.init.method).toBe('GET')
  })

  it('starts a pre-aborted stream aborted and ends it once', async () => {
    const streams: FakeStream[] = []
    const client = new DesktopIpcApiClient(makeBridge(streams))
    const controller = new AbortController()
    controller.abort()
    const iterator = client.events.mux({}, controller.signal)
    await expect(iterator[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true })
    expect(streams[0]?.aborted).toBe(true)
  })

  it('pumps the host stream through openHost', async () => {
    const streams: FakeStream[] = []
    const client = new DesktopIpcApiClient(makeBridge(streams))
    const iterator = client.events.host({}, new AbortController().signal)
    const pending = iterator[Symbol.asyncIterator]().next()
    await Promise.resolve()
    const errorFrame = JSON.stringify({
      type: 'server-request',
      rpcId: 'h1',
      method: 'host/event',
      payload: { type: 'host/agent-error', sessionId: 's-9', message: 'boom' },
    })
    streams[0]?.emit(errorFrame)
    const step = await pending
    expect(step.done).toBe(false)
    expect(step.value).toMatchObject({ payload: { type: 'host/agent-error' } })
    streams[0]?.end()
    await iterator[Symbol.asyncIterator]().next()
  })
})

describe('DesktopIpcApiClient streams', () => {
  it('yields parsed frames and ends when the upstream closes', async () => {
    const streams: FakeStream[] = []
    const bridge = makeBridge(streams)
    const client = new DesktopIpcApiClient(bridge)
    const iterator = client.events.mux({}, new AbortController().signal)
    const next = (): Promise<IteratorResult<RpcRequest<MuxFrame>>> => iterator[Symbol.asyncIterator]().next()
    const first = next()
    await Promise.resolve()
    await Promise.resolve()
    streams[0]?.emit(JSON.stringify(frameEnvelope()))
    const step = await first
    expect(step.done).toBe(false)
    expect(step.value).toMatchObject({ payload: { sessionId: 's-1' } })
    streams[0]?.end()
    await expect(next()).resolves.toMatchObject({ done: true })
  })

  it('drops malformed frames but keeps the stream alive', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const streams: FakeStream[] = []
    const client = new DesktopIpcApiClient(makeBridge(streams))
    const iterator = client.events.mux({}, new AbortController().signal)
    const next = (): Promise<IteratorResult<RpcRequest<MuxFrame>>> => iterator[Symbol.asyncIterator]().next()
    const first = next()
    await Promise.resolve()
    await Promise.resolve()
    streams[0]?.emit('not-json')
    // A named-event block carries no data payload; the client skips it
    // silently (no consumer frame, no malformed-frame error).
    streams[0]?.emitRaw('event: exit')
    streams[0]?.emit(JSON.stringify({ type: 'server-request', rpcId: 'x' }))
    streams[0]?.emit(JSON.stringify(frameEnvelope()))
    const step = await first
    expect(step.value).toBeDefined()
    expect(errorSpy).toHaveBeenCalledTimes(2)
    streams[0]?.end()
    await next()
  })

  it('aborts the upstream pump on consumer signal', async () => {
    const streams: FakeStream[] = []
    const client = new DesktopIpcApiClient(makeBridge(streams))
    const controller = new AbortController()
    const iterator = client.events.mux({}, controller.signal)
    const next = (): Promise<IteratorResult<RpcRequest<MuxFrame>>> => iterator[Symbol.asyncIterator]().next()
    const pending = next()
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    expect(streams[0]?.aborted).toBe(true)
    await expect(pending).resolves.toMatchObject({ done: true })
  })
})

describe('createDesktopConnectionRpc', () => {
  it('posts the full envelope to the generic channel path and validates the echo', async () => {
    const seen: FetchCall[] = []
    const bridge: DesktopCarrierBridge = {
      fetch: async (path: string, init: FetchInit) => {
        seen.push({ path, init })
        const request = JSON.parse(init.body ?? '{}') as { rpcId: string }
        return {
          status: 200,
          body: JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: 'done' } }),
        }
      },
      abortFetch: () => {},
      openStream: () => new FakeStream(),
    }
    const rpc = createDesktopConnectionRpc(bridge)
    const result = await rpc.call('/test', 'echo', { hello: 1 })
    expect(result).toEqual({ ok: true, value: 'done' })
    expect(seen[0]?.path).toBe('/connection/test/echo')
  })

  it('rejects invalid targets before touching the bridge', async () => {
    const rpc = createDesktopConnectionRpc(makeBridge())
    await expect(rpc.call('bad-channel', 'echo', {})).rejects.toThrow(/invalid RPC target/u)
  })

  it('throws a transport failure on non-200 statuses', async () => {
    const bridge: DesktopCarrierBridge = {
      fetch: async () => ({ status: 503, body: '' }),
      abortFetch: () => {},
      openStream: () => new FakeStream(),
    }
    const rpc = createDesktopConnectionRpc(bridge)
    await expect(rpc.call('/test', 'echo', {})).rejects.toThrow(/HTTP 503/u)
  })

  it('aborts a connection-rpc call through the bridge token', async () => {
    const seen: FetchCall[] = []
    const abortCalls: string[] = []
    const controller = new AbortController()
    let rejectPending: ((error: Error) => void) | undefined
    const bridge2: DesktopCarrierBridge = {
      fetch: (path: string, init: FetchInit) => new Promise((_resolve, reject) => {
        seen.push({ path, init })
        // Hangs until the renderer-side abort arrives via abortFetch.
        rejectPending = reject
      }),
      abortFetch: (token: string): void => {
        abortCalls.push(token)
        rejectPending?.(new Error('aborted by test'))
      },
      openStream: () => new FakeStream(),
    }
    const rpc = createDesktopConnectionRpc(bridge2)
    const pending = rpc.call('/test', 'echo', {}, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow('aborted by test')
    expect(seen[0]?.init.token).toEqual(expect.any(String))
    expect(abortCalls[0]).toBe(seen[0]?.init.token)
  })

  it('rejects on an rpcId echo mismatch', async () => {
    const bridge2: DesktopCarrierBridge = {
      fetch: async () => ({ status: 200, body: JSON.stringify({ type: 'server-response', rpcId: 'other', result: { ok: true, value: null } }) }),
      abortFetch: () => {},
      openStream: () => new FakeStream(),
    }
    const rpc = createDesktopConnectionRpc(bridge2)
    await expect(rpc.call('/test', 'echo', {})).rejects.toThrow(/rpcId mismatch/u)
  })

  it('rejects endpoints with empty or traversal segments', async () => {
    const rpc = createDesktopConnectionRpc(makeBridge())
    await expect(rpc.call('/test', '', {})).rejects.toThrow(/invalid RPC target/u)
    await expect(rpc.call('/test', '../escape', {})).rejects.toThrow(/invalid RPC target/u)
  })
})


describe('connection plugin carrier selection', () => {
  it('wires the desktop client and rpc when a bridge is seated', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { apply } = await import('../src/client/index.ts')
    const bridge = makeBridge()
    ;(globalThis as Record<string, unknown>).__DSH_IPC_CARRIER__ = bridge
    try {
      const ctx = new Context()
      apply(ctx)
      const handle = ctx.get('connection') as import('../src/client/index.ts').ConnectionHandle
      expect(handle.api).toBeInstanceOf(DesktopIpcApiClient)
      expect(handle.isLoopback).toBe(true)
    } finally {
      delete (globalThis as Record<string, unknown>).__DSH_IPC_CARRIER__
    }
  })
})
