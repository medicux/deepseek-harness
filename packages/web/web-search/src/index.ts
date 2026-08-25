/**
 * `@deepseek-ai/dsh-web-search`: the single configurable search provider mount
 * for the web seam. One plugin, one `web-search` settings namespace: its
 * `provider` literal picks the backend — native model-mediated search
 * (`deepseek`, `claude`, `gemini`) or external search APIs (`exa`, `brave`,
 * `duckduckgo`, `perplexity`) — and registers exactly one `WebSearchProvider`
 * into `ctx.web` under that id. A committed provider switch swaps the
 * registration live; option edits reach the next search through the section
 * snapshot each operation reads at its entry.
 *
 * A function/namespace plugin (NOT a default-export service): it registers
 * INTO the seam's provider registry, exactly as `@deepseek-ai/dsh-llm-deepseek`
 * registers an adapter into `ctx.llm`.
 *
 * @module @deepseek-ai/dsh-web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-agent'
import { resolveProviderKeyOptions } from '@deepseek-ai/dsh-web'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  AnthropicNativeSearchProvider,
  type NativeAnthropicSearchLlmRequest,
} from './native-anthropic.ts'
import { GeminiSearchProvider, type NativeGeminiSearchLlmRequest } from './native-gemini.ts'
import { BraveSearchProvider } from './external-brave.ts'
import { DuckDuckGoSearchProvider } from './external-duckduckgo.ts'
import { ExaSearchProvider, EXA_DEFAULT_HIGHLIGHTS_PER_RESULT, EXA_DEFAULT_SEARCH_TYPE } from './external-exa.ts'
import { PerplexitySearchProvider } from './external-perplexity.ts'
import {
  ANTHROPIC_PROVIDER_DEFAULTS,
  BRAVE_PROVIDER_DEFAULTS,
  DUCKDUCKGO_PROVIDER_DEFAULTS,
  EXA_PROVIDER_DEFAULTS,
  GEMINI_PROVIDER_DEFAULTS,
  PERPLEXITY_PROVIDER_DEFAULTS,
  SEARCH_PROVIDER_IDS,
  validateSection,
  type SearchProviderId,
  type WebSearchPluginConfig,
} from './config.ts'

export {
  ANTHROPIC_PROVIDER_DEFAULTS,
  BRAVE_PROVIDER_DEFAULTS,
  DUCKDUCKGO_PROVIDER_DEFAULTS,
  EXA_PROVIDER_DEFAULTS,
  GEMINI_PROVIDER_DEFAULTS,
  PERPLEXITY_PROVIDER_DEFAULTS,
  SEARCH_PROVIDER_IDS,
  validateSection,
} from './config.ts'
export type { SearchProviderId, WebSearchPluginConfig } from './config.ts'
export {
  AnthropicNativeSearchProvider,
  citationSnippets,
  mapAnthropicNativeResponse,
  type AnthropicNativeSearchOptions,
  type NativeAnthropicSearchLlmRequest,
} from './native-anthropic.ts'
export {
  GeminiSearchProvider,
  mapGeminiResponse,
  type GeminiSearchProviderOptions,
  type NativeGeminiSearchLlmRequest,
} from './native-gemini.ts'
export {
  BraveSearchProvider,
  mapBraveResponse,
  BRAVE_DEFAULT_BASE_URL,
  stripMarkup,
} from './external-brave.ts'
export {
  DuckDuckGoSearchProvider,
  DUCKDUCKGO_DEFAULT_BASE_URL,
  mapDuckDuckGoResponse,
  parseResultsPage,
  unwrapResultHref,
} from './external-duckduckgo.ts'
export {
  ExaSearchProvider,
  mapExaResponse,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
} from './external-exa.ts'
export {
  PerplexitySearchProvider,
  mapPerplexityResponse,
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
} from './external-perplexity.ts'
export type {
  BraveSearchProviderOptions,
} from './external-brave.ts'
export type {
  DuckDuckGoSearchProviderOptions,
} from './external-duckduckgo.ts'
export type {
  ExaSearchProviderOptions,
} from './external-exa.ts'
export type {
  PerplexityRecency,
  PerplexitySearchProviderOptions,
} from './external-perplexity.ts'
export type {
  AnthropicMessagesSearchBody,
  AnthropicResponse,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace carrying the provider choice and every backend option. */
