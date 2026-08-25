// @vitest-environment jsdom
/**
 * TerminalPanel session lifetime: one gateway session per panel lifetime —
 * collapsing the workbench column only hides the view (the PTY, scrollback,
 * and stream stay live), a exited shell resets on the next expansion, and the
 * final subtree destruction closes the owned session. @xterm is stubbed so no
 * canvas work runs; fetch and ResizeObserver are test doubles.
 */
import { cleanup, render } from '@testing-library/react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_CACHE_KEY, TerminalPanel } from '@deepseek-ai/dsh-client-ui-terminal/client'

interface CallRecord {
  path: string
  payload: Record<string, unknown>
  keepalive: boolean
}

const { mockTerminal, mockFitAddon, fitHarness } = vi.hoisted(() => {
  const fitHarness = { proposal: undefined as { cols: number; rows: number } | undefined }

  /** One terminal emulator double; captures write/resize/dispose evidence.
   * The `mock` prefix lets the vi.mock factories below reference it safely. */
  class mockTerminal {
    static instances: mockTerminal[] = []
    cols = 80
    rows = 24
    disposed = false
    written: Uint8Array[] = []
    private dataHandler: ((data: string) => void) | undefined
    constructor(public options: unknown) {
      mockTerminal.instances.push(this)
    }

    loadAddon(): void {}
    open(): void {}

    /** Register the keystroke forwarder the panel installs. */
    onData(handler: (data: string) => void): { dispose(): void } {
      this.dataHandler = handler
      return { dispose: () => { this.dataHandler = undefined } }
    }

    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }

    write(data: Uint8Array): void {
      this.written.push(data)
    }

    dispose(): void {
      this.disposed = true
    }

    /** Simulate user keystrokes through the registered forwarder. */
    type(data: string): void {
      this.dataHandler?.(data)
    }
  }

  /** Fit addon double whose proposal the test pins per scenario. */
  class mockFitAddon {
    loadAddon(): void {}
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } | undefined {
      return fitHarness.proposal
    }
  }

  return { mockTerminal, mockFitAddon, fitHarness }
})

let hostWidth = 0

/** ResizeObserver double; the panel's observer fires only from tests. */
class FakeResizeObserver {
  static latest: FakeResizeObserver | undefined
  disconnected = false
  constructor(private readonly callback: () => void) {}

  observe(): void {
    FakeResizeObserver.latest = this
  }

  disconnect(): void {
    this.disconnected = true
  }

  /** Fire the observed callback with the current stubbed measurements. */
  flush(): void {
    if (!this.disconnected) this.callback()
  }
}

/** Manual SSE body: tests push whole frames; reads park until one arrives. */
class MockStreamBody {
  private queue: { done: false; value: Uint8Array }[] = []
  private pending: ((read: { done: boolean; value?: Uint8Array }) => void) | undefined

  readonly reader = {
    read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
      const next = this.queue.shift()
      if (next !== undefined) return Promise.resolve(next)
      return new Promise((resolve) => { this.pending = resolve })
    },
  }

  /** Deliver one complete SSE frame. */
  push(text: string): void {
    const chunk = { done: false as const, value: new TextEncoder().encode(text) }
    const parked = this.pending
    if (parked !== undefined) {
      this.pending = undefined
      parked(chunk)
      return
    }
    this.queue.push(chunk)
  }
}

vi.mock('@xterm/xterm', () => ({ Terminal: mockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: mockFitAddon }))

