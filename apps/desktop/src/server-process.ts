/**
 * Supervisor for the desktop shell's `dsh web` child process.
 *
 * One instance owns exactly one child: it spawns the resolved launch target,
 * detects readiness through the web surface's stdout URL line, hands startup
 * failures and post-readiness exits to the caller with a diagnostics tail,
 * and stops the child with bounded escalation (SIGTERM, then SIGKILL after a
 * grace period). The child's own signal handling performs the harness
 * disposal — this class only owns the process lifetime, never the tree's.
 * @module @deepseek-ai/dsh-desktop/server-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { FrameChannel } from './frames.ts'
import { extractReadyUrl, hasStdioReadyLine } from './readiness.ts'

/** Default budget for the readiness line after spawn. */
const DEFAULT_READY_TIMEOUT_MS = 120_000
/** Default SIGTERM→SIGKILL escalation delay in {@link DshServerProcess.stop}. */
const DEFAULT_KILL_GRACE_MS = 5_000
/** Upper bound on stdout retained for readiness scanning; boot logs cannot reach this. */
const MAX_CAPTURE_CHARS = 1 << 20
/** Lines of combined output kept for failure diagnostics. */
const DIAGNOSTIC_TAIL_LINES = 40

/** What {@link DshServerProcessOptions.onExit} reports about the child's end. */
export interface ServerExit {
  /** Exit code, or `null` when a signal terminated the child. */
  code: number | null
  /** Terminating signal name, or `null` on an ordinary exit. */
  signal: NodeJS.Signals | null
}

/** Options for {@link DshServerProcess}. */
export interface DshServerProcessOptions {
  /** Spawn-style command: program plus arguments, no shell. */
  command: readonly string[]
  /** Working directory handed to the child; defaults to the current directory. */
  cwd?: string
  /** Environment handed to the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * Fail {@link DshServerProcess.start} when no readiness line arrives within
   * this budget. Defaults to {@link DEFAULT_READY_TIMEOUT_MS}.
   */
  readyTimeoutMs?: number
  /**
   * How long {@link DshServerProcess.stop} waits after SIGTERM before
   * escalating to SIGKILL. Defaults to {@link DEFAULT_KILL_GRACE_MS}.
   */
  killGraceMs?: number
  /** Injectable spawner; tests substitute a fake. Defaults to `node:child_process` spawn. */
  spawnImpl?: typeof spawn
  /**
   * Receives every decoded stdout/stderr chunk as the child emits it. The
   * shell uses this to mirror server output into a log file so packaged
   * builds stay diagnosable without a launching terminal.
   */
  onOutput?: (chunk: string) => void
  /** Called once when the child exits after readiness was reported. */
  onExit?: (exit: ServerExit) => void
}

/** The outcome of one successful {@link DshServerProcess.start}. */
export type ServerReady = { kind: 'tcp'; url: string } | { kind: 'stdio' }

/**
 * Owns one supervised `dsh web` child process from spawn to teardown.
 * Methods are idempotent: `start()` memoizes its outcome, and repeated
 * `stop()` calls collapse into one escalation sequence.
 */
export class DshServerProcess {
  readonly #options: DshServerProcessOptions
  #child: ChildProcess | undefined
  #url?: string
  #readyPromise?: Promise<ServerReady>
  #carrier: 'tcp' | 'stdio' = 'stdio'
  #frames?: { input: Writable; output: Readable }
  #channel?: FrameChannel
  #stopPromise?: Promise<void>
  #stopping = false
  /** Whether start() resolved for the current child; gates post-readiness exit reports. */
  #ready = false
  #tail: string[] = []
  #onExit: ((exit: ServerExit) => void) | undefined

  constructor(options: DshServerProcessOptions) {
    if (options.command.length === 0) throw new Error('dsh-desktop: launch command must name a program')
    this.#options = options
    this.#onExit = options.onExit
  }

  /** The loopback URL reported by the readiness line; absent in stdio mode. */
  get url(): string | undefined {
    return this.#url
  }

  /** Which delivery carrier the child's readiness line announced (default stdio). */
  get carrier(): 'tcp' | 'stdio' {
    return this.#carrier
  }

  /** Whether start() resolved for the current child; gates activate-time window recreation. */
  get started(): boolean {
    return this.#ready
  }

  /** The child's process id once spawned, for supervisor-side diagnostics. */
  get pid(): number | undefined {
    return this.#child?.pid
  }

  /**
   * The child's frame pipes once spawned (fds 3 and 4). Present for both
   * carriers — a tcp child never reads or writes them — and `undefined`
   * before the first successful spawn.
   */
  get framePipes(): { input: Writable; output: Readable } | undefined {
    return this.#frames
  }

