# Agent Note: GUI QA tooling for the agent — adopted lanes and boot-ordering fix

Status: implemented

English | [中文](2026-08-25-agent-gui-qa-tooling.zh.md)


- **Area:** client UI · web e2e lane · visual lane · docs/research
- **Supersedes:** none · **Related:** [web e2e lane](../../../../apps/web/tests/README.md) · [unified label taxonomy](2026-08-08-unified-github-label-taxonomy.md)

## Problem

The agent had no direct way to see and drive the product it builds: interactive QA meant hand-rolled Playwright scripts (one-way screenshots, SSE-hostile `networkidle` waits, overlay-mask click timeouts), accessibility conformance was unmeasured, painted-output regressions had no gate, and locators leaned on localized copy that drifts between source and bundle. Separately, the merged jsdom lane booted red for every assembled-composition scenario (`slot "workbench" is not declared`) because entry creation raced slot-parent initialization.

## Decision

Adopt the Playwright family as the QA stack, per the research note in [docs/research/gui-qa-tooling.md](../../../../docs/research/gui-qa-tooling.md): `@axe-core/playwright` gates WCAG 2.x A/AA on the settled shell and the settings dialog (`apps/web/tests/accessibility-axe.e2e.ts`); a separate `@playwright/test` visual lane (`apps/web/visual/`, `pnpm run test:web:visual`) pins pixel baselines per platform via `toHaveScreenshot`; stable `data-testid` anchors land on primary chrome (`settings-trigger`, `settings-dialog`, `composer-input`, `drag-handle-*`) so locators survive locale drift. Boot ordering becomes deterministic at two levels: `orderByModuleGraph` now treats `inject` names as graph edges, and `runPluginBoot` creates entries in dependency levels (`dependencyLevels`) so a slot parent always initializes before an occupant registers into its children. The golden harness that needs vitest's `expect` moved to `tests/goldens.ts`, leaving `scaffold.ts` loadable under plain node+tsx so the visual lane can boot the real composition outside vitest.

## Alternatives considered

**MCP-first interaction.** Rejected as the default: this harness always has a shell, and Microsoft routes shell-first agents to CLI/skills over MCP tool schemas; Chrome DevTools MCP stays the recommendation for performance/console deep-dives.

**SaaS visual/agentic-QA platforms (Percy, Chromatic, Applitools, Checkly, Momentic, mabl).** Deferred: cloud baselines or vendor-bound runners buy nothing against a loopback target already driven natively; revisit only if DSH ships hosted deployments.

**Fixing the slot race inside vendor/loader.** Rejected: the loader correctly rejects late parents; the bug was our composition creating entries without dependency ordering, fixed entirely in first-party code.

**Broad `data-testid` rollout.** Deferred beyond the four primary-chrome anchors until interactive QA exercises more surfaces; the convention (Playwright default attribute) is documented in the research note.

## Consequences

The lane boots deterministically in fast-eval environments, not just under HTTP latency; assembled-composition scenarios reach their real assertions again. Accessibility violations are now a lane failure, so new chrome must pass WCAG 2.x A/AA or carry a documented exclusion. Pixel baselines are platform-scoped and committed (`apps/web/visual/snapshots/<platform>/…`); contributors on a new platform regenerate with `--update-snapshots` instead of fighting foreign baselines. Known residual on master, unchanged here: `built-boot.snapshot.ts` still fails on the brand-profile guard in the jsdom harness (the official-brand bundle folds `DSH_CLIENT_BUILD_PROFILE` only when built through the full pipeline), plus pre-existing aria-golden drift in three `lifecycle-chrome` goldens and tooltip flakiness — all requiring their own diagnosis.
