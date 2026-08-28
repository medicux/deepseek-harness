// Desktop shell QA over the real Electron app: the window boots its own
// isolated harness stack, so every assertion here exercises the exact
// surface a user runs — dsh:// protocol forward, IPC-carrier RPC, injected
// window chrome — not an HTTP stand-in.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DESKTOP_ROOT, launchDesktopApp, type DesktopApp } from './helpers.ts'

const require = createRequire(join(DESKTOP_ROOT, 'package.json'))
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

let desktop: DesktopApp

test.beforeAll(async () => {
  desktop = await launchDesktopApp()
})

test.afterAll(async () => {
  await desktop?.close()
})

test('settles the frame over the IPC carrier with zero console errors', async () => {
  const { page } = desktop
  // The hero anchors prove the client booted past the boot manifest into
  // React content rather than a blank scheme page.
  await expect(page.getByText('Into the Unknown', { exact: false }).first()).toBeVisible()
  await expect(page.getByTestId('settings-trigger')).toBeVisible()
  // The hero names two controls alike (the workspace chip and the composer
  // trigger); either being present proves the picker is reachable.
  await expect(page.getByRole('button', { name: 'Choose workspace' }).first()).toBeVisible()
  // Pixel baseline of the settled shell (traffic lights, brand row, hero).
  // Fonts plus a double frame wait for late hero copy: a time-based sleep
  // raced it and flaked the baseline between runs.
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await expect(page.locator('body')).toBeVisible()
  await expect(page).toHaveScreenshot('shell-settled.png')
  expect(desktop.errors).toEqual([])
})

test('drops the brand row below the traffic lights and keeps the top edge a drag region', async () => {
  const { page } = desktop
  // The brand row owns real top padding: the logo/wordmark must clear the
  // macOS traffic-light band instead of crowding it.
  const brandPadding = await page.evaluate(() => {
    const brand = document.querySelector<HTMLElement>("[data-dsh-window-drag='brand']")
    return brand === null ? null : getComputedStyle(brand).paddingTop
  })
  expect(brandPadding).not.toBeNull()
  expect(Number.parseInt(brandPadding ?? '0', 10)).toBeGreaterThanOrEqual(36)

  // The injected top strip spans the whole window top, including over the
  // non-sidebar columns, carries the app-region drag style, and lets clicks
  // pass through to whatever chrome sits in that band via pointer-events:none.
  // Playwright's synthetic mouse events cannot drive macOS window dragging —
  // Chromium handles app-region grabs on the native input path — so the
  // mechanism, not a bounds delta, is what's asserted. (elementFromPoint
  // intentionally no longer reports the strip, since click passthrough is
  // the whole point of the wider drag region.)
  const stripProbe = await page.evaluate(() => {
    const strip = document.getElementById('dsh-desktop-top-strip')
    if (strip === null) return null
    const rect = strip.getBoundingClientRect()
    const cs = getComputedStyle(strip)
    return {
      height: rect.height,
      coversViewportWidth: Math.abs(rect.width - window.innerWidth) < 1,
      appRegion: (cs as CSSStyleDeclaration & { webkitAppRegion?: string }).webkitAppRegion,
      pointerEvents: cs.pointerEvents,
    }
  })
  expect(stripProbe).not.toBeNull()
  expect(stripProbe?.coversViewportWidth).toBe(true)
  expect(stripProbe?.appRegion).toBe('drag')
  expect(stripProbe?.pointerEvents).toBe('none')

  // A marked client header drags wherever one is mounted; a blank-hero boot
  // renders none, and the injected strip owns dragging in that state.
  const headerDrag = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-dsh-window-drag=""]')
    return header === null ? null : (getComputedStyle(header) as CSSStyleDeclaration & { webkitAppRegion?: string }).webkitAppRegion
  })
  if (headerDrag !== null) expect(headerDrag).toBe('drag')
})

