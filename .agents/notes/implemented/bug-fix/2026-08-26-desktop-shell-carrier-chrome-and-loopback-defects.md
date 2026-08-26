# Agent Note: Desktop shell defects — abort tokens across contextBridge, chrome ownership, and the dsh://app loopback gap

Status: implemented

English

- **Area:** desktop shell · client connection · client UI
- **Related:** [GUI QA tooling](../process/2026-08-25-agent-gui-qa-tooling.md) · [web lane brand face and golden drift](../testing/2026-08-25-web-lane-brand-face-and-golden-drift.md)

## Problem

The first real exercise of the Electron shell (`apps/desktop`) against the supervised stdio child surfaced three defects the web lane could never see, because every prior GUI surface ran a browser over HTTP:

1. Settings → Models and Agent presets both failed with `init.signal.addEventListener is not a function`. The renderer passed a live `AbortSignal` through the `__DSH_IPC_CARRIER__` bridge, and `contextBridge` hands the preload a prototype-less clone — the method disappears at the boundary.
2. The window top dragged only over the sidebar. Only the brand row carried the drag attribute in states the user actually sees; the injected full-width strip was 6px tall and the brand-row padding rule (26px) lost the cascade to client stylesheet order, computing 8px — so the wordmark also crowded the traffic lights.
3. Latent behind the first fix: the client derives local-vs-remote posture from `location.hostname`, and the shell's origin is `dsh://app` — no network host. `connection.isLoopback` therefore read false, flipping the settings mirror to memory persistence ("settings are unavailable in this browser") and degrading deliverable links and the document controller.

## Decision

**Aborts cross the bridge as opaque correlation tokens.** The renderer keeps its live signal; `bindAbortToken` generates a UUID per call, wires the signal to a new required `bridge.abortFetch(token)`, and the bridge fetch carries `init.token`. The main-side handler registers its `AbortController` under the renderer token when present (the preload's own outer token remains the fallback), so pre-abort rejection, mid-flight cancellation, and listener cleanup all stay in the renderer world where the signal actually lives. The preload no longer touches signal objects at all.

**Injected chrome owns its geometry with `!important`.** The brand row padding (40px) must win regardless of client stylesheet order because the shell, not any client package, answers for the area under the traffic lights; a specificity race with bundled module CSS is not a contest the shell can afford to lose. The grab edge doubles to 12px, still hiding under fullscreen.

**The desktop carrier implies loopback.** `isLoopback` is true whenever the IPC bridge exists: same-machine by construction, whatever the scheme names. All downstream consumers (settings persistence, document controller, deliverable file links) pick up the correction from the one derivation site.

**The desktop QA lane gates the real app.** `apps/desktop/qa` boots Playwright `_electron` with a throwaway `DSH_HOME` and `DSH_DESKTOP_USER_DATA` (new seam keeping the single-instance lock away from interactive runs), dismisses fresh-home modals, and asserts the settled frame (zero console errors, pixel baseline), the chrome mechanism, both previously-failing settings tabs over the carrier, and an injected axe-core WCAG A/AA pass — AxeBuilder itself cannot run here because it opens pages through a browser context Electron does not support. Synthetic mouse events cannot drive macOS app-region drags either, so the lane asserts the mechanism (computed region, geometry, hit-test), not a bounds delta.

## Alternatives considered

**Serialize the signal into the bridge** (keep listeners main-side by passing `{aborted}` snapshots). Rejected: polling loses sub-frame cancel latency, pre-abort races return, and the wire contract grows a shape to mirror a DOM interface.

**Teach `isLoopbackHostname` about custom schemes.** Rejected: the predicate is shared with the Host's `/api` trust fence; widening it for one consumer weakens a security-relevant classifier. The transport identity, not the hostname grammar, is what knows the call is local.

**Drop `aria-haspopup`/`aria-expanded` from the hero textarea** to silence the axe gate. Rejected: it hides real state from assistive tech. The readonly textarea genuinely acts as the picker trigger, so it takes `role="button"` while in that posture; empty session trees drop `role="tree"` until they own treeitems instead of presenting an invalid empty tree.

## Consequences

Every renderer-to-shell fetch now carries a correlation token; the bridge interface grew a required member, so out-of-tree bridges fail typecheck rather than silently losing cancellation. Client packages may not rely on `location` to detect locality — ask the connection handle. The pixel baseline pins the desktop-only composition (traffic lights over the padded brand row); re-record after intentional chrome changes with `pnpm run test:desktop -- --update-snapshots`.
