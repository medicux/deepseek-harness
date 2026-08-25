/**
 * Interactive user-terminal gateway for the DeepSeek Harness web GUI host:
 * spawns plain user shells (the operator's `$SHELL` with full user rights —
 * VS Code integrated-terminal semantics, chosen deliberately over the agent
 * sandbox) through the subprocess capability's PTY seam and serves them to the
 * GUI over five `/api/terminal.*` routes. Unary routes are POST JSON; output
 * streams as Server-Sent Events of base64 chunks so the transport survives any
 * delivery carrier, including the desktop stdio carriage.
 * @module @deepseek-ai/dsh-host-terminal-gateway
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Branded } from '@deepseek-ai/dsh-brand'
import { assertTrustedAuthority, isTrustedApiRequest } from '@deepseek-ai/dsh-client-connection/src/api-request-trust.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Opaque identity minted per live gateway shell session. */
export type TerminalGatewaySessionId = Branded<'dsh.terminal-gateway.session'>

/**
 * Brand one registry-minted string as a {@link TerminalGatewaySessionId}.
 * @param value - raw registry-issued id.
 * @returns Same string with the gateway session brand.
 */
export function TerminalGatewaySessionId(value: string): TerminalGatewaySessionId {
  return value as TerminalGatewaySessionId
}

/** Largest accepted `terminal.write` payload; a fixed wire/security bound. */
export const MAX_WRITE_BYTES = 65536

/** Largest accepted request body across unary routes; a fixed wire bound. */
const MAX_BODY_BYTES = 131072

/** Bounded rolling output history per session, in base64 characters (~512 KiB of
 * decoded payload); a fixed protocol bound like the write bound. */
const MAX_HISTORY_CHARS = 700_000

/** Gateway configuration. */
export interface Config {
  /**
   * Shell argv override; when absent the gateway resolves `$SHELL`, falling
   * back to the platform login shell (`/bin/zsh` on darwin, `/bin/bash` on
   * linux, `powershell.exe` on win32).
   */
  shell: readonly string[] | undefined
  /** TERM-to-KILL cleanup grace applied when terminating sessions. */
  graceMs: number
  /**
   * Non-loopback authorities this deployment serves, shared verbatim with the
   * connection plugin's fence so every `/api/terminal.*` exact route enforces
   * the same DNS-rebinding/cross-site defense the `/api` prefix applies.
   */
  trustedHosts: string[]
  /**
   * Live-session ceiling. Opening past it first terminates the oldest
   * session with no attached stream (a closed tab's orphan); when every
   * session is attached, `open` fails loud instead of growing unbounded.
   */
  maxSessions: number
}

export const Config: z<Config> = z.object({
  // Absent input means resolve at spawn time; the cast mirrors apiproxy's
  // exactOptionalPropertyTypes accommodation for defaulted/optional fields.
  shell: z.array(z.string()) as z<readonly string[] | undefined>,
  graceMs: z.natural().default(5000),
  trustedHosts: z.array(z.string()).default([]),
  maxSessions: z.natural().default(8),
})

/** One live gateway-owned shell session and its stream fan-out state. */
interface GatewaySession {
  readonly id: TerminalGatewaySessionId
  readonly handle: SubprocessTerminalHandle
  /** SSE writers attached to `/api/terminal.stream`; each owns its response end. */
  readonly subscribers: Set<(chunk: string | null) => void>
  /** Rolling output history, oldest first; every attaching stream receives it,
   * so a reload reconstructs the scrollback instead of only the detached window. */
  readonly history: string[]
  /** Summed base64 length of {@link history}, maintained to make trimming O(1). */
  historyChars: number
  exited: boolean
}

/** Spawn + fan-out core over the subprocess PTY seam; routes delegate here. */
export class TerminalGateway {
  private readonly sessions = new Map<TerminalGatewaySessionId, GatewaySession>()
  private disposing = false

