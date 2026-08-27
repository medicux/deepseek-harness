/**
 * Desktop IPC carrier: the renderer-side transport for the Electron shell.
 *
 * Implements the architecture note's reserved "IPC bridge subclass" seat:
 * protocol invariants stay in {@link AbstractApiClient}; only the two
 * transport aspects swap. Unary/respond calls and generic Connection channels
 * round-trip over a bridge object the shell's preload installs at
 * `globalThis.__DSH_IPC_CARRIER__`; downstream event frames arrive as
 * JSON-text messages on a per-stream emitter the bridge hands out, preserving
 * the WebSocket carrier's message shape byte for byte.
 *
 * The bridge is host-authored injection (the same trust level as
 * `__DSH_BOOT__`): its presence selects this carrier, so browsers without the
 * preload keep the HTTP/WebSocket path untouched.
 * @module desktop-carrier
 */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import type { ServerRequest } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { sseDataPayload } from './sse-blocks.ts'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import {
  RpcId,
  serverResponseSchema,
  type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '../rpc.ts'
import { randomUuid } from './random-uuid.ts'
import { assertRpcTarget } from './rpc-target.ts'

/** One downstream event stream handed out by the bridge. */
export interface DesktopCarrierStream {
  /** Register the frame callback before the first yield point. */
  onFrame(callback: (data: string) => void): void
  /** Register the end-of-stream callback (upstream closed or aborted). */
  onEnd(callback: () => void): void
  /** Stop the upstream pump; exactly one trailing end callback still fires. */
  abort(): void
}

/**
 * The window-injection contract the desktop preload installs. Paths are
 * same-origin absolute paths; bodies and frame payloads are JSON text.
 */
export interface DesktopCarrierBridge {
  /**
   * Forward one unary request. Transport failures reject; business errors
   * arrive as HTTP 200 envelopes per the wire contract. `token` correlates
   * the call with {@link DesktopCarrierBridge.abortFetch} — the caller's
   * `AbortSignal` never crosses this surface (contextBridge strips
   * prototypes), only an opaque string does.
   */
  fetch(path: string, init: {
    method: string
    body?: string
    headers?: Record<string, string>
    token?: string
  }): Promise<{ status: number; body: string }>
  /** Abort the in-flight fetch carrying `token`; unknown tokens are no-ops. */
  abortFetch(token: string): void
  /** Open one downstream event stream for an absolute events path. */
  openStream(path: string): DesktopCarrierStream
  /**
   * Native directory chooser answered by the shell's dialog; `null` is the
   * user's cancellation. Optional: shells without a dialog leave it absent,
   * and callers fall back to the Host's OS-chooser RPC.
   */
  pickDirectory?: () => Promise<string | null>
}

/**
 * The abort wiring {@link bindAbortToken} hands back: the correlation token
 * to send with the request, and a settle hook removing the listener once the
 * call finishes.
 */
interface AbortGate {
  token?: string | undefined
  settle(): void
}

/**
 * Bind one renderer-world `AbortSignal` to the bridge's abort channel.
 *
 * The signal object itself must never cross the bridge: contextBridge hands
 * the preload a prototype-less clone, so `addEventListener` disappears there
 * (the production failure behind "init.signal.addEventListener is not a
 * function"). The renderer keeps the live signal, generates a correlation
 * token, and forwards only that token; the shell maps it to its own
 * AbortController.
 * @param bridge - the injected desktop carrier bridge.
 * @param signal - the caller's cancellation signal, when one exists.
 * @returns the token to send with the request, and a settle hook removing the listener.
 * @throws {Error} immediately when the signal is already aborted.
 */
export function bindAbortToken(bridge: DesktopCarrierBridge, signal?: AbortSignal): AbortGate {
  if (signal === undefined) return { settle(): void {} }
  if (signal.aborted) throw new Error('This operation was aborted')
  const token = randomUuid()
  const onAbort = (): void => { bridge.abortFetch(token) }
  signal.addEventListener('abort', onAbort, { once: true })
  return { token, settle: (): void => { signal.removeEventListener('abort', onAbort) } }
}

/** The global seat name the desktop preload populates. */
const BRIDGE_SEAT = '__DSH_IPC_CARRIER__'

/**
 * Read the desktop carrier bridge injected by the shell's preload.
 * @returns the bridge, or `undefined` outside the desktop shell.
 */
export function readDesktopCarrierBridge(): DesktopCarrierBridge | undefined {
  const candidate = (globalThis as Record<string, unknown>)[BRIDGE_SEAT]
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const bridge = candidate as Partial<DesktopCarrierBridge>
  if (typeof bridge.fetch !== 'function' || typeof bridge.openStream !== 'function') return undefined
  return candidate as DesktopCarrierBridge
}

type FrameItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type Parser<F> = { parse(value: unknown): F }

/**
 * The desktop shell's client: every aspect rides the bridge, so the renderer
 * never opens a TCP connection to the supervised server.
 */
export class DesktopIpcApiClient extends AbstractApiClient {
  readonly #bridge: DesktopCarrierBridge

  constructor(bridge: DesktopCarrierBridge) {
    super()
    this.#bridge = bridge
  }

  protected override async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {}
    if (init?.headers instanceof Headers) {
      init.headers.forEach((value, key) => { headers[key] = value })
    } else if (Array.isArray(init?.headers)) {
      for (const [key, value] of init.headers) headers[key] = value
    } else if (init?.headers !== undefined) {
      Object.assign(headers, init.headers)
    }
    const gate = bindAbortToken(this.#bridge, init?.signal ?? undefined)
    try {
      const response = await this.#bridge.fetch(`${input.pathname}${input.search}`, {
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        headers,
        ...(gate.token === undefined ? {} : { token: gate.token }),
      })
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      })
    } finally {
      gate.settle()
    }
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readStream('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readStream('/api/events.host', signal, hostFrameSchema, onOpen)
  }

  private async *readStream<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const stream = this.#bridge.openStream(path)
    const inbox: FrameItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: FrameItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    stream.onFrame((block) => {
      let full: ServerRequest
      let frame: F
      // The bridge forwards whole SSE blocks; only `data:` payloads carry frames.
      const data = sseDataPayload(block)
      if (data === undefined) return
      try {
        full = serverRequestSchema.parse(JSON.parse(data))
        // Payload parse mirrors the WebSocket carrier: a malformed known-shape
        // frame is dropped loud, never fed to consumers raw.
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed desktop stream frame on ${path}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    })
    stream.onEnd(() => { enqueue({ kind: 'end' }) })
    const handleAbort = (): void => { stream.abort() }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    onOpen?.()
    // The end item is the single close source: the bridge sends exactly one
    // trailing end for upstream close, error, or abort alike.
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as FrameItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      handleAbort()
    }
  }
}

/**
 * Create the generic Connection RPC caller over the desktop bridge. Mirrors
 * the web caller's correlation and validation contract; only the socket swaps.
 * @param bridge - the injected desktop carrier bridge.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createDesktopConnectionRpc(bridge: DesktopCarrierBridge): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      assertRpcTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      const gate = bindAbortToken(bridge, signal)
      try {
        const response = await bridge.fetch(`${channel}/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          ...(gate.token === undefined ? {} : { token: gate.token }),
        })
        if (response.status !== 200) {
          throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${String(response.status)}`)
        }
        const full = serverResponseSchema.parse(JSON.parse(response.body))
        if (full.rpcId !== rpcId) {
          throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
        }
        return full.result
      } finally {
        gate.settle()
      }
    },
  }
}