describe('TerminalPanel session lifetime', () => {
  let calls: CallRecord[]
  let streams: Map<string, MockStreamBody>
  let sessions: string[]
  let fetchMock: ReturnType<typeof vi.fn>
  // Gateway-faithful liveness: only these ids answer an adopt request.
  const live = new Set<string>()

  /** The POST bodies recorded for one route path suffix, e.g. 'close'. */
  const callsTo = (path: string): CallRecord[] => calls.filter(call => call.path === `/api/terminal.${path}`)

  beforeEach(() => {
    mockTerminal.instances = []
    FakeResizeObserver.latest = undefined
    fitHarness.proposal = { cols: 80, rows: 24 }
    sessions = []
    live.clear()
    streams = new Map()
    calls = []
    sessionStorage.clear()
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = rawUrl.replace(/^https?:\/\/[^/]+/, '')
      const payload = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      calls.push({ path, payload, keepalive: (init as { keepalive?: boolean }).keepalive === true })
      if (path === '/api/terminal.open') {
        const requested = typeof payload.session === 'string' ? payload.session : undefined
        if (requested !== undefined && live.has(requested)) {
          return { ok: true, json: async () => ({ session: requested }) } as unknown as Response
        }
        const session = `sess-${sessions.length + 1}`
        sessions.push(session)
        live.add(session)
        return { ok: true, json: async () => ({ session }) } as unknown as Response
      }
      if (path.startsWith('/api/terminal.stream')) {
        const stream = new MockStreamBody()
        const requested = new URL(rawUrl, 'http://panel.invalid').searchParams.get('session') ?? ''
        streams.set(requested, stream)
        return { ok: true, body: { getReader: () => stream.reader } } as unknown as Response
      }
      if (path === '/api/terminal.close') live.delete(String(payload.session))
      return { ok: true, json: async () => ({}) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    hostWidth = 0
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => hostWidth)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 800)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('spawns once at first expansion and keeps the session alive across collapse', async () => {
    const view = render(<TerminalPanel collapsed width={0} />)
    await Promise.resolve()
    expect(calls).toEqual([]) // A never-opened column spawns nothing.

    hostWidth = 640
    view.rerender(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(mockTerminal.instances.length).toBe(1) })
    await vi.waitFor(() => { expect(callsTo('open')).toHaveLength(1) })
    const openBody = callsTo('open')[0]!.payload
    expect(openBody).toEqual({ cols: 80, rows: 24 })

    // Collapse: no close request, no teardown of the live stack.
    hostWidth = 0
    view.rerender(<TerminalPanel collapsed width={0} />)
    await Promise.resolve()
    expect(callsTo('close')).toEqual([])
    expect(mockTerminal.instances[0]!.disposed).toBe(false)

    // Re-expand: the same session continues; no second spawn.
    hostWidth = 640
    view.rerender(<TerminalPanel collapsed={false} width={640} />)
    await Promise.resolve()
    expect(callsTo('open')).toHaveLength(1)
    expect(sessions).toEqual(['sess-1'])

    // Keystrokes still reach the surviving session after the round trip.
    mockTerminal.instances[0]!.type('ls\n')
    await vi.waitFor(() => { expect(callsTo('write')).toHaveLength(1) })
    expect(callsTo('write')[0]!.payload).toMatchObject({ session: 'sess-1', data: 'ls\n' })

    // Output streamed while hidden lands in the surviving emulator.
    streams.get('sess-1')!.push('data: aGk=\n\n')
    await vi.waitFor(() => { expect(mockTerminal.instances[0]!.written).toHaveLength(1) })

    view.unmount()
  })

  it('syncs the fitted geometry to the PTY once at startup and holds it while the column measures zero', async () => {
    hostWidth = 640
    fitHarness.proposal = { cols: 96, rows: 30 }
    const view = render(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(streams.size).toBe(1) })

    // The gateway spawned at its default 80x24; the emulator fitted to 640px
    // differs, so startup pushes one unconditional resize before any
    // observer tick.
    await vi.waitFor(() => { expect(callsTo('resize')).toHaveLength(1) })
    await Promise.resolve()
    expect(callsTo('resize')[0]!.payload).toEqual({ session: 'sess-1', cols: 96, rows: 30 })
    expect(mockTerminal.instances[0]!.cols).toBe(96)

    // Collapsed measurement: proposeDimensions would clamp to its 2x1 floor;
    // the observer must not push that onto the PTY.
    hostWidth = 0
    fitHarness.proposal = { cols: 2, rows: 1 }
    FakeResizeObserver.latest!.flush()
    expect(callsTo('resize')).toHaveLength(1)
    expect(mockTerminal.instances[0]!.cols).toBe(96)

    // A changed expansion geometry flows through again, exactly once more.
    hostWidth = 500
    fitHarness.proposal = { cols: 64, rows: 20 }
    FakeResizeObserver.latest!.flush()
    // Unary posts serialize through a promise chain: give the tick a beat.
    await vi.waitFor(() => { expect(callsTo('resize')).toHaveLength(2) })
    expect(callsTo('resize')[1]!.payload).toEqual({ session: 'sess-1', cols: 64, rows: 20 })
    expect(mockTerminal.instances[0]!.cols).toBe(64)

    view.unmount()
  })

  it('a refused open re-arms the panel so a later expansion retries', async () => {
    // The once-override answers before the recording base implementation,
    // so the refused open intentionally leaves no recorded call.
    // A one-shot 503: the panel must re-arm instead of staying stuck.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
    hostWidth = 640
    const view = render(<TerminalPanel collapsed={false} width={640} />)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(sessions).toEqual([])
    expect(streams.size).toBe(0)

    // The retry expansion spawns fresh instead of finding `started` stuck.
    hostWidth = 480
    view.rerender(<TerminalPanel collapsed width={480} />)
    await Promise.resolve()
    view.rerender(<TerminalPanel collapsed={false} width={480} />)
    await vi.waitFor(() => { expect(streams.size).toBe(1) })

    view.unmount()
  })

  it('respawns a fresh session on the next expansion after the shell exits', async () => {
    hostWidth = 640
    const view = render(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(streams.size).toBe(1) })

    streams.get('sess-1')!.push('event: exit\ndata: {}\n\n')
    live.delete('sess-1')
    // Let the stream loop process the exit frame while still expanded, the
    // way a real shell exit precedes any collapse.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // Collapse disposes the corpse immediately; nothing closes server-side
    // because the gateway already removed the exited session.
    hostWidth = 0
    view.rerender(<TerminalPanel collapsed width={0} />)
    await vi.waitFor(() => { expect(mockTerminal.instances[0]!.disposed).toBe(true) })
    expect(callsTo('close')).toEqual([])

    hostWidth = 640
    view.rerender(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(mockTerminal.instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(sessions).toEqual(['sess-1', 'sess-2']) })
    expect(mockTerminal.instances[1]!.disposed).toBe(false)

    view.unmount()
    expect(callsTo('close')).toEqual([{ path: '/api/terminal.close', payload: { session: 'sess-2' }, keepalive: true }])
  })

  it('still reacts to an exit that happened across later guard-only flips', async () => {
    hostWidth = 640
    const view = render(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(mockTerminal.instances).toHaveLength(1) })

    // Two flip cycles after setup: every intervening run is guard-only and
    // must still leave the shared teardown registered.
    hostWidth = 0
    view.rerender(<TerminalPanel collapsed width={0} />)
    view.rerender(<TerminalPanel collapsed={false} width={640} />)
    view.rerender(<TerminalPanel collapsed width={0} />)
    view.rerender(<TerminalPanel collapsed={false} width={640} />)
    expect(callsTo('open')).toHaveLength(1)

    // The shell exits while expanded; the next collapse disposes the corpse
    // even though no run since setup owned resources.
    streams.get('sess-1')!.push('event: exit\ndata: {}\n\n')
    live.delete('sess-1')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    hostWidth = 0
    view.rerender(<TerminalPanel collapsed width={0} />)
    await vi.waitFor(() => { expect(mockTerminal.instances[0]!.disposed).toBe(true) })
    expect(callsTo('close')).toEqual([])

    hostWidth = 640
    view.rerender(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(mockTerminal.instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(sessions).toEqual(['sess-1', 'sess-2']) })

    view.unmount()
    expect(callsTo('close')).toEqual([{ path: '/api/terminal.close', payload: { session: 'sess-2' }, keepalive: true }])
  })

  it('a reload resumes the cached session by adoption instead of spawning', async () => {
    sessionStorage.setItem(SESSION_CACHE_KEY, 'sess-alive')
    live.add('sess-alive')
    hostWidth = 640
    const view = render(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(streams.get('sess-alive')?.reader).toBeDefined() })
    expect(callsTo('open')).toHaveLength(1)
    expect(callsTo('open')[0]!.payload).toEqual({ cols: 80, rows: 24, session: 'sess-alive' })
    expect(sessions).toEqual([])

    // Output buffered while the page was away lands in the resumed emulator.
    streams.get('sess-alive')!.push('data: aGk=\n\n')
    await vi.waitFor(() => { expect(mockTerminal.instances[0]!.written).toHaveLength(1) })

    view.unmount()
    expect(callsTo('close')).toEqual([{ path: '/api/terminal.close', payload: { session: 'sess-alive' }, keepalive: true }])
  })

  it('a stale cached id falls through to a fresh spawn and updates the cache', async () => {
    sessionStorage.setItem(SESSION_CACHE_KEY, 'sess-stale')
    hostWidth = 640
    const view = render(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(streams.size).toBe(1) })
    expect(callsTo('open')[0]!.payload).toEqual({ cols: 80, rows: 24, session: 'sess-stale' })
    expect(sessions).toEqual(['sess-1'])
    expect(sessionStorage.getItem(SESSION_CACHE_KEY)).toBe('sess-1')

    view.unmount()
    expect(callsTo('close')).toEqual([{ path: '/api/terminal.close', payload: { session: 'sess-1' }, keepalive: true }])
    expect(sessionStorage.getItem(SESSION_CACHE_KEY)).toBeNull()
  })

  it('closes the owned session when the subtree is destroyed', async () => {
    hostWidth = 640
    const view = render(<TerminalPanel collapsed={false} width={640} />)
    await vi.waitFor(() => { expect(streams.size).toBe(1) })

    view.unmount()
    expect(callsTo('close')).toEqual([{ path: '/api/terminal.close', payload: { session: 'sess-1' }, keepalive: true }])
    expect(mockTerminal.instances[0]!.disposed).toBe(true)
  })
})
