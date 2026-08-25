# Agent Note: Subprocess terminal handle gains PTY resize

Status: implemented

English | [中文](2026-08-22-subprocess-terminal-resize.zh.md)

## Problem

`SubprocessTerminalHandle` could spawn a PTY at a fixed cell grid and write input, but could not resize it after spawn. An interactive terminal consumer needs to follow its viewport; without `resize`, every pane geometry change would require killing and respawning the shell.

## Decision

The seam grows `resize(cols, rows): Promise<void>` alongside `write`. The local node-pty provider resizes synchronously under the same promise-preserving contract as `write` (including the exited-handle rejection), and the E2B provider forwards to `sandbox.pty.resize(pid, {cols, rows})` inside its tracked-operation wrapper so termination still cancels in-flight resizes. Both providers reject on an already-exited terminal, matching `write`.

## Alternatives considered

**A respawn-on-resize convention in consumers.** Rejected: it loses shell state per geometry change and pushes substrate knowledge into every caller.

**An optional `resize?` member.** Rejected: capability seams carry complete contracts; optionality would force every consumer to branch on provider support.

## Consequences

Existing handle fakes gained the method, and any new `SubprocessTerminalHandle` implementation must provide real resizing or fail loud. Remote transports keep the async shape, so a future remote provider implements it without seam changes.

## Testing

The extended seam compiles across the local provider, the E2B provider, and every existing handle fake; subprocess and terminal-bash suites stay green (224 passed). Behavior-level resize coverage lands with its first consumer, the terminal-gateway plugin.
