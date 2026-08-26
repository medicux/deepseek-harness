// Web e2e scenario: accessibility smoke over the real composition. axe-core
// scans the two surfaces every interactive QA session touches — the settled
// boot page and the open settings dialog — and the gate holds when neither
// carries a WCAG 2.x A/AA violation. axe's own result object is the oracle
// (passes/violations/incomplete); the assertion is on `violations` only, so
// rules needing human judgement (`incomplete`) never fail the lane.
// Keyless: no fixture, no model round (lane scope: the browser-e2e-lane
// Agent Note; the settings surface itself has its own spec).
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

/** Rule tags this gate holds the product to (WCAG 2.x A/AA conformance). */
const CONFORMANCE_TAGS = ['wcag2a', 'wcag2aa']

/**
 * Reduce an axe result to the failing records worth reporting: one line per
 * violation with its impact, rule id, and affected node targets.
 */
function summarizeViolations(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string[] {
  return violations.map(v =>
    `${v.impact ?? 'unknown'} ${v.id} (${v.nodes.length} node(s): ${v.nodes.map(n => n.target.join(' ')).join('; ')})`)
}

describe('web e2e: accessibility smoke (axe-core)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // axe-core/playwright injects through an explicit browser context; a
    // page lifted straight off `browser.newPage()` sits in an implicit
    // context its script cannot reach.
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The connected-workspace shell is the state real sessions live in; scan
    // that rather than the pre-connect hero so the gate covers the chrome
    // (rail, columns, composer) rather than first-run copy.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('boots the connected shell without WCAG 2.x A/AA violations', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-axe-shell'))
    const results = await new AxeBuilder({ page }).withTags(CONFORMANCE_TAGS).analyze()
    expect(summarizeViolations(results.violations), 'axe violations on the settled shell').toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('opens the settings dialog without WCAG 2.x A/AA violations', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-axe-settings'))
    const trigger = page.getByTestId('settings-trigger')
    await trigger.click()
    const dialog = page.getByRole('dialog').first()
    await dialog.waitFor({ timeout: 10_000 })
    // Scope to the dialog: the shell behind an aria-modal overlay is inert by
    // design, and axe would re-report its background contrast through the
    // scrim otherwise.
    const results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(CONFORMANCE_TAGS).analyze()
    expect(summarizeViolations(results.violations), 'axe violations inside the settings dialog').toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
