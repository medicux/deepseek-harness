import { useEffect, useRef } from 'react'
// Static xterm imports: a runtime dynamic import makes the bundler split
// sibling chunks whose relative requires cannot resolve through the client
// module table.
import { Terminal } from '@xterm/xterm'
import { readDesktopCarrierBridge, sseDataPayload, sseEventName } from '@deepseek-ai/dsh-client-connection/client'
import type { DesktopCarrierBridge } from '@deepseek-ai/dsh-client-connection/client'
import { FitAddon } from '@xterm/addon-fit'
import type { ITerminalOptions } from '@xterm/xterm'

/** Owner share of ui-layout's `workbench` slot plus no injected services. */
export interface TerminalPanelProps {
  collapsed: boolean
  width: number
}

/**
 * Read the teardown flag through a call: async setup races the cleanup
 * closures, and a direct property test narrows the holder to never-true.
 * @param holder - the component-scoped destroyed flag.
 * @returns whether the subtree was destroyed.
 */
function isDestroyed(holder: { current: boolean }): boolean {
  return holder.current
}

/** Structural byte source both DOM reader and Node stream typings satisfy. */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
}

/** Parsed SSE frame: an optional event name and its single-line data payload. */
export interface SseFrame {
  event: string | undefined
  data: string
}

/** Parse one SSE frame stream into base64 data payloads and named events. */
async function* sseFrames(body: ByteReader): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder()
  let buffered = ''
  for (;;) {
    const { done, value } = await body.read()
    if (done) return
    buffered += decoder.decode(value, { stream: true })
    let separator = buffered.indexOf('\n\n')
    while (separator !== -1) {
      const frame = buffered.slice(0, separator)
      buffered = buffered.slice(separator + 2)
      const lines = frame.split('\n')
      const eventLine = lines.find(line => line.startsWith('event: '))
      const data = lines.find(line => line.startsWith('data: '))?.slice(6)
      if (data !== undefined) yield { event: eventLine?.slice(7), data }
      separator = buffered.indexOf('\n\n')
    }
  }
}

/** sessionStorage key carrying this panel's session id across page reloads; per-tab by web-standards scope. */
export const SESSION_CACHE_KEY = 'dsh.terminal-gateway.workbench-session'

/**
 * Read the cached session id to reattach after a reload, when storage is
 * usable at all.
 * @returns the cached id, or undefined on a first visit or unusable storage.
 */
function cachedSession(): string | undefined {
  if (typeof sessionStorage === 'undefined') return undefined
  try {
    return sessionStorage.getItem(SESSION_CACHE_KEY) ?? undefined
  } catch {
    // Storage access denied (privacy mode, embedded carriage): reload
    // persistence degrades to fresh sessions.
    return undefined
  }
}

/**
 * Cache the session id this panel now owns.
 * @param session - the id returned by `/api/terminal.open`.
 */
function rememberSession(session: string): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(SESSION_CACHE_KEY, session)
  } catch {
    // Quota or denial: same degradation as cachedSession.
  }
}

/** Drop the cache entry; called only when ownership ends deliberately. */
function forgetSession(): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(SESSION_CACHE_KEY)
  } catch {
    // Denial: nothing cached is reachable anyway.
  }
}

/** One answered unary request: status plus a parsed-on-demand JSON body. */
interface TransportResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

/** Read the desktop bridge when this page runs inside the shell. */
function carrierBridge(): DesktopCarrierBridge | undefined {
  return readDesktopCarrierBridge()
}

/**
 * Answer one terminal unary route through whichever transport this page has:
 * the desktop IPC carrier inside the shell, same-origin fetch in a browser.
 * @param path - API path beginning `/api/terminal.`.
 * @param body - JSON payload.
 * @param options - abort signal and unload-keepalive switches.
 * @returns status plus a lazily parsed JSON body.
 */
