/**
 * Native search through Gemini's `generateContent` endpoint with the
 * `google_search` grounding tool. Each search costs a model turn; sources come
 * from the response's `groundingMetadata` chunks and the grounded prose joins
 * them as `content`. The wire format and native `fetch` client are
 * provider-private and do not use `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search/native-gemini
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
  postJson,
  providerErrorDetail,
  mapResponseJson,
  resolveSearchKey,
  throwIfSearchAborted,
  USER_AGENT,
} from './internal.ts'
import type {
  GeminiGenerateContentBody,
  GeminiGenerateContentResponse,
} from './types.ts'

/** Stable id this provider registers under. */
export const GEMINI_PROVIDER_ID = 'gemini'

/**
 * Map a `generateContent` response to a normalized search result. Sources come
 * from every candidate's `groundingMetadata.groundingChunks[].web`, deduped by
 * URL; the first candidate's text parts join into `content`. Chunks carry no
 * excerpt field, so `snippet` stays unset rather than invented.
 *
 * @param response - the parsed `generateContent` response body.
 * @returns the normalized result.
 * @throws {@link WebError} when grounding produced no chunk at all — that is a
 *   search request whose native tool did not fire, not an empty result set.
 */
export function mapGeminiResponse(response: GeminiGenerateContentResponse): WebSearchResult {
  const candidates = response.candidates ?? []
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const candidate of candidates) {
    for (const metadata of candidate.groundingMetadata ?? []) {
      for (const chunk of metadata.groundingChunks ?? []) {
        const url = chunk.web?.uri
        if (url == null || url.length === 0 || seen.has(url)) continue
        seen.add(url)
        const title = chunk.web?.title
        sources.push({
          url,
          ...title != null && title.length > 0 ? { title } : {},
        })
      }
    }
  }
  if (sources.length === 0) {
    throw new WebError(
      'Gemini returned no grounding chunks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    )
  }

  const content = (candidates[0]?.content?.parts ?? [])
    .map(part => part.text)
    .filter((text): text is string => text != null && text.length > 0)
    .join('')
  return {
    ...content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

/**
 * Exact secret-free Gemini search request recorded immediately before one
 * auxiliary dispatch (`provider` discriminates the log event).
 */
export interface NativeGeminiSearchLlmRequest {
  readonly provider: 'gemini'
  /** Fully resolved `generateContent` endpoint. */
  readonly endpoint: string
  /** Exact JSON body sent to the provider. */
  readonly body: GeminiGenerateContentBody
}

/** Resolved options for one Gemini search operation. */
export interface GeminiSearchProviderOptions {
  /** Literal API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/models/{model}:generateContent` is appended. */
  baseURL: string
  /** Gemini model name. */
  model: string
  /**
   * Record the exact secret-free request immediately before dispatch. A throw
   * prevents dispatch so model-visible auxiliary input cannot escape logging.
   */
  recordRequest?: (request: NativeGeminiSearchLlmRequest) => void
}

/** The Gemini-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class GeminiSearchProvider implements WebSearchProvider {
  readonly id = GEMINI_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new endpoint
   * would make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => GeminiSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return hasCredential(options.apiKey, options.resolveApiKey)
      && URL.canParse(options.baseURL)
      && options.model.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await resolveSearchKey({
      product: 'Gemini',
      apiKey: options.apiKey,
      resolveApiKey: options.resolveApiKey,
      apiKeyEnv: options.apiKeyEnv,
      fallbackEnv: 'GEMINI_API_KEY',
    }, signal)
    throwIfSearchAborted('Gemini', signal)
    const endpoint = `${options.baseURL}/models/${options.model}:generateContent`
    const body: GeminiGenerateContentBody = {
      contents: [{
        parts: [{ text: `Perform a web search for the query: ${request.query}` }],
      }],
      tools: [{ google_search: {} }],
    }
    options.recordRequest?.({ provider: 'gemini', endpoint, body })
    throwIfSearchAborted('Gemini', signal)
    const response = await postJson('Gemini', endpoint, {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
      'accept': 'application/json',
      'user-agent': USER_AGENT,
    }, body, signal)

    if (!response.ok) {
      await throwProviderHttpError(response, {
        product: 'Gemini',
        ...signal !== undefined ? { signal } : {},
        extractDetail: providerErrorDetail,
      })
    }

    return mapResponseJson('Gemini', response, signal, mapGeminiResponse)
  }
}
