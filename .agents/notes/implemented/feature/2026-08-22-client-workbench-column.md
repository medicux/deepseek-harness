# Agent Note: Client workbench column — the left expandable view surface

Status: implemented

English | [中文](2026-08-22-client-workbench-column.zh.md)

## Problem

The frame had three fixed columns (sidebar | center | details), leaving no home for persistent working surfaces — diff review, code viewing, image inspection, and a future embedded browser all need their own left-side area that survives session switches. Without one, each such feature would invent its own panel plumbing or fight the session-scoped details contract.

## Decision

[`packages/client/ui-layout`](../../../../packages/client/ui-layout/README.md) renders a four-track grid (`sidebar | workbench | center | details`) from the same concession-chain solver, which now orders its concessions as: details shrinks toward its minimum then auto-closes; only then does the workbench shrink toward its minimum (never above its own preference — closing details may free enough room that no concession is needed) and auto-close; center absorbs any remaining deficit last. Derived closes never rewrite stored preferences, so re-widening restores them.

The `workbench` child slot is declared by the root registration alongside its siblings, is root-scoped so the column outlives session switches, and carries an owner share of `collapsed`/`width` mirroring the sidebar's live concession output. Single-slot semantics render nothing while unoccupied, so the column is invisible — and the panel actions are visual no-ops — until a feature claims it by registering there. The layout store gains the `workbench` width preference (0 = closed) with the same action discipline as its siblings (`setWorkbench` clamps into the 320–560 contract range; open writes the 400 default only from closed; close zeroes), and `ctx.layout` extends to `openWorkbench()`/`closeWorkbench()` so any plugin's apply world can drive the column without reaching into the store. Discoverability is owned by the frame: while the column is closed a slim tab on the sidebar seam (`workbenchToggle`, chevron affordance, aria-labelled) opens it at the contract default — necessary because the drag handle does not exist at zero width — and a double-click on the open column's handle closes it again. The first intended occupant is the interactive terminal; diff and code viewers follow.

## Alternatives considered

**Host views inside the existing details column or sidebar seats.** Rejected: the details column is right-hand and session-scoped (it closes on every session switch), and the sidebar's inner seats compose navigation, not working surfaces — both would fight their existing contracts.

**An overlay or popover layer.** Rejected: workbench content is persistent working context, not transient chrome; `shell.overlay` is deliberately click-through and unowned.

**A collapsible section inside the sidebar itself.** Rejected: it couples view hosting to navigation state and drags the rail-collapsed contract into view management; a sibling track keeps both columns independently resizable under one solver.

## Consequences

Features that register into `workbench` inherit the frame's geometry contract: they must tolerate zero-width mounting (the subtree stays mounted when closed), read their width from owner props rather than the store preference, and drive visibility through `ctx.layout` rather than local state. The concession chain now has one more participant, so panel-squeeze behavior changes for compositions that open both side panels — details always concedes first.

## Testing

Solver specs cover every concession step including the details-first ordering, the no-expansion-above-preference rule, auto-close recovery, and degenerate viewports; store specs pin the init shape, clamp ranges, default-open/close lifecycle, and the absence of persistence; frame specs pin the four-track template, owner-prop delivery, handle placement at sidebar+workbench with +dx widening, the squeeze scenario where details concedes and closes while the workbench holds, and the closed-state tab opening at the default with the handle double-click closing it again; the service spec pins delegation of the new face methods.
