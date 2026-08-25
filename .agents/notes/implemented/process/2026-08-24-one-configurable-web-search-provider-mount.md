# Agent Note: one configurable web-search provider mount

Status: implemented

English | [中文](2026-08-24-one-configurable-web-search-provider-mount.zh.md)

## Problem

The shipped search pipeline hardwired DeepSeek: the base bundle pinned `searchProvider: deepseek-official` and mounted only `@deepseek-ai/dsh-web-search-deepseek`, while Exa and Perplexity existed as separate packages no composition ever registered. A deployment that wanted another backend had to know three package names, wire each into `cordis.yml`, and keep the seam's `searchProvider` pin in sync by hand — and every deployment paid the DeepSeek route regardless, because the harness's own chat key made that provider permanently usable. The settings UI compounded this with a DeepSeek-only card over a `web-search-deepseek` namespace.

## Decision

One package replaces three: `@deepseek-ai/dsh-web-search` (plugin id and namespace `web-search`) exposes a single discriminated config whose `provider` literal picks the backend — native model-mediated search (`deepseek`, `claude`, `gemini`) or external search APIs (`exa`, `brave`, `duckduckgo`, `perplexity`) — and registers exactly one `WebSearchProvider` under that id. Because only one provider is ever registered, the base bundle drops its `searchProvider` pin and the seam auto-selects; switching backends is one `provider:` value in one place.

DeepSeek and Claude share the same Anthropic-compatible Messages protocol, so one parameterized class (`AnthropicNativeSearchProvider`) serves both with per-backend defaults; Gemini gets its own grounding client; the external backends are one module each. Cross-field validation fails loud at load and rejects settings writes: a field that does not apply to the selected provider (say `maxUses` under `exa`) names itself and the providers it applies to, so a provider switch can never leave a stale option silently shadowing the new backend. A committed section change remounts the registration — dispose first, register after — so a provider switch is live, not restart-gated. The pre-dispatch log event generalizes to `web/native-search-llm-request` with a discriminated payload spanning both native protocols; per the pre-release stance, old logs carrying the retired event name are not readable by this build.

The workbench card gains the provider dropdown plus per-backend field visibility (the keyless DuckDuckGo hides the credential plane entirely), mirroring default key references client-side since a client package must not depend on a Host package.

## Alternatives considered

**Keep per-provider packages and add Brave/DuckDuckGo/Claude/Gemini siblings.** Rejected: it grows exactly the sprawl being removed — seven namespaces, seven cards' worth of settings surface, and composition wiring per backend — to avoid one mechanical consolidation the pre-release stance explicitly permits.

**Auto-select by which API key happens to be present** (e.g. prefer Exa when `$EXA_API_KEY` is set). Rejected: presence-based selection is a hidden priority chain; explicit configuration beats environment accidents, and the seam's documented semantics already refuse ambiguity instead of guessing.

**Gate provider switches behind a restart (`applies: 'restart'`).** Rejected when the remount pattern proved simple: dispose-then-register inside the existing settings hooks leaves the invariant (exactly one registered provider) true at every observable moment, so a restart would buy nothing but downtime.

## Consequences

Bought: adding a search backend is now one module plus one defaults entry plus one applicability-table row in a single package; users configure "web-search" once, in composition or the settings card; native coverage extends beyond DeepSeek for free because two of the four new backends reuse the existing Messages mapper. Cost: the registry ids changed (`deepseek-official` → `deepseek`), so compositions pinning the old id fail loud until updated; the session event rename orphans logs written before this change; and the consolidated package's coverage obligation is larger than any one predecessor's.

## Testing

The consolidated package carries 320+ unit tests across eight suites (per-backend request/error/abort matrices ported from their predecessors, plugin validation matrix, live-switch via a real in-memory settings provider, credential rotation through the local credentials store, Loader unwrap shape), the real-HTTP redirect fixture, and self-skipping live-API probes. The workbench card specs cover provider staging, keyless visibility, and per-backend field rendering.
