/**
 * dsh desktop — Electron main process.
 *
 * The shell owns native-window lifetime and the supervised server's process
 * lifetime, nothing else: it spawns the real `dsh --profile web` surface
 * (see launch.ts), waits for the readiness line (see server-process.ts), and
 * loads the window from `dsh://app/` (see protocol.ts) — the scheme handler
 * forwards every request to the supervised server, so the renderer never
 * learns a TCP authority. API traffic rides the preload-installed IPC carrier
 * (see packages/client/connection desktop-carrier); the window-control bridge
 * (see preload.ts) is the only other renderer IPC.
 *
 * Window chrome: the native title bar is removed (`hiddenInset` on macOS,
 * `hidden` elsewhere) so content sits flush with the top edge, Codex-style.
 * The client's marked header rows become the drag region via injected CSS,
 * and platforms left without native controls get a small injected overlay.
 *
 * Lifecycle rules:
 * - Quitting everywhere closes the window and stops the server, including on
 *   macOS: this window IS the product surface, and a dock-resident shell
 *   whose backend has exited would only serve errors.
 * - An unexpected server death after readiness fails loud through a dialog;
 *   a silent blank window would hide the harness failure.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { createWriteStream } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WriteStream } from 'node:fs'
import { SERVER_CWD, resolveLaunchTarget } from './launch.ts'
import { DshServerProcess } from './server-process.ts'
import { wrapWithParentDeathWatchdog } from './watchdog.ts'
import {
  DRAG_REGION_CSS,
  TOP_STRIP_CSS,
  WINDOW_CONTROLS_CSS,
  applyWindowOp,
  buildTopStripScript,
  buildWindowControlsScript,
} from './window-chrome.ts'
import { registerDesktopCarrier, resetDesktopCarrier } from './carrier.ts'
import { DESKTOP_APP_URL, installDesktopProtocol, registerDesktopScheme, resetDesktopProtocol } from './protocol.ts'
import { trace } from './trace.ts'

// Privileged-scheme registration must precede app ready.
registerDesktopScheme()

/** Absolute path of the built CommonJS preload (sandboxed preloads cannot be ESM). */
const PRELOAD_PATH = fileURLToPath(new URL('./preload.cjs', import.meta.url))

/** Environment override for the readiness budget; milliseconds. */
const READY_TIMEOUT_ENV = 'DSH_DESKTOP_READY_TIMEOUT_MS'
/** Default readiness budget: a cold profile boot stays well inside one minute. */
const DEFAULT_READY_TIMEOUT_MS = 120_000

/** The single supervised server; assigned once the app is ready. */
let server: DshServerProcess | undefined
/** The one product window; recreated on macOS dock activation. */
let window: BrowserWindow | undefined
/** Set once a quit has been requested, so late exits stop surprising the user. */
let quitting = false
/** Append-only mirror of the server child's output; closed on quit. */
let serverLog: WriteStream | undefined

/**
 * Open the server log beside the platform's per-app log directory. Packaged
 * builds have no launching terminal: this file is the only place the child's
 * startup failures and runtime stderr remain readable.
 */
function openServerLog(): WriteStream {
  const dir = app.getPath('logs')
  mkdirSync(dir, { recursive: true })
  const stream = createWriteStream(join(dir, 'dsh-web-server.log'), { flags: 'a' })
  trace(`server log ${join(dir, 'dsh-web-server.log')}`)
  return stream
}