export const WEB_SEARCH_SETTINGS_NAMESPACE = settingsNamespace('web-search')

/** Provider applied when the section names none (preserves shipped behavior). */
const DEFAULT_PROVIDER: SearchProviderId = 'deepseek'

export const Config: z<WebSearchPluginConfig> = z.object({
  provider: z.union(SEARCH_PROVIDER_IDS),
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  model: z.string(),
  apiVersion: z.string(),
  maxTokens: z.number().step(1).min(1),
  maxUses: z.number().step(1).min(1),
  searchType: z.union(['auto', 'keyword', 'neural'] as const),
  numResults: z.number().step(1).min(1),
  highlightsPerResult: z.number().step(1).min(1),
  country: z.string(),
  searchLang: z.string(),
  searchRecency: z.union(['day', 'week', 'month', 'year'] as const),
})

/**
 * Exact secret-free auxiliary search request recorded immediately before one
 * native dispatch; the discriminated union spans both model-mediated protocols
 * (Anthropic-compatible Messages and Gemini `generateContent`). External REST
 * backends dispatch no model request and log nothing.
 */
export type NativeSearchLlmRequest =
  | NativeAnthropicSearchLlmRequest
  | NativeGeminiSearchLlmRequest

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Secret-free auxiliary native-search request recorded before dispatch. */
    'web/native-search-llm-request': NativeSearchLlmRequest
  }
}

/**
 * Register the configured search provider with `ctx.web`. The composition
 * entry seeds the active section; while a settings service is mounted, a
 * committed change re-validates and remounts the registration — including a
 * provider switch, which swaps the registry id live. Key resolution stays
 * per-operation through {@link resolveProviderKeyOptions}, so a rotated key
 * reaches the next search without re-registration.
 *
 * @param ctx - plugin context supplying the web, credential, and environment planes.
 * @param config - the composition entry for the `web-search` section.
 */
