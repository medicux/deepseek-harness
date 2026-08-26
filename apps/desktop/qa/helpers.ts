// Shared launch harness for the desktop QA lane: every test boots the real
// Electron shell over a throwaway Harness home and userData dir, so lane
// runs never touch the interactive user's profile, sessions, or
// single-instance lock.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import type { ElectronApplication, Page } from 'playwright'

const require = createRequire(import.meta.url)

/** Absolute path of apps/desktop — the Electron app root (`electron .`). */
export const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Console noise the shell's own logging emits on every boot. */
const BENIGN_CONSOLE_PREFIXES = [
  '[ui-cordis] reading the Cordis inventory failed',
  '[cordis-client-runner] syncing inspect providers failed',
]

export interface DesktopApp {
  app: ElectronApplication
  page: Page
  /** Throwaway DSH_HOME the supervised server booted from. */
  home: string
  /** Collected console errors and uncaught page errors, in order. */
  errors: string[]
  close(): Promise<void>
}

/**
 * Launch the desktop shell end to end and return its first window once the
 * client frame has mounted (the server reached readiness and the renderer is
 * live over the IPC carrier).
 * @returns the running app plus its window page and teardown handle.
 */
export async function launchDesktopApp(): Promise<DesktopApp> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-qa-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'dsh-desktop-qa-user-'))
  const errors: string[] = []
  const app = await _electron.launch({
    args: ['.'],
    cwd: DESKTOP_ROOT,
    executablePath: require('electron') as string,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_DESKTOP_USER_DATA: userData,
      DSH_DESKTOP_DEBUG: '1',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (BENIGN_CONSOLE_PREFIXES.some(prefix => message.text().startsWith(prefix))) return
    errors.push(`console.error: ${message.text()}`)
  })
  await page.waitForSelector('[class*="frame"]', { timeout: 90_000 })
  await dismissFreshBootModals(page)
  return {
    app,
    page,
    home,
    errors,
    close: async (): Promise<void> => {
      await app.close()
    },
  }
}

/**
 * Dismiss the modals a fresh Harness home greets the user with — the
 * version-gated Internal Testing Notice, then the first-run API-key
 * onboarding — so lane assertions reach the underlying shell. Each step is
 * optional: a home that already acknowledged one skips it.
 */
async function dismissFreshBootModals(page: Page): Promise<void> {
  const steps = [
    { gate: page.getByRole('button', { name: 'Continue' }), dialog: page.getByRole('dialog') },
    { gate: page.getByRole('button', { name: 'Configure later' }), dialog: page.getByRole('dialog') },
  ]
  for (const step of steps) {
    try {
      await step.gate.waitFor({ state: 'visible', timeout: 8_000 })
      await step.gate.click()
      await step.dialog.waitFor({ state: 'detached', timeout: 10_000 })
    } catch {
      // This modal did not appear on this boot.
    }
  }
}
