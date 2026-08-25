/**
 * The `web-search` plugin's config: one discriminated section whose `provider`
 * literal selects the search backend, plus per-backend option fields validated
 * against an applicability table. Fields set for a backend that does not use
 * them fail loud — at load through {@link validateSection}, and at settings
 * writes through the same function — so a stale option can never silently
 * disable a switched provider.
 * @module @deepseek-ai/dsh-web-search/config
 */

/** Every search backend the plugin can mount; each value is a registry key. */
export const SEARCH_PROVIDER_IDS = ['deepseek', 'claude', 'gemini', 'exa', 'brave', 'duckduckgo', 'perplexity'] as const

/** One search backend id (also the id the provider registers under). */
export type SearchProviderId = typeof SEARCH_PROVIDER_IDS[number]

/** Plugin config (all fields optional — `apply` fills the selected backend's defaults). */
export interface WebSearchPluginConfig {
  /** Which backend serves the model-facing web_search tool. Defaults to `deepseek`. */
  readonly provider?: SearchProviderId
  /**
   * Literal API key; prefer {@link apiKeyEnv} so no secret enters configuration
   * files. Unused by `duckduckgo` (keyless).
   */
  readonly apiKey?: string
  /**
   * Credential reference naming the environment/managed key. Defaults to the
   * selected backend's conventional name (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`,
   * `GEMINI_API_KEY`, `EXA_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`).
   * Unused by `duckduckgo`.
   */
  readonly apiKeyEnv?: string
  /** Endpoint base for keyed backends; blank inherits the backend default. */
  readonly baseURL?: string
  /** Model name for model-mediated backends (`deepseek`/`claude`/`gemini`/`perplexity`). */
  readonly model?: string
  /** `anthropic-version` header value (`deepseek`/`claude`). */
  readonly apiVersion?: string
  /** Upper bound on generated answer tokens (`deepseek`/`claude`/`perplexity`). */
  readonly maxTokens?: number
  /** Maximum native server-tool uses per request (`deepseek`/`claude`). */
  readonly maxUses?: number
  /** Exa retrieval mode sent as `type`. */
  readonly searchType?: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no bound (`exa`/`brave`/`duckduckgo`). */
  readonly numResults?: number
  /** Highlight sentences requested per result (`exa`). */
  readonly highlightsPerResult?: number
  /** Two-letter country code (`brave`). */
  readonly country?: string
  /** Search language (`brave`). */
  readonly searchLang?: string
  /** Recency window (`perplexity`). */
  readonly searchRecency?: 'day' | 'week' | 'month' | 'year'
}

/**
 * Defaults for the Anthropic-compatible native backends (`deepseek`,
 * `claude`) — the same wire protocol, different endpoints and credentials.
 * DeepSeek's base is deliberately NOT `$DEEPSEEK_BASE_URL`: chat-completions
 * and the Anthropic-compatible Messages API are different endpoints.
 */
export const ANTHROPIC_PROVIDER_DEFAULTS: Readonly<Record<'deepseek' | 'claude', {
  readonly baseURL: string
  readonly model: string
  readonly apiVersion: string
  readonly maxTokens: number
  readonly maxUses: number
  readonly apiKeyEnv: string
}>> = {
  deepseek: {
    baseURL: 'https://api.deepseek.com/anthropic/v1',
    model: 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  claude: {
    baseURL: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
}

/** Defaults for the Gemini native grounding backend. */
export const GEMINI_PROVIDER_DEFAULTS: Readonly<{
  baseURL: string
  model: string
  apiKeyEnv: string
}> = {
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash',
  apiKeyEnv: 'GEMINI_API_KEY',
}

/** Defaults for the Exa external backend. */
export const EXA_PROVIDER_DEFAULTS: Readonly<{
  baseURL: string
  apiKeyEnv: string
}> = {
  baseURL: 'https://api.exa.ai',
  apiKeyEnv: 'EXA_API_KEY',
}

/** Defaults for the Brave external backend. */
export const BRAVE_PROVIDER_DEFAULTS: Readonly<{
  baseURL: string
  apiKeyEnv: string
}> = {
  baseURL: 'https://api.search.brave.com/res',
  apiKeyEnv: 'BRAVE_API_KEY',
}

/** Defaults for the keyless DuckDuckGo external backend. */
export const DUCKDUCKGO_PROVIDER_DEFAULTS: Readonly<{ baseURL: string }> = {
  baseURL: 'https://html.duckduckgo.com',
}

/** Defaults for the Perplexity external backend. */
export const PERPLEXITY_PROVIDER_DEFAULTS: Readonly<{
  baseURL: string
  model: string
  maxTokens: number
  apiKeyEnv: string
}> = {
  baseURL: 'https://api.perplexity.ai',
  model: 'sonar',
  maxTokens: 1024,
  apiKeyEnv: 'PERPLEXITY_API_KEY',
}

/**
 * Which backends each option field applies to. A field set outside this table
 * for the selected provider is rejected by {@link validateSection}. Key fields
 * apply to every keyed backend — `duckduckgo` alone is absent because it is
 * keyless.
 */
const FIELD_PROVIDERS: Readonly<Record<Exclude<keyof WebSearchPluginConfig, 'provider'>, readonly SearchProviderId[]>> = {
  apiKey: ['deepseek', 'claude', 'gemini', 'exa', 'brave', 'perplexity'],
  apiKeyEnv: ['deepseek', 'claude', 'gemini', 'exa', 'brave', 'perplexity'],
  baseURL: ['deepseek', 'claude', 'gemini', 'exa', 'brave', 'perplexity'],
  model: ['deepseek', 'claude', 'gemini', 'perplexity'],
  apiVersion: ['deepseek', 'claude'],
  maxTokens: ['deepseek', 'claude', 'perplexity'],
  maxUses: ['deepseek', 'claude'],
  searchType: ['exa'],
  numResults: ['exa', 'brave', 'duckduckgo'],
  highlightsPerResult: ['exa'],
  country: ['brave'],
  searchLang: ['brave'],
  searchRecency: ['perplexity'],
}

/**
 * Reject a resolved section whose fields do not all apply to its selected
 * provider. Runs at plugin load and on every settings write, so a provider
 * switch can never leave a stale field silently shadowing the new backend.
 *
 * @param config - the resolved section (schema-valid by construction).
 * @param provider - the backend the section selects.
 * @throws Error naming one inapplicable field per call.
 */
export function validateSection(config: WebSearchPluginConfig, provider: SearchProviderId): void {
  // An empty string is not a value: it would shadow the backend default with
  // a blank the request builders cannot use. Clearing is the unset gesture.
  for (const field of ['apiKeyEnv', 'baseURL', 'model'] as const) {
    if (config[field] === '') throw new Error(`web-search config: "${field}" must not be an empty string; clear it instead`)
  }
  for (const [field, providers] of Object.entries(FIELD_PROVIDERS)) {
    const value = config[field as Exclude<keyof WebSearchPluginConfig, 'provider'>]
    if (value === undefined) continue
    if (!providers.includes(provider)) {
      throw new Error(
        `web-search config: "${field}" does not apply to provider "${provider}" `
        + `(applies to: ${providers.join(', ')})`,
      )
    }
  }
}
