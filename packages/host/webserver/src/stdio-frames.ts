/**
 * NDJSON framing for the stdio web carrier.
 *
 * One JSON value per line. Requests flow into the child; responses stream
 * back as an ordered frame sequence per request id. Binary bodies (fonts,
 * images) ride base64 chunk frames so the line protocol stays text-safe.
 * @module stdio-frames
 */

/** A request frame: one HTTP-shaped call into the child's dispatch. */
export interface StdioRequestFrame {
  id: number
  method: string
  /** Absolute path plus query, e.g. `/assets/index.js?v=2`. */
  url: string
  headers: Record<string, string>
  /** Request body bytes (base64); absent when the method takes no body. */
  body?: string
}

/**
 * A cancel control frame from the supervisor: abandon the streamed response
 * for this id. Without it an aborted event stream leaves the child's SSE
 * generator pumping frames no one reads.
 */
export interface StdioCancelFrame {
  id: number
  t: 'cancel'
}

/** Anything the supervisor may write into the child's request pipe. */
export type StdioInboundFrame = StdioRequestFrame | StdioCancelFrame

/** One response frame in the ordered sequence of a request id. */
export type StdioResponseFrame =
  | { id: number; t: 'head'; status: number; headers: Record<string, string> }
  | { id: number; t: 'chunk'; data: string }
  | { id: number; t: 'end' }
  | { id: number; t: 'destroy' }
  | { id: number; t: 'handler-error'; message: string }

/**
 * Parse one stdin line into a request or cancel frame.
 * @param line - one raw input line without its newline.
 * @returns the frame, or `undefined` for blank separator lines.
 * @throws on malformed JSON or a frame missing required members.
 */
export function decodeRequest(line: string): StdioInboundFrame | undefined {
  if (line.trim() === '') return undefined
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('stdio-carrier: frame is not an object')
  const record = parsed as Record<string, unknown>
  if (typeof record.id !== 'number' || !Number.isInteger(record.id)) {
    throw new Error('stdio-carrier: frame id must be an integer')
  }
  if (record.t === 'cancel') return { id: record.id, t: 'cancel' }
  if (typeof record.method !== 'string' || typeof record.url !== 'string') {
    throw new Error('stdio-carrier: frame needs string method and url')
  }
  const headers: Record<string, string> = {}
  if (record.headers !== undefined) {
    if (typeof record.headers !== 'object' || record.headers === null) {
      throw new Error('stdio-carrier: headers must be an object')
    }
    for (const [key, value] of Object.entries(record.headers)) {
      if (typeof value !== 'string') throw new Error('stdio-carrier: header values must be strings')
      headers[key] = value
    }
  }
  if (record.body !== undefined && typeof record.body !== 'string') {
    throw new Error('stdio-carrier: body must be base64 text')
  }
  return {
    id: record.id,
    method: record.method,
    url: record.url,
    headers,
    ...(record.body === undefined ? {} : { body: record.body }),
  }
}

/**
 * Encode a head frame as one output line.
 * @param id - request id the response belongs to.
 * @param status - HTTP status code for the simulated response head.
 * @param headers - response headers sent before the first body chunk.
 * @returns one newline-terminated NDJSON line.
 */
export function encodeHead(id: number, status: number, headers: Record<string, string>): string {
  return `${JSON.stringify({ id, t: 'head', status, headers })}\n`
}

/**
 * Encode a body-chunk frame as one output line.
 * @param id - request id the response belongs to.
 * @param bytes - raw body bytes carried base64 inside the text-safe line.
 * @returns one newline-terminated NDJSON line.
 */
export function encodeChunk(id: number, bytes: Uint8Array): string {
  return `${JSON.stringify({ id, t: 'chunk', data: Buffer.from(bytes).toString('base64') })}\n`
}

/**
 * Encode the end-of-response frame as one output line.
 * @param id - request id the response belongs to.
 * @returns one newline-terminated NDJSON line.
 */
export function encodeEnd(id: number): string {
  return `${JSON.stringify({ id, t: 'end' })}\n`
}

/**
 * Encode a destroy frame (the handler tore the response down early).
 * @param id - request id the response belongs to.
 * @returns one newline-terminated NDJSON line.
 */
export function encodeDestroy(id: number): string {
  return `${JSON.stringify({ id, t: 'destroy' })}\n`
}

/**
 * Incremental line splitter over a byte/text stream: buffers partial lines,
 * yields complete ones.
 */
export class LineBuffer {
  #pending = ''

  /**
   * Append text and return every complete line it completed.
   * @param text - the next slice of supervisor output (any split point).
   * @returns complete lines in order, without their newlines.
   */
  push(text: string): string[] {
    this.#pending += text
    const lines: string[] = []
    let at = this.#pending.indexOf('\n')
    while (at !== -1) {
      lines.push(this.#pending.slice(0, at))
      this.#pending = this.#pending.slice(at + 1)
      at = this.#pending.indexOf('\n')
    }
    return lines
  }
}