async function postTerminal(
  path: string,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<TransportResponse> {
  const payload = JSON.stringify(body)
  const bridge = carrierBridge()
  if (bridge !== undefined) {
    // The carrier needs no keepalive: the request rides the shell's already-
    // open IPC channel, not this document's network stack.
    const answer = await bridge.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
    return { ok: answer.status === 200, status: answer.status, json: () => Promise.resolve(JSON.parse(answer.body) as unknown) }
  }
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.keepalive === true ? { keepalive: true } : {}),
  })
  return { ok: response.ok, status: response.status, json: () => response.json() }
}

/**
 * Close one gateway session the panel can no longer own: mid-open abandonment
 * and final subtree destruction both end here. The cache entry dies with the
 * ownership — a dead id would only cost a fall-through spawn later.
 * @param session - the orphaned gateway session.
 */
function closeSession(session: string): void {
  forgetSession()
  // Best effort across page unload: the browser-transport request must not
  // need this document to outlive the navigation.
  void postTerminal('/api/terminal.close', { session }, { keepalive: true }).catch(() => undefined)
}

/**
 * The workbench terminal panel. Binds one gateway session per panel lifetime:
 * closing the column only hides the view — the PTY, its scrollback, and the
 * output stream stay live, so reopening resumes the same shell. A full page
 * reload resumes it too: the session id rides sessionStorage and
 * `/api/terminal.open` adopts the live shell, whose detached output arrives
 * as replay into the fresh emulator. A session ends when its shell exits;
 * the next expansion then spawns a fresh one. The final subtree destruction
 * closes the session the panel still owns.
 */
