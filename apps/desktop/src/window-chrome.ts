/**
 * Window chrome for the frameless desktop shell.
 *
 * The shell removes the native title bar (`hiddenInset` on macOS,
 * `hidden` elsewhere) so the page content sits flush with the top edge,
 * Codex-style. Two injected artifacts own the consequences: a stylesheet
 * that turns the client's marked header rows into the drag region, and —
 * where the platform has no native controls left — a small button overlay
 * wired through the preload bridge. Both are pure string builders so tests
 * can pin exactly what reaches the renderer.
 * @module @deepseek-ai/dsh-desktop/window-chrome
 */

/** Attribute the client headers carry to opt into the drag region. */
export const DRAG_REGION_ATTRIBUTE = 'data-dsh-window-drag'

/** Element id of the injected window-control overlay. */
export const WINDOW_CONTROLS_ID = 'dsh-window-controls'

/** Bridge name the preload exposes on `window`. */
export const DESKTOP_BRIDGE = 'dshDesktop'

/**
 * Stylesheet making marked header rows drag the window while every
 * interactive descendant stays clickable. Inert in browsers: nothing there
 * sets the attribute.
 */
export const DRAG_REGION_CSS = `
[${DRAG_REGION_ATTRIBUTE}] { -webkit-app-region: drag; }
[${DRAG_REGION_ATTRIBUTE}] :is(button, input, textarea, select, a, [role='button'], [contenteditable], [data-dsh-window-no-drag]) { -webkit-app-region: no-drag; }
#${WINDOW_CONTROLS_ID}, #${WINDOW_CONTROLS_ID} * { -webkit-app-region: no-drag; }
body:fullscreen #${WINDOW_CONTROLS_ID} { display: none; }
`

/** The window surface the operation dispatcher needs. */
export interface WindowChromeTarget {
  minimize(): void
  isMaximized(): boolean
  maximize(): void
  unmaximize(): void
  close(): void
}

/**
 * Apply one bridge operation to the window. Unknown operations are rejected
 * loudly: the channel crosses a process boundary, so an unexpected value is
 * a contract breach, not a silent no-op.
 * @param target - the BrowserWindow-shaped receiver.
 * @param op - the operation name from the renderer bridge.
 * @throws when `op` is not one of `minimize`, `toggle-maximize`, `close`.
 */
export function applyWindowOp(target: WindowChromeTarget, op: unknown): void {
  if (op === 'minimize') { target.minimize(); return }
  if (op === 'toggle-maximize') {
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
    return
  }
  if (op === 'close') { target.close(); return }
  throw new Error(`dsh-desktop: unknown window operation ${JSON.stringify(op)}`)
}

/**
 * Build the renderer script that installs the window-control overlay for
 * platforms whose native controls disappeared with the title bar. Idempotent:
 * re-running on a live document is a no-op. Buttons resolve their action
 * through the preload bridge; styling rides {@link WINDOW_CONTROLS_CSS}.
 * @returns the script source for `webContents.executeJavaScript`.
 */
export function buildWindowControlsScript(): string {
  return `
(() => {
  if (document.getElementById('${WINDOW_CONTROLS_ID}')) return
  const bar = document.createElement('div')
  bar.id = '${WINDOW_CONTROLS_ID}'
  const WINDOW_CONTROL_LABELS: Record<string, string> = {
    close: 'Close window',
    'toggle-maximize': 'Maximize or restore window',
    minimize: 'Minimize window',
  }
  for (const op of ['close', 'toggle-maximize', 'minimize']) {
    const button = document.createElement('button')
    button.dataset.op = op
    button.setAttribute('aria-label', WINDOW_CONTROL_LABELS[op] ?? op)
    bar.appendChild(button)
  }
  bar.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-op]') : null
    if (button === null) return
    const bridge = window['${DESKTOP_BRIDGE}']
    if (typeof bridge !== 'object' || bridge === null) return
    const op = button.dataset.op
    if (op === 'close') bridge.close()
    else if (op === 'toggle-maximize') bridge.toggleMaximize()
    else if (op === 'minimize') bridge.minimize()
  })
  document.body.appendChild(bar)
})()`
}

/**
 * Stylesheet for the injected control overlay: three macOS-colored dots at
 * the top-right edge, above content, below fullscreen suppression.
 */
export const WINDOW_CONTROLS_CSS = `
#${WINDOW_CONTROLS_ID} {
  position: fixed;
  top: 8px;
  right: 10px;
  display: flex;
  gap: 8px;
  z-index: 2147483647;
}
#${WINDOW_CONTROLS_ID} button {
  width: 12px;
  height: 12px;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}
#${WINDOW_CONTROLS_ID} button[data-op='close'] { background: #ff5f57; }
#${WINDOW_CONTROLS_ID} button[data-op='toggle-maximize'] { background: #febc2e; }
#${WINDOW_CONTROLS_ID} button[data-op='minimize'] { background: #28c840; }
`

/** Element id of the injected full-width top drag edge. */
export const DESKTOP_TOP_STRIP_ID = 'dsh-desktop-top-strip'

/**
 * Desktop adjustments for the frameless window's top zone. The app surface
 * sits flush — nothing is reserved or pushed down. Two rules:
 *
 * - The sidebar brand row (marked `data-dsh-window-drag='brand'` by the
 *   client) gains top padding, dropping the logo and wordmark below the
 *   traffic-light / window-control band. The padding belongs to the row
 *   itself, so the new air is draggable exactly where it renders. The
 *   collapsed rail keeps its own tighter spacing (its two-class rule
 *   outranks this attribute selector).
 * - A 6px transparent edge across the whole window top is a drag region, so
 *   grabbing the very top of either column works even while the session
 *   header is hidden (blank hero). It covers no interactive pixels: every
 *   control starts below it, and it hides with fullscreen like the rest of
 *   the chrome.
 */
export const TOP_STRIP_CSS = `
[data-dsh-window-drag='brand'] { padding-top: 26px; }
#${DESKTOP_TOP_STRIP_ID} {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  -webkit-app-region: drag;
  z-index: 2147483646;
}
body:fullscreen #${DESKTOP_TOP_STRIP_ID} { display: none; }
`

/**
 * Build the renderer script that installs the top drag edge. Idempotent:
 * re-running on a live document is a no-op.
 * @returns the script source for `webContents.executeJavaScript`.
 */
export function buildTopStripScript(): string {
  return `
(() => {
  if (document.getElementById('${DESKTOP_TOP_STRIP_ID}')) return
  const strip = document.createElement('div')
  strip.id = '${DESKTOP_TOP_STRIP_ID}'
  document.body.appendChild(strip)
})()`
}
