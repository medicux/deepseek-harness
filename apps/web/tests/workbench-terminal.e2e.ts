// Keyless live lane for the workbench terminal: real chromium, real webserver
// routes, real node-pty user shell — no model calls, no fixtures. It pins the
// session-persistence contract the unit specs model with doubles: closing and
// reopening the workbench column performs exactly one /api/terminal.open and
// zero /api/terminal.close posts; shell state set before collapsing (a shell
// variable) still answers in the reopened view, proving the same process kept
// running behind the closed column; and the PTY geometry survives the round
// trip instead of collapsing onto the fit addon's clamped floor. A full page
// reload adopts the still-live session by its cached id: one more open post,
// no new spawn, and the output buffered while the page was away replays into
// the fresh emulator.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

/** Read the rendered terminal text; only viewport rows live in the DOM. */
const screenText = (page: Page): Promise<string> => page.evaluate(
  () => document.querySelector('.dsh-terminal-panel .xterm-rows')?.textContent ?? '',
)

/** Poll until the rendered screen contains one exact output marker. */
async function waitContains(page: Page, marker: string): Promise<void> {
  await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain(marker)
}

/** Poll until the rendered screen matches one output pattern. */
async function waitMatches(page: Page, pattern: RegExp): Promise<void> {
  await expect.poll(async () => pattern.test(await screenText(page)), { timeout: 15_000 }).toBe(true)
}

/** Type one line into the focused terminal and wait for its output marker. */
async function runAndExpect(page: Page, command: string, marker: string): Promise<void> {
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await waitContains(page, marker)
}

describe('web e2e: workbench terminal session persists across collapse', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let openCount = 0
  let closeCount = 0
  const seenSessions = new Set<string>()

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path === '/api/terminal.open') openCount += 1
      if (path === '/api/terminal.close') closeCount += 1
    })
    page.on('response', async (response) => {
      if (new URL(response.url()).pathname !== '/api/terminal.open') return
      try {
        const body = await response.json() as { session?: string }
        if (typeof body.session === 'string') seenSessions.add(body.session)
      } catch {
        // A torn-down navigation can abort the body read; spawn counting
        // already covers the contract.
      }
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps one shell alive behind a closed column', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workbench-terminal'))

    // Open the workbench through its collapsed-state tab and wait for xterm.
    await page.getByRole('button', { name: 'Open workbench' }).click()
    await page.locator('.dsh-terminal-panel .xterm-screen').waitFor({ timeout: 30_000 })
    await page.locator('.dsh-terminal-panel .xterm').click()
    await waitMatches(page, /[%$#]/)

    // Shell-executed arithmetic distinguishes real PTY execution from typed
    // echo: the literal `$((6*7))` appears as keystrokes, `V-42` only when a
    // shell evaluated it.
    await runAndExpect(page, 'echo V-$((6*7))', 'V-42')

    // Record state that only THIS process instance can answer later.
    await runAndExpect(page, 'DSHPERSIST=still-here', 'still-here')
    await runAndExpect(page, 'echo P-$DSHPERSIST', 'P-still-here')
    await page.keyboard.type('stty size')
    await page.keyboard.press('Enter')
    await waitMatches(page, /(\d+) (\d+)/)
    const textBefore = await screenText(page)
    const geometryBefore = [...textBefore.matchAll(/(\d+) (\d+)/g)].at(-1)![0]

    // Close via the handle's double-click; the collapsed frame must show.
    await page.locator('[data-side="workbench"]').dblclick()
    await page.locator('[data-workbench-collapsed]').waitFor({ timeout: 15_000 })
    expect(closeCount, 'collapse must not close the session').toBe(0)

    // Reopen: same session continues — the variable still resolves, the PTY
    // geometry is unchanged, and no second spawn happened.
    await page.getByRole('button', { name: 'Open workbench' }).click()
    await page.locator('.dsh-terminal-panel .xterm-screen').waitFor({ timeout: 30_000 })
    await page.locator('.dsh-terminal-panel .xterm').click()
    await runAndExpect(page, 'echo P-$DSHPERSIST', 'P-still-here')
    await page.keyboard.type('stty size')
    await page.keyboard.press('Enter')
    await waitMatches(page, /(\d+) (\d+)/)
    const geometryAfter = [...(await screenText(page)).matchAll(/(\d+) (\d+)/g)].at(-1)![0]
    expect(geometryAfter).toBe(geometryBefore)
    expect(openCount, 'the whole round trip spawns once').toBe(1)
    expect(closeCount).toBe(0)
  }, 120_000)

  it('respawns a fresh shell after the previous one exits', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workbench-terminal-respawn'))

    // Exit while expanded: the corpse stays visible; nothing posts close.
    // The gateway ends the SSE response exactly when the session exits, so
    // awaiting that event removes the teardown-timing guesswork.
    const streamClosed = new Promise<void>((resolve) => {
      const onRequestFinished = (request: import('playwright').Request): void => {
        if (new URL(request.url()).pathname === '/api/terminal.stream') {
          page.off('requestfinished', onRequestFinished)
          resolve()
        }
      }
      page.on('requestfinished', onRequestFinished)
    })
    await page.locator('.dsh-terminal-panel .xterm').click()
    await page.keyboard.type('exit')
    await page.keyboard.press('Enter')
    await Promise.race([streamClosed, new Promise<void>((resolve) => { setTimeout(resolve, 15_000) })])
    expect(closeCount).toBe(0)

    // Collapse and reopen: a brand-new session spawns and the old shell's
    // variable is gone.
    await page.locator('[data-side="workbench"]').dblclick()
    await page.locator('[data-workbench-collapsed]').waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Open workbench' }).click()
    await page.locator('.dsh-terminal-panel .xterm-screen').waitFor({ timeout: 30_000 })
    await page.locator('.dsh-terminal-panel .xterm').click()
    await waitMatches(page, /[%$#]/)
    await expect.poll(() => screenText(page), { timeout: 15_000 }).not.toContain('still-here')
    await runAndExpect(page, 'echo R-$DSHPERSIST', 'R-')
    expect(openCount).toBe(2)
    expect(closeCount, 'exited sessions are never client-closed').toBe(0)
  }, 120_000)

  it('a full page reload adopts the live session and replays detached output', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workbench-terminal-reload'))

    // State that only the running process can answer, left on screen so its
    // post-reload reappearance proves replay rather than fresh output.
    await page.locator('.dsh-terminal-panel .xterm').click()
    await runAndExpect(page, 'RELOADMARK=reload-live', 'reload-live')
    await runAndExpect(page, 'echo M-before-reload', 'M-before-reload')

    await page.reload({ waitUntil: 'load' })

    // The boot lands with the column closed; reopening presents the cached
    // id and the gateway answers with the same session — one more open
    // request, zero spawns.
    await page.getByRole('button', { name: 'Open workbench' }).click()
    await page.locator('.dsh-terminal-panel .xterm-screen').waitFor({ timeout: 30_000 })
    await page.locator('.dsh-terminal-panel .xterm').click()

    // The pre-reload screen text returns through the gateway's buffered
    // replay into the fresh emulator, before anything is typed.
    await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain('M-before-reload')

    // And it is genuinely the same process: its variable still resolves.
    await runAndExpect(page, 'echo Q-$RELOADMARK', 'Q-reload-live')
    expect(openCount, 'adoption reuses the open route without spawning').toBe(3)
    expect(seenSessions.size, 'three opens across two distinct sessions').toBe(2)
    expect(closeCount).toBe(0)
  }, 120_000)
})
