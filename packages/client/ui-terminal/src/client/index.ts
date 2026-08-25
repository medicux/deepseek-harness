/**
 * Interactive user terminal: the workbench column's first occupant. One
 * xterm.js instance per mounted, expanded panel; output arrives as base64
 * SSE chunks from `/api/terminal.stream`, keystrokes POST to
 * `/api/terminal.write` as-is (the PTY owns echo and line discipline), and a
 * ResizeObserver keeps the PTY grid on the rendered viewport through
 * `/api/terminal.resize`. The session outlives the column: collapsing only
 * hides the view, and reopening — or a full page reload, via the sessionStorage
 * id — resumes the live shell whose scrollback lives in the PTY.
 * @module @deepseek-ai/dsh-client-ui-terminal/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap merge declaring the `workbench` single slot.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { TerminalPanel } from './TerminalPanel.tsx'
import xtermCss from './xterm.css?inline'

/** Style tag marker so factory re-execution never doubles the stylesheet. */
const STYLE_TAG = 'ui-terminal/xterm.css'

export const inject = ['slots']

/**
 * Client plugin body: register the terminal panel into ui-layout's
 * root-scoped `workbench` slot. The panel opens its shell when the column is
 * first expanded; it renders nothing while collapsed.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css='${STYLE_TAG}']`) === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = xtermCss
      document.head.appendChild(tag)
    }
    return ctx.slots.register({ name: 'workbench', inject: () => ({}) }, TerminalPanel)
  }, 'ui-terminal: workbench occupant')
}

export { SESSION_CACHE_KEY, TerminalPanel } from './TerminalPanel.tsx'
