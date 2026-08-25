import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DUCKDUCKGO_PROVIDER_ID,
  DuckDuckGoSearchProvider,
  mapDuckDuckGoResponse,
  parseResultsPage,
  unwrapResultHref,
} from '../src/external-duckduckgo.ts'

const searchProvider = (overrides: { baseURL?: string; numResults?: number } = {}): DuckDuckGoSearchProvider =>
  new DuckDuckGoSearchProvider(() => ({ baseURL: 'https://ddg.test', ...overrides }))

/** A trimmed results page carrying two hits: one redirect-wrapped, one direct. */
function resultsPage(): string {
  return `
  <div class="result">
    <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fpage&rut=abc">First &amp; foremost</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fpage">Snippet <b>one</b>  text</a>
  </div>
  <div class="result">
    <h2><a rel="nofollow" class="result__a result--highlight" href="https://b.test/direct">Second</a></h2>
    <a class="result__snippet" href="https://b.test/direct">Snippet two</a>
  </div>`
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('unwrapResultHref', () => {
  it('decodes the uddg parameter of a redirect link', () => {
    expect(unwrapResultHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fpage&rut=abc'))
      .toBe('https://a.test/page')
  })

  it('passes direct http(s) links through', () => {
    expect(unwrapResultHref('https://b.test/direct')).toBe('https://b.test/direct')
    expect(unwrapResultHref('http://b.test/direct')).toBe('http://b.test/direct')
  })

  it('returns undefined for redirect links without a target and unknown schemes', () => {
    expect(unwrapResultHref('//duckduckgo.com/l/?rut=abc')).toBeUndefined()
    expect(unwrapResultHref('/internal/path')).toBeUndefined()
  })
})

describe('parseResultsPage / mapDuckDuckGoResponse', () => {
  it('pairs anchors with same-index snippets and unwraps redirect targets', () => {
    const hits = parseResultsPage(resultsPage())
    expect(hits).toEqual([
      { title: 'First & foremost', url: 'https://a.test/page', snippet: 'Snippet one text' },
      { title: 'Second', url: 'https://b.test/direct', snippet: 'Snippet two' },
    ])
  })

  it('leaves the tail without snippets when the page has fewer of them', () => {
    const html = `
      <a class="result__a" href="https://a.test">A</a>
      <a class="result__snippet">only one snippet</a>
      <a class="result__a" href="https://b.test">B</a>`
    expect(parseResultsPage(html)).toEqual([
      { title: 'A', url: 'https://a.test', snippet: 'only one snippet' },
      { title: 'B', url: 'https://b.test' },
    ])
  })

  it('skips anchors that unwrap to nothing or carry no title', () => {
    const html = `
      <a class="result__a" href="/internal/path"></a>
      <a class="result__a" href="//duckduckgo.com/l/?rut=x">no target</a>
      <a class="result__a" href="https://ok.test">OK</a>`
    expect(parseResultsPage(html)).toEqual([{ title: 'OK', url: 'https://ok.test' }])
  })

  it('maps an empty page to zero sources and tolerates a missing limit', () => {
    expect(mapDuckDuckGoResponse('<html></html>')).toEqual({ sources: [], truncated: false })
    expect(mapDuckDuckGoResponse(resultsPage()).content).toBeUndefined()
  })

  it('slices client-side to the effective limit while reporting truncated false', () => {
    const result = mapDuckDuckGoResponse(resultsPage(), 1)
    expect(result.sources).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('drops the snippet key for hits the page left without one', () => {
    const html = `
      <a class="result__a" href="https://a.test">A</a>
      <a class="result__snippet">only one snippet</a>
      <a class="result__a" href="https://b.test">B</a>`
    const result = mapDuckDuckGoResponse(html)
    expect(result.sources).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'only one snippet' },
      { url: 'https://b.test', title: 'B' },
    ])
  })
})

describe('DuckDuckGoSearchProvider availability', () => {
  it(`registers under its id (${DUCKDUCKGO_PROVIDER_ID}) and is keyless-available`, () => {
    expect(searchProvider().id).toBe(DUCKDUCKGO_PROVIDER_ID)
    expect(searchProvider().available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(searchProvider({ numResults: 0 }).available()).toBe(false)
    expect(searchProvider({ numResults: 1.5 }).available()).toBe(false)
  })
})

describe('DuckDuckGoSearchProvider request mapping', () => {
  it('posts the query form-encoded to the html endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(resultsPage(), { status: 200, headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider().search({ query: 'hello' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://ddg.test/html/')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(init.body).toBe('q=hello')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(headers['accept']).toBe('text/html')
  })

  it('lets a request maxResults win over the configured numResults', async () => {
    const fetchMock = vi.fn(async () => new Response(resultsPage(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await searchProvider({ numResults: 7 }).search({ query: 'q', maxResults: 1 })
    expect(result.sources).toHaveLength(1)
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => new Response(resultsPage(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider().search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('DuckDuckGoSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the status line (the body is HTML)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>denied</html>', { status: 403 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo API error (HTTP 403)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a mid-stream body failure to WEB_PROVIDER_ERROR rather than an abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new TypeError('stream broke')) },
    }), { status: 200 })))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort during dispatch to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('throws WEB_ABORTED for a call already aborted at entry', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an abort during body read as WEB_ABORTED', async () => {
    const body = { text: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})
