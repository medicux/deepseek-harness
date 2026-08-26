// Child-process entry for the visual lane: boots the vitest lane's real
// scaffold (workspace sources need the tsx ESM hook for vendored `declare`
// fields that Playwright's own transpiler cannot parse), prints one JSON
// line with the base URL, and keeps the process alive until killed.
import { launchWebScaffold } from './scaffold.ts'

const scaffold = await launchWebScaffold({})
process.stdout.write(`DSH_VISUAL_SCAFFOLD ${JSON.stringify({ baseUrl: scaffold.baseUrl })}\n`)

/** Keep the event loop alive until the parent tears us down. */
setInterval(() => {}, 1 << 30)
