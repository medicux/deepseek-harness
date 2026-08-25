/**
 * Launch-target resolution for the desktop shell's supervised server.
 *
 * The shell never assembles the harness composition itself: it spawns the
 * real `dsh --profile web` surface, so the shipped bundle stack, user patch
 * layers, HMR watch, and trust fence stay owned by the CLI app. The default
 * target is the repository's source launch (`node --import tsx/esm
 * apps/cli/src/bin.ts`), the same launcher the `pnpm dsh` script uses.
 * Packaged builds replace only the program — a `dsh` executable from
 * `DSH_DESKTOP_SERVER_BIN`, optionally a specific Node runtime through
 * `DSH_DESKTOP_NODE_BIN` — while the flag set stays identical, because both
 * targets accept the same launcher and web-app flags.
 * @module @deepseek-ai/dsh-desktop/launch
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** One resolved spawn target for the supervised server. */
export interface LaunchTarget {
  /** Program plus arguments, in argv order; spawned without a shell. */
  command: readonly string[]
  /**
   * Working directory for the child when it must differ from the caller's
   * default ({@link SERVER_CWD}); the packaged runtime entry names its own
   * deploy root so profile resources resolve beside the closure.
   */
  cwd?: string
  /**
   * Extra child environment this target requires, merged over the parent
   * environment by the caller. The source launch pins tsx's tsconfig path so
   * the workspace `paths` facade applies regardless of the child's cwd.
   */
  env?: Readonly<Record<string, string>>
}

/** The working directory every launch hands to the child: the repository root. */
export const SERVER_CWD = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * Flags every desktop launch passes to `dsh`: the web profile, no
 * default-browser handoff (this shell is the browser), and an OS-assigned
 * port so a concurrently running `dsh web` can never collide. Launcher flags
 * come first; `--no-open` and `--port` are unrecognized by the launcher and
 * therefore reach the booted tree verbatim.
 */
const SERVER_FLAGS = ['--profile', 'web', '--no-open'] as const

/**
 * Carrier flags appended after the shared flags. The desktop shell defaults to
 * the stdio carrier — the child binds no socket and frames ride fds 3/4;
 * `DSH_DESKTOP_CARRIER=tcp` restores the loopback listener (the pre-stdio
 * fallback) for diagnosis.
 * @param env - environment providing the optional override.
 */
function carrierFlags(env: NodeJS.ProcessEnv): readonly string[] {
  return env.DSH_DESKTOP_CARRIER === 'tcp' ? ['--port', '0'] : ['--carrier', 'stdio']
}

/**
 * Resolve how to spawn the supervised `dsh web` surface.
 *
 * Default (repository checkout): the system `node` from `PATH` running the
 * CLI source through tsx's ESM-only hook, with the tsx entry resolved as an
 * absolute URL anchored at this repository so resolution does not depend on
 * the Electron process' cwd.
 *
 * Packaged builds have two equivalent shapes. `DSH_DESKTOP_SERVER_BIN` names
 * a standalone `dsh` executable (optionally under a specific runtime via
 * `DSH_DESKTOP_NODE_BIN`). The shipped packaging instead sets both
 * `DSH_DESKTOP_RUNTIME_BIN` (the Electron binary) and
 * `DSH_DESKTOP_SERVER_ENTRY` (the deployed CLI's `bin.js`): the child runs
 * with `ELECTRON_RUN_AS_NODE=1`, so no separate Node ships inside the app,
 * and the flag set stays identical across every shape.
 * @param env - environment providing the optional overrides; defaults to `process.env`.
 * @returns the spawn-style command for the server process.
 */
export function resolveLaunchTarget(env: NodeJS.ProcessEnv = process.env): LaunchTarget {
  const nodeBin = env.DSH_DESKTOP_NODE_BIN || 'node'
  const runtimeBin = env.DSH_DESKTOP_RUNTIME_BIN ?? ''
  const serverEntry = env.DSH_DESKTOP_SERVER_ENTRY ?? ''
  if (runtimeBin !== '' && serverEntry !== '') {
    return {
      // Electron-as-Node accepts plain Node argv; --expose-internals is what
      // the vendored loader gates its internal-module hooks on, which the
      // web profile's HMR service requires.
      command: [runtimeBin, '--expose-internals', serverEntry, ...SERVER_FLAGS, ...carrierFlags(env)],
      // The deployed CLI's deploy root four levels above its package entry:
      // profile config and the healed node_modules fallback resolve beside it.
      cwd: resolve(dirname(serverEntry), '../../../..'),
      // Electron's binary doubles as plain Node under this switch; without it
      // spawning it would open a second GUI instead of running the CLI.
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  const serverBin = env.DSH_DESKTOP_SERVER_BIN ?? ''
  if (serverBin !== '') return { command: [serverBin, ...SERVER_FLAGS, ...carrierFlags(env)] }
  const require = createRequire(join(SERVER_CWD, 'package.json'))
  const tsxEntry = pathToFileURL(require.resolve('tsx/esm')).href
  return {
    command: [
      nodeBin,
      '--import', tsxEntry,
      join(SERVER_CWD, 'apps/cli/src/bin.ts'),
      ...SERVER_FLAGS,
      ...carrierFlags(env),
    ],
    // tsx resolves bare workspace imports through the repository's tsconfig
    // `paths` facade only when it knows which tsconfig to read; cwd-relative
    // discovery breaks the moment the child runs outside the checkout.
    env: { TSX_TSCONFIG_PATH: join(SERVER_CWD, 'tsconfig.base.json') },
  }
}
