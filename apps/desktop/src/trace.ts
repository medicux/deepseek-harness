/**
 * Optional stderr tracing for desktop-lifecycle diagnosis (`DSH_DESKTOP_DEBUG=1`).
 * @module @deepseek-ai/dsh-desktop/trace
 */

/** Write one `dsh-desktop:` line to stderr when debug tracing is enabled.
 * @param message - the diagnostic fact to record. */
export function trace(message: string): void {
  if (process.env.DSH_DESKTOP_DEBUG === '1') process.stderr.write(`dsh-desktop: ${message}\n`)
}
