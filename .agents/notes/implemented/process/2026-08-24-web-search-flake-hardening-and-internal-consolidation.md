# Agent Note: web-search flake hardening and internal consolidation

Status: implemented

English | [中文](2026-08-24-web-search-flake-hardening-and-internal-consolidation.zh.md)

## Problem

Three defects surfaced around the consolidated search package and its test lanes. First, `packages/client/ui-trajectory` flaked intermittently: the full GUI battery failed with an unhandled `ReferenceError: window is not defined` attributed to a `@tanstack/react-virtual` timer after the file's jsdom teardown. The mechanism: vitest's jsdom lane deletes browser globals at environment teardown, and vitest rewrites `document.defaultView` to the worker's Node global, so virtual-core resolved `targetWindow` to that global — making its 150 ms scroll-offset debounce a plain Node timer. Nothing upstream cancelled it on unmount, so a scroll event within the last 150 ms of a file left a live callback to fire into deleted globals. Second, the loader-smoke SIGKILL deadline was raised 30s → 60s as a bare constant after measuring tsx boot cost; a machine slower than the development baseline had no way to raise it without editing harness code. Third, the five keyed search backends each carried private copies of the same machinery — credential resolution with the missing-key diagnostic, transport-failure translation, response-body mapping with abort/unprocessable handling, and shape-specific provider-error-envelope extractors — so every semantic fix had five places to land.

## Decision

Bump `@tanstack/react-virtual` from ^3.14.9 to ^3.14.10, which pins `@tanstack/virtual-core` 3.17.8 — upstream added exactly the missing cancellation (`debounce(...).cancel()` invoked by the offset observer's unsubscribe), so unmount now kills a queued reset instead of leaking it. A deterministic regression test in `table.client.spec.tsx` pins the invariant at our layer: track every ambient timer scheduled from a scroll event onward and require unmount to cancel all of them (verified to fail against neutered 3.17.8 dist).

The smoke deadline becomes an owned resolution step: `resolveSmokeProcessTimeoutMs()` prefers an explicit option over a validated `DSH_SMOKE_PROCESS_TIMEOUT_MS` entry over the measured default, and `LOADER_SMOKE_TEST_TIMEOUT_MS` derives from it — the vitest limit can never fire before the subprocess-owned one.

Inside `@deepseek-ai/dsh-web-search`, one internal module now owns each repeated translation: `resolveSearchKey` (credential plane plus the shared missing-key diagnostic), `translateSearchTransportError` (fetch failure → `WEB_ABORTED`/`WEB_PROVIDER_ERROR`), `mapResponseJson`/`mapResponseText` (body read plus mapper inside one abort/unprocessable/WebError-passthrough guard), `providerErrorDetail` (one extractor for all observed error envelopes), and `hasCredential` for the `available()` predicate. Exa and Perplexity drop their hand-rolled POST clients for the existing `postJson`; the per-provider error-envelope types become dead and are deleted.

## Alternatives considered

**Patch virtual-core locally via `patchedDependencies`.** Rejected once upstream 3.17.8 shipped the identical fix hours-of-review cheaper: a patch would pin maintenance burden onto every future bump for zero delta over the release.

**Drain the debounce in the spec's `afterEach` (sleep past 150 ms).** Rejected: it taxes every test in the file forever, papers over the leak instead of removing it, and any future suite scrolling a virtualizer silently re-imports the flake.

**Leave the five backend copies and rely on jscpd.** Rejected: the clone detector passed because header names and envelope shapes differ slightly, but semantics lived in five places — exactly the drift surface this consolidation removes.

## Consequences

Bought: the trajectory ledger can no longer strand a post-teardown timer regardless of which suite scrolls it; constrained CI machines raise one environment variable instead of patching test code; adding a search backend means writing mappers and defaults, not re-deriving error translation. Cost: the react-virtual bump is a lockfile-wide change riding this PR; the two new internal helpers carry generic-mapper signatures whose casts lean on type-parameter call mechanics; and `DSH_SMOKE_PROCESS_TIMEOUT_MS` is one more knob documented only here and in JSDoc.

## Testing

`table.client.spec.tsx` adds the cancel-on-unmount regression test (fails against the pre-fix virtual-core); `loader-smoke.spec.ts` covers default, valid override, and malformed-override rejection of the resolver; the web-search suites stay at 211 tests green with per-file coverage intact after the consolidation. Full GUI battery (293 files), keyless snapshot battery (13 files), hygiene, duplication (0 clones), lint, and typecheck pass.
