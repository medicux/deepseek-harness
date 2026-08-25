/**
 * Pure concession-chain column solver for the four-column AppFrame.
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details, then auto-closing it; the same treatment then falls to the
 * workbench column (shrink toward its minimum, then auto-close); only the
 * final fallback lets center drop below its minimum. Derived zeroes never
 * rewrite preferred width preferences, so widening the window restores them.
 * The sidebar never concedes: its rendered width is always the drag
 * preference (or the collapsed rail), while closed details and a closed
 * workbench resolve to zero width. The SIDEBAR_AUTO_COLLAPSE breakpoint is
 * consumed by AppFrame, which decides the effective sidebar preference
 * before solving; the solver itself stays breakpoint-free.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; workbench: number; center: number; details: number }

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360
/** Workbench drag clamp floor (diff/code/terminal surfaces need real width). */
export const WORKBENCH_MIN = 320
/** Workbench drag clamp ceiling. */
export const WORKBENCH_MAX = 560
/** Workbench width before any user drag. */
export const WORKBENCH_DEFAULT = 400

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the four column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param workbench - workbench width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @returns resolved widths; a 0 workbench or details means visually closed
 *   (never unmounted), while a closed sidebar keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, workbench: number, details: number): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const w0 = workbench === 0 ? 0 : clampWidth(workbench, WORKBENCH_MIN, WORKBENCH_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)

  // Step 1: everything fits at preferred widths.
  if (s + w0 + d0 + CENTER_MIN <= viewport) return { sidebar: s, workbench: w0, center: viewport - s - w0 - d0, details: d0 }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - w0 - CENTER_MIN)
  if (s + w0 + d1 + CENTER_MIN <= viewport) return { sidebar: s, workbench: w0, center: CENTER_MIN, details: d1 }

  // Step 3: auto-close details (derived — preferences untouched).
  const d2 = 0
  // Step 4: shrink the workbench toward its minimum — never above its own
  // preference: closing details may have freed enough room that no workbench
  // concession is needed at all.
  const w1 = w0 === 0 ? 0 : Math.min(w0, Math.max(WORKBENCH_MIN, viewport - s - CENTER_MIN))
  if (s + w1 + CENTER_MIN <= viewport) return { sidebar: s, workbench: w1, center: viewport - s - w1, details: d2 }

  // Step 5: auto-close the workbench; center absorbs any remaining deficit
  // (may drop below CENTER_MIN).
  return { sidebar: s, workbench: 0, center: Math.max(0, viewport - s), details: d2 }
}