  constructor(
    private readonly spawnTerminal: (spec: {
      argv: readonly string[]
      cwd: string
      rows: number
      cols: number
      graceMs: number
    }) => Promise<SubprocessTerminalHandle>,
    private readonly config: Config,
  ) {
    // Config boundary: a malformed entry fails the load loudly rather than
    // silently authorizing a hostname prefix at request time.
    for (const entry of config.trustedHosts) assertTrustedAuthority(entry)
  }

  /**
   * The browser-trust fence every exact `/api/terminal.*` route applies before
   * touching a shell — identical semantics to the connection plugin's `/api`
   * prefix gate, which exact routes bypass by dispatch precedence.
   * @param request - Node HTTP or Fetch request facts.
   * @returns true when the request may reach a terminal route.
   */
  trusted(request: IncomingMessage): boolean {
    return isTrustedApiRequest(request, this.config.trustedHosts)
  }

  /**
   * Spawn one plain user shell and register it for streaming.
   * @param cols - initial terminal column count requested by the client viewport.
   * @param rows - initial terminal row count requested by the client viewport.
   * @param reattach - optional id of a still-live session to adopt instead of
   * spawning: a page reload presents its cached id and resumes the same shell.
   * Unknown or already-exited ids fall through to a fresh spawn, so stale
   * caches self-heal within the same request.
   * @returns The minted or adopted session id.
   */
  async open(cols: number, rows: number, reattach?: TerminalGatewaySessionId): Promise<TerminalGatewaySessionId> {
    this.assertLive()
    if (reattach !== undefined) {
      const existing = this.sessions.get(reattach)
      // Adoption ignores the caller's geometry: the live PTY keeps its own
      // size, and the reattaching client resizes explicitly after replay.
      if (existing !== undefined) return existing.id
    }
    await this.reclaimCapacity()
    const id = TerminalGatewaySessionId(randomUUID())
    const handle = await this.spawnTerminal({
      argv: this.resolveShellArgv(),
      cwd: homedir(),
      rows,
      cols,
      graceMs: this.config.graceMs,
    })
    const record: GatewaySession = { id, handle, subscribers: new Set(), history: [], historyChars: 0, exited: false }
    this.sessions.set(id, record)
    handle.output.on('data', (chunk: Buffer) => {
      this.broadcast(record, chunk.toString('base64'))
    })
    handle.output.once('end', () => { this.finish(record) })
    handle.done.then(
      () => { this.finish(record) },
      // A live transport failure still ends every subscriber stream; the exit
      // reason is not modeled on the wire.
      () => { this.finish(record) },
    )
    return id
  }

  /**
   * Write raw keystroke text to one session's PTY input.
   * @param id - session to write to.
   * @param data - UTF-8 text delivered without implicit newline conversion.
   */
  async write(id: TerminalGatewaySessionId, data: string): Promise<void> {
    const record = this.require(id)
    await record.handle.write(data)
  }

  /**
   * Resize one session's PTY to the client viewport.
   * @param id - session to resize.
   * @param cols - new column count.
   * @param rows - new row count.
   */
  async resize(id: TerminalGatewaySessionId, cols: number, rows: number): Promise<void> {
    const record = this.require(id)
    await record.handle.resize(cols, rows)
  }

  /**
   * Terminate one session; its stream ends with an `exit` event.
   * @param id - session to terminate.
   */
  async close(id: TerminalGatewaySessionId): Promise<void> {
    const record = this.require(id)
    await record.handle.terminate()
    this.finish(record)
  }

  /**
   * Attach one SSE response to a session, replaying the retained output
   * history first so a reattaching consumer (a page reload) reconstructs the
   * scrollback before live chunks arrive.
   * @param req - the streaming request; its `close` detaches the writer.
   * @param res - the node:http response held open until session exit.
   * @param id - session to subscribe to.
   */
  stream(req: IncomingMessage, res: ServerResponse, id: TerminalGatewaySessionId): void {
    const record = this.require(id)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    // Flush immediately: a session with no pre-subscriber output would otherwise
    // hold the client's request open with no headers until the first PTY byte.
    res.flushHeaders()
    const send = (chunk: string | null): void => {
      // A supervisor cancel destroys (not ends) the captured stdio response;
      // a browser disconnect closes the socket under the node:http response.
      if (res.writableEnded || res.destroyed) return
      if (chunk === null) {
        res.write('event: exit\ndata: {}\n\n')
        res.end()
        return
      }
      res.write(`data: ${chunk}\n\n`)
    }
    // Snapshot: broadcast during iteration would mutate the array under the loop.
    for (const chunk of [...record.history]) send(chunk)
    record.subscribers.add(send)
    // Both halves detach: node:http fires 'close' on either side, while the
    // stdio carrier can only surface cancellation through the response.
    const detach = (): void => { record.subscribers.delete(send) }
    req.once('close', detach)
    res.once('close', detach)
  }

