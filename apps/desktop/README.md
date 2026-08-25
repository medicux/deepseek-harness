# dsh desktop

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` is the Electron desktop shell: it shows the DeepSeek Harness web UI in a native window. The shell owns native-window lifetime and the supervised server's process lifetime — nothing else. The harness composition, the HTTP carriage, and the web client all stay owned by their existing surfaces.

## How the window gets its UI

The main process spawns the real `dsh --profile web --carrier stdio` surface as a supervised child (`src/launch.ts`, `src/server-process.ts`) and reads its readiness line — `dsh web-stdio: ready`, the stdio-carrier signal of [the web-app bundle](../../packages/bundle/web-app/src/index.ts). The child binds no socket: requests and responses ride NDJSON frames on file descriptors 3 and 4 ([frames.ts](src/frames.ts), mirroring the webserver's wire contract). The renderer never touches a network stack at all: the preload installs the `__DSH_IPC_CARRIER__` seat ([preload.ts](src/preload.ts)), the connection package's selection sees it and swaps `WebApiClient` for `DesktopIpcApiClient` plus a bridge-backed Connection RPC caller, and [carrier.ts](src/carrier.ts) answers unary posts and pumps both event streams over per-stream IPC channels, forwarding to the child through the frame channel. The window loads `dsh://app/` — a privileged custom scheme ([protocol.ts](src/protocol.ts)) whose handler forwards every request to the child main-process-side — so the renderer never learns an authority of any kind: HTML, static bundles, boot manifest, and plugin packages all arrive through the forward, and the child stays the sole composition owner. `DSH_DESKTOP_CARRIER=tcp` restores the loopback listener for diagnosis; in that mode the shell talks plain `fetch` to the reported URL instead of frames.

This is the staged plan of [the Electron desktop-shell Agent Note](../../.agents/notes/implemented/feature/2026-08-22-electron-desktop-shell.md) delivered: the page-side socket count is zero and the child's listener is gone by default, while the supervision seam keeps small modules between Electron and the harness:

| Module | Contract |
|---|---|
| `launch.ts` | Resolves the spawn target: repository source launch through tsx by default; a packaged `dsh` executable through `DSH_DESKTOP_SERVER_BIN`; an explicit Node runtime through `DSH_DESKTOP_NODE_BIN`. |
| `readiness.ts` | Pure parser over accumulated stdout: finds the readiness URL line among sibling announcements. |
| `server-process.ts` | One supervised child: spawn → readiness → bounded-stop escalation (SIGTERM, then SIGKILL after a grace period); failures carry an output tail. |
| `watchdog.ts` | Parent-death guard: the server runs under a stock-Node watchdog that terminates it within one second of the shell disappearing for any reason — Electron cannot deliver SIGTERM to JavaScript reliably, so teardown never depends on it. |

## Running

```sh
pnpm install                     # once; downloads the Electron runtime
pnpm run build                   # builds lib/types and bundles lib/main.js
electron apps/desktop            # or: pnpm --filter @deepseek-ai/dsh-desktop run start
```

A second launch focuses the existing window instead of booting a second harness stack (single-instance lock).

### Configuration

| Variable | Effect |
|---|---|
| `DSH_DESKTOP_SERVER_BIN` | Spawn this `dsh` executable instead of the repository source launch (the packaged-build path). Flags stay identical. |
| `DSH_DESKTOP_NODE_BIN` | Node binary running the source launch; defaults to `node` from `PATH`. |
| `DSH_DESKTOP_CARRIER` | Set to `tcp` to restore the child's loopback listener and the shell's fetch path (diagnosis only; the stdio frame carrier is the default). |
| `DSH_DESKTOP_READY_TIMEOUT_MS` | Readiness budget in milliseconds; default 120000. A non-numeric value fails loud. |
| `DSH_DESKTOP_DEBUG` | Set to `1` to trace desktop lifecycle transitions (ready, stop requests) on stderr. |

## Window chrome and desktop integration

The window is frameless-but-native: content sits flush with the top edge (Codex-style), macOS traffic lights float over the sidebar's brand row, and platforms without native controls get a small injected overlay. The client marks its header rows with `data-dsh-window-drag` (inert in browsers); the shell turns them into the drag region via injected CSS, keeping every interactive descendant clickable. Desktop IPC covers exactly two surfaces: the minimal window-control bridge and the IPC carrier above; the standard application menu supplies the Edit roles that make Cmd+C/Cmd+V work in the composer.

Drag-and-drop attachment and clipboard paste are client features the desktop window inherits unchanged: dropping files anywhere attaches images to the composer (the page's own drop handlers run; the shell only suppresses file-navigation), and pasting image data uses the same path.

## Packaging

`pnpm --filter @deepseek-ai/dsh-desktop run package` builds an installable app per [electron-builder.yml](electron-builder.yml):

1. **Closure** — the script regenerates the dependency-only manifest at [`closure/package.json`](closure/package.json) from live workspace manifests (dependencies, peers, and workspace-scoped dev dependencies of the CLI plus every installable bundle — the packages a standalone tree must resolve for composition rows), then `pnpm deploy --legacy --prod` materializes it into `dist-closure/` and every symlink is replaced with file content. The same shape as the Python SDK runtime's deploy root.
2. **Native ABI** — `@electron/rebuild` rebuilds `node-pty` inside the closure against Electron's headers, because the packaged child runs under `ELECTRON_RUN_AS_NODE=1`: Electron's own binary doubles as plain Node, so no second runtime ships inside the app.
3. **Bundle** — electron-builder emits `dist-packages/` artifacts (.dmg/.zip on macOS arm64, .AppImage/.deb on Linux).

The packaged main process detects installation through `app.isPackaged` and launches the staged runtime without env vars; development checkouts keep the tsx source launch.

## Lifecycle rules

- Quitting everywhere closes the window **and** stops the server, including on macOS: this window is the whole product surface, and a dock-resident shell whose backend has exited would only serve connection errors.
- A server death after readiness fails loud through a modal dialog; a silent blank window would hide the harness failure.
- Stop escalation is bounded: SIGTERM first so the harness can dispose its tree, SIGKILL after the grace period.

## Model / token / KV-cache experience

The shell adds no model-visible content and no session-log events: it renders the same web client over the same wire protocol as `dsh web`. Sessions, prompts, and tool behavior are identical to the browser surface; the model cannot observe whether the client is Electron or a browser tab.

## Known Limitations and Deferred Work

- **Release signing and CI legs are deferred.** `pnpm run package` produces local artifacts with an ad-hoc macOS identity (`identity: null`); notarized release signing and per-target CI legs are the remaining distribution work. Icons fall back to the Electron default until a designed set lands.
- **Server logs land in the platform log directory** (`~/Library/Logs/@deepseek-ai/dsh-desktop/dsh-web-server.log` on macOS, the equivalent per-app `logs/` location elsewhere): the shell mirrors the child's stdout/stderr there in addition to the launching terminal.
