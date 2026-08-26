# Agent Note: Web lane brand face follows the build record; goldens drop pointer geometry

Status: implemented

English

- **Area:** web e2e lane · visual lane
- **Supersedes:** partially resolves the known residuals recorded in [GUI QA tooling](../process/2026-08-25-agent-gui-qa-tooling.md) · **Related:** [client build environment](../architecture/2026-08-18-client-build-environment.md)

## Problem

`built-boot.snapshot.ts` read the client build record but never used its environment: the brand assertions hardcoded the official face (wordmark SVG present, fallback label absent), so a local-profile tree — including the default `pnpm run build` that `pnpm run test:web` performs first — failed on UI its own artifacts correctly produced. Separately, two `lifecycle-chrome` goldens drifted for different reasons: the five-column workbench refactor added the always-rendered Open-workbench tab to the frame chrome after the last recording, and the hero capture intermittently carried a `- tooltip "Commands"` row because the connect flow leaves the pointer wherever its last click landed, and a 500 ms rest over a composer control raises its delayed hover tooltip.

## Decision

The smoke now derives both faces from the recorded `DSH_CLIENT_BUILD_PROFILE`: an official record pins the wordmark and no fallback label; any other record pins the inverse. CI's official build keeps exercising the wordmark path, so define folding stays proven end to end on both faces. `lifecycle-chrome` parks the pointer in a tooltip-free viewport corner before its two full-frame aria captures, making goldens independent of where earlier clicks left the mouse, and adopts the tab's `separator` + button rows; the settled-shell pixel baseline is re-recorded for the same painted change. The suspected space-loss aria drift (`Think …`, `Context injection @pkg` rows gluing together) does not reproduce on the level-ordered boot and is attributed to mid-hydration captures under the old creation race that [dependency-level boot](../process/2026-08-25-agent-gui-qa-tooling.md) removed.

## Alternatives considered

**Build the official profile in `test:web`.** Rejected: plain local builds remain a supported face with different branding, and the build record is already the binding truth between bytes and behavior.

**Park the pointer inside `captureStableAria`.** Rejected: other scenarios' goldens deliberately encode hover/focus state reached by real interactions; scenario-local parking removes the accidental geometry dependence without rewriting those records.

## Consequences

`pnpm run test:web` passes on either build face with no profile-specific instruction. Full-frame aria goldens in this spec describe chrome truth rather than pointer history; future captures there must keep the pointer parked or accept encoding transient hover state deliberately.
