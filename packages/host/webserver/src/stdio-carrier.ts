/**
 * Stdio web carrier: drive the same route dispatch as node:http over NDJSON
 * frames on the child's stdin/stdout, so a supervised shell can carry every
 * renderer-facing surface without any listening socket.
 * @module stdio-carrier
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import type { Writable } from 'node:stream'
import { WebServer } from './index.ts'
import {
  LineBuffer,
  decodeRequest,
  encodeChunk,
  encodeDestroy,
  encodeEnd,
  encodeHead,
} from './stdio-frames.ts'

/** Minimal writable-response capture: enough surface for every route owner. */
class CapturedResponse extends EventEmitter {
  status = 200
  headers: Record<string, string> = {}
  headersSent = false
  destroyed = false
  /** Node semantics: true from the moment `end()` is called. Client-disconnect detection keys on it. */
  writableEnded = false
  readonly #chunks: Buffer[] = []
  readonly #id: number
  readonly #output: Writable

  constructor(id: number, output: Writable) {
    super()
    this.#id = id
    this.#output = output
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status
    this.headers = { ...headers }
    this.headersSent = true
    this.#emitHead()
    return this
  }

  write(chunk: string | Uint8Array): boolean {
    // A destroyed exchange (supervisor cancel) drops further writes instead
    // of emitting chunk frames past its destroy frame, mirroring a socket
    // that died under the handler.
    if (this.destroyed) return false
    this.#write(chunk)
    // Frames append to the output pipe without backpressure signaling; a
    // constant true keeps slow-consumer branches (waiting on 'drain')
    // unreachable, exactly like a socket that never fills.
    return true
  }

  end(chunk?: string | Uint8Array): void {
    if (this.destroyed) return
    if (chunk !== undefined && !this.headersSent) this.status = 200
    if (chunk !== undefined) this.#write(chunk)
    this.writableEnded = true
    this.destroyed = true
    this.#output.write(encodeEnd(this.#id))
    queueMicrotask(() => { this.emit('close') })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.#output.write(encodeDestroy(this.#id))
    queueMicrotask(() => { this.emit('close') })
  }

  #emitHead(): void {
    this.#output.write(encodeHead(this.#id, this.status, this.headers))
  }

  #write(chunk: string | Uint8Array): void {
    if (!this.headersSent) {
      // Handlers that stream without an explicit writeHead still get a head.
      this.writeHead(200, { 'content-type': 'application/octet-stream' })
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    this.#chunks.push(bytes)
    this.#output.write(encodeChunk(this.#id, bytes))
  }
}

/**
 * Serve the server's route dispatch over one stdio connection.
 * @param server - the composed web server whose routes answer the frames.
 * @param input - framed request lines (the child's stdin).
 * @param output - frame lines sink (the child's stdout), below app logs.
 * @returns disposer detaching the reader.
 */
export function serveStdio(server: WebServer, input: Readable, output: Writable): () => void {
  const lines = new LineBuffer()
  /** In-flight streamed responses by frame id, for supervisor cancels. */
  const responses = new Map<number, CapturedResponse>()
  const onData = (text: string): void => {
    for (const line of lines.push(text)) {
      let frame
      try {
        frame = decodeRequest(line)
      } catch (error) {
        // One malformed control line must not kill the carrier; the peer is
        // trusted composition-owned code, so this can only be a bug — log it.
        output.write(`${JSON.stringify({ t: 'bad-frame', message: error instanceof Error ? error.message : String(error) })}\n`)
        continue
      }
      if (frame === undefined) continue
      // Cancel frames are the only inbound members carrying a tag.
      if ('t' in frame) {
        responses.get(frame.id)?.destroy()
        continue
      }
      const response = new CapturedResponse(frame.id, output)
      responses.set(frame.id, response)
      const request = buildRequest(frame)
      // Cancel or completion tears down both halves: route owners may key
      // stream teardown on the request's 'close' (the SSE-detach idiom), so a
      // supervisor cancel must reach those listeners too.
      response.once('close', () => {
        responses.delete(frame.id)
        request.destroy()
      })
      server.handleRequest(
        request,
        response as unknown as ServerResponse,
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        output.write(`${JSON.stringify({ id: frame.id, t: 'handler-error', message })}\n`)
        if (!response.destroyed) response.destroy()
      })
    }
  }
  input.on('data', onData)
  return () => { input.off('data', onData) }
}

/**
 * Build the incoming-request view of one decoded frame. A real Readable, not
 * a plain object: route adapters (the node↔fetch bridge) consume the body by
 * async iteration, detect client teardown via destroy(), and register close
 * listeners — all stream machinery a bare `{ method, url, headers, on }`
 * cannot carry.
 *
 * Frames arrive over the supervisor pipe — fds inherited at spawn, private to
 * the shell↔child pair — so an absent Host binds to the loopback authority
 * that pipe represents. The browser-trust fence reads this header; browsers
 * can never set it themselves, and the desktop renderer sends none. An
 * explicit Host passes through unchanged, so a spoofed non-loopback authority
 * still fails the fence closed.
 */
function buildRequest(frame: Extract<ReturnType<typeof decodeRequest>, { method: string }>): IncomingMessage {
  const body = frame.body === undefined ? undefined : Buffer.from(frame.body, 'base64')
  const request = new Readable({ read(): void {} })
  const headers: Record<string, string> = { ...frame.headers }
  if (!Object.keys(headers).some(key => key.toLowerCase() === 'host')) {
    headers.host = '127.0.0.1'
  }
  Object.assign(request, { method: frame.method, url: frame.url, headers })
  queueMicrotask(() => {
    if (body !== undefined) request.push(body)
    request.push(null)
  })
  return request as unknown as IncomingMessage
}
