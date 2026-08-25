import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiSearchProvider, mapGeminiResponse, type GeminiSearchProviderOptions } from '../src/native-gemini.ts'
import type { GeminiGenerateContentResponse } from '../src/types.ts'

const options = {
  apiKey: 'g-key',
  baseURL: 'https://gemini.test/v1beta',
  model: 'gemini-test',
}

/** Override shape allowing an explicit `undefined` to delete a base member. */
type GeminiOverrides = { [K in keyof GeminiSearchProviderOptions]?: GeminiSearchProviderOptions[K] | undefined }

/** Merge overrides over the base options, dropping an explicit `undefined` so optional members stay absent. */
function withOverrides<T extends object>(base: T, overrides: object): T {
  const merged = { ...base, ...overrides } as Record<string, unknown>
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as T
}


const searchProvider = (overrides: GeminiOverrides = {}): GeminiSearchProvider =>
  new GeminiSearchProvider(() => withOverrides(options, overrides))

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** One grounded candidate: two chunks (one duplicated across candidates) plus prose. */
function groundedResponse(): GeminiGenerateContentResponse {
  return {
    candidates: [
      {
        content: { parts: [{ text: 'Grounded answer. ' }, { text: 'More.' }] },
        groundingMetadata: [
          { groundingChunks: [{ web: { uri: 'https://a.test', title: 'A' } }] },
          { groundingChunks: [{ web: { uri: 'https://b.test' } }] },
        ],
      },
      {
        groundingMetadata: [
          { groundingChunks: [{ web: { uri: 'https://a.test', title: 'duplicate ignored' } }] },
        ],
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mapGeminiResponse', () => {
  it('collects deduped sources across candidates and joins the first candidate prose', () => {
    const result = mapGeminiResponse(groundedResponse())
    expect(result).toEqual({
      content: 'Grounded answer. More.',
      sources: [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test' }],
      truncated: false,
    })
  })

  it('omits content when the first candidate carries no text parts', () => {
    const result = mapGeminiResponse({
      candidates: [{
        groundingMetadata: [{ groundingChunks: [{ web: { uri: 'https://a.test', title: '' } }] }],
      }],
    })
    expect(result).toEqual({ sources: [{ url: 'https://a.test' }], truncated: false })
    expect(result.content).toBeUndefined()
  })

  it('skips chunks without a uri and blank titles', () => {
    const result = mapGeminiResponse({
      candidates: [{
        groundingMetadata: [{
          groundingChunks: [
            { web: { uri: '', title: 'empty uri' } },
            { web: { title: 'no uri' } },
            {},
            { web: { uri: 'https://ok.test', title: 'OK' } },
          ],
        }],
      }],
    })
    expect(result.sources).toEqual([{ url: 'https://ok.test', title: 'OK' }])
  })

  it('treats a candidate without grounding metadata as contributing nothing', () => {
    expect(() => mapGeminiResponse({ candidates: [{}] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('tolerates grounding metadata without chunks alongside a grounded candidate', () => {
    const result = mapGeminiResponse({
      candidates: [
        { groundingMetadata: [{}] },
        { groundingMetadata: [{ groundingChunks: [{ web: { uri: 'https://ok.test' } }] }] },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://ok.test' }])
  })

  it('throws WEB_PROVIDER_ERROR when grounding produced no chunk at all', () => {
    expect(() => mapGeminiResponse({ candidates: [{ content: { parts: [{ text: 'prose only' }] } }] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('throws WEB_PROVIDER_ERROR when candidates are absent entirely', () => {
    expect(() => mapGeminiResponse({}))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('GeminiSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(searchProvider({ apiKey: '' }).available()).toBe(false)
  })

  it('is available with only a resolver', () => {
    expect(searchProvider({ apiKey: undefined, resolveApiKey: async () => 'k' }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured without a model', () => {
    expect(searchProvider({ model: '' }).available()).toBe(false)
  })
})

describe('GeminiSearchProvider request mapping', () => {
  it('records and posts the same generateContent request with the google_search tool', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(groundedResponse()))
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ recordRequest }).search({ query: 'hello' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://gemini.test/v1beta/models/gemini-test:generateContent')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('g-key')
    const body = {
      contents: [{ parts: [{ text: 'Perform a web search for the query: hello' }] }],
      tools: [{ google_search: {} }],
    }
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect(recordRequest).toHaveBeenCalledWith({ provider: 'gemini', endpoint: url, body })
    expect(recordRequest.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0)
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(groundedResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider().search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('GeminiSearchProvider error handling', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({ apiKey: undefined, resolveApiKey, recordRequest }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending', async () => {
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = searchProvider({
      apiKey: undefined,
      resolveApiKey: () => new Promise<string>(() => {}),
      recordRequest,
    }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a credential resolver rejection under an active signal to WEB_PROVIDER_ERROR', async () => {
    const controller = new AbortController()
    await expect(searchProvider({
      apiKey: undefined,
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Gemini search credential resolution failed: Error: credential backend failed',
      }))
  })

  it('names the reference in the missing-key diagnostic', async () => {
    await expect(searchProvider({ apiKey: '', resolveApiKey: async () => undefined }).search({ query: 'q' }))
      .rejects.toThrow(new RegExp('GEMINI_API_KEY'))
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'quota exceeded' } }, { status: 429 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'quota exceeded' }))
  })

  it('falls back to a top-level message and forwards an active signal into HTTP-error diagnostics', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return jsonResponse({ message: 'top-level failure' }, { status: 400 })
    }))
    await expect(searchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'top-level failure' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Gemini API error (HTTP 503)' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('strict mode flows through search(): a prose-only response throws WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'no grounding' }] } }] })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})
