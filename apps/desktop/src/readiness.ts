/**
 * Readiness detection for the supervised `dsh web` child process.
 *
 * The web surface prints one URL line after its Loader tree settles —
 * `dsh web: <url>`, optionally followed by a ` (LAN: …)` parenthetical — and
 * supervisors are the documented consumers of that line. This module is a
 * pure function over accumulated stdout text so the Electron main process and
 * tests feed it the same way: re-scan the whole buffer on every data event;
 * the function is idempotent and tolerant of chunk-split lines.
 * @module @deepseek-ai/dsh-desktop/readiness
 */

/** Exact prefix of the readiness line printed by the web surface. */
const READY_PREFIX = 'dsh web: '
/** The readiness line printed when the web surface rides the stdio carrier. */
const STDIO_READY_LINE = 'dsh web-stdio: ready'

/**
 * Whether the accumulated stdout contains the stdio carrier's readiness line.
 * Only complete lines are evaluated, mirroring {@link extractReadyUrl}.
 * @param output - stdout text accumulated so far, in arrival order.
 * @returns true when a complete line matches the stdio readiness line.
 */
export function hasStdioReadyLine(output: string): boolean {
  const completeLength = output.endsWith('\n') ? output.length : output.lastIndexOf('\n') + 1
  return output.slice(0, completeLength).split(/\r?\n/u).includes(STDIO_READY_LINE)
}

/**
 * Extract the loopback URL of the ready web surface from accumulated child
 * stdout. Only newline-terminated lines are evaluated, so a URL split across
 * stdout chunks waits for its completing chunk instead of resolving early.
 * Sibling announcements share the line prefix (`dsh web: opening the default
 * browser…`) and are skipped: a candidate must parse as an absolute `http:`
 * URL with an empty path and query to count as the readiness line.
 * @param output - stdout text accumulated so far, in arrival order.
 * @returns the URL from the first readiness line, or `undefined` while none has arrived.
 */
export function extractReadyUrl(output: string): string | undefined {
  const completeLength = output.endsWith('\n') ? output.length : output.lastIndexOf('\n') + 1
  for (const line of output.slice(0, completeLength).split(/\r?\n/u)) {
    if (!line.startsWith(READY_PREFIX)) continue
    const candidate = line.slice(READY_PREFIX.length).trim().split(/\s+/u)[0] ?? ''
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      continue
    }
    if (url.protocol === 'http:' && url.pathname === '/' && url.search === '') return candidate
  }
  return undefined
}