test('loads the Models provider directory and agent presets over the carrier', async () => {
  const { page } = desktop
  await page.getByTestId('settings-trigger').click()
  const dialog = page.getByTestId('settings-dialog')
  await expect(dialog).toBeVisible()

  // Both surfaces previously failed loud with
  // "init.signal.addEventListener is not a function": their loader's abort
  // signal crossed contextBridge prototype-less. They must render real
  // content (or a genuine empty state), never that transport error.
  const modelsTab = dialog.getByRole('tab', { name: 'Models' })
    .or(dialog.getByRole('button', { name: 'Models', exact: true }))
  await modelsTab.first().click()
  await expect(page.getByText('Loading the provider directory failed')).toHaveCount(0)
  await expect(page.getByText('init.signal.addEventListener is not a function')).toHaveCount(0)

  const presetsTab = dialog.getByRole('tab', { name: /Agent presets/i })
    .or(dialog.getByRole('button', { name: /Agent presets/i }))
  await presetsTab.first().click()
  await expect(page.getByText('Could not load agent presets')).toHaveCount(0)
  await expect(page.getByText('init.signal.addEventListener is not a function')).toHaveCount(0)
})

test('passes the WCAG 2.x A/AA axe gate on the settled shell', async () => {
  // @axe-core/playwright's AxeBuilder opens a fresh page through the
  // browser context, which Electron windows do not support; inject the
  // axe-core bundle into the live window and run it there instead.
  const { page } = desktop
  await page.addScriptTag({ content: axeSource })
  const summary = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: AxeRunner }).axe
    const results = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      resultTypes: ['violations'],
    })
    return results.violations.map((v) => {
      const first = v.nodes[0]
      const target = Array.isArray(first?.target) ? first.target.join(' ') : ''
      return `${v.id} (${v.impact ?? 'unknown'}): ${String(v.nodes.length)} node(s) at ${String(target)} :: ${String(first?.html?.slice(0, 120) ?? '')}`
    })
  })
  expect(summary).toEqual([])
})

test('exposes a polite live region, a tablist settings dialog, and a treeitem empty sidebar', async () => {
  const { page } = desktop
  // The polite live region is the only AT announcement channel; screen
  // readers never see boot progress or connection resets without it.
  const liveRegion = page.locator('[role="status"][aria-live="polite"]')
  await expect(liveRegion).toHaveCount(1)

  // Close any settings dialog left open by a prior test before re-opening.
  // The earlier test exercises the dialog and Playwright's worker does not
  // unmount the app between tests, so the trigger reflects its last state.
  const openDialog = page.getByTestId('settings-dialog')
  if (await openDialog.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await expect(openDialog).toHaveCount(0)
  }

  // Settings dialog opens from the trigger and is a real tablist, not a
  // button-in-nav (which screen readers cannot navigate with Tab/Arrow).
  await page.getByTestId('settings-trigger').click()
  const dialog = page.getByTestId('settings-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('tablist')).toBeVisible()
  const activeTab = dialog.getByRole('tab', { selected: true })
  await expect(activeTab).toHaveCount(1)
  // Roving tabindex: exactly one tab is the Tab stop, the rest are -1.
  const rovingTabs = await dialog.getByRole('tab').evaluateAll(nodes =>
    nodes.map(node => (node as HTMLElement).tabIndex))
  expect(rovingTabs.filter(tabindex => tabindex === 0)).toHaveLength(1)
  expect(rovingTabs.every(tabindex => tabindex === 0 || tabindex === -1)).toBe(true)

  // The empty sidebar hint is exposed as a disabled treeitem so the tree
  // structure is honest to AT even when no sessions exist.
  const emptyHint = page.locator('[role="treeitem"][aria-disabled="true"]').first()
  await expect(emptyHint).toBeVisible()
})

/** The slice of axe's run() result the gate reads. */
interface AxeRunner {
  run: (context: Document, options: unknown) => Promise<{
    violations: AxeViolation[]
  }>
}

interface AxeViolation {
  id: string
  impact: string | null
  nodes: Array<{ target: string[]; html: string }>
}
