import { defineConfig } from '@playwright/test'

/**
 * Desktop QA lane for the Electron shell (@playwright/test runner driving
 * Playwright's `_electron` launcher). Every launch is fully isolated: a
 * temp `DSH_HOME` bootstraps its own harness profile and a temp
 * `DSH_DESKTOP_USER_DATA` keeps the single-instance lock away from any
 * interactively running shell. Pixel baselines are per-platform under
 * `snapshots/<platform>/`; regenerate with
 * `pnpm run test:desktop -- --update-snapshots` and commit your platform's
 * directory.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  use: {
    headless: true,
    screenshot: 'off',
    trace: 'off',
  },
  expect: {
    toHaveScreenshot: {
      // Live Electron windows composite through the GPU window server, and
      // solid fills can drift by one channel value between boots (~tens of
      // pixels). Real regressions move thousands; 0.0001 absorbs only that
      // noise. The web visual lane keeps 0 because headless Chromium
      // rasterizes in software.
      maxDiffPixelRatio: 0.0001,
      animations: 'disabled',
      caret: 'hide',
    },
    timeout: 15_000,
  },
  // {arch} is not a Playwright template token; arm64/x64 share the darwin
  // directory because both render with the same OS text stack.
  snapshotPathTemplate: '{testDir}/snapshots/{platform}/{testFileName}/{arg}{ext}',
})
