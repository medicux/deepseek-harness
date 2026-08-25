/**
 * `DuckDuckGoSearchProvider`: a keyless `WebSearchProvider` backed by
 * DuckDuckGo's HTML result page (`POST https://html.duckduckgo.com/html/`). It
 * parses the stable `result__a` anchor and `result__snippet` marker classes;
 * redirect-wrapped hrefs are unwrapped to their target URL. No credential, no
 * generated answer (`content` stays unset), and no recency field exists.
 * @module @deepseek-ai/dsh-web-search/external-duckduckgo
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import {
  isPositiveInteger,
  mapResponseText,
  throwIfSearchAborted,
  translateSearchTransportError,
  USER_AGENT,
} from './internal.ts'

/** Stable id this provider registers under. */
export const DUCKDUCKGO_PROVIDER_ID = 'duckduckgo'

/** Default endpoint serving the HTML results page. */
export const DUCKDUCKGO_DEFAULT_BASE_URL = 'https://html.duckduckgo.com'

/** One parsed HTML hit: title text, resolved target URL, and snippet text. */
interface ParsedHit {
  title: string
  url: string
  snippet?: string
}

/**
 * Unwrap one `href` from the results page. Redirect links point at
 * `//duckduckgo.com/l/?uddg=<encoded-target>&rut=…`; the target rides in the
 * `uddg` parameter. Links that already carry a direct http(s) URL pass through.
 *
 * @param href - the raw `href` attribute value.
 * @returns the absolute target URL, or `undefined` when neither form matches.
 */
export function unwrapResultHref(href: string): string | undefined {
  if (href.startsWith('//')) {
    const query = href.slice(href.indexOf('?') + 1)
    const target = new URLSearchParams(query).get('uddg')
    if (target !== null && target.length > 0) return decodeURIComponent(target)
    return undefined
  }
  if (href.startsWith('http://') || href.startsWith('https://')) return href
  return undefined
}

/** Strip tags and collapse whitespace so parsed markup lands as plain text. */
function plainText(raw: string): string {
  return raw
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll(/&amp;/gu, '&')
    .replaceAll(/&lt;/gu, '<')
    .replaceAll(/&gt;/gu, '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', '\'')
    .replaceAll(/\s+/gu, ' ')
    .trim()
}

/**
 * Parse one HTML results page into hits. Result anchors and snippets appear in
 * document order, so anchors pair with same-index snippets; a page with fewer
 * snippets than anchors leaves the tail without excerpts.
 *
 * @param html - the response body.
 * @returns the parsed hits in document order (unusable anchors skipped).
 */
export function parseResultsPage(html: string): ParsedHit[] {
  const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gu
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gu
  const snippets = [...html.matchAll(snippetPattern)].map(match => plainText(match[1] as string))
  const hits: ParsedHit[] = []
  let index = 0
  for (const match of html.matchAll(anchorPattern)) {
    const url = unwrapResultHref(match[1] as string)
    const title = plainText(match[2] as string)
    if (url === undefined || title.length === 0) continue
    const snippet = snippets[index]
    hits.push({ title, url, ...snippet !== undefined && snippet.length > 0 ? { snippet } : {} })
    index += 1
  }
  return hits
}

/**
 * Map a parsed page to a normalized search result.
 *
 * @param html - the response body.
 * @param limit - configured default result count; slices client-side because
 *   the endpoint exposes no count parameter.
 * @returns the normalized result; `truncated` stays `false` — the slice is the
 *   provider's own configured cap, not the seam's enforcement.
 */
export function mapDuckDuckGoResponse(html: string, limit?: number): WebSearchResult {
  // parseResultsPage already drops unusable anchors and blank excerpts, so
  // every hit carries a non-empty title and at most a non-empty snippet.
  const hits = parseResultsPage(html)
  const sources: WebSearchSource[] = hits.map(hit => ({
    url: hit.url,
    title: hit.title,
    ...hit.snippet !== undefined && hit.snippet.length > 0 ? { snippet: hit.snippet } : {},
  }))
  return { sources: limit !== undefined ? sources.slice(0, limit) : sources, truncated: false }
}

/** Resolved provider options (the plugin's `apply` supplies constant defaults). */
export interface DuckDuckGoSearchProviderOptions {
  /** Endpoint base; `/html/` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
}

/**
 * The DuckDuckGo-backed search provider; HTTP redirects fail as
 * `WEB_PROVIDER_ERROR`. Keyless by design — the backend serves its public HTML
 * endpoint without an API key, so this provider defines no credential surface.
 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once
   *   at each operation's entry so one search never mixes two sections.
   */
  constructor(private readonly resolveOptions: () => DuckDuckGoSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL)
      && (options.numResults === undefined || isPositiveInteger(options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    throwIfSearchAborted('DuckDuckGo', signal)
    // A per-request bound wins over the configured default; either may be absent.
    const limit = request.maxResults ?? options.numResults
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/html/`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'accept': 'text/html',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams({ q: request.query }).toString(),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      translateSearchTransportError('DuckDuckGo', error, signal)
    }

    if (!response.ok) {
      throw new WebError(`DuckDuckGo API error (HTTP ${String(response.status)})`, 'WEB_PROVIDER_ERROR')
    }

    return mapResponseText('DuckDuckGo', response, signal, html => mapDuckDuckGoResponse(html, limit))
  }
}