export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  // Collapse toggles re-run the effect, so the run that owns the live
  // resources registers them here where every later cleanup reaches them.
  const started = useRef(false)
  const destroyed = useRef(false)
  const dead = useRef(false)
  const activeSession = useRef<string | undefined>(undefined)
  const activeDispose = useRef<(() => void) | undefined>(undefined)
  // Definition-order cleanup guarantees this runs before the main effect's
  // cleanup sees the unmount.
  useEffect(() => () => { destroyed.current = true }, [])
  useEffect(() => {
    // Runs on every collapse toggle. Each run hands back this teardown even
    // when it spawns nothing: a guard-only run must still leave a cleanup
    // behind so a later flip can react to an exit that happened while the
    // column stayed expanded, and to the final unmount.
    const teardown = (): void => {
      // Collapse keeps the whole stack alive — PTY, scrollback, and stream —
      // so reopening resumes the same shell.
      if (!destroyed.current && !dead.current) return
      activeDispose.current?.()
      activeDispose.current = undefined
      if (!destroyed.current) {
        // The shell exited while expanded: dispose the corpse now and let the
        // next expansion spawn a fresh session. The gateway already removed
        // the exited session, so there is nothing left to close.
        activeSession.current = undefined
        started.current = false
        return
      }
      const session = activeSession.current
      activeSession.current = undefined
      if (session !== undefined) closeSession(session)
    }

    const host = hostRef.current
    // First expansion only: a panel that never opened spawns nothing, and a
    // transiently zero-measured host defers startup to the next toggle.
    if (props.collapsed || started.current || host === null || host.clientWidth === 0) return teardown
    started.current = true
    dead.current = false

    void (async () => {
      try {
        // A cached id turns the open into an adopt: the gateway returns the
        // live session for a reload, or spawns fresh when the id is stale.
        const reattach = cachedSession()
        const openResponse = await postTerminal(
          '/api/terminal.open',
          reattach === undefined ? { cols: 80, rows: 24 } : { cols: 80, rows: 24, session: reattach },
        )
        if (!openResponse.ok || isDestroyed(destroyed)) {
          // A refused open must not wedge the panel: re-arm so a later
          // expansion retries instead of finding `started` forever true.
          if (!isDestroyed(destroyed)) started.current = false
          return
        }
        const body: unknown = await openResponse.json()
        const session = (body as { session: string }).session
        if (isDestroyed(destroyed)) {
          // Subtree destroyed mid-open: close the spawned shell nobody owns.
          closeSession(session)
          return
        }
        rememberSession(session)
        activeSession.current = session

        const abort = new AbortController()
        // Unary posts serialize through one chain: HTTP gives no ordering
        // across connections, and an older resize landing last would leave
        // the PTY's winsize desynchronized from the emulator.
        let unaryChain: Promise<void> = Promise.resolve()
        const post = (path: string, payload: Record<string, unknown>): void => {
          unaryChain = unaryChain
            .then(() => postTerminal(`/api/terminal.${path}`, { session, ...payload }, { signal: abort.signal }))
            .then(() => undefined, () => undefined) // A dying session surfaces through the stream's exit event.
        }

        const options: ITerminalOptions = { convertEol: false, cursorBlink: true }
        const term = new Terminal(options)
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(host)
        fit.fit()
        // The gateway spawned at its default geometry; the emulator fitted to
        // the real viewport usually differs. The first sync is unconditional,
        // and the observer's dedupe state starts from what the PTY has been
        // told — not from the emulator.
        const initial = fit.proposeDimensions()
        if (initial !== undefined && host.clientWidth > 0 && host.clientHeight > 0) {
          term.resize(initial.cols, initial.rows)
          post('resize', { cols: initial.cols, rows: initial.rows })
        }

        // Keystrokes forward verbatim; the PTY owns echo and line discipline.
        term.onData((data) => { post('write', { data }) })

        let lastCols = term.cols
        let lastRows = term.rows
        const observer = new ResizeObserver(() => {
          // A closed column measures zero and proposeDimensions clamps that to
          // its 2x1 floor; hold the PTY's last real geometry while hidden.
          if (host.clientWidth === 0 || host.clientHeight === 0) return
          const proposed = fit.proposeDimensions()
          if (proposed === undefined || (proposed.cols === lastCols && proposed.rows === lastRows)) return
          lastCols = proposed.cols
          lastRows = proposed.rows
          term.resize(proposed.cols, proposed.rows)
          post('resize', { cols: proposed.cols, rows: proposed.rows })
        })
        observer.observe(host)

        const streamAbort = new AbortController()
        activeDispose.current = () => {
          abort.abort()
          streamAbort.abort()
          observer.disconnect()
          term.dispose()
        }
        try {
          const bridge = carrierBridge()
          if (bridge !== undefined) {
            // Inside the desktop shell the stream rides the IPC carrier: the
            // pump forwards whole SSE blocks, so named events survive.
            const stream = bridge.openStream(`/api/terminal.stream?session=${encodeURIComponent(session)}`)
            activeDispose.current = (): void => {
              abort.abort()
              stream.abort()
              observer.disconnect()
              term.dispose()
            }
            stream.onFrame((block) => {
              const data = sseDataPayload(block)
              if (data === undefined) return
              if (sseEventName(block) === 'exit') {
                dead.current = true
                stream.abort()
                return
              }
              term.write(Uint8Array.from(atob(data), character => character.charCodeAt(0)))
            })
            stream.onEnd(() => {
              // A server-ended stream without an exit frame still ended the session.
              dead.current = true
            })
            return
          }
          const response = await fetch(`/api/terminal.stream?session=${encodeURIComponent(session)}`, { signal: streamAbort.signal })
          if (!response.body || isDestroyed(destroyed)) return
          for await (const frame of sseFrames(response.body.getReader())) {
            if (frame.event === 'exit') {
              dead.current = true
              return
            }
            term.write(Uint8Array.from(atob(frame.data), character => character.charCodeAt(0)))
          }
          // A server-ended stream without an exit frame still ended the session.
          dead.current = true
        } catch {
          // Aborted during teardown or a dropped transport; the exit path owns cleanup.
        }
      } catch {
        // Open-phase failures (network, non-JSON body) land here; re-arm the
        // startup gate so the next expansion retries instead of wedging.
        // Unary and transport failures carry no UI by design.
        if (!isDestroyed(destroyed)) started.current = false
      }
    })()
    return teardown
  }, [props.collapsed])

  return <div className="dsh-terminal-panel" style={{ width: '100%', height: '100%', padding: 4 }} ref={hostRef} />
}
