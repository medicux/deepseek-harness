# Agent Note: tsconfig paths exact keys target entry files

Status: implemented

English | [中文](2026-08-24-tsconfig-paths-exact-keys-target-entry-files.zh.md)

## Problem

The test source plane resolves bare `@deepseek-ai/*` specifiers through `vite-tsconfig-paths` reading the `paths` map in `tsconfig.base.json`; the map exists so tests and static gates always see one shared module copy from `src/`, never the built `lib/` bundles. That guarantee failed silently: twelve `packages/host/apiproxy` specs rejected with generic `code: 'internal'` errors because `instanceof SessionTitleInvalidError` and `instanceof TypertLookupFailure` were false inside api-proxy code even though both sides named the same class. The proxy module executed from its built bundle — which inlines its own dependency copies — while sibling imports resolved elsewhere, so class identity split across module graphs. A pristine-HEAD tree passed only because its lib vintage happened to be consistent; a clean rebuild exposed the failure, and nothing in the configuration distinguished the working state from the broken one.

## Decision

Every exact-key `paths` entry in `tsconfig.base.json` targets an existing entry file (`src/index.ts`, `src/client/index.ts`, …), never a source directory; wildcard `…/*` keys keep directory targets because their substitutions name concrete files at the use site. All sixty-nine previously directory-targeted exact keys were converted, and one dead entry (`@deepseek-ai/dsh-agent/brand` → a nonexistent `brand.ts`, zero consumers) was deleted. The rule is enforced, not conventional: `checkTsconfigPathsTargets` in [scripts/check-workspace-constraints.ts](../../../../scripts/check-workspace-constraints.ts) (the `constraints` hygiene gate) rejects exact keys whose target is missing or a directory.

File targets are required because a rewrite that yields a resolvable file path behaves deterministically across resolution environments, while a directory target depends on fallback index resolution that silently skips in some environments; the resulting fall-through to node_modules is indistinguishable from success until an identity-dependent assertion breaks far from the cause.

## Alternatives considered

**Externalize `@deepseek-ai/*` dependencies in host bundles** so built libs share one module copy. Rejected: bundling shape is owned per package by the tsdown configuration, externalizing changes publish artifacts, and type-plane drift would remain.

**Mirror the paths map as vitest `resolve.alias` entries.** Rejected: it duplicates the canonical map as a second source of truth guaranteed to drift; the fix keeps single ownership in `tsconfig.base.json`.

**Have specs import siblings through relative `src/…` paths.** Rejected: it fixes symptoms per spec and re-imposes the hazard on every future spec instead of removing it once.

## Consequences

Bought: deterministic source-plane identity for every bare workspace specifier — the twelve failures disappeared with no product-code change — plus a gate that turns future regressions into loud, located errors naming the offending entry. Cost: sixty-three mechanical mapping edits ride in the converting change, so blame for unrelated-looking diffs lands there; and enforcement covers only exact keys — a wildcard key whose base directory disappears still fails only at first use.

## Testing

`pnpm run constraints` passes on the converted map; temporarily reintroducing one directory target produces exactly one located violation, and restoring the map goes green again. After the conversion, the full local battery is green: typecheck, build, `test:gui` (4031 passed), hygiene, duplication, and doc-sync.
