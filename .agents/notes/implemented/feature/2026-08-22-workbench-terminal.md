# Agent Note: Workbench terminal — the first column occupant

Status: implemented

English | [中文](2026-08-22-workbench-terminal.zh.md)

## Problem

The workbench column shipped unoccupied by design, and the terminal gateway had no client: nothing rendered a live shell, so the fourth column remained invisible and the gateway routes had no caller.

## Decision

[`packages/client/ui-terminal`](../../../../packages/client/ui-terminal/README.md) registers an xterm.js panel into ui-layout's root-scoped `workbench` slot. Expanding the column opens one gateway session and binds it for the panel's mounted lifetime: output streams from `/api/terminal.stream` as base64 SSE frames decoded straight into the emulator, keystrokes forward verbatim to `/api/terminal.write` (the PTY owns echo and line discipline), and a ResizeObserver drives `/api/terminal.resize` through the fit addon's proposed grid, skipping no-op resizes. Closing the column only hides the view: one gateway session lives for the panel's lifetime, so re-expanding resumes the same shell with its PTY scrollback intact, and an exited shell respawns on the next expansion. The xterm stylesheet is vendored verbatim with a provenance header so the bundle stays inside the shared tsdown preset's supported `?inline` CSS path; the host-side stub package composes both halves through one cordis row (`ui-terminal` alongside `terminal-gateway` in the web-app patch).

## Alternatives considered

**Auto-open the workbench on plugin mount.** Rejected: visibility changes belong to `ctx.layout` callers, and an unprompted shell spawn on every GUI load is surprising; the column opens when the user asks.

**EventSource instead of fetch-streaming the SSE.** Rejected: EventSource auto-reconnects into a dead session id and cannot distinguish exit from transport drop; the manual reader owns retry policy.

**Render without xterm via a pre + hidden input.** Rejected: hand-rolling terminal emulation where the maintained emulator exists violates the dependencies-over-hand-rolling policy.

## Consequences

The workbench slot now has a real occupant, so its owner-share contract (`collapsed`/`width`) is load-bearing: the panel keeps the PTY, scrollback, and output stream alive behind a closed column, and a zero-measured host must never reach the fit addon's proposal because its 2x1 floor would otherwise resize the hidden PTY. A full page reload resumes the running shell: the panel caches the session id in sessionStorage and presents it to `open`, whose adopt-first path returns the live session without spawning — unknown or exited ids fall through to a fresh spawn in the same request, so stale caches self-heal; and the gateway’s rolling output history replays into the fresh emulator, reconstructing the scrollback. Because sessionStorage is copied when a tab is duplicated, a duplicate adopts the original’s session: fan-out carries the extra reader, but interleaved keystrokes from both views are accepted by design. The vendored stylesheet must be re-copied on xterm upgrades.

## Testing

The apply spec pins the slot contract: registration lands in the declared root-scoped single slot with the shipped component, and a plugin-free context leaves the same declared slot empty. Transport behavior (replay order, chunk decoding, exit handling, resize passthrough) is owned by the gateway's route specs over a real loopback server, and `tests/terminal-panel.client.spec.tsx` pins the client lifetime over fetch/xterm/ResizeObserver doubles: single spawn at first expansion, nothing closed across collapse, geometry held at zero measurements, fresh spawn after shell exit, reload adoption of the cached id (plus stale-id fall-through and cache update), and close-with-keepalive on subtree destruction. The workbench terminal flow also runs as a keyless live lane against the real composition (`apps/web/tests/workbench-terminal.e2e.ts`): collapse/reopen with one spawn and zero closes, respawn after exit detected via the SSE response ending, and a real `page.reload()` whose reopen adopts the live session — one more open post, two distinct sessions total — with the pre-reload screen returning through buffered replay.
