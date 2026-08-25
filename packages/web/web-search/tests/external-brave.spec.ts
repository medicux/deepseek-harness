import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  BRAVE_PROVIDER_ID,
  BraveSearchProvider,
  mapBraveResponse,
  mapBraveResult,
  stripMarkup,
  type BraveSearchProviderOptions,
} from '../src/external-brave.ts'

const options: BraveSearchProviderOptions = {
  apiKey: 'brave-key',
  baseURL: 'https://brave.test/res',
}

/** Override shape allowing an explicit `undefined` to delete a base member. */
type BraveOverrides = { [K in keyof BraveSearchProviderOptions]?: BraveSearchProviderOptions[K] | undefined }

/** Merge overrides over the base options, dropping an explicit `undefined` so optional members stay absent. */
function withOverrides<T extends object>(base: T, overrides: object): T {
  const merged = { ...base, ...overrides } as Record<string, unknown>
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as T
}


const searchProvider = (overrides: BraveOverrides = {}): BraveSearchProvider =>
  new BraveSearchProvider(() => withOverrides(options, overrides))

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('stripMarkup', () => {
  it('removes embedded markup tags and unescapes standalone entities', () => {
    expect(stripMarkup('The <b>best</b> &amp; brightest &quot;search&quot;&#39;'))
      .toBe('The best & brightest "search"\'')
  })
})

describe('mapBraveResult / mapBraveResponse', () => {
  it('maps a full result entry with age preferred over page_age', () => {
    expect(mapBraveResult({
      title: 'A',
      url: 'https://a.test',
      description: 'About <strong>A</strong>',
      age: '2 hours ago',
      page_age: '2026-01-01',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'About A', publishedAt: '2 hours ago' })
  })

  it('falls back to page_age when age is absent', () => {
    expect(mapBraveResult({ url: 'https://a.test', description: 'd', page_age: '2026-01-01' }))
      .toEqual({ url: 'https://a.test', snippet: 'd', publishedAt: '2026-01-01' })
  })

  it('drops entries without a url or without a non-blank description', () => {
    expect(mapBraveResult({ description: 'no url' })).toBeUndefined()
    expect(mapBraveResult({ url: '', description: 'empty url' })).toBeUndefined()
    expect(mapBraveResult({ url: 'https://a.test', description: '' })).toBeUndefined()
    expect(mapBraveResult({ url: 'https://a.test', description: null })).toBeUndefined()
    expect(mapBraveResult({ url: 'https://a.test', description: '   ' })).toBeUndefined()
  })

  it('omits blank titles and blank recency fields', () => {
    expect(mapBraveResult({ title: '', url: 'https://a.test', description: 'd', age: '' }))
      .toEqual({ url: 'https://a.test', snippet: 'd' })
  })

  it('maps a response envelope to a result with filtered sources', () => {
    const result = mapBraveResponse({
      web: {
        results: [
          { url: 'https://a.test', description: 'first', title: 'A' },
          { url: 'https://b.test' },
        ],
      },
    })
    expect(result).toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'first' }],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('throws WEB_PROVIDER_ERROR when the web section is missing', () => {
    expect(() => mapBraveResponse({}))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('tolerates an empty results array', () => {
    expect(mapBraveResponse({ web: { results: [] } }).sources).toEqual([])
  })
})

describe('BraveSearchProvider availability', () => {
  it(`registers under its id (${BRAVE_PROVIDER_ID})`, () => {
    expect(searchProvider().id).toBe(BRAVE_PROVIDER_ID)
  })

  it('is unavailable without a key', () => {
    expect(searchProvider({ apiKey: '' }).available()).toBe(false)
  })

  it('is available with only a resolver', () => {
    expect(searchProvider({ apiKey: undefined, resolveApiKey: async () => undefined }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(searchProvider({ numResults: -1 }).available()).toBe(false)
  })
})

describe('BraveSearchProvider request mapping', () => {
  it('sends query, count, country, language and the subscription token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [{ url: 'https://a.test', description: 'hi' }] } }))
    vi.stubGlobal('fetch', fetchMock)

    await searchProvider({ country: 'US', searchLang: 'en', numResults: 7 }).search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://brave.test/res/v1/web/search?q=hello&count=5&country=US&search_lang=en')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers['x-subscription-token']).toBe('brave-key')
    expect(headers['user-agent']).toMatch(/^deepseek-harness\//u)
  })

  it('omits count/country/language when nothing is configured and no maxResults rides the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider().search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [URL]
    expect(url.searchParams.get('count')).toBeNull()
    expect(url.searchParams.get('country')).toBeNull()
    expect(url.searchParams.get('search_lang')).toBeNull()
  })

  it('falls back to the configured numResults when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ numResults: 7 }).search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [URL]
    expect(url.searchParams.get('count')).toBe('7')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider().search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('BraveSearchProvider error handling', () => {
  it('sends the key resolved for the operation', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ apiKey: undefined, resolveApiKey: async () => 'resolved-key' }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('resolved-key')
  })

  it('prefers the literal key and never calls the resolver', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => 'resolver-key')
    await searchProvider({ resolveApiKey }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key')
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('fails as WEB_PROVIDER_CREDENTIAL_MISSING naming the reference when nothing resolves', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchProvider({
      apiKey: undefined,
      resolveApiKey: async () => undefined,
      apiKeyEnv: credentialRef('MY_BRAVE_KEY'),
    }).search({ query: 'q' })).rejects.toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
      message: expect.stringContaining('MY_BRAVE_KEY') as string,
    }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the conventional reference name when no explicit reference is configured', async () => {
    await expect(searchProvider({ apiKey: undefined, resolveApiKey: async () => undefined }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
        message: expect.stringContaining('BRAVE_API_KEY') as string,
      }))
  })

  it('wraps a failing credential backend as WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(searchProvider({
      apiKey: undefined,
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' })).rejects.toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('credential resolution failed') as string,
    }))
  })

  it('does not start credential resolution for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({ apiKey: undefined, resolveApiKey }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an abort during credential preflight as WEB_ABORTED without dispatching', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const promise = searchProvider({
      apiKey: undefined,
      resolveApiKey: () => new Promise<string>(() => {}),
    }).search({ query: 'q' }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('forwards an active signal into HTTP-error diagnostics', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return jsonResponse({ error: 'slow down' }, { status: 429 })
    }))
    await expect(searchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'slow down' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Brave API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Brave API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
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

  it('strict mode flows through search(): a missing web section throws WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ news: { results: [] } })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})