  /**
   * Terminate every live session (plugin disposal); resolves when all settle.
   */
  async dispose(): Promise<void> {
    this.disposing = true
    await Promise.allSettled([...this.sessions.values()].map(record => record.handle.terminate()))
    for (const record of [...this.sessions.values()]) this.finish(record)
  }

  private resolveShellArgv(): readonly string[] {
    // Schemastery normalizes an absent `shell` to []; only a non-empty
    // override pins argv, anything else resolves from the environment.
    if (this.config.shell !== undefined && this.config.shell.length > 0) return this.config.shell
    const fromEnv = process.env.SHELL
    if (fromEnv !== undefined && fromEnv !== '') return [fromEnv]
    return [process.platform === 'darwin' ? '/bin/zsh' : process.platform === 'win32' ? 'powershell.exe' : '/bin/bash']
  }

  private require(id: TerminalGatewaySessionId): GatewaySession {
    const record = this.sessions.get(id)
    if (record === undefined) throw new GatewayError('unknown terminal session', 404)
    return record
  }

  private assertLive(): void {
    if (this.disposing) throw new GatewayError('terminal gateway is disposing', 503)
  }

  /**
   * Make room for one more session under `maxSessions`: terminate the oldest
   * detached sessions first (insertion order), since a closed tab can never
   * come back for them. A ceiling with every session still attached fails
   * loud — silent unbounded growth is the alternative.
   */
  private async reclaimCapacity(): Promise<void> {
    while (this.sessions.size >= this.config.maxSessions) {
      const orphan = [...this.sessions.values()].find(record => record.subscribers.size === 0)
      if (orphan === undefined) {
        throw new GatewayError(`terminal gateway has ${this.config.maxSessions} attached sessions; close one before opening another`, 503)
      }
      await orphan.handle.terminate()
      this.finish(orphan)
    }
  }

  private broadcast(record: GatewaySession, chunk: string): void {
    // Every chunk is retained for future attaching streams, whether or not
    // someone is listening right now.
    record.history.push(chunk)
    record.historyChars += chunk.length
    while (record.historyChars > MAX_HISTORY_CHARS && record.history.length > 0) {
      // shift() under length > 0 always yields a retained chunk; a definedness
      // guard here would be an uncoverable branch under the per-file gate.
      const dropped = record.history.shift() as string
      record.historyChars -= dropped.length
    }
    if (record.subscribers.size > 0) {
      for (const send of record.subscribers) send(chunk)
    }
  }

  private finish(record: GatewaySession): void {
    if (record.exited) return
    record.exited = true
    this.sessions.delete(record.id)
    for (const send of record.subscribers) send(null)
    record.subscribers.clear()
  }
}

/** Error carrying the HTTP status a route must answer with. */
export class GatewayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GatewayError'
  }
}

/**
 * Read and parse one JSON request body under the fixed size bound.
 * @param req - the incoming request.
 * @returns The parsed JSON value.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new GatewayError('request body too large', 413)
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new GatewayError('request body must be valid JSON', 400)
  }
}

/** Fail-loud body field extraction: numbers must be positive integers, strings non-empty. */
function requireFields(body: unknown, ...names: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw new GatewayError('request body must be an object', 400)
  const record = body as Record<string, unknown>
  for (const name of names) {
    const value = record[name]
    const ok = typeof value === 'string' ? value !== '' : typeof value === 'number' && Number.isInteger(value) && value > 0
    if (!ok) throw new GatewayError(`field '${name}' is required`, 400)
  }
  return record
}

