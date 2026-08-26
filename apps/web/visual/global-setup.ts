import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { FullConfig } from '@playwright/test'

/**
 * Global setup for the visual lane: boot the real composition once by
 * spawning the vitest lane's scaffold in a tsx child process (workspace
 * sources carry vendored `declare` fields that Playwright's transpiler
 * cannot parse, and the lane contract launches TS sources through tsx), read
 * the base URL from the child's marker line, and publish it to workers via
 * the environment. Teardown kills the child. Dist must be current — run
 * `pnpm run test:web:visual`, which builds first.
 */
let child: ReturnType<typeof spawn> | undefined

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const entry = fileURLToPath(new URL('../tests/visual-server-entry.ts', import.meta.url))
  child = spawn(process.execPath, ['--import', 'tsx/esm', entry], { stdio: ['ignore', 'pipe', 'inherit'] })
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => { reject(new Error('visual scaffold did not report a base URL within 120s')) }, 120_000)
    child?.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const marker = buffered.match(/^DSH_VISUAL_SCAFFOLD (.*)$/m)
      if (marker !== null && marker[1] !== undefined) {
        clearTimeout(timer)
        resolve((JSON.parse(marker[1]) as { baseUrl: string }).baseUrl)
      }
    })
    child?.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`visual scaffold exited early with code ${String(code)}:\n${buffered}`))
    })
  })
  process.env.DSH_VISUAL_BASE_URL = baseUrl
  return async () => {
    child?.kill('SIGTERM')
  }
}
