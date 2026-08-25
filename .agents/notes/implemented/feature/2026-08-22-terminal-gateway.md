# Agent Note: Terminal gateway — the user shell behind the workbench

Status: implemented

English | [中文](2026-08-22-terminal-gateway.zh.md)

## Problem

The GUI's new workbench column had no occupant, and the harness had no server surface a live terminal could ride: the existing terminal capability is agent-shaped (owner-session fencing, sandbox policy, bounded per-command reads, fixed PTY size), while an interactive terminal needs raw keystroke writes, viewport-driven resize, and continuous output streaming. Without a gateway, the workbench column stays an empty contract.

## Decision

[`packages/host/terminal-gateway`](../../../../packages/host/terminal-gateway/README.md) registers five exact `/api/terminal.*` routes on the webserver: `open` spawns the operator's `$SHELL` (full user rights — VS Code integrated-terminal semantics; the sandboxed agent-terminal seam is deliberately not reused) via `ctx.subprocess.spawnTerminal` and adopts an optional cached still-live id instead of spawning (stale ids fall through to a fresh spawn in the same request), `write` delivers raw keystroke text under a fixed 64 KiB bound, `resize` forwards viewport changes through the seam's new `resize`, `close` terminates one session, and `stream` answers Server-Sent Events of base64 output chunks so the transport is carrier-agnostic (TCP and the desktop stdio carriage behave identically). Every exact route applies the connection plugin's browser-trust fence (`isTrustedApiRequest` over a shared `trustedHosts` config) because exact paths bypass the `/api` prefix gate by dispatch precedence — a spoofed cross-site Host answers 403 before any shell is touched. Sessions are branded UUIDs with a bounded rolling output history (~512 KiB) that every attaching stream receives in full, so reloads reconstruct the scrollback rather than only the detached window; headers flush eagerly so a silent session still completes the client's fetch; every stream ends with an `exit` event; disposal terminates all live sessions. The client half — an xterm-based plugin registering into the `workbench` slot — lands next.

## Alternatives considered

**Reuse the agent terminal capability (`dsh-terminal`).** Rejected: it fences on an owner Agent session and resolves sandbox policy, both meaningless for a user-owned shell; its sanitizer and bounded reads are tuned for model consumption.

**A MuxFrame union extension riding the session event downlink.** Rejected: terminal output is not session-log content and would drag a high-frequency channel into a union shared with conversation streaming.

**The connection package's generic RPC channel.** Rejected: it has no consumers yet; explicit named routes keep the terminal's wire shape inspectable and trust-fenced like every other `/api` path.

## Consequences

Every `/api/terminal.*` request executes arbitrary shell commands as the desktop user by design — the route family inherits the webserver's trust fence and must never be exposed beyond loopback or the supervised stdio carriage. The subprocess PTY seam now carries `resize`, which any future handle implementation must provide. The gateway holds one PTY per open session for the plugin's lifetime; unbounded session counts are capped only by the OS until a client-side limit proves necessary.

## Testing

Route specs drive a real loopback HTTP server over a fake PTY handle: spawn spec shape (argv override, home cwd, client viewport), the schemastery-normalized empty shell override resolving to `$SHELL` instead of a program-less argv, live-id adoption without spawning plus stale-id fall-through, rolling history reaching later subscriber generations (attached-era and detached-era chunks alike), live base64 chunk delivery plus the exit event ending the stream, write/resize passthrough with the 413 payload bound, close-then-404, unknown-session 404s across routes, dispose terminating every live session, and a spoofed Host answering 403 on every unary route.