/** Route answer helper: JSON success or the GatewayError's status. */
async function answer(res: ServerResponse, handler: () => Promise<string>): Promise<void> {
  try {
    const body = await handler()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  } catch (error) {
    const status = error instanceof GatewayError ? error.status : 500
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end(error instanceof Error ? error.message : 'internal error')
  }
}

/**
 * Build the five gateway routes over one gateway instance.
 * @param gateway - the spawn + fan-out core.
 * @returns Exact-path route registrations for the webserver.
 */
export function createRoutes(gateway: TerminalGateway): WebRoute[] {
  const unary = (
    path: string,
    run: (body: unknown) => Promise<string>,
  ): WebRoute => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!gateway.trusted(req)) { res.writeHead(403); res.end('forbidden'); return }
      await answer(res, async () => run(await readJson(req)))
    },
  })

  return [
    unary('/api/terminal.open', async (body) => {
      const fields = requireFields(body, 'cols', 'rows')
      // An absent session field spawns; a present id adopts when still alive.
      let reattach: TerminalGatewaySessionId | undefined
      if (fields.session !== undefined && fields.session !== null) {
        if (typeof fields.session !== 'string' || fields.session === '') {
          throw new GatewayError("field 'session' must be a session id", 400)
        }
        reattach = TerminalGatewaySessionId(fields.session)
      }
      const session = await gateway.open(fields.cols as number, fields.rows as number, reattach)
      return JSON.stringify({ session })
    }),
    unary('/api/terminal.write', async (body) => {
      const fields = requireFields(body, 'session')
      if (typeof fields.data !== 'string') throw new GatewayError("field 'data' is required", 400)
      const payload = Buffer.from(fields.data, 'utf8')
      if (payload.length > MAX_WRITE_BYTES) throw new GatewayError('write exceeds the payload bound', 413)
      await gateway.write(TerminalGatewaySessionId(fields.session as string), fields.data)
      return '{}'
    }),
    unary('/api/terminal.resize', async (body) => {
      const fields = requireFields(body, 'session', 'cols', 'rows')
      await gateway.resize(TerminalGatewaySessionId(fields.session as string), fields.cols as number, fields.rows as number)
      return '{}'
    }),
    unary('/api/terminal.close', async (body) => {
      const fields = requireFields(body, 'session')
      await gateway.close(TerminalGatewaySessionId(fields.session as string))
      return '{}'
    }),
    {
      kind: 'exact',
      path: '/api/terminal.stream',
      handler: (req, res) => {
        if (!gateway.trusted(req)) { res.writeHead(403); res.end('forbidden'); return }
        const url = new URL(req.url ?? '/', 'http://gateway.invalid')
        const session = url.searchParams.get('session')
        if (session === null || session === '') throw new GatewayError("query parameter 'session' is required", 400)
        try {
          gateway.stream(req, res, TerminalGatewaySessionId(session))
        } catch (error) {
          const status = error instanceof GatewayError ? error.status : 500
          res.writeHead(status, { 'content-type': 'text/plain' })
          res.end(error instanceof Error ? error.message : 'internal error')
        }
      },
    },
  ]
}

/** Cordis injection keys: the HTTP carrier and the PTY seam. */
export const inject = ['webServer', 'subprocess']

/**
 * Register the terminal gateway routes; disposal unregisters them and
 * terminates every live shell session.
 * @param ctx - cordis context providing `webServer` and `subprocess`.
 * @param config - validated gateway configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const gateway = new TerminalGateway(
    spec => ctx.subprocess.spawnTerminal({ ...spec, signal: undefined, env: undefined }),
    config,
  )
  ctx.effect(() => {
    const unregister = createRoutes(gateway).map(route => ctx.webServer.register(route))
    return async () => {
      for (const off of unregister) off()
      // Await settlement: process exit must not race the shells' TERM→KILL
      // escalation into orphaned processes.
      await gateway.dispose()
    }
  })
}
