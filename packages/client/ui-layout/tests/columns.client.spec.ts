import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns,
  DETAILS_DEFAULT, DETAILS_MIN, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MIN,
  WORKBENCH_DEFAULT, WORKBENCH_MAX,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, workbench: 400, center: 1920 - 280 - 400 - 360, details: 360 })
  })

  it('closed sidebar keeps its compact rail while closed panels contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(400), closed(360)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, workbench: 0, center: 1920 - SIDEBAR_COLLAPSED, details: 0 })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(1920, open(9999), open(9999), open(1))
    expect(cols.sidebar).toBe(420)
    expect(cols.workbench).toBe(WORKBENCH_MAX)
    expect(cols.details).toBe(DETAILS_MIN)
    expect(computeColumns(1920, open(1), open(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT)).sidebar).toBe(SIDEBAR_MIN)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 360 + 640 = 1280 > 1250; details concedes to 1250-280-640 = 330.
    const cols = computeColumns(1250, open(SIDEBAR_DEFAULT), closed(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, workbench: 0, center: CENTER_MIN, details: 330 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const cols = computeColumns(300 + 360 + CENTER_MIN, open(300), closed(400), open(360))
    expect(cols).toEqual({ sidebar: 300, workbench: 0, center: CENTER_MIN, details: 360 })
    const one = computeColumns(300 + 360 + CENTER_MIN - 1, open(300), closed(400), open(360))
    expect(one).toEqual({ sidebar: 300, workbench: 0, center: CENTER_MIN, details: 359 })
  })

  it('step 3: details auto-closes when its min still starves center — sidebar holds its preference', () => {
    // 280 + 300 + 640 = 1220 > 1210 → details 0; sidebar untouched: center = 1210-280 = 930.
    const cols = computeColumns(1210, open(SIDEBAR_DEFAULT), closed(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, workbench: 0, center: 930, details: 0 })
  })

  it('the workbench concedes only after details is gone: shrink toward min first', () => {
    // 280 + 400 + 640 = 1320 > 1300 with no details: workbench shrinks to
    // 1300-280-640 = 380 while center pins at min.
    const cols = computeColumns(1300, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), closed(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, workbench: 380, center: CENTER_MIN, details: 0 })
    // A tighter frame shrinks further but never crosses the contract minimum.
    const shrunk = computeColumns(1250, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), closed(DETAILS_DEFAULT))
    expect(shrunk.workbench).toBe(330)
    expect(shrunk.center).toBe(CENTER_MIN)
    // Closing details may free enough room that no concession is needed.
    const spared = computeColumns(1500, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT))
    expect(spared.workbench).toBe(WORKBENCH_DEFAULT)
  })

  it('step 4/5: an open workbench auto-closes when its min still starves center', () => {
    // 280 + 320 + 640 = 1240 > 1230 → workbench 0; center absorbs the rest.
    const cols = computeColumns(1230, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), closed(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, workbench: 0, center: 950, details: 0 })
    // Preferences are never rewritten by derived closes: re-widening restores.
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), closed(DETAILS_DEFAULT))
    expect(restored.workbench).toBe(WORKBENCH_DEFAULT)
  })

  it('with both side panels open, details concedes and closes before the workbench moves', () => {
    // 280 + 400 + 360 + 640 = 1680 > 1500: details shrinks to
    // 1500-280-400-640 = 180 → below DETAILS_MIN, clamps to 300; still
    // starving (1620 > 1500) → details auto-closes. The freed room means the
    // workbench keeps its full preference and center absorbs the surplus.
    const cols = computeColumns(1500, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, workbench: 400, center: 820, details: 0 })
  })

  it('the sidebar never concedes: center absorbs the deficit below CENTER_MIN', () => {
    // 700 < 280+640: sidebar keeps 280, center takes 420 < CENTER_MIN.
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(WORKBENCH_DEFAULT), closed(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, workbench: 0, center: 420, details: 0 })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fits = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN, closed(300), closed(400), open(DETAILS_DEFAULT))
    expect(fits).toEqual({ sidebar: SIDEBAR_COLLAPSED, workbench: 0, center: CENTER_MIN, details: DETAILS_MIN })
    const starved = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN - 1, closed(300), closed(400), open(DETAILS_DEFAULT))
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      workbench: 0,
      center: DETAILS_MIN + CENTER_MIN - 1,
      details: 0,
    })
  })

  it('tiny viewport: panels close, sidebar holds, center takes the remainder', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols.details).toBe(0)
    expect(cols.workbench).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(1100, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT))
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(WORKBENCH_DEFAULT), open(DETAILS_DEFAULT))
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.workbench).toBe(WORKBENCH_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, center takes the rest', () => {
    // Reaches step 3's auto-close with the compact rail sidebar.
    expect(computeColumns(500, closed(300), closed(400), open(DETAILS_DEFAULT)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, workbench: 0, center: 500 - SIDEBAR_COLLAPSED, details: 0 })
  })
})
