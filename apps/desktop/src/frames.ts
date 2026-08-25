/**
 * Parent-side client of the child's stdio frame carrier.
 *
 * Mirrors `@deepseek-ai/dsh-host-webserver`'s wire contract (`stdio-frames.ts`
 * there): one JSON request line per request into the child's fd 3, and NDJSON
 * response frames — `{id,t:'head'…}`, `{id,t:'chunk',data:<base64>}`,
 * `{id,t:'end'}`, `{id,t:'destroy'}` — back on fd 4. Abandoned stream
 * subscriptions write `{id,t:'cancel'}` so the child stops producing frames
 * for them. Kept as a local codec so the packaged app's closure stays free of
 * host-package runtime imports; the contract is asserted from both sides in
 * tests. Body bytes ride base64 because control characters must never break
 * line framing.
 * @module frames
 */

import { Buffer } from 'node:buffer'
import type { Readable, Writable } from 'node:stream'

/** One forwarded request, in the child's frame vocabulary. */
export interface FrameRequest {
  method: string
  /** Path and query, e.g. `/api/connection/foo` or `/assets/app.js`. */
  url: string
  headers?: Record<string, string> | undefined
  /** Request body bytes, sent base64-encoded. */
  body?: Uint8Array | undefined
}

/** A completed unary exchange. */
export interface FrameResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export type FrameResponseFrame =
  | { id: number; t: 'head'; status: number; headers: Record<string, string> }
  | { id: number; t: 'chunk'; data: string }
  | { id: number; t: 'end' }
  | { id: number; t: 'destroy' }
  /** The child's handler threw before a head was written; `message` is the error text. */
  | { id: number; t: 'handler-error'; message: string }

interface Pending {
  head: { status: number; headers: Record<string, string> } | undefined
  chunks: Buffer[]
  streamHandlers: ((frame: FrameResponseFrame) => void) | undefined
  resolve: ((response: FrameResponse) => void) | undefined
  reject: ((error: Error) => void) | undefined
}

/**
 * One multiplexed request/response channel over the supervised child's frame
 * pipes: writes request lines, demultiplexes response frames by id, and
 * exposes both unary requests and chunk subscriptions for event streams.
 */
export class FrameChannel {
  readonly #input: Writable
  readonly #output: Readable
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #lineBuffer = ''

  /**
   * @param input - writable pipe feeding request lines to the child (fd 3).
   * @param output - readable pipe carrying response frames (fd 4).
   */
  constructor(input: Writable, output: Readable) {
    this.#input = input
    this.#output = output
    output.setEncoding('utf8')
    this.#onData = (chunk: string): void => { this.#accept(chunk) }
    output.on('data', this.#onData)
    // The child's death tears both pipes down; late writes (a teardown-time
    // cancel, a straggler request) must not raise an unhandled 'error' in the
    // shell, and every in-flight exchange fails instead of hanging until quit.
    input.on('error', () => { /* EPIPE/ERR_STREAM_DESTROYED after child death; the output 'close' path settles all pendings */ })
    output.once('close', () => { this.close() })
  }

  readonly #onData: (chunk: string) => void

  /**
   * Send one request and await its full unary response.
   * @param request - method, path+query, headers, optional body bytes.
   * @param signal - optional abort signal; aborting deletes the pending
   *   entry and writes the child a cancel frame so server-side work stops.
   * @returns status, headers, and concatenated body bytes.
   */
  async request(request: FrameRequest, signal?: AbortSignal): Promise<FrameResponse> {
    const id = this.#nextId
    this.#nextId += 1
    return await new Promise<FrameResponse>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('The operation was aborted'))
        return
      }
      const onAbort = (): void => {
        // Unlike a subscription detach, an aborted unary must settle: reject
        // the waiter, drop the pending entry, and stop the child's work.
        if (!this.#pending.delete(id)) return
        signal?.removeEventListener('abort', onAbort)
        this.#input.write(`${JSON.stringify({ id, t: 'cancel' })}\n`)
        reject(new Error('The operation was aborted'))
      }
      this.#pending.set(id, { head: undefined, chunks: [], streamHandlers: undefined, resolve, reject })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#write(id, request)
    })
  }

  /**
   * Subscribe to the raw chunk/end/destroy frames of one request without
   * buffering them; used by the SSE pump.
   * @returns the disposer detaching the subscription; it also writes a
   * cancel frame so the child stops producing frames for the stream.
   */
  subscribe(request: FrameRequest, onFrame: (frame: FrameResponseFrame) => void): () => void {
    const id = this.#nextId
    this.#nextId += 1
    this.#pending.set(id, { head: undefined, chunks: [], streamHandlers: onFrame, resolve: undefined, reject: undefined })
    this.#write(id, request)
    return () => { this.#cancel(id) }
  }

  /** Drop one pending exchange and tell the child to stop producing for it. */
  #cancel(id: number): void {
    if (!this.#pending.delete(id)) return
    this.#input.write(`${JSON.stringify({ id, t: 'cancel' })}\n`)
  }

  /** Detach from the output pipe and fail every in-flight unary request. */
  close(): void {
    this.#output.off('data', this.#onData)
    for (const [id, pending] of this.#pending) {
      pending.reject?.(new Error(`frames: channel closed while request ${String(id)} was in flight`))
    }
    this.#pending.clear()
  }

  #write(id: number, request: FrameRequest): void {
    const frame = {
      id,
      method: request.method,
      url: request.url,
      headers: request.headers ?? {},
      ...(request.body === undefined ? {} : { body: Buffer.from(request.body).toString('base64') }),
    }
    this.#input.write(`${JSON.stringify(frame)}\n`)
  }

  #accept(chunk: string): void {
    this.#lineBuffer += chunk
    let newline = this.#lineBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#lineBuffer.slice(0, newline)
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1)
      if (line.trim() !== '') this.#dispatch(line)
      newline = this.#lineBuffer.indexOf('\n')
    }
  }

  #dispatch(line: string): void {
    let frame: FrameResponseFrame
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || !('t' in parsed)) return
      frame = parsed as FrameResponseFrame
    } catch {
      // A control line that is not valid JSON cannot map to any pending
      // exchange; dropping it keeps one stray log line from failing requests.
      return
    }
    const pending = this.#pending.get(frame.id)
    if (pending === undefined) return
    switch (frame.t) {
      case 'head': {
        pending.head = { status: frame.status, headers: frame.headers }
        break
      }
      case 'chunk': {
        if (pending.streamHandlers === undefined) pending.chunks.push(Buffer.from(frame.data, 'base64'))
        else pending.streamHandlers(frame)
        break
      }
      case 'end': {
        this.#pending.delete(frame.id)
        if (pending.streamHandlers === undefined) {
          pending.resolve?.({
            status: pending.head?.status ?? 200,
            headers: pending.head?.headers ?? {},
            body: Buffer.concat(pending.chunks),
          })
        } else pending.streamHandlers(frame)
        break
      }
      case 'destroy': {
        this.#pending.delete(frame.id)
        if (pending.streamHandlers === undefined) pending.reject?.(new Error('frames: child destroyed the response'))
        else pending.streamHandlers(frame)
        break
      }
      case 'handler-error': {
        // The handler failed on the child before any head: settle the unary
        // exchange with the child's own message instead of hanging until the
        // channel closes.
        this.#pending.delete(frame.id)
        if (pending.streamHandlers === undefined) pending.reject?.(new Error(`frames: ${frame.message}`))
        else pending.streamHandlers({ id: frame.id, t: 'destroy' })
        break
      }
    }
  }
}
