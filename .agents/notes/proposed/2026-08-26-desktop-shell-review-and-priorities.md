# Agent Note: Desktop shell visual and functional review — UX gaps, missing capabilities, and a prioritization

Status: proposed

English

- **Area:** desktop shell · client UI · UX · testing
- **Related:** [Electron desktop shell design](2026-08-22-electron-desktop-shell.md) · [GUI QA tooling](../process/2026-08-25-agent-gui-qa-tooling.md) · [desktop shell carrier and chrome defects](2026-08-26-desktop-shell-carrier-chrome-and-loopback-defects.md)

## Problem

The first three PRs against the desktop shell fixed the boot-blocking defects ([carrier and chrome](2026-08-26-desktop-shell-carrier-chrome-and-loopback-defects.md)) and stood up the `apps/desktop/qa` Playwright `_electron` lane. With the shell actually exercisable end to end, a full visual and functional review exposed the next layer of work: UX gaps the web lane structurally never sees, missing power-user affordances, accessibility omissions, and one non-blocking transport error. Capturing this in a note keeps the prioritization durable and reviewable before any single PR grows large.

## Evidence base

Four driver scripts under `/tmp` ran against the real app over a throwaway `DSH_HOME` and `DSH_DESKTOP_USER_DATA`: a primary sweep (every surface, every settings tab, command palette, mode switcher, workbench, sidebar collapse, search), a follow-up probing slash and `@-mention` menus, focus chain, and tooltips, and a tertiary sweep on a real session probing model selector, access mode menu, and tooltip visibility. Artifacts live under `.playwright-mcp/review/` (~50 frames and aria snapshots, 3 findings JSONs). The `apps/desktop/qa/shell.spec.ts` lane already covers the four gates described in the prior note; the review went past those gates to exercise every chrome surface.

## Findings — by impact

The review surfaced ~30 distinct items. Ranked by user-visible impact and effort:

**T1 — Quick wins, ~1 day total**
- *Cmd+, does not open Settings.* The system-wide macOS convention is ignored. Fix in the desktop shell's main-process menu (or in the client's keymap) by adding the accelerator.
- *Cmd+N: stray `role="tooltip"` "Search" leaks into the aria tree with no visible new-session state.* The keystroke reaches the sidebar search input but the tooltip framework renders a stale node. Investigate the tooltip component's hide-vs-unmount policy; the aria tree should not carry hidden `role="tooltip"` nodes.
- *No `aria-live` regions anywhere on the shell.* Status changes (boot progress, errors, token counters) are silent to screen readers. Add a polite live region at the renderer root and route key state through it.
- *No keyboard hint in the composer placeholder.* "Describe what you want to build" omits the `/` for commands and `@` for subagent hints. Single-string change with discoverability dividend.
- *Settings dialog tabs are `button` inside a `navigation`, not `role="tab"` in a `tablist`.* Keyboard users don't get Tab/Shift+Tab tab-navigation. Promote to proper ARIA tablist with `aria-selected`.
- *Click outside the Settings dialog does not dismiss it.* Add a backdrop click handler (matches the workspace picker pattern).
- *The drag-handle-sidebar is 8 px wide.* Barely usable; a 12-px minimum with a visible affordance (hover state) is a small CSS + DOM change.
- *Persistent console error on boot:* `[ui-cordis] reading the Cordis inventory failed: Error: client api: dynamicCordisRunner/inventory failed: transport failure for /api/dynamicCordisRunner/inventory: HTTP 405`. The endpoint exists and is called via POST; if the inspector calls it as GET, that's the 405. Either fix the call method or guard the call behind a feature flag. Not user-blocking but pollutes the console and the lane's `errors` array.
- *The "No sessions yet" hint inside the empty sidebar has no role.* This is the trade-off from the prior fix; consider `role="treeitem" aria-disabled="true"` for a more honest AT affordance.