/** Parse the readiness-budget override; a non-numeric value is a loud misconfiguration. */
function resolveReadyTimeoutMs(): number {
  const raw = process.env[READY_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return DEFAULT_READY_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`dsh-desktop: ${READY_TIMEOUT_ENV} must be a positive number of milliseconds, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

/**
 * Install the application menu. Standard Edit roles are load-bearing for the
 * product: without them macOS never delivers Cmd+C/Cmd+V into the composer,
 * which would silently break paste. View roles keep reload and DevTools
 * reachable during development; nothing here is desktop-only product surface.
 *
 * The "Settings…" item on darwin is the system-wide macOS convention: the
 * app menu (under the app name) gains a `Cmd+,` accelerator that opens
 * preferences. The click forwards to the focused window's renderer, where
 * SettingsRoot listens for the resulting `dsh-desktop:open-settings` event.
 */
function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => { window?.webContents.send('dsh-desktop:open-settings') },
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    { role: 'fileMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' }] : []),
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => { window?.webContents.send('dsh-desktop:open-settings') },
        },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]))
}

/** Handle one window-control request from the renderer bridge. */
function onWindowOp(op: unknown): void {
  if (window === undefined) return
  try {
    applyWindowOp(window, op)
  } catch (error) {
    // A foreign value crossed the IPC boundary: log it, never crash the shell.
    trace(`rejected window operation: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Environment for the packaged form: when running from an installed bundle,
 * the harness runtime is the deploy staged under Resources, and the runtime
 * binary is this very Electron executable. Development ignores all of this.
 */
function packagedLaunchOverrides(): NodeJS.ProcessEnv | undefined {
  if (!app.isPackaged) return undefined
  const resources = process.resourcesPath
  const serverEntry = join(resources, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  trace(`packaged launch entry ${serverEntry}`)
  return {
    DSH_DESKTOP_RUNTIME_BIN: process.execPath,
    DSH_DESKTOP_SERVER_ENTRY: serverEntry,
    // The parent-death watchdog runs under plain Node semantics; no system
    // Node may exist on an end-user machine, so the Electron binary doubles
    // as it (ELECTRON_RUN_AS_NODE rides in the launch target's base env).
    DSH_DESKTOP_NODE_BIN: process.execPath,
  }
}

/** Show a modal failure and end the app; every startup failure funnels here. */
function failLoud(title: string, detail: string): void {
  dialog.showErrorBox(title, detail)
  app.quit()
}

/**
 * Stop the server and quit. Idempotent: the closing path can arrive from the
 * window, the quit menu, and the server's own death in any order.
 */
async function stopServerAndQuit(): Promise<void> {
  trace(`stop requested (quitting=${String(quitting)})`)
  quitting = true
  await server?.stop()
  trace('server stopped; calling app.quit()')
  app.quit()
}
/** Create the product window; the carrier and app-scheme surfaces are already installed. */
function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness',
    show: false,
    backgroundColor: '#1b1b1f',
    // Frameless-but-native: content flush to the top, traffic lights floating
    // over the sidebar's brand row on macOS, no bar anywhere.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: { preload: PRELOAD_PATH },
  })
  window.once('ready-to-show', () => { window?.show() })
  // The web client is a single-page application served by the supervised
  // origin: navigation away and popups are never product flows. External
  // http(s) links open in the system browser instead.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://') || target.startsWith('http://')) void shell.openExternal(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => { event.preventDefault() })
  // The product title stays the shell's: the served page's <title> must not
  // rename the window (dock, mission control, dialog wording).
  window.on('page-title-updated', (event) => { event.preventDefault() })
  window.webContents.on('dom-ready', () => {
    void window?.webContents.insertCSS(DRAG_REGION_CSS)
    // The flush top drag edge runs on every platform: it carries the brand
    // row's dropped padding and the 6px grab hairline across both columns.
    void window?.webContents.insertCSS(TOP_STRIP_CSS)
    void window?.webContents.executeJavaScript(buildTopStripScript())
    // Platforms whose controls vanished with the title bar get an overlay;
    // macOS keeps its native traffic lights over the drag region.
    if (process.platform !== 'darwin') {
      void window?.webContents.insertCSS(WINDOW_CONTROLS_CSS)
      void window?.webContents.executeJavaScript(buildWindowControlsScript())
    }
  })
  window.on('closed', () => { window = undefined })
  window.loadURL(DESKTOP_APP_URL).catch((error: unknown) => {
    trace(`page load failed: ${String(error instanceof Error ? error.message : error)}`)
  })
}

void app.whenReady().then(async () => {
  installMenu()
  ipcMain.on('dsh-desktop:window', (_event, op: unknown) => { onWindowOp(op) })
  // The renderer-facing surfaces are process-global, so they install exactly
  // once at startup — never per window — and their getters resolve the server
  // lazily, so installing before the child exists is fine.
  registerDesktopCarrier(() => server?.url, () => server?.channel)
  installDesktopProtocol(() => server?.url, () => server?.channel)
  try {
    serverLog = openServerLog()
    const readyTimeoutMs = resolveReadyTimeoutMs()
    const target = wrapWithParentDeathWatchdog(resolveLaunchTarget({ ...process.env, ...packagedLaunchOverrides() }))
    const supervised = new DshServerProcess({
      command: target.command,
      cwd: target.cwd ?? SERVER_CWD,
      readyTimeoutMs,
      env: { ...process.env, ...target.env },
      onOutput: (chunk) => { serverLog?.write(chunk) },
      onExit: (exit) => {
        if (quitting) return
        void stopServerAndQuit()
        failLoud(
          'DeepSeek Harness exited unexpectedly',
          `The background dsh web process terminated (code ${String(exit.code)}, signal ${String(exit.signal)}). `
          + 'Check the terminal output for its log tail, then start the app again.',
        )
      },
    })
    server = supervised
    const ready = await supervised.start()
    trace(ready.kind === 'tcp' ? `server ready at ${ready.url}` : 'server ready over the stdio carrier (no listening socket)')
    createWindow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    trace(`startup failed: ${message}`)
    failLoud('Could not start DeepSeek Harness', message)
  }
})

// The single-instance lock and Chromium storage live under the userData dir;
// an isolated launch (QA, second profile) redirects it before the lock is
// requested so a parallel instance boots its own stack instead of focusing.
const USER_DATA_ENV = 'DSH_DESKTOP_USER_DATA'
const userDataOverride = process.env[USER_DATA_ENV]
if (userDataOverride !== undefined && userDataOverride !== '') app.setPath('userData', userDataOverride)

// A second launch means the user asked for the app again: surface the
// existing window instead of booting a second harness stack.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  // No macOS activate-recreate: quitting everywhere is the lifecycle
  // contract, so once the last window closes the carrier, protocol, and
  // server surfaces are already winding down — a dock click must not open a
  // window onto a torn-down shell.
  app.on('window-all-closed', () => {
    resetDesktopCarrier()
    resetDesktopProtocol()
    void stopServerAndQuit()
  })

  // External SIGTERM/SIGINT never reaches JavaScript here (Chromium reaps
  // them first), which is exactly why the server child runs under the
  // parent-death watchdog: teardown cannot depend on this process staying
  // alive long enough to clean up.
  app.on('before-quit', () => {
    quitting = true
    serverLog?.end()
    serverLog = undefined
  })
}