  /**
   * The frame channel onto the child's pipes; `undefined` in tcp mode and
   * before spawn. One channel per process lifetime — its demultiplexer owns
   * request-id correlation from first use.
   */
  get channel(): FrameChannel | undefined {
    if (this.#carrier !== 'stdio') return undefined
    const pipes = this.#frames
    if (pipes === undefined) return undefined
    this.#channel ??= new FrameChannel(pipes.input, pipes.output)
    return this.#channel
  }

  /**
   * Spawn the child and resolve with its loopback URL when the readiness line
   * arrives. Rejects on spawn failure, early exit, the readiness timeout, or
   * a `stop()` that landed first; every rejection carries the output tail.
   */
  start(): Promise<ServerReady> {
    this.#readyPromise ??= this.#awaitReady()
    return this.#readyPromise
  }

  /**
   * Stop the child: SIGTERM first so the harness can dispose its tree, then
   * SIGKILL after the grace period. Resolves once the child is gone; safe to
   * call any number of times, before or after readiness.
   */
  stop(): Promise<void> {
    this.#stopPromise ??= this.#escalatingStop()
    return this.#stopPromise
  }

  #awaitReady(): Promise<ServerReady> {
    if (this.#stopping) return Promise.reject(new Error(this.#stoppedMessage()))
    return new Promise<ServerReady>((resolve, reject) => {
      let captured = ''
      let settled = false
      const spawnImpl = this.#options.spawnImpl ?? spawn
      const [program, ...args] = this.#options.command
      let child: ChildProcess
      if (program === undefined) {
        reject(new Error(`${this.#stoppedMessage()}: launch command must name a program`))
        return
      }
      try {
        child = spawnImpl(program, args, {
          cwd: this.#options.cwd,
          env: this.#options.env,
          // fds 3/4 are the frame pipes; a tcp-carrier child leaves them idle.
          stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(new Error(`${this.#stoppedMessage()}: spawn failed: ${String(error)}`))
        return
      }
      this.#child = child
      const third = child.stdio[3]
      const fourth = child.stdio[4]
      if (third !== null && fourth !== null && third instanceof Writable && fourth instanceof Readable) {
        this.#frames = { input: third, output: fourth }
      }
      const timer = setTimeout(() => {
        settleWith(() => {
          reject(new Error(
            `dsh web printed no readiness line within ${String(this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)}ms\n${this.#tailText()}`,
          ))
        })
        void this.stop()
      }, this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)

      function settleWith(done: () => void): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done()
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        this.#options.onOutput?.(chunk)
        this.#pushTail(chunk)
        if (captured.length < MAX_CAPTURE_CHARS) captured += chunk
        if (hasStdioReadyLine(captured)) {
          this.#carrier = 'stdio'
          settleWith(() => {
            this.#ready = true
            resolve({ kind: 'stdio' })
          })
          return
        }
        const url = extractReadyUrl(captured)
        if (url === undefined) return
        this.#carrier = 'tcp'
        this.#url = url
        settleWith(() => {
          this.#ready = true
          resolve({ kind: 'tcp', url })
        })
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        this.#options.onOutput?.(chunk)
        this.#pushTail(chunk)
        process.stderr.write(chunk)
      })
      child.on('error', (error: Error) => {
        settleWith(() => { reject(new Error(`${this.#stoppedMessage()}: ${error.message}\n${this.#tailText()}`)) })
      })
      child.on('exit', (code, signal) => {
        this.#child = undefined
        settleWith(() => {
          reject(new Error(
            `dsh web exited before readiness (code ${String(code)}, signal ${String(signal)})\n${this.#tailText()}`,
          ))
        })
        // Report only deaths after readiness: the shell turns this into its
        // unexpected-exit dialog, and every carrier kind owes that report.
        if (this.#ready) this.#onExit?.({ code, signal })
      })
    })
  }

  async #escalatingStop(): Promise<void> {
    this.#stopping = true
    const child = this.#child
    if (child === undefined || (child.exitCode !== null || child.signalCode !== null)) return
    child.kill('SIGTERM')
    if (!(await this.#exitWithin(this.#options.killGraceMs ?? DEFAULT_KILL_GRACE_MS))) {
      child.kill('SIGKILL')
      await this.#exitWithin(undefined)
    }
  }

  /**
   * Resolve when the current child exits; resolve `false` on timeout so the
   * caller can escalate instead of treating a slow dispose as a hang forever.
   * @param ms - the wait budget; `undefined` waits indefinitely (SIGKILL has no next escalation).
   */
  #exitWithin(ms: number | undefined): Promise<boolean> {
    const child = this.#child
    if (child === undefined) return Promise.resolve(true)
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(() => {
        child.off('exit', onExit)
        resolve(false)
      }, ms)
      function onExit(): void {
        if (timer !== undefined) clearTimeout(timer)
        resolve(true)
      }
      child.once('exit', onExit)
    })
  }

  #stoppedMessage(): string {
    return this.#stopping ? 'dsh web was stopped before readiness' : 'dsh web failed to start'
  }

  #pushTail(chunk: string): void {
    for (const line of chunk.split(/\r?\n/u)) {
      if (line === '') continue
      this.#tail.push(line)
    }
    if (this.#tail.length > DIAGNOSTIC_TAIL_LINES) this.#tail.splice(0, this.#tail.length - DIAGNOSTIC_TAIL_LINES)
  }

  #tailText(): string {
    return this.#tail.length === 0 ? '(no output captured)' : this.#tail.join('\n')
  }
}