**T2 — Power-user affordances, ~1 week**
- *Prompt library / reusable prompts.* No first-class surface for storing and inserting reusable prompts. Slots cleanly into the existing agent-preset pattern.
- *Search across all sessions and workspaces.* The sidebar search is per-list; a global palette (`Cmd+Shift+F`) over session content would be a power-user winner.
- *Draft auto-save indicator on the composer.* The composer persists; the user has no signal that a draft is saved. A small dot or pulse would close the loop.
- *Mode switcher (Standard / PTC / Minimal / Creator) visual state in session.* Clicking shows the menu, but a session only inherits a mode — there is no per-session mode badge in the sidebar.
- *Cancel running task.* No way to interrupt a long-running tool round from the UI; the chrome offers no affordance.
- *File-link opening in deliverable view.* The details panel already exists; linking to Finder/Explorer from a produced file is a one-day add.
- *Session export/import.* A round trip is currently impossible; a "Save conversation" command and "Import JSONL" intake would close the loop with the persistence format.
- *Agent run progress (streaming tokens, tool events).* The chat shows results but the agent-loop progress is implicit; a thin progress strip during active rounds would make the agent feel alive.

**T3 — Architecture and infrastructure, ~2 weeks**
- *Single global session-loop log in the renderer's connection handle.* The `ConnectionController` rebuilds on every session switch; this is fine but worth profiling under real load.
- *The desktop shell's `DSH_DESKTOP_READY_TIMEOUT_MS` and `DSH_DESKTOP_DEBUG` seams are the only knobs.* Add a real "reset profile" command for QA lanes that exercises profile migration paths without rebuilding.
- *A11y conformance beyond axe core rules.* Axe catches the structured violations; manual NVDA/VoiceOver passes for power flows (slash menu, plan mode, subagent) are not yet in the lane.
- *i18n parity at 100% for the agent-presets and deliverable surfaces.* Some English-only strings remain; sweep and gate.
- *Settings dialog: keyboard navigation across the form fields.* Tab order is implicit; add a deliberate tabindex plan or a `RovingTabindex` provider.

**T4 — Out of scope (deliberately)**
- Native notifications. The shell currently relies on the in-app status; OS notifications are a follow-up that requires per-platform permission and styling work.
- Auto-update. The `dsh` runtime is configured per-deployment; update channels belong to the packaging work, not the shell.
- Code signing and notarization. Open distribution work already enumerated in the design note.

## Decision

The first PR after the defect fix lands **T1** in one small batch — keyboard shortcuts (Cmd+,), aria-live, click-outside dismiss, the Cordis 405, and the "No sessions yet" empty-state role restoration. Each is one or two-line changes with strong user-visible dividends. The lane (axe + console-error watch + settled-state screenshot) will catch any regression in the same PR. Subsequent PRs follow the T2 tier one at a time so each is reviewable and the lane keeps the desktop shell's quality bar.

## Alternatives considered

**Land everything in one big PR.** Rejected: hard to review, hard to bisect, and the lane's tolerance for screenshot drift grows with the diff.

**Bypass the lane for "safe" cosmetic changes.** Rejected: the lane already pays for itself in t1 (the carrier fix). Treating the desktop shell like the web lane — every change passes through it — is the point of having a desktop lane.

**Implement the new features (T2) first, polish (T1) later.** Rejected: T1 carries the perception that the shell "feels finished"; T2 carries capabilities but doesn't move the perceived-quality needle as much.

## Consequences

This note is the gate before the next PR. It does not change the shipped source; the next PR (T1) will. If the user agrees with the scope, the implementation note moves to `implemented/` in the same PR and the policy stays the same: small batches, every change through `apps/desktop/qa`, English-only Agent Notes.

## Required verification

The `apps/desktop/qa` lane already covers the gates; the T1 PR must keep it green and add:
- a `Cmd+,` accelerator assertion
- a `role="status" aria-live="polite"` assertion that catches a deliberately-fired event
- a backdrop-click test for the Settings dialog
- a console-error watch (the lane already collects `pageerror`/`console.error`); the T1 PR must keep it empty for the settled shell
