import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'

/**
 * Per-worker browser plus one fresh context/page over the composition the
 * global setup booted. The browser lives here (not in globalSetup) because
 * Playwright runs setup and worker processes separately — only the base URL
 * crosses that boundary through the environment.
 */
let workerBrowser: Browser | undefined

/**
 * Open a settled English page over the running scaffold server.
 * @param width - viewport width (lane baseline 1680).
 * @param height - viewport height.
 * @returns the page plus a close handle releasing the context.
 */
export async function openVisualPage(width = 1680, height = 1000): Promise<{ page: Page; close: () => Promise<void> }> {
  const baseUrl = process.env.DSH_VISUAL_BASE_URL
  if (baseUrl === undefined || baseUrl.length === 0) throw new Error('visual lane booted without DSH_VISUAL_BASE_URL (global setup did not run)')
  workerBrowser ??= await chromium.launch()
  const context = await workerBrowser.newContext({ viewport: { width, height }, locale: 'en-US' })
  const page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  return { page, close: () => context.close() }
}

/** Release the worker's browser; called from each spec's afterAll. */
export async function closeVisualBrowser(): Promise<void> {
  await workerBrowser?.close()
  workerBrowser = undefined
}
