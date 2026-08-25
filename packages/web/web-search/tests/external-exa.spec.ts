import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ExaSearchProvider, type ExaSearchProviderOptions } from '../src/external-exa.ts'
import { mapExaResponse, mapExaResult } from '../src/external-exa.ts'

const options = { apiKey: 'exa-key', baseURL: 'https://api.exa.test', searchType: 'auto' as const, highlightsPerResult: 1 }

/** Wrap option overrides in the per-operation thunk the provider consumes. */
const provider = (overrides: {
  apiKey?: string | undefined
  resolveApiKey?: (() => Promise<string | undefined>) | undefined
  apiKeyEnv?: string
  searchType?: 'auto' | 'keyword' | 'neural'
  numResults?: number
  highlightsPerResult?: number
  baseURL?: string
} = {}): ExaSearchProvider => {
  // An explicit `undefined` override removes the base value instead of setting
  // it: the provider reads an absent `apiKey` as "resolve instead". A spread
  // cannot remove a key `...options` already laid down, so presence in
  // `overrides` paired with `undefined` deletes the inherited member.
  const { apiKey, resolveApiKey, apiKeyEnv, ...rest } = overrides
  const merged: ExaSearchProviderOptions = { ...options, ...rest }
  if ('apiKey' in overrides && apiKey === undefined) delete merged.apiKey
  if ('resolveApiKey' in overrides && resolveApiKey === undefined) delete merged.resolveApiKey
  if ('apiKeyEnv' in overrides && apiKeyEnv === undefined) delete merged.apiKeyEnv
  return new ExaSearchProvider(() => ({
    ...merged,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(resolveApiKey === undefined ? {} : { resolveApiKey }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) }),
  }))
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Exa result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapExaResult({
      url: 'https://a.test',
      title: 'A',
      publishedDate: '2026-01-01',
      highlights: ['salient sentence', 'second'],
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient sentence', publishedAt: '2026-01-01' })
  })

  it('drops a result with no usable highlight', () => {
    expect(mapExaResult({ url: 'https://a.test', highlights: [] })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test', highlights: ['  '] })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapExaResult({ url: 'https://a.test', title: null, publishedDate: null, highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
    expect(mapExaResult({ url: 'https://a.test', title: '', publishedDate: '', highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapExaResponse({
      results: [
        { url: 'https://a.test', highlights: ['one'] },
        { url: 'https://b.test' },
        { url: 'https://c.test', title: 'C', highlights: ['three'] },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapExaResponse({}).sources).toEqual([])
  })

})

describe('ExaSearchProvider availability', () => {
  it('is unavailable without a key or resolver', () => {
    expect(provider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with only a key resolver', () => {
    expect(provider({ ...options, apiKey: undefined, resolveApiKey: async () => undefined }).available()).toBe(true)
  })

  it('is available with a key', () => {
    expect(provider().available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(provider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when highlightsPerResult is not a positive integer', () => {
    expect(provider({ ...options, highlightsPerResult: 0 }).available()).toBe(false)
    expect(provider({ ...options, highlightsPerResult: 1.5 }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(provider({ ...options, numResults: -1 }).available()).toBe(false)
  })
})

describe('ExaSearchProvider credential resolution', () => {
  it('sends the key resolved for the operation as bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    await provider({ apiKey: undefined, resolveApiKey }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer resolved-key')
  })

  it('prefers the literal key and never calls the resolver', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => 'resolver-key')
    await provider({ resolveApiKey }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer exa-key')
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('fails as WEB_PROVIDER_CREDENTIAL_MISSING naming the reference when nothing resolves', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider({
      apiKey: undefined,
      resolveApiKey: async () => undefined,
      apiKeyEnv: 'MY_EXA_KEY',
    }).search({ query: 'q' })).rejects.toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
      message: expect.stringContaining('MY_EXA_KEY') as string,
    }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the conventional reference name when no explicit reference is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    await expect(provider({ apiKey: undefined, resolveApiKey: async () => undefined }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
        message: expect.stringContaining('EXA_API_KEY') as string,
      }))
  })

  it('wraps a failing credential backend as WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    await expect(provider({
      apiKey: undefined,
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' })).rejects.toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('credential resolution failed') as string,
    }))
  })

  it('surfaces an abort during credential preflight as WEB_ABORTED without dispatching', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const promise = provider({
      apiKey: undefined,
      resolveApiKey: () => new Promise<string>(() => {}),
    }).search({ query: 'q' }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not start credential resolution for a pre-aborted call', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => 'late-key')
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(provider({
      apiKey: undefined,
      resolveApiKey,
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the abort race alive when an HTTP error lands with an active signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'quota exhausted' }, { status: 402 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await expect(provider({ apiKey: undefined, resolveApiKey: async () => 'k' })
      .search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: expect.stringContaining('quota exhausted') as string,
      }))
  })

  it('maps an abort surfacing through body parsing to WEB_ABORTED', async () => {
    const abortingJson = async (): Promise<unknown> => {
      throw new DOMException('reader closed', 'AbortError')
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: abortingJson }) as unknown as Response))
    const controller = new AbortController()
    await expect(provider({ apiKey: undefined, resolveApiKey: async () => 'k' })
      .search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('snapshots options once so one search never mixes two sections', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    let current = { ...options }
    const mutable = new ExaSearchProvider(() => current)
    const search = mutable.search({ query: 'q' })
    current = { ...options, apiKey: 'rotated-key', baseURL: 'https://rotated.exa.test' }
    await search
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.exa.test/search')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer exa-key')
  })
})

describe('ExaSearchProvider request mapping', () => {
  it('sends query, type, highlights, numResults and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', highlights: ['hi'] }] }))
    vi.stubGlobal('fetch', fetchMock)

    await provider({ searchType: 'neural', highlightsPerResult: 3 }).search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.exa.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer exa-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      type: 'neural',
      contents: { highlights: { highlightsPerUrl: 3 } },
      numResults: 5,
    })
  })

  it('falls back to the configured numResults when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ ...options, numResults: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ numResults: 7 })
  })

  it('lets a request maxResults win over the configured numResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ ...options, numResults: 7 }).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ numResults: 2 })
  })

  it('omits numResults when neither maxResults nor a configured default is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('numResults')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider().search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('ExaSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Exa API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})
