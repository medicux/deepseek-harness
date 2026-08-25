/**
 * Perplexity search over its OpenAI-compatible chat-completions endpoint. The generated answer
 * becomes `content`; sources prefer structured `search_results[]` and fall back to URL-only
 * `citations[]`. The wire format and native `fetch` client are provider-private and do not use
 * `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search/external-perplexity
 */

import { throwProviderHttpError } from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import {
  hasCredential,
  isPositiveInteger,
  postJson,
  providerErrorDetail,
  mapResponseJson,
  resolveSearchKey,
  throwIfSearchAborted,
  USER_AGENT,
} from './internal.ts'
import type { PerplexityResponse, PerplexitySearchResult } from './types.ts'

/** Stable id this provider registers under. */
export const PERPLEXITY_PROVIDER_ID = 'perplexity'

/** Default Perplexity endpoint; `/chat/completions` is the operation. */
export const PERPLEXITY_DEFAULT_BASE_URL = 'https://api.perplexity.ai'

/** Default search model. */
export const PERPLEXITY_DEFAULT_MODEL = 'sonar'

/** Default upper bound on generated answer tokens. */
export const PERPLEXITY_DEFAULT_MAX_TOKENS = 1024

/** Recency filter values Perplexity accepts for `search_recency_filter`. */
export type PerplexityRecency = 'day' | 'week' | 'month' | 'year'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface PerplexitySearchProviderOptions {
  /** Literal Perplexity API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Perplexity API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Search model name. */
  model: string
  /** Upper bound on generated answer tokens (`max_tokens`). */
  maxTokens: number
  /** Optional recency window sent as `search_recency_filter`; omitted = no filter. */
  searchRecency?: PerplexityRecency
}

/**
 * Map one structured Perplexity search result to a normalized source.
 *
 * @param result - one entry of the response's `search_results[]`.
 * @returns the normalized source; blank fields are omitted rather than set empty.
 */
export function mapPerplexityResult(result: PerplexitySearchResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.snippet != null && result.snippet.length > 0 ? { snippet: result.snippet } : {},
    ...result.date != null && result.date.length > 0 ? { publishedAt: result.date } : {},
  }
}

/**
 * Map a Perplexity response envelope to a normalized search result. Prefers
 * structured `search_results[]`; falls back to URL-only `citations[]` (those
 * sources carry just a `url`) only when `search_results` is absent.
 *
 * @param response - the parsed chat-completions response body.
 * @returns the normalized result; `content` is omitted when the answer is empty.
 */
export function mapPerplexityResponse(response: PerplexityResponse): WebSearchResult {
  const content = response.choices?.[0]?.message?.content
  const sources: WebSearchSource[] = response.search_results !== undefined
    ? response.search_results.map(mapPerplexityResult)
    : (response.citations ?? []).map(url => ({ url }))
  return {
    ...content != null && content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

/** The Perplexity-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class PerplexitySearchProvider implements WebSearchProvider {
  readonly id = PERPLEXITY_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once at each
   *   operation's entry so one search never mixes a key with a stale endpoint. A thunk rather
   *   than a value because the credential reference can rotate between searches, and
   *   re-registering the provider to carry a new key would make the seam's selection observable
   *   to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => PerplexitySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasCredential(options.apiKey, options.resolveApiKey)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a rotation
    // landing inside that await must not send the key resolved from one reference to an
    // endpoint named by another.
    const options = this.resolveOptions()
    const apiKey = await resolveSearchKey({
      product: 'Perplexity',
      apiKey: options.apiKey,
      resolveApiKey: options.resolveApiKey,
      apiKeyEnv: options.apiKeyEnv,
      fallbackEnv: 'PERPLEXITY_API_KEY',
    }, signal)
    throwIfSearchAborted('Perplexity', signal)
    const response = await postJson('Perplexity', `${options.baseURL}/chat/completions`, {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'user-agent': USER_AGENT,
    }, {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{ role: 'user', content: request.query }],
      ...options.searchRecency !== undefined ? { search_recency_filter: options.searchRecency } : {},
    }, signal)

    if (!response.ok) {
      await throwProviderHttpError(response, {
        product: 'Perplexity',
        ...signal !== undefined ? { signal } : {},
        extractDetail: providerErrorDetail,
      })
    }

    return mapResponseJson('Perplexity', response, signal, mapPerplexityResponse)
  }
}
