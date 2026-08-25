/**
 * `ExaSearchProvider`: a `WebSearchProvider` backed by the Exa search API (`POST /search` with
 * highlight contents). A non-empty literal key wins over `resolveApiKey`; when neither yields a
 * value the search fails as `WEB_PROVIDER_CREDENTIAL_MISSING` naming `apiKeyEnv`. It maps the
 * first non-blank highlight to `snippet`, maps `publishedDate` to `publishedAt`, drops entries
 * without a snippet, and omits `content` because Exa returns no generated answer.
 * @module @deepseek-ai/dsh-web-search/external-exa
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
import type { ExaResult, ExaSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const EXA_PROVIDER_ID = 'exa'

/** Default Exa search endpoint; `/search` is the operation. */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'

/** Default retrieval mode: let Exa pick between keyword and neural search. */
export const EXA_DEFAULT_SEARCH_TYPE = 'auto'

/** Default number of highlight sentences requested per result. */
export const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface ExaSearchProviderOptions {
  /** Literal Exa API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Exa API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Retrieval mode sent as Exa's `type`. */
  searchType: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
  /** Highlight sentences requested per result (Exa's `highlightsPerUrl`). */
  highlightsPerResult: number
}

/**
 * Map one Exa result to a normalized source, or `undefined` when it carries no
 * portable snippet (an entry with no highlight is dropped — the seam has no
 * other field to derive a snippet from, and inventing one would lie).
 *
 * @param result - one entry of Exa's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank highlight.
 */
export function mapExaResult(result: ExaResult): WebSearchSource | undefined {
  const snippet = result.highlights?.find(highlight => highlight.trim().length > 0)
  if (snippet === undefined) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Map an Exa response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; snippet-less entries are dropped
 *   ({@link mapExaResult}).
 */
export function mapExaResponse(response: ExaSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapExaResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // Exa returns no generated answer, so `content` is omitted. The web service owns the
  // final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The Exa-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class ExaSearchProvider implements WebSearchProvider {
  readonly id = EXA_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once at each
   *   operation's entry so one search never mixes a key with a stale endpoint. A thunk rather
   *   than a value because the credential reference can rotate between searches, and
   *   re-registering the provider to carry a new key would make the seam's selection observable
   *   to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => ExaSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasCredential(options.apiKey, options.resolveApiKey)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.highlightsPerResult)
      && (options.numResults === undefined || isPositiveInteger(options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a rotation
    // landing inside that await must not send the key resolved from one reference to an
    // endpoint named by another.
    const options = this.resolveOptions()
    const apiKey = await resolveSearchKey({
      product: 'Exa',
      apiKey: options.apiKey,
      resolveApiKey: options.resolveApiKey,
      apiKeyEnv: options.apiKeyEnv,
      fallbackEnv: 'EXA_API_KEY',
    }, signal)
    throwIfSearchAborted('Exa', signal)
    // A per-request bound wins over the configured default; either may be absent.
    const numResults = request.maxResults ?? options.numResults
    const response = await postJson('Exa', `${options.baseURL}/search`, {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'user-agent': USER_AGENT,
    }, {
      query: request.query,
      type: options.searchType,
      contents: { highlights: { highlightsPerUrl: options.highlightsPerResult } },
      ...numResults !== undefined ? { numResults } : {},
    }, signal)

    if (!response.ok) {
      await throwProviderHttpError(response, {
        product: 'Exa',
        ...signal !== undefined ? { signal } : {},
        extractDetail: providerErrorDetail,
      })
    }

    return mapResponseJson('Exa', response, signal, mapExaResponse)
  }
}