export function apply(ctx: Context, config: WebSearchPluginConfig): void {
  let current: () => WebSearchPluginConfig = () => config
  let disposeRegistration: (() => void) | undefined

  const recordNativeRequest = (request: NativeSearchLlmRequest): void => {
    ctx.get('agents')?.currentInitiator()?.session.append(
      'web/native-search-llm-request',
      request,
    )
  }

  const keyOptions = (section: WebSearchPluginConfig, apiKeyEnv: string) =>
    resolveProviderKeyOptions({
      credentials: ctx.get('credentials'),
      ambientValues: launchEnvironmentOf(ctx),
      apiKeyEnv: credentialRef(apiKeyEnv),
      literalApiKey: section.apiKey,
    })

  const mount = (): void => {
    const section = current()
    const provider = section.provider ?? DEFAULT_PROVIDER
    // Fails loud for an entry naming fields its provider ignores; the same
    // check rejects settings writes through the hooks below.
    validateSection(section, provider)
    const options = () => current()
    let built: Parameters<typeof ctx.web.registerSearchProvider>[0]
    switch (provider) {
      // The Config schema's union owns unknown-id rejection at parse time.

      case 'deepseek':
      case 'claude':
        built = new AnthropicNativeSearchProvider(provider, provider === 'claude' ? 'Claude' : 'DeepSeek', () => {
          const snapshot = options()
          const defaults = ANTHROPIC_PROVIDER_DEFAULTS[provider]
          return {
            ...keyOptions(snapshot, snapshot.apiKeyEnv ?? defaults.apiKeyEnv),
            // Section override over the ambient `$DEEPSEEK_SEARCH_BASE_URL`
            // over the built-in default; the ambient knob keeps one redirect
            // working for both native backends without a settings write.
            baseURL: snapshot.baseURL
              ?? launchEnvironmentOf(ctx).get('DEEPSEEK_SEARCH_BASE_URL')?.value
              ?? defaults.baseURL,
            model: snapshot.model ?? defaults.model,
            apiVersion: snapshot.apiVersion ?? defaults.apiVersion,
            maxTokens: snapshot.maxTokens ?? defaults.maxTokens,
            maxUses: snapshot.maxUses ?? defaults.maxUses,
            recordRequest: recordNativeRequest,
          }
        })
        break
      case 'gemini':
        built = new GeminiSearchProvider(() => {
          const snapshot = options()
          return {
            ...keyOptions(snapshot, snapshot.apiKeyEnv ?? GEMINI_PROVIDER_DEFAULTS.apiKeyEnv),
            baseURL: snapshot.baseURL ?? GEMINI_PROVIDER_DEFAULTS.baseURL,
            model: snapshot.model ?? GEMINI_PROVIDER_DEFAULTS.model,
            recordRequest: recordNativeRequest,
          }
        })
        break
      case 'exa':
        built = new ExaSearchProvider(() => {
          const snapshot = options()
          return {
            ...keyOptions(snapshot, snapshot.apiKeyEnv ?? EXA_PROVIDER_DEFAULTS.apiKeyEnv),
            baseURL: snapshot.baseURL ?? EXA_PROVIDER_DEFAULTS.baseURL,
            searchType: snapshot.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
            highlightsPerResult: snapshot.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
            ...snapshot.numResults !== undefined ? { numResults: snapshot.numResults } : {},
          }
        })
        break
      case 'brave':
        built = new BraveSearchProvider(() => {
          const snapshot = options()
          return {
            ...keyOptions(snapshot, snapshot.apiKeyEnv ?? BRAVE_PROVIDER_DEFAULTS.apiKeyEnv),
            baseURL: snapshot.baseURL ?? BRAVE_PROVIDER_DEFAULTS.baseURL,
            ...snapshot.numResults !== undefined ? { numResults: snapshot.numResults } : {},
            ...snapshot.country !== undefined ? { country: snapshot.country } : {},
            ...snapshot.searchLang !== undefined ? { searchLang: snapshot.searchLang } : {},
          }
        })
        break
      case 'duckduckgo':
        built = new DuckDuckGoSearchProvider(() => {
          const snapshot = options()
          return {
            baseURL: snapshot.baseURL ?? DUCKDUCKGO_PROVIDER_DEFAULTS.baseURL,
            ...snapshot.numResults !== undefined ? { numResults: snapshot.numResults } : {},
          }
        })
        break
      case 'perplexity':
        built = new PerplexitySearchProvider(() => {
          const snapshot = options()
          return {
            ...keyOptions(snapshot, snapshot.apiKeyEnv ?? PERPLEXITY_PROVIDER_DEFAULTS.apiKeyEnv),
            baseURL: snapshot.baseURL ?? PERPLEXITY_PROVIDER_DEFAULTS.baseURL,
            model: snapshot.model ?? PERPLEXITY_PROVIDER_DEFAULTS.model,
            maxTokens: snapshot.maxTokens ?? PERPLEXITY_PROVIDER_DEFAULTS.maxTokens,
            ...snapshot.searchRecency !== undefined ? { searchRecency: snapshot.searchRecency } : {},
          }
        })
        break
    }
    disposeRegistration?.()
    disposeRegistration = ctx.web.registerSearchProvider(built)
  }

  mount()
  installSettingsSection(ctx, WEB_SEARCH_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // Re-validate and remount on every committed change: a new provider
    // literal swaps the registry id, so the seam's selection follows the
    // section without a restart. The previous registration disposes first,
    // leaving exactly one search provider registered at any moment.
    onChange: () => {
      mount()
    },
    validate: (value) => {
      validateSection(value, value.provider ?? DEFAULT_PROVIDER)
    },
  })
}
