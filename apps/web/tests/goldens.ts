// Golden-harness helpers that ride on vitest's `expect`: stable aria
// capture, golden compare/refresh, and the fixture-inventory guard. They
// live apart from scaffold.ts so the scaffold itself loads under plain
// node+tsx (the visual lane boots it outside vitest).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import type { Page } from 'playwright'
import { expect } from 'vitest'
import { scrubRequestHeaders } from '@deepseek-ai/dsh-acp-snapshot'
import type { WebSnapshotMode } from './scaffold.ts'

/**
 * Normalize an aria snapshot: uuid, cwd, workspace-basename, duration,
 * decode-throughput, and path-sensitive compaction estimates collapse to
 * stable tokens.
 *
 * Throughput needs a token for the same reason durations do, and no fixture
 * can supply one: the figure divides a replayed step's output tokens by the
 * wall time the local run took to stream them, so it moves between two runs
 * on one machine (measured 69 → 70 tok/s) and swings wildly on a fast replay
 * (26333 tok/s for a 3 ms stream).
 */
function normalizeAria(snapshot: string, workspaceCwd: string): string {
  // The session heading renders the workspace's basename, not the full
  // path, so both spellings must collapse to the token.
  const base = workspaceCwd.split('/').pop()!
  return snapshot
    .split(workspaceCwd).join('{{cwd}}')
    .split(base).join('{{workspace}}')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{{uuid}}')
    // The optional space in `\d+m ?\d+s` covers both minute spellings: the
    // stats line's compact `2m42s` and the message-chrome template's `2m 42s`.
    .replace(
      /~\d+(?:y(?: \d+mo)?|mo(?: \d+d)?)|\b(?:\d+d(?: \d+h(?: \d+m \d+s)?)?|\d+h \d+m \d+s|\d+m ?\d+s|\d+(?:\.\d+)?s|\d+(?:\.\d+)?ms)\b/g,
      duration => duration.startsWith('~') ? duration : '{{duration}}',
    )
    .replace(/\b\d[\d,]*(?:\.\d+)? ms\b/g, '{{duration}}')
    .replace(
      /约\d+(?:年(?:\d+个月)?|个月(?:\d+天)?)|\d+(?:天(?:\d+小时(?:\d+分\d+秒)?)?|小时\d+分\d+秒|分\d+秒|(?:\.\d+)?秒)/g,
      duration => duration.startsWith('约') ? duration : '{{duration}}',
    )
    .replace(/\d+(?:\.\d+)?(?= tok\/s(?!\w))/g, '{{throughput}}')
    // Seeded compaction prices realized file paths, whose length differs
    // between local worktrees and CI scratch directories.
    .replace(/(Compacted \d+ history items \(~)\d+( tokens\))/g, '$1{{tokens}}$2')
    // Session summaries and Message IconActions clocks cross calendar
    // boundaries; collapse every shape so goldens stay stable across them.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '{{timestamp}}')
    .replace(/\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
    .replace(/\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
    .replace(/(?<!\d)\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*[AP]M)?(?!\d)/gi, '{{clock}}')
    .replace(/(?<!\d)\d{2}:\d{2}(?!\d)/g, '{{clock}}')
}

/**
 * Capture the region's aria snapshot at a settled milestone: poll until two
 * consecutive normalized captures are equal — a single-shot capture races the
 * last React commits.
 * @param page - the page under test.
 * @param selector - the region locator selector.
 * @param workspaceCwd - normalization input.
 * @returns the stable normalized snapshot.
 */
export async function captureStableAria(page: Page, selector: string, workspaceCwd: string): Promise<string> {
  const region = page.locator(selector).first()
  let previous = normalizeAria(await region.ariaSnapshot(), workspaceCwd)
  await expect.poll(async () => {
    const current = normalizeAria(await region.ariaSnapshot(), workspaceCwd)
    const stable = current === previous
    previous = current
    return stable
  }, { timeout: 5_000, message: 'aria snapshot did not stabilize' }).toBe(true)
  return previous
}

/**
 * Compare a normalized golden, or rewrite it under refresh. Refresh is the
 * ONLY writer: a missing golden in replay mode fails with the healing command
 * instead of silently self-bootstrapping.
 * @param goldenPath - the committed ui.expected.md path.
 * @param actual - the stable normalized snapshot.
 * @param mode - the active snapshot mode.
 */
export async function compareOrRefreshGolden(goldenPath: string, actual: string, mode: WebSnapshotMode): Promise<void> {
  const payload = `${actual}\n`
  if (mode === 'refresh') {
    await writeFile(goldenPath, payload)
    return
  }
  if (!existsSync(goldenPath)) {
    throw new Error(`missing golden ${goldenPath} — run DSH_SNAPSHOT=refresh pnpm run test:web to generate it`)
  }
  expect(payload).toBe(await readFile(goldenPath, 'utf8'))
}

/**
 * Fixture-inventory guard: the scenario directory holds exactly the expected
 * files and every committed JSONL is a scrub fixed-point without a run-local
 * browser RPC id.
 * @param dir - the scenario snapshot directory.
 * @param expected - the exact expected file inventory.
 */
export async function assertFixtureInventory(dir: string, expected: string[]): Promise<void> {
  const entries = (await readdir(dir)).sort()
  expect(entries).toEqual([...expected].sort())
  for (const entry of entries.filter(name => name.endsWith('.jsonl'))) {
    const content = await readFile(join(dir, entry), 'utf8')
    expect(scrubRequestHeaders(content), `${dir}/${entry} carries request-header bulk`).toBe(content)
    expect(content, `${dir}/${entry} carries a run-local rpcId`)
      .not.toMatch(/"rpcId":"(?!\{\{rpcId\}\})[^"]+"/)
  }
}

