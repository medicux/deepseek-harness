import { defineConfig } from '@playwright/test'

/**
 * Visual-regression lane for the DSH web GUI (@playwright/test runner,
 * separate from the vitest e2e lane). Screenshots ride the same real
 * composition the e2e lane boots; baselines are per-platform so macOS and
 * Linux renderers never fight over one file set — regenerate locally with
 * `pnpm run test:web:visual -- --update-snapshots` and commit your platform's
 * directory. Animations are disabled by toHaveScreenshot default; locale is
 * pinned in helpers.ts so copy cannot drift under a capture.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    screenshot: 'off',
    trace: 'off',
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  // {arch} is not a Playwright template token; arm64/x64 share the darwin
  // directory because both render with the same OS text stack.
  snapshotPathTemplate: '{testDir}/snapshots/{platform}/{testFileName}/{arg}{ext}',
})
