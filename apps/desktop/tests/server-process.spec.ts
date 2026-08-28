import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshServerProcess, type DshServerProcessOptions, type ServerExit } from '../src/server-process.ts'

/** The spawner shape {@link DshServerProcess} injects; tests substitute fakes. */
type SpawnImpl = typeof import('node:child_process').spawn

/** A fake output stream carrying just the members the supervisor touches. */
class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

/** A controllable fake child shaped like the members the supervisor touches. */
const noopStream = (): import('node:stream').Writable => new Writable({ write(_c, _e, done) { done() } })
const noopReadable = (): import('node:stream').Readable => new Readable({ read(): void {} })

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  /** fds 3/4 exist on every real spawn; the fake mirrors that shape. */
  readonly stdio = [null, this.stdout as unknown, this.stderr as unknown, noopStream(), noopReadable()]
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly killCalls: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals): boolean {
    this.killCalls.push(signal)
    return true
  }

  /** Simulate stream output. */
  write(stream: 'stdout' | 'stderr', chunk: string): void {
    this[stream].emit('data', chunk)
  }

  /** Simulate process end; a signal marks the child signal-killed. */
  exit(code?: number, signal?: NodeJS.Signals): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    if (signal === undefined) this.exitCode = code ?? 0
    else this.signalCode = signal
    this.emit('exit', signal === undefined ? (code ?? 0) : null, signal ?? null)
  }
}

/** Harness around one fake child: records spawn arguments, hands out the child. */
function createFakeSpawn(): { child: FakeChild; spawned: { program: string; args: string[] }[]; impl: SpawnImpl } {
  const child = new FakeChild()
  const spawned: { program: string; args: string[] }[] = []
  const impl = ((program: string, args: string[]) => {
    spawned.push({ program, args })
    return child as unknown as ChildProcess
  }) as unknown as SpawnImpl
  return { child, spawned, impl }
}

function start(overrides: Partial<DshServerProcessOptions>, impl: SpawnImpl): {
  server: DshServerProcess
  exits: ServerExit[]
} {
  const exits: ServerExit[] = []
  const defaults: DshServerProcessOptions = {
    command: ['dsh-fake', '--profile', 'web'],
    readyTimeoutMs: 5_000,
    killGraceMs: 20,
    spawnImpl: impl,
    onExit: (exit) => { exits.push(exit) },
  }
  const server = new DshServerProcess({ ...defaults, ...overrides })
  return { server, exits }}

afterEach(() => {
  vi.useRealTimers()
})

