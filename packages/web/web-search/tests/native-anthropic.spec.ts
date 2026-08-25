import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  AnthropicNativeSearchProvider,
  citationSnippets,
  mapAnthropicNativeResponse,
  type AnthropicNativeSearchOptions,
} from '../src/native-anthropic.ts'
import type { AnthropicResponse } from '../src/types.ts'

/** Construct the provider over a fixed options value; production passes a live thunk. */
const searchProvider = (
  id: 'deepseek' | 'claude',
  options: AnthropicNativeSearchOptions,
): AnthropicNativeSearchProvider => new AnthropicNativeSearchProvider(id, id === 'claude' ? 'Claude' : 'DeepSeek', () => options)

const options = {
  apiKey: 'ds-key',
  baseURL: 'https://api.deepseek.test/anthropic/v1',
  model: 'deepseek-chat',
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  maxUses: 5,
}

/** Merge overrides over the base options, dropping an explicit `undefined` so optional members stay absent. */
function withOverrides<T extends object>(base: T, overrides: object): T {
  return Object.fromEntries(Object.entries({ ...base, ...overrides }).filter(([, value]) => value !== undefined)) as T
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** A response with one result block plus a text block carrying the snippet. */
function searchResponse(): AnthropicResponse {
  return {
    content: [
      { type: 'text', text: 'Here is what I found.', citations: [{ type: 'web_search_result_location', url: 'https://a.test', cited_text: 'excerpt for A' }] },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.test', title: 'A', page_age: '2026-02-02' },
          { type: 'web_search_result', url: 'https://b.test', title: 'B' },
        ],
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('citationSnippets', () => {
  it('maps url → cited_text from text blocks, first occurrence wins', () => {
    const map = citationSnippets([
      { type: 'text', citations: [{ url: 'https://a.test', cited_text: 'first' }, { url: 'https://a.test', cited_text: 'second' }] },
      { type: 'text', citations: [{ url: 'https://b.test', cited_text: 'b text' }] },
    ])
    expect(map.get('https://a.test')).toBe('first')
    expect(map.get('https://b.test')).toBe('b text')
  })

  it('ignores citations missing url or cited_text', () => {
    const map = citationSnippets([
      { type: 'text', citations: [{ url: 'https://a.test' }, { cited_text: 'orphan' }, { url: '', cited_text: 'empty url' }] },
    ])
    expect(map.size).toBe(0)
  })
})

describe('mapAnthropicNativeResponse', () => {
  it('joins result items to citation snippets and maps page_age to publishedAt', () => {
    const result = mapAnthropicNativeResponse(searchResponse())
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'excerpt for A', publishedAt: '2026-02-02' },
        { url: 'https://b.test', title: 'B' },
      ],
      truncated: false,
    })
  })

  it('dedupes repeated urls across result blocks (first wins)', () => {
    const result = mapAnthropicNativeResponse({
      content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'first' }] },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'second' }] },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'first' }])
  })

  it('skips non-result items and items with an empty url', () => {
    const result = mapAnthropicNativeResponse({
      content: [{
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result_error', url: 'https://err.test' },
          { type: 'web_search_result', url: '' },
          { type: 'web_search_result', url: 'https://ok.test' },
        ],
      }],
    })
    expect(result.sources).toEqual([{ url: 'https://ok.test' }])
  })

  it('omits optional fields when absent or empty', () => {
    const result = mapAnthropicNativeResponse({
      content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: '', page_age: '' }] }],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
  })

  it('tolerates a text block with no citations', () => {
    const result = mapAnthropicNativeResponse({
      content: [
        { type: 'text', text: 'no citations here' },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'A' }] },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'A' }])
  })

  it('tolerates a result block with no content array', () => {
    const result = mapAnthropicNativeResponse({
      content: [
        { type: 'web_search_tool_result' },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test' }] },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
  })

  it('throws WEB_PROVIDER_ERROR (strict mode) when no result block is present', () => {
    expect(() => mapAnthropicNativeResponse({ content: [{ type: 'text', text: 'just prose, no search' }] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('throws WEB_PROVIDER_ERROR when content is absent entirely', () => {
    expect(() => mapAnthropicNativeResponse({}))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe.each([
  ['deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY'],
  ['claude', 'Claude', 'ANTHROPIC_API_KEY'],
] as const)('%s backend availability and identity', (id, product, defaultRef) => {
  it(`registers under its own id (${id})`, () => {
    expect(searchProvider(id, options).id).toBe(id)
  })

  it('is unavailable without a key', () => {
    expect(searchProvider(id, { ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(searchProvider(id, options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider(id, { ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when request limits are not positive integers', () => {
    expect(searchProvider(id, { ...options, maxTokens: 0 }).available()).toBe(false)
    expect(searchProvider(id, { ...options, maxUses: 0 }).available()).toBe(false)
    expect(searchProvider(id, { ...options, maxUses: 1.5 }).available()).toBe(false)
  })

  it(`names the reference in the ${product} missing-key diagnostic`, async () => {
    await expect(searchProvider(id, { ...options, apiKey: '', apiKeyEnv: credentialRef(defaultRef) }).search({ query: 'q' }))
      .rejects.toThrow(new RegExp(`${product} search has no API key for "${defaultRef}"`))
  })

  it(`falls back to the generic reference name in the ${product} missing-key diagnostic`, async () => {
    await expect(searchProvider(id, withOverrides(options, { apiKey: '', apiKeyEnv: undefined })).search({ query: 'q' }))
      .rejects.toThrow(new RegExp(`${product} search has no API key for "API_KEY"`))
  })
})

describe('native Messages request mapping', () => {
  it('records and posts the same Anthropic Messages request with the web_search server tool', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider('deepseek', { ...options, recordRequest }).search({ query: 'hello' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.test/anthropic/v1/messages')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('ds-key')
    expect(headers['authorization']).toBe('Bearer ds-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = {
      model: 'deepseek-chat',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: hello' }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect(recordRequest).toHaveBeenCalledOnce()
    expect(recordRequest).toHaveBeenCalledWith({
      provider: 'deepseek',
      endpoint: url,
      apiVersion: '2023-06-01',
      body,
    })
    expect(recordRequest.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0)
  })

  it('discriminates the claude backend in the recorded request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider('claude', {
      ...options,
      baseURL: 'https://api.anthropic.test/v1',
      recordRequest,
    }).search({ query: 'hello' })
    expect(recordRequest).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude' }))
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://api.anthropic.test/v1/messages')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider('deepseek', options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('settings changes mid-search', () => {
  it('serves one search from one section even when settings land during credential resolution', async () => {
    // The section the search starts on, and the one a user commits while the
    // credential is still resolving.
    const before: AnthropicNativeSearchOptions = { ...options, apiKey: '', resolveApiKey: async () => 'key-from-before', baseURL: 'https://before.test/v1', model: 'model-before', maxUses: 2 }
    const after: AnthropicNativeSearchOptions = { ...options, apiKey: '', baseURL: 'https://after.test/v1', model: 'model-after', maxUses: 9 }
    let current = before
    let commitSettings = () => {}
    const resolveApiKey = () => new Promise<string>((resolve) => {
      commitSettings = () => { current = after; resolve('key-from-before') }
    })
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new AnthropicNativeSearchProvider('deepseek', 'DeepSeek', () => ({ ...current, resolveApiKey }))
    const search = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(typeof commitSettings).toBe('function') })
    commitSettings()
    await search

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    // The key resolved from `before` must never reach `after`'s origin.
    expect(endpoint).toBe('https://before.test/v1/messages')
    expect(init.headers['x-api-key']).toBe('key-from-before')
    expect(JSON.parse(init.body)).toMatchObject({ model: 'model-before' })
  })
})

describe('error handling', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider('deepseek', {
      ...options,
      apiKey: '',
      resolveApiKey,
      recordRequest,
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending', async () => {
    const resolveApiKey = vi.fn(() => new Promise<string>(() => {}))
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = searchProvider('deepseek', {
      ...options,
      apiKey: '',
      resolveApiKey,
      recordRequest,
    }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves credentials under an active cancellation signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await expect(searchProvider('deepseek', {
      ...options,
      apiKey: '',
      resolveApiKey: async () => 'resolved-key',
    }).search({ query: 'q' }, controller.signal)).resolves.toMatchObject({ truncated: false })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('resolved-key')
  })

  it('maps a credential resolver rejection under an active signal to WEB_PROVIDER_ERROR', async () => {
    const controller = new AbortController()
    await expect(searchProvider('deepseek', {
      ...options,
      apiKey: '',
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek search credential resolution failed: Error: credential backend failed',
      }))
  })

  it('observes cancellation triggered synchronously by credential resolution', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchProvider('deepseek', {
      ...options,
      apiKey: '',
      resolveApiKey: () => {
        controller.abort(new Error('resolver cancelled caller'))
        return Promise.resolve('unused-key')
      },
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 })))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }))
  })

  it('keeps the abort race alive when an HTTP error lands with an active signal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 })))
    const controller = new AbortController()
    await expect(searchProvider('deepseek', options).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }))
  })

  it('handles a string-form error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad request' }, { status: 400 })))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'bad request' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'DeepSeek API error (HTTP 503)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'DeepSeek API error (HTTP 500)' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a custom abort reason to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('custom abort reason')) }, { once: true })
      })))
    const search = searchProvider('deepseek', options).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('timeout reason'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: {} }, { status: 200 })))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('strict mode flows through search(): a prose-only response throws WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'no search happened' }] })))
    await expect(searchProvider('deepseek', options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})
