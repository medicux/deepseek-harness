# @deepseek-ai/dsh-client-ui-terminal

English | [中文](README.zh.md)

Browser half of the interactive user terminal: an xterm.js panel registered into ui-layout's root-scoped `workbench` slot (the column's first occupant). Expanding the workbench opens one gateway session (`/api/terminal.open`); output streams from `/api/terminal.stream` as base64 SSE chunks straight into the emulator, keystrokes forward verbatim to `/api/terminal.write` with the PTY owning echo and line discipline, and a ResizeObserver keeps the grid on the rendered viewport via `/api/terminal.resize`. Closing the column only hides the view: one session lives for the panel's lifetime, so reopening resumes the same shell with its PTY scrollback intact, and an exited shell respawns on the next expansion, and a full page reload resumes the same shell by presenting its sessionStorage-cached id for adoption — output buffered while the page was away replays into the fresh emulator. The xterm stylesheet is vendored verbatim (provenance header in `src/client/xterm.css`) so the bundle stays inside the `?inline` CSS loader path.

## Model Experience

None, as the package renders the browser terminal view; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The cached session id is per browser tab** — adoption reads `sessionStorage`, so a duplicated tab presents the same id and both views attach to one shell; keystrokes from either tab land in the same PTY. Moving the cache to per-view storage is deferred until a consumer needs it.
