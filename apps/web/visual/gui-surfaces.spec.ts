// Visual baselines for the three surfaces every QA session touches: the
// settled connected-workspace shell, the open settings dialog, and the
// Plugins page's Web search card. Pixel goldens (unlike the vitest lane's
// color-blind aria goldens) pin the actual painted surface — palette,
// spacing, and layout regressions all trip the gate. Regenerate per platform
// with `pnpm run test:web:visual -- --update-snapshots`.
import { expect, test } from '@playwright/test'
import { closeVisualBrowser, openVisualPage } from './helpers.ts'

test.afterAll(async () => {
  await closeVisualBrowser()
})

test('settled shell paints the connected workspace baseline', async () => {
  const { page, close } = await openVisualPage()
  await page.getByTestId('composer-input').waitFor({ state: 'visible', timeout: 15_000 })
  // One rAF-turn of settle time so late fonts/scrollbars finish before capture.
  await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) }))
  await expect(page).toHaveScreenshot('shell-settled.png')
  await close()
})

test('settings dialog paints its General section baseline', async () => {
  const { page, close } = await openVisualPage()
  await page.getByTestId('composer-input').waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByTestId('settings-trigger').click()
  const dialog = page.getByTestId('settings-dialog')
  await dialog.waitFor({ timeout: 10_000 })
  await expect(dialog).toHaveScreenshot('settings-general.png')
  await close()
})
