# Agent Note: Desktop shell security-posture pinning, navigation policy, and bounded teardown

Status: implemented

English

- **Area:** desktop shell · security · lifecycle
- **Related:** [Electron desktop shell design](../bug-fix/2026-08-26-desktop-shell-carrier-chrome-and-loopback-defects.md) · [desktop shell review and priorities](../process/2026-08-26-desktop-shell-review-and-priorities.md)

## Problem

The desktop shell shipped with three latent risks that the QA lane could not surface without an explicit review pass:

1. `webPreferences` relied on Electron defaults: `sandbox`, `contextIsolation`, `nodeIntegration`, and `webSecurity` were never set explicitly, so a future Electron version or a config regression that flips a default would silently widen the renderer's attack surface on a privileged `dsh://app/` origin.
2. `setWindowOpenHandler` used `target.startsWith('https://')` to decide what to hand to the OS. A scheme like `https-evil://` (or any `https-something:` scheme) bypasses the check while still being a distinct origin that should never reach the system browser. The same flaw applied to the `http` check.
3. `DshServerProcess.#escalatingStop` called `#exitWithin(undefined)` after SIGKILL, resolving only when the child's `exit` event fires. A process stuck in an uninterruptible kernel wait (D-state) never exits; `app.quit()` — already a best-effort Chromium reap — would then wait indefinitely, stranding the shell.

## Decision

**Pin the renderer security posture explicitly.** The `webPreferences` block now sets `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true` so the contract is enforced by the source, not by Electron's defaults. The preload continues to run as the only bridge, and the sandbox means renderer-origin scripts have no Node surface at all.

**Parse URLs, never `startsWith`.** `shouldOpenExternal` in `window-chrome.ts` runs `new URL(target)` and accepts only `http:` / `https:` protocols. A scheme-sharing look-alike (`https-evil:`) parses to a different protocol and is rejected. Every other scheme — `file:`, `javascript:`, `data:`, or an unparseable string — is denied.

**Bound SIGKILL reaping.** After SIGTERM→SIGKILL escalation, `#exitWithin` now waits at most `SIGKILL_REAP_TIMEOUT_MS` (2s). If the child is unkillable, `stop()` resolves anyway and `app.quit()` proceeds; a logged trace marks the timeout for diagnosis. The `#exitWithin` signature narrows to `number` (no more `undefined` = wait forever), making the bound a type-level invariant rather than a convention.

**Navigation policy left as a blanket block with a clarifying comment.** The initial review suggestion (allow same-origin `dsh://app/*` navigation through `will-navigate`) was tested and rejected: the web client is a pushState SPA, so `will-navigate` only ever fires on full-document loads the app never initiates. Allowing any `dsh://` navigation would let page script full-reload the document. The unconditional `preventDefault()` is the correct posture; the comment documents why.

## Tests

- `shouldOpenExternal` unit tests assert the happy path (`https://`, `http://` accepted) and the rejection path (`https-evil://`, `file:`, `dsh://`, `javascript:`, empty, and unparseable strings rejected). The `https-evil://` case is the regression guard for the old `startsWith` flaw.
- A new `DshServerProcess` test uses fake timers to assert that `stop()` resolves after SIGKILL escalation even when the child never exits — no hang, no unbounded wait.
- `apps/desktop/qa/shell.spec.ts` keeps its zero-console-error and axe-gate assertions over the real Electron window.
- The pre-existing top-strip height assertion (`height: 30px`, stale at `32px`) is corrected so the unit lane is green on its own.

## Consequences

The navigation policy (`shouldOpenExternal` only) is the one behavioral change visible to the renderer: a `window.open` for a non-http(s) scheme is still denied (previously it was also denied, just via a less-exact check). `will-navigate` semantics are unchanged (still blocks all). The security `webPreferences` are additive constraints that match the Electron ≥20 defaults the shell already depended on. The SIGKILL reap bound is a teardown-time-only change with no startup or steady-state impact.
