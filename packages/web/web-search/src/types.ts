/**
 * Provider-private wire types for every search backend this plugin can mount.
 * Types only — no runtime code. None of these create a dependency on
 * `ctx.llm`; each backend's client speaks its own HTTP protocol directly.
 * @module @deepseek-ai/dsh-web-search/types
 */

// ── Anthropic-compatible Messages (DeepSeek, Claude) ────────────────────────

/** A `web_search_result` item inside a `web_search_tool_result` block. */
export interface WebSearchResultItem {
  type: string
  url: string
  title?: string | null
  /** Provider-supplied page age/recency string (mapped to `publishedAt`). */
  page_age?: string | null
}

/** A `web_search_tool_result` content block: the citeable result shape. */
export interface WebSearchToolResultBlock {
  type: 'web_search_tool_result'
  content?: WebSearchResultItem[]
}

/** One citation location inside a `text` block (the snippet source). */
export interface CitationLocation {
  type?: string
  url?: string | null
  cited_text?: string | null
}

/** A `text` content block: the model's prose plus per-URL citations. */
export interface TextBlock {
  type: 'text'
  text?: string | null
  citations?: CitationLocation[]
}

/** Any content block; only `web_search_tool_result` and `text` are consumed. */
export type ContentBlock = WebSearchToolResultBlock | TextBlock | { type: string }

/** The Anthropic Messages response envelope served by both native backends. */
export interface AnthropicResponse {
  content?: ContentBlock[]
}

/** Exact JSON body of one native Messages search request (`/messages`). */
export interface AnthropicMessagesSearchBody {
  readonly model: string
  readonly max_tokens: number
  readonly messages: readonly [{
    readonly role: 'user'
    readonly content: readonly [{
      readonly type: 'text'
      readonly text: string
    }]
  }]
  readonly tools: readonly [{
    readonly type: 'web_search_20250305'
    readonly name: 'web_search'
    readonly max_uses: number
  }]
}

// ── Gemini (Google Search grounding) ─────────────────────────────────────────

/** Exact JSON body of one Gemini `generateContent` search request. */
export interface GeminiGenerateContentBody {
  readonly contents: readonly [{
    readonly parts: readonly [{ readonly text: string }]
  }]
  readonly tools: readonly [{ readonly google_search: Record<string, never> }]
}

/** One grounding chunk: a URL the model's grounded answer drew on. */
export interface GeminiGroundingChunk {
  web?: {
    uri?: string | null
    title?: string | null
  }
}

/** One candidate's grounding metadata (the source list for that candidate). */
export interface GeminiGroundingMetadata {
  groundingChunks?: GeminiGroundingChunk[]
}

/** Gemini's `generateContent` response envelope (consumed fields only). */
export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string | null }>
    }
    groundingMetadata?: GeminiGroundingMetadata[]
  }>
}

// ── Exa ───────────────────────────────────────────────────────────────────────

/** One entry of Exa's flat `results[]`. */
export interface ExaResult {
  url: string
  title?: string | null
  publishedDate?: string | null
  highlights?: string[]
}

/** Exa's search response envelope. */
export interface ExaSearchResponse {
  results?: ExaResult[]
}

// ── Brave ─────────────────────────────────────────────────────────────────────

/** One entry of Brave's `web.results[]`. Descriptions carry light HTML markup. */
export interface BraveResult {
  title?: string | null
  url?: string | null
  description?: string | null
  /** Relative recency string (e.g. `"2 hours ago"`); preferred over `page_age`. */
  age?: string | null
  /** ISO-ish timestamp variant some responses carry instead of `age`. */
  page_age?: string | null
}

/** Brave's web-search response envelope (only the `web` vertical is consumed). */
export interface BraveSearchResponse {
  web?: {
    results?: BraveResult[]
  }
}

// ── Perplexity ────────────────────────────────────────────────────────────────

/** One entry of Perplexity's structured `search_results[]`. */
export interface PerplexitySearchResult {
  url: string
  title?: string | null
  snippet?: string | null
  date?: string | null
}

/** Perplexity's chat-completions response envelope (consumed fields only). */
export interface PerplexityResponse {
  choices?: Array<{
    message?: {
      content?: string | null
    }
  }>
  search_results?: PerplexitySearchResult[]
  citations?: string[]
}
