/**
 * Native search through the Anthropic-compatible Messages API with the
 * `web_search_20250305` server tool — the protocol both DeepSeek's
 * Anthropic-compatible endpoint and the Anthropic API itself speak. Each search
 * costs a model turn, but returns structured result blocks; absence of those
 * blocks is an error rather than a prose-scraping fallback. The wire format and
 * native `fetch` client are provider-private and do not use `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search/native-anthropic
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
  postJson,
  providerErrorDetail,
  mapResponseJson,
  resolveSearchKey,
  throwIfSearchAborted,
  USER_AGENT,
} from './internal.ts'
import type {
  AnthropicMessagesSearchBody,
  AnthropicResponse,
  ContentBlock,
  TextBlock,
  WebSearchToolResultBlock,
} from './types.ts'

/**
 * Build a `url → cited_text` map from every `text` block's `citations[]`. This
 * is the snippet source: Messages `web_search_result` items carry
 * `url`/`title`/`page_age` but typically NO inline snippet — the excerpt lives
 * in a separate `text` block's citation, keyed by `url` (first occurrence wins).
 *
 * @param blocks - the response's content blocks; non-`text` blocks are skipped.
 * @returns the `url → cited_text` map (empty when no citations are present).
 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of (block as TextBlock).citations ?? []) {
      if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text)
      }
    }
  }
  return map
}

/**
 * Map a Messages response to a normalized search result. Walks
 * `web_search_tool_result` blocks for citeable `web_search_result` items, joins
 * each to its citation excerpt as `snippet`, and dedupes by `url` (a
 * `max_uses > 1` request can surface the same URL across searches). The web
 * service owns the final `maxResults` truncation, so `truncated` is always
 * `false` here.
 *
 * @param response - the parsed Messages response body.
 * @returns the normalized result with deduped, snippet-joined sources.
 * @throws {@link WebError} when native search produced no result block.
 */
export function mapAnthropicNativeResponse(response: AnthropicResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter(
    (block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'the provider returned no web_search_tool_result blocks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    )
  }

  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...item.title != null && item.title.length > 0 ? { title: item.title } : {},
        ...snippet != null && snippet.length > 0 ? { snippet } : {},
        ...item.page_age != null && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
      })
    }
  }
  return { sources, truncated: false }
}

/** Resolved options for one native Messages search backend. */
export interface AnthropicNativeSearchOptions {
  /** Literal API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/messages` is appended. */
  baseURL: string
  /** Anthropic-format model name. */
  model: string
  /** `anthropic-version` header value. */
  apiVersion: string
  /** Upper bound on generated tokens for the Messages request. */
  maxTokens: number
  /** Maximum `web_search` server-tool uses per request. */
  maxUses: number
  /**
   * Record the exact secret-free request immediately before dispatch. A throw
   * prevents dispatch so model-visible auxiliary input cannot escape logging.
   */
  recordRequest?: (request: NativeAnthropicSearchLlmRequest) => void
}

/**
 * Exact secret-free Messages search request recorded immediately before one
 * auxiliary dispatch (`provider` names which native backend sent it).
 */
export interface NativeAnthropicSearchLlmRequest {
  readonly provider: 'deepseek' | 'claude'
  /** Fully resolved Messages endpoint. */
  readonly endpoint: string
  /** `anthropic-version` header value. */
  readonly apiVersion: string
  /** Exact JSON body sent to the provider. */
  readonly body: AnthropicMessagesSearchBody
}

/** One native Messages search backend (`id` doubles as its registry key). */
export class AnthropicNativeSearchProvider implements WebSearchProvider {
  readonly id: 'deepseek' | 'claude'

  /**
   * @param id - registry key and log-event discriminator (`deepseek` or `claude`).
   * @param product - name opening every diagnostic message (e.g. `'DeepSeek'`).
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new endpoint
   * would make the seam's selection observable to the user as a flicker.
   */
  constructor(
    id: 'deepseek' | 'claude',
    private readonly product: string,
    private readonly resolveOptions: () => AnthropicNativeSearchOptions,
  ) {
    this.id = id
  }

  available(): boolean {
    const options = this.resolveOptions()
    return hasCredential(options.apiKey, options.resolveApiKey)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
      && isPositiveInteger(options.maxUses)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await resolveSearchKey({
      product: this.product,
      apiKey: options.apiKey,
      resolveApiKey: options.resolveApiKey,
      apiKeyEnv: options.apiKeyEnv,
      fallbackEnv: 'API_KEY',
    }, signal)
    throwIfSearchAborted(this.product, signal)
    const endpoint = `${options.baseURL}/messages`
    const body: AnthropicMessagesSearchBody = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
    }
    options.recordRequest?.({ provider: this.id, endpoint, apiVersion: options.apiVersion, body })
    throwIfSearchAborted(this.product, signal)
    const response = await postJson(this.product, endpoint, {
      // Official backends expect `x-api-key`; an Anthropic-compatible proxy
      // may expect `Authorization: Bearer` — send both so either resolves.
      'x-api-key': apiKey,
      'authorization': `Bearer ${apiKey}`,
      'anthropic-version': options.apiVersion,
      'content-type': 'application/json',
      'accept': 'application/json',
      'user-agent': USER_AGENT,
    }, body, signal)

    if (!response.ok) {
      await throwProviderHttpError(response, {
        product: this.product,
        ...signal !== undefined ? { signal } : {},
        extractDetail: providerErrorDetail,
      })
    }

    return mapResponseJson(this.product, response, signal, mapAnthropicNativeResponse)
  }
}
