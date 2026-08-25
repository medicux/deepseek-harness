# Agent Note: Web search providers resolve credential references per search

Status: implemented

English | [中文](2026-08-21-web-search-provider-credential-reference.zh.md)

## Problem

Every `WebSearchProvider` needs an API key for each search. The shipped provider plugins did not agree on where that key comes from: `dsh-web-search-deepseek` resolved a `CredentialRef` through the optional `ctx.credentials` seam once per search, while `dsh-web-search-exa` captured a literal config key or one launch-environment read at registration time. A deployment that manages keys through the harness — the Models page writing `.credentials.yaml` — therefore could not point the Exa provider at the managed store at all: switching search providers meant pasting a raw secret into a composition file or exporting the variable into the long-lived server process's launching shell, and rotating it meant editing those again.

## Decision

Every shipped search-provider plugin resolves its key for each search under one contract:

1. A non-empty literal `apiKey` in the plugin config wins.
2. Otherwise the plugin installs a resolver that reads `apiKeyEnv` — a `CredentialRef` defaulting to the provider's documented variable name — from `ctx.credentials` when the seam is mounted, and from the launch environment otherwise.
3. When neither yields a value, that search fails as `WebError` `WEB_PROVIDER_CREDENTIAL_MISSING` naming the unresolved reference; the stable `web_search` schema stays registered.
4. The provider snapshots its options once per operation, so one search never sends a key resolved from one reference to an endpoint named by another.
5. `available()` reports usable when a literal or a resolver exists; whether the referenced store currently holds a value is an execution-time fact, not a registration-time one.

`dsh-web-search-deepseek` already behaved this way; `dsh-web-search-exa` now does too. `dsh-web-search-perplexity` still captures at registration and remains the known gap.

## Alternatives considered

**Require `EXA_API_KEY` in the server's launching environment.** Lost: the managed credentials store exists precisely so a key can rotate without relaunching the process, and an environment export cannot be set or rotated from inside the product.

**Keep the literal `apiKey` as the primary route (`role('secret')`, no resolver).** Kept as the escape hatch, rejected as primary: a secret in a configuration plane is readable by every configuration surface and rotatable only by edit; the reference route keeps configuration secret-free and rotation live.

**Give Exa a bespoke credential path and leave DeepSeek alone.** Rejected: the asymmetry between two providers of one seam is what produced this gap; a second dialect would multiply it.

## Consequences

A key stored or rotated through the credentials seam reaches the next search without re-registration, and switching the seam's configured provider id between compliant providers carries the same operational model. The cost is honest unavailability semantics: `available()` cannot prove a key exists, so a selected keyless provider passes selection and fails the search with the actionable reference name. The per-operation preflight lives once in `@deepseek-ai/dsh-web`'s provider-support seam, which both providers share.

## Testing

Unit coverage pins literal-over-resolver precedence, resolver-sourced bearer auth, the `WEB_PROVIDER_CREDENTIAL_MISSING` code and message naming the reference, wrapped credential-backend failures, preflight abort surfacing as `WEB_ABORTED` without dispatch, and single-snapshot-per-search semantics; the plugin suite covers launch-environment fallback and HMR-safe registration. Deployment composition of the row is exercised by the consuming profile's patch layer.
