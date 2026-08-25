/**
 * Package the desktop app: materialize the harness closure, rebuild native
 * addons for Electron's Node ABI, then run electron-builder.
 *
 * Stages, all under apps/desktop:
 * 1. `pnpm deploy` the dependency-only manifest at `closure/package.json`
 *    into `dist-closure/` (legacy hoisted layout — one real node_modules
 *    tree, no store links), then replace any remaining symlink with the
 *    target's content so the artifact is self-contained.
 * 2. Rebuild `node-pty` inside the closure against Electron's headers with
 *    `@electron/rebuild`: the packaged child runs under
 *    `ELECTRON_RUN_AS_NODE=1`, whose module ABI is Electron's.
 * 3. `electron-builder` per electron-builder.yml → `dist-packages/`.
 *
 * The packaged main process picks the staged runtime up through
 * `app.isPackaged` defaults in main.ts (`process.execPath` as the runtime,
 * `Contents/Resources/dsh-runtime` as the entry root); no env vars needed
 * for the shipped form.
 * @module package-desktop
 */

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { cpSync, existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(APP_ROOT, '../..')
const CLOSURE_OUT = join(APP_ROOT, 'dist-closure')
/** The bundle name electron-builder.yml produces; keep the two in sync. */
const PRODUCT_NAME = 'DeepSeek Harness'
/** The test-double group: its vitest/testing-library tooling is repo-only and never ships. */
const TEST_SUPPORT_ROOT = join(REPO_ROOT, 'packages', 'test-support')
/** Native addons that ship inside the closure; each needs Electron-ABI rebuild. */
const NATIVE_ADDONS = ['node-pty'] as const

/** Run one command, inheriting stdio; any failure ends the packaging run. */
function run(
  program: string,
  args: readonly string[],
  options: { cwd?: string; allowExitCodes?: readonly number[] } = {},
): void {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? APP_ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  })
  if (result.error !== undefined) throw result.error
  const allowed = options.allowExitCodes ?? []
  if (result.status !== 0 && !allowed.includes(result.status)) {
    throw new Error(`package: ${program} ${args.join(' ')} exited with ${String(result.status ?? result.signal)}`)
  }
}

/**
 * Copy every direct dependency the legacy hoister left beside the deploy
 * source instead of inside the target (workspace `link:` overrides behave
 * this way). Sources come from the repository root's node_modules, nested
 * node_modules excluded so one flat instance survives packaging.
 */
function restoreMissingDirectDeps(): void {
  const manifest = JSON.parse(readFileSync(join(CLOSURE_OUT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const destination = join(CLOSURE_OUT, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(REPO_ROOT, 'node_modules', dependency)
    if (!existsSync(source)) {
      throw new Error(`package: deployed dependency ${dependency} is absent from both ${destination} and ${source}`)
    }
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => !path.includes(`${dependency}/node_modules/`),
    })
    console.log(`package: restored ${dependency}`)
  }
}

/** Replace every symlink under `root` (recursively) with the target's content. */
function deSymlink(root: string): void {
  if (!existsSync(root)) throw new Error(`package: missing staged tree ${root}`)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      const target = resolve(root, readlinkSync(path))
      if (!existsSync(target)) throw new Error(`package: dangling symlink ${path} → ${target}`)
      rmSync(path)
      cpSync(target, path, { recursive: true, dereference: true, verbatimSymlinks: false })
      // The dereferenced copy can itself contain symlinks (nested peer
      // installs); walk the replacement when it is a directory.
      if (statSync(path).isDirectory()) deSymlink(path)
    } else if (entry.isDirectory()) {
      deSymlink(path)
    }
  }
}

/** The Electron version this checkout develops against, from the installed package. */
function electronVersion(): string {
  const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'node_modules/electron/package.json'), 'utf8')) as { version: string }
  return manifest.version
}

