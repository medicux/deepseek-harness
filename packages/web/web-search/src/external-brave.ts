/**
 * `BraveSearchProvider`: a `WebSearchProvider` backed by Brave's web-search API
 * (`GET /v1/web/search`, key in `X-Subscription-Token`). Descriptions become
 * `snippet` after their embedded HTML markup is stripped, and the recency
 * string maps to `publishedAt`. Brave returns no generated answer, so
 * `content` stays unset.
 * @module @deepseek-ai/dsh-web-search/external-brave
 */

import { throwProviderHttpError, WebError } from '@deepseek-ai/dsh-web'
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
  providerErrorDetail,
  mapResponseJson,
  resolveSearchKey,
  throwIfSearchAborted,
  translateSearchTransportError,
  USER_AGENT,
} from './internal.ts'
import type { BraveResult, BraveSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Default Brave endpoint; `/v1/web/search` is appended. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com/res'

/**
 * Strip the light HTML markup Brave embeds in result descriptions (`<b>`,
 * `<strong>`, …) so the excerpt lands as plain text.
 *
 * @param description - one raw `results[].description` value.
 * @returns the description with tags removed and entities unescaped.
 */
export function stripMarkup(description: string): string {
  return description
    .replaceAll(/<[^>]+>/gu, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', '\'')
}

/**
 * Map one Brave result to a normalized source, or `undefined` when it carries
 * no URL or no non-blank description (the seam has no other field to derive a
 * snippet from, and inventing one would lie).
 *
 * @param result - one entry of Brave's `web.results[]`.
 * @returns the normalized source, or `undefined` when unusable.
 */
export function mapBraveResult(result: BraveResult): WebSearchSource | undefined {
  if (result.url == null || result.url.length === 0) return undefined
  const rawDescription = result.description
  if (rawDescription == null || rawDescription.trim().length === 0) return undefined
  const publishedAt = result.age ?? result.page_age
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet: stripMarkup(rawDescription),
    ...publishedAt != null && publishedAt.length > 0 ? { publishedAt } : {},
  }
}

/**
 * Map a Brave response envelope to a normalized search result.
 *
 * @param response - the parsed search response body.
 * @returns the normalized result; unusable entries are dropped
 *   ({@link mapBraveResult}).
 * @throws {@link WebError} when the response carries no `web` vertical — the
 *   only vertical this provider consumes.
 */
export function mapBraveResponse(response: BraveSearchResponse): WebSearchResult {
  const results = response.web?.results
  if (results === undefined) {
    throw new WebError(
      'Brave returned no web results section; the request may not have reached the web-search vertical',
      'WEB_PROVIDER_ERROR',
    )
  }
  const sources = results
    .map(mapBraveResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface BraveSearchProviderOptions {
  /** Literal Brave API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Brave API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/v1/web/search` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
  /** Two-letter country code sent as `country`; omitted = Brave's default. */
  country?: string
  /** Search language sent as `search_lang`; omitted = Brave's default. */
  searchLang?: string
}

/** The Brave-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once at each
   *   operation's entry so one search never mixes a key with a stale endpoint. A thunk rather
   *   than a value because the credential reference can rotate between searches, and
   *   re-registering the provider to carry a new key would make the seam's selection observable
   *   to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => BraveSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasCredential(options.apiKey, options.resolveApiKey)
      && URL.canParse(options.baseURL)
      && (options.numResults === undefined || isPositiveInteger(options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a rotation
    // landing inside that await must not send the key resolved from one reference to an
    // endpoint named by another.
    const options = this.resolveOptions()
    const apiKey = await resolveSearchKey({
      product: 'Brave',
      apiKey: options.apiKey,
      resolveApiKey: options.resolveApiKey,
      apiKeyEnv: options.apiKeyEnv,
      fallbackEnv: 'BRAVE_API_KEY',
    }, signal)
    throwIfSearchAborted('Brave', signal)
    // A per-request bound wins over the configured default; either may be absent.
    const count = request.maxResults ?? options.numResults
    const url = new URL(`${options.baseURL}/v1/web/search`)
    url.searchParams.set('q', request.query)
    if (count !== undefined) url.searchParams.set('count', String(count))
    if (options.country !== undefined) url.searchParams.set('country', options.country)
    if (options.searchLang !== undefined) url.searchParams.set('search_lang', options.searchLang)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'x-subscription-token': apiKey,
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      translateSearchTransportError('Brave', error, signal)
    }

    if (!response.ok) {
      await throwProviderHttpError(response, {
        product: 'Brave',
        ...signal !== undefined ? { signal } : {},
        extractDetail: providerErrorDetail,
      })
    }

    return mapResponseJson('Brave', response, signal, mapBraveResponse)
  }
}