describe('DshServerProcess', () => {
  it('resolves the stdio carrier kind when the child prints the stdio readiness line', async () => {
    const { child, impl } = createFakeSpawn()
    const { server } = start({}, impl)
    const pending = server.start()
    expect(server.started).toBe(false)
    child.write('stdout', 'dsh web-stdio: ready\n')
    await expect(pending).resolves.toEqual({ kind: 'stdio' })
    expect(server.carrier).toBe('stdio')
    expect(server.started).toBe(true)
    expect(server.url).toBeUndefined()
    expect(server.framePipes).toBeDefined()
    // The frame channel materializes lazily over fds 3/4.
    expect(server.channel).toBeDefined()
  })

  it('reports post-readiness exits in stdio carrier mode too', async () => {
    const { child, impl } = createFakeSpawn()
    const { server, exits } = start({}, impl)
    const pending = server.start()
    child.write('stdout', 'dsh web-stdio: ready\n')
    await pending
    child.exit(1)
    // The shell's unexpected-exit dialog keys on this report; a stdio child
    // has no URL, so readiness itself must gate the report.
    expect(exits).toEqual([{ code: 1, signal: null }])
  })

  it('resolves with the readiness URL and reports later exits', async () => {
    const { child, impl } = createFakeSpawn()
    const { server, exits } = start({}, impl)
    const pending = server.start()
    child.write('stdout', 'booting\n')
    expect(server.url).toBeUndefined()
    child.write('stdout', 'dsh web: http://127.0.0.1:4310\n')
    await expect(pending).resolves.toEqual({ kind: 'tcp', url: 'http://127.0.0.1:4310' })
    expect(server.started).toBe(true)
    expect(exits).toEqual([])
    child.exit(0)
    expect(exits).toEqual([{ code: 0, signal: null }])
    await expect(server.stop()).resolves.toBeUndefined()
    expect(child.killCalls).toEqual([])
  })

  it('mirrors every output chunk to the onOutput sink', async () => {
    const { child, impl } = createFakeSpawn()
    const seen: string[] = []
    const { server } = start({ onOutput: (chunk) => { seen.push(chunk) } }, impl)
    const pending = server.start()
    child.write('stdout', 'booting\n')
    child.write('stderr', 'warn: slow disk\n')
    child.write('stdout', 'dsh web: http://127.0.0.1:4311\n')
    await expect(pending).resolves.toEqual({ kind: 'tcp', url: 'http://127.0.0.1:4311' })
    expect(seen).toEqual(['booting\n', 'warn: slow disk\n', 'dsh web: http://127.0.0.1:4311\n'])
  })

  it('rejects with the output tail when the child dies before readiness', async () => {
    const { child, impl } = createFakeSpawn()
    const { server } = start({}, impl)
    const pending = server.start()
    child.write('stderr', 'config parse failed loudly\n')
    child.exit(2)
    await expect(pending).rejects.toThrow(/exited before readiness[\s\S]*config parse failed loudly/u)
  })

  it('rejects and stops the child when readiness never arrives', async () => {
    vi.useFakeTimers()
    const { child, impl } = createFakeSpawn()
    const { server } = start({ readyTimeoutMs: 1_000 }, impl)
    const failure = expect(server.start()).rejects.toThrow(/no readiness line within 1000ms/u)
    await vi.advanceTimersByTimeAsync(1_001)
    await failure
    expect(child.killCalls).toContain('SIGTERM')
  })

  it('escalates SIGTERM to SIGKILL after the grace period', async () => {
    const { child, impl } = createFakeSpawn()
    const { server } = start({ killGraceMs: 5 }, impl)
    const pending = server.start()
    child.write('stdout', 'dsh web: http://127.0.0.1:4311\n')
    await pending
    const stopping = server.stop()
    expect(child.killCalls).toEqual(['SIGTERM'])
    await new Promise((resolve) => { setTimeout(resolve, 15) })
    expect(child.killCalls).toEqual(['SIGTERM', 'SIGKILL'])
    child.exit(undefined, 'SIGKILL')
    await stopping
    expect(child.signalCode).toBe('SIGKILL')
  })

  it('gives up reaping an unkillable child instead of hanging quit', async () => {
    vi.useFakeTimers()
    const { child, impl } = createFakeSpawn()
    const { server } = start({ killGraceMs: 5 }, impl)
    const pending = server.start()
    child.write('stdout', 'dsh web: http://127.0.0.1:4314\n')
    await pending
    // The child never exits: SIGKILL cannot reap a process parked in an
    // uninterruptible kernel wait, and stop() must not wait forever on it.
    const stopping = server.stop()
    await vi.advanceTimersByTimeAsync(10)
    expect(child.killCalls).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(stopping).resolves.toBeUndefined()
  })

  it('stops gracefully within the grace period without escalating', async () => {
    const { child, impl } = createFakeSpawn()
    const { server } = start({ killGraceMs: 5 }, impl)
    const pending = server.start()
    child.write('stdout', 'dsh web: http://127.0.0.1:4312\n')
    await pending
    const stopping = server.stop()
    child.exit(0)
    await stopping
    expect(child.killCalls).toEqual(['SIGTERM'])
  })

  it('collapses concurrent stop calls into one escalation sequence', async () => {
    const { child, impl } = createFakeSpawn()
    const { server } = start({ killGraceMs: 5 }, impl)
    const pending = server.start()
    child.write('stdout', 'dsh web: http://127.0.0.1:4313\n')
    await pending
    const stopping = Promise.all([server.stop(), server.stop(), server.stop()])
    child.exit(0)
    await stopping
    expect(child.killCalls).toEqual(['SIGTERM'])
  })

  it('rejects a start issued after stop was requested', async () => {
    const { impl } = createFakeSpawn()
    const { server } = start({}, impl)
    const stopping = server.stop()
    await expect(server.start()).rejects.toThrow(/stopped before readiness/u)
    await stopping
  })

  it('rejects immediately when the spawner throws', async () => {
    const throwing = (() => { throw new Error('enoent') }) as unknown as SpawnImpl
    const { server } = start({}, throwing)
    await expect(server.start()).rejects.toThrow(/spawn failed.*enoent/u)
  })
})
