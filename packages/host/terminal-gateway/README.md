# @deepseek-ai/dsh-host-terminal-gateway

English | [中文](README.zh.md)

Host plugin serving the GUI's interactive user terminal over `/api/terminal.*` routes. It spawns plain user shells through the subprocess capability's PTY seam (`ctx.subprocess.spawnTerminal`) — the operator's `$SHELL` with full user rights by default, `config.shell` to pin an argv override — and streams raw PTY output to the browser as Server-Sent Events of base64 chunks, so the surface works identically over TCP and the desktop stdio carriage. Session ids are branded UUIDs minted at open; `open` also accepts an optional cached id and adopts a still-live session instead of spawning (unknown or exited ids fall through to a fresh spawn), which is what makes page reloads resume the same shell with the session’s rolling output history replayed into the fresh view; unary routes answer JSON, unknown sessions answer 404, oversized writes answer 413 under fixed wire bounds (`MAX_WRITE_BYTES`, body cap). Every attaching stream first receives a bounded rolling history of all session output (~512 KiB), so reattaching consumers reconstruct the scrollback across subscriber generations. Disposal unregisters the routes and terminates every live session; each session's stream ends with an `exit` SSE event when its shell exits. The client half (xterm-based workbench occupant) registers into the frame's `workbench` slot.

## Model Experience

None, as the package hosts PTY sessions behind HTTP routes; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Replay history is bounded, not complete scrollback** — every attaching stream receives the retained rolling history (~512 KiB); chunks evicted by the cap are gone, so a client reattaching after very heavy output rebuilds a truncated view. A durable server-side scrollback store remains deferred work.