/** The CLI app whose dependency graph the closure must satisfy. */
const CLOSURE_ROOT_PACKAGE = '@deepseek-ai/dsh'
/**
 * Additional seeds: installable bundles declare their own plugin rows (the
 * manifests under the packages/bundle directory), and a packaged tree must
 * carry those packages even though the CLI itself never depends on them.
 */
const CLOSURE_BUNDLE_GLOB = 'packages/bundle/*'
/** Workspace globs from pnpm-workspace.yaml that hold resolvable packages. */
const WORKSPACE_GLOBS = ['packages/*/*', 'apps/*', 'vendor/*'] as const

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * Index every workspace package by name so the closure resolver can tell
 * workspace edges (pinned `workspace:*`) from registry edges (version range
 * preserved).
 */
function workspaceIndex(): Map<string, { dir: string; manifest: PackageManifest }> {
  const index = new Map<string, { dir: string; manifest: PackageManifest }>()
  for (const glob of WORKSPACE_GLOBS) {
    const [base, , leafPattern] = glob.split('/')
    const groups = readdirSync(join(REPO_ROOT, base), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
    for (const group of groups) {
      // Two-level globs enumerate leaf directories; one-level globs are the
      // group directory itself.
      const leafDirs = leafPattern === undefined
        ? [join(REPO_ROOT, base, group.name)]
        : readdirSync(join(REPO_ROOT, base, group.name), { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => join(REPO_ROOT, base, group.name, entry.name))
      for (const dir of leafDirs) {
        const manifestPath = join(dir, 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
        if (manifest.name !== undefined) index.set(manifest.name, { dir, manifest })
      }
    }
  }
  return index
}

/**
 * Compute the closure's dependency set from the CLI's live manifests:
 * dependencies plus peers of every reachable workspace package. Peer chains
 * are what a standalone tree must name explicitly — the repository satisfies
 * them through hoisting, the packaged flat node_modules cannot.
 */
/** Resolve the closure's dependency map against the current workspace manifests. */
export function computeClosureDependencies(existing: Record<string, string>): Record<string, string> {
  const index = workspaceIndex()
  const resolved: Record<string, string> = {}
  const queue = [CLOSURE_ROOT_PACKAGE]
  const bundleBase = CLOSURE_BUNDLE_GLOB.split('/')[0]
  for (const entry of readdirSync(join(REPO_ROOT, bundleBase), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(REPO_ROOT, bundleBase, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    if (manifest.name !== undefined) queue.push(manifest.name)
  }
  const visited = new Set<string>()
  while (queue.length > 0) {
    const name = queue.pop()!
    if (visited.has(name)) continue
    visited.add(name)
    const entry = index.get(name)
    if (entry === undefined) continue // registry package: nothing to expand
    // Workspace-scoped devDependencies ride along: a composition row can live
    // in a package's dev section (test/dev-only wiring such as extra search
    // providers), and a standalone tree must still resolve it. External dev
    // tooling never enters the closure, and neither do test-support roots:
    // their vitest/testing-library dependency sets are repo tooling, so a dev
    // or peer edge that reaches one stops there.
    const isTestSupport = (dependency: string): boolean =>
      index.get(dependency)?.dir.startsWith(TEST_SUPPORT_ROOT) ?? false
    const devWorkspaceEdges = Object.entries(entry.manifest.devDependencies ?? {})
      .filter(([dependency]) => index.has(dependency) && !isTestSupport(dependency))
    const edges = {
      ...entry.manifest.dependencies,
      ...entry.manifest.peerDependencies,
      ...Object.fromEntries(devWorkspaceEdges),
    }
    for (const [dependency, range] of Object.entries(edges)) {
      if (dependency === name) continue
      if (isTestSupport(dependency)) continue
      if (index.has(dependency)) {
        resolved[dependency] = 'workspace:*'
        queue.push(dependency)
      } else if (resolved[dependency] === undefined) {
        resolved[dependency] = range
      }
    }
  }
  // Keep hand-added entries (override targets and future explicit pins),
  // except test-support roots: a stale pin must not resurrect repo tooling
  // that the edge walk above deliberately stopped at.
  for (const [dependency, range] of Object.entries(existing)) {
    if (resolved[dependency] !== undefined || dependency === CLOSURE_ROOT_PACKAGE) continue
    if (index.get(dependency)?.dir.startsWith(TEST_SUPPORT_ROOT) ?? false) continue
    resolved[dependency] = range
  }
  resolved[CLOSURE_ROOT_PACKAGE] = 'workspace:*'
  return Object.fromEntries(Object.entries(resolved).sort(([a], [b]) => a.localeCompare(b)))
}

/** Rewrite the closure manifest with the computed, sorted dependency set. */
/** Regenerate `closure/package.json` from the live workspace manifests. */
export function writeClosureManifest(): void {
  const path = join(APP_ROOT, 'closure', 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> } & Record<string, unknown>
  const previousCount = Object.keys(manifest.dependencies ?? {}).length
  manifest.dependencies = computeClosureDependencies(manifest.dependencies ?? {})
  writeManifest(path, manifest)
  console.log(`package: closure manifest ${previousCount} → ${Object.keys(manifest.dependencies).length} dependencies`)
}

function writeManifest(path: string, manifest: unknown): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Run every packaging stage; see the module doc for the stage list. */
export function main(): void {
  rmSync(CLOSURE_OUT, { recursive: true, force: true })
  writeClosureManifest()

  // Stage 1: materialize the dependency-only closure. --legacy gives the
  // hoisted single node_modules tree the packaged runtime resolves through;
  // auto-install-peers fills the peer chains that the repository satisfies
  // through hoisting but a standalone tree must name explicitly.
  run('pnpm', [
    '--filter', '@deepseek-ai/dsh-desktop-closure', 'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=true',
    '--config.link-workspace-packages=true',
    CLOSURE_OUT,
  ], { cwd: REPO_ROOT })
  restoreMissingDirectDeps()
  deSymlink(join(CLOSURE_OUT, 'node_modules'))

  // Stage 2: native addon ABI for Electron-as-Node.
  for (const addon of NATIVE_ADDONS) {
    if (!existsSync(join(CLOSURE_OUT, 'node_modules', addon))) {
      throw new Error(`package: closure lacks native addon ${addon}`)
    }
  }
  run('pnpm', [
    'exec', 'electron-rebuild', '-f',
    '-m', CLOSURE_OUT,
    '-w', NATIVE_ADDONS.join(','),
    '-v', electronVersion(),
  ])

  // Stage 3: bundle per electron-builder.yml.
  rmSync(join(APP_ROOT, 'dist-packages'), { recursive: true, force: true })
  run('pnpm', ['exec', 'electron-builder'])
  // Stage 4 (macOS): drop the embedded asar-integrity seal. Builder writes
  // the Info.plist dict even for unsigned builds, but its enforcement path
  // needs a real signature chain — with `identity: null` the seal only makes
  // the app abort at GUI start before any JavaScript runs. Re-signing just
  // the main executable keeps the factory framework/helper signatures.
  if (process.platform === 'darwin') {
    const appPath = join(APP_ROOT, 'dist-packages', 'mac-arm64', `${PRODUCT_NAME}.app`)
    if (!existsSync(appPath)) throw new Error(`package: expected bundle missing at ${appPath}`)
    const plist = join(appPath, 'Contents', 'Info.plist')
    run('/usr/libexec/PlistBuddy', ['-c', 'Delete :ElectronAsarIntegrity', plist], { allowExitCodes: [1] })
    run('codesign', ['--force', '--sign', '-', join(appPath, 'Contents', 'MacOS', PRODUCT_NAME)])
  }

  console.log('package: artifacts in apps/desktop/dist-packages')
}
// CLI entry: importers (manifest regeneration) get the exported functions
// without triggering an electron-builder run.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
