# @deepseek-ai/dsh-web-search

English | [中文](README.zh.md)

The harness's one configurable search provider mount for the [web capability seam](../web/README.md) (`ctx.web`). One plugin, one `web-search` settings namespace: its `provider` literal picks the backend, and the plugin registers exactly one `WebSearchProvider` under that id — so seam selection needs no pin and a committed switch takes effect immediately.

Two families of backend:

- **Native** — search runs inside an auxiliary model request with server-side retrieval: `deepseek` (Anthropic-compatible Messages + `web_search_20250305`), `claude` (the same wire protocol against the Anthropic API), `gemini` (`generateContent` with the `google_search` grounding tool).
- **External** — a direct call to a search API: `exa`, `brave`, `duckduckgo` (keyless), `perplexity`.

This is an **implementation** package: it registers into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

All fields are optional; `apply` fills the selected backend's defaults. A field that does not apply to the selected provider fails loud at load and rejects the settings write.

| Key | Applies to | Default | Meaning |
|---|---|---|---|
| `provider` | — | `deepseek` | Which backend serves searches; also its registry id. |
| `apiKey` | all but `duckduckgo` | — | Literal key. Prefer `apiKeyEnv` so no secret enters configuration files. |
| `apiKeyEnv` | all but `duckduckgo` | per provider¹ | Credential reference resolved for each search. |
| `baseURL` | all but `duckduckgo`² | per provider² | Endpoint base. |
| `model` | `deepseek`, `claude`, `gemini`, `perplexity` | per provider³ | Model name for model-mediated backends. |
| `apiVersion` | `deepseek`, `claude` | `2023-06-01` | `anthropic-version` header value. |
| `maxTokens` | `deepseek`, `claude`, `perplexity` | `4096` / `1024` | Upper bound on generated answer tokens. |
| `maxUses` | `deepseek`, `claude` | `5` | Maximum native `web_search` server-tool uses per request. |
| `searchType` | `exa` | `auto` | Exa retrieval mode sent as `type`. |
| `numResults` | `exa`, `brave`, `duckduckgo` | (unset) | Default result count when a request carries no `maxResults`. |
| `highlightsPerResult` | `exa` | `1` | Highlight sentences requested per result. |
| `country` | `brave` | (unset) | Two-letter country code. |
| `searchLang` | `brave` | (unset) | Search language. |
| `searchRecency` | `perplexity` | (unset) | Recency window: `day`, `week`, `month`, or `year`. |

¹ `$DEEPSEEK_API_KEY` / `$ANTHROPIC_API_KEY` / `$GEMINI_API_KEY` / `$EXA_API_KEY` / `$BRAVE_API_KEY` / `$PERPLEXITY_API_KEY`. ² DeepSeek deliberately does NOT reuse `$DEEPSEEK_BASE_URL`: chat-completions and the Anthropic-compatible Messages API are different endpoints. The endpoint resolves section override first, then `$DEEPSEEK_SEARCH_BASE_URL`, then the built-in default. ³ `deepseek-v4-flash`, `claude-sonnet-4-5`, `gemini-2.5-flash`, `sonar`.

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'

- id: web-search
  name: '@deepseek-ai/dsh-web-search'
  config:
    provider: deepseek        # deepseek | claude | gemini | exa | brave | duckduckgo | perplexity

# A different deployment pins another backend:
#   config:
#     provider: exa
```

Because the plugin registers exactly one provider, the seam auto-selects it without a pinned `searchProvider`; mounting two plugins (or setting `DSH_WEB_SEARCH_PROVIDER`) selects explicitly.

## Switching providers live

A committed settings change re-validates and remounts the registration, including a `provider` switch: the previous registration disposes first, so exactly one search provider exists at any moment and the next search already uses the new backend. Option edits (endpoint, budget) reach the next search through the section snapshot each operation reads at its entry; key rotation needs no restart because credentials resolve per operation.

## Logging contract

Immediately before dispatch, a native search running under an initiating Agent appends the log-only `web/native-search-llm-request` session event carrying the discriminated request record (`provider` plus the exact secret-free endpoint/version/body sent to the backend); headers and credentials are excluded. External backends dispatch no model request and log nothing. A throw from recording prevents dispatch, so model-visible auxiliary input cannot escape logging.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains every backend's normalized sources (URLs, titles, snippets, publication dates, generated answers where the backend produces them) under its `maxResults` bound, and this package's stable `WEB_*` failures under the consumer's error wrapper while provider-private wire fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **DuckDuckGo parses a public HTML page** — no official API and no SLA; markup drift surfaces as zero sources rather than an error.
- **Gemini grounding chunks carry no excerpt** — `snippet` stays unset rather than invented; only Brave/Exa/DuckDuckGo/Perplexity supply per-result excerpts.
- **Brave descriptions carry light HTML**, stripped to plain text; exotic entities beyond the common five pass through unescaped.
