/** The `web-search` plugin: one configurable provider mount over `ctx.web`. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as webSearchPlugin from '../src/index.ts'
import { WEB_SEARCH_SETTINGS_NAMESPACE } from '../src/index.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** The smallest Anthropic-shaped answer the native backend accepts. */
const ONE_ANTHROPIC_RESULT = {
  content: [
    { type: 'text', text: 'ok' },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'A' }] },
  ],
}

/** The smallest Exa-shaped answer. */
const ONE_EXA_RESULT = { results: [{ url: 'https://exa.test', highlights: ['hi'] }] }

/** Default endpoint fragment each backend hits, keyed by provider id. */
/** A fetch spy with its real call signature, without generic spyOn constraints. */
interface FetchSpy {
  mock: { calls: [input: string | Request | URL, init?: RequestInit | undefined][] }
  mockRestore(): void
}

const ENDPOINT_FRAGMENT: Record<string, string> = {
  deepseek: 'api.deepseek.com/anthropic/v1/messages',
  claude: 'api.anthropic.com/v1/messages',
  gemini: 'generativelanguage.googleapis.com',
  exa: 'api.exa.ai/search',
  brave: 'api.search.brave.com/res/v1/web/search',
  duckduckgo: 'html.duckduckgo.com/html/',
  perplexity: 'api.perplexity.ai/chat/completions',
}

/** The smallest success body each backend's mapper accepts. */
function successBodyFor(provider: string): unknown {
  switch (provider) {
    case 'deepseek':
    case 'claude':
      return ONE_ANTHROPIC_RESULT
    case 'gemini':
      return { candidates: [{ groundingMetadata: [{ groundingChunks: [{ web: { uri: 'https://g.test' } }] }] }] }
    case 'brave':
      return { web: { results: [{ url: 'https://b.test', description: 'd' }] } }
    case 'duckduckgo':
      return '<a class="result__a" href="https://a.test">A</a>'
    default:
      return {}
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Run one search and answer the endpoint it reached. A fresh `Response` per
 * call because a body can only be read once, and the call history is cleared
 * because repeated `spyOn` returns the same spy.
 * @param ctx - context whose `ctx.web` serves the search.
 * @param body - the mocked success body.
 * @returns the URL (or request target) the provider fetched.
 */
async function searchOnce(ctx: Context, body: unknown = ONE_ANTHROPIC_RESULT): Promise<string> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(body)))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  return String((fetchSpy.mock.calls.at(-1)?.[0] as URL | string | undefined) ?? '')
}

describe('web-search plugin registration', () => {
  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in webSearchPlugin).toBe(false)
  })

  it('survives the real Loader unwrapExports path keeping name/inject/Config', () => {
    // A default export would make `unwrapExports` collapse the namespace and drop `inject: ['web']`.
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(webSearchPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(webSearchPlugin)
    expect(unwrapped.name).toBe('web-search')
    expect(unwrapped.inject).toEqual(['web'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('registers the deepseek provider by default and disposes with the fiber (HMR-safe)', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    const fiber = await ctx.plugin(webSearchPlugin, { apiKey: 'ds-key' })
    expect(await searchOnce(ctx)).toBe('https://api.deepseek.com/anthropic/v1/messages')
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('mounts each configured backend under its own registry id', async () => {
    for (const provider of ['claude', 'gemini', 'exa', 'brave', 'duckduckgo', 'perplexity'] as const) {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      // Perplexity rides the loop to carry its optional recency window through.
      await ctx.plugin(webSearchPlugin, { provider, ...provider !== 'duckduckgo' ? { apiKey: 'k' } : {} })
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(jsonResponse(successBodyFor(provider))))
      fetchSpy.mockClear()
      await expect(ctx.web.search({ query: 'q' })).resolves.toBeDefined()
      const [target] = fetchSpy.mock.calls[0] as unknown as [URL | string]
      expect(String(target)).toContain(ENDPOINT_FRAGMENT[provider])
      await ctx.fiber.dispose()
    }
  })

  it('forwards optional backend options from the section snapshot', async () => {
    async function mounted(config: Record<string, unknown>): Promise<{ ctx: Context; spy: FetchSpy }> {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      const full = { ...config, ...(config.provider !== 'duckduckgo' ? { apiKey: 'k' } : {}) } as never
      await ctx.plugin(webSearchPlugin, full)
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(jsonResponse(successBodyFor(String(config.provider)))))
      return { ctx, spy }
    }

    const cases: { label: string; config: Record<string, unknown>; assert: (spy: FetchSpy) => void }[] = [
      {
        label: 'exa numResults',
        config: { provider: 'exa', numResults: 7 },
        assert: (spy) => {
          const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
          expect(JSON.parse(init.body as string)).toMatchObject({ numResults: 7 })
        },
      },
      {
        label: 'brave query options',
        config: { provider: 'brave', numResults: 4, country: 'de', searchLang: 'de' },
        assert: (spy) => {
          const [target] = spy.mock.calls[0] as unknown as [string]
          const url = new URL(target)
          expect(url.searchParams.get('count')).toBe('4')
          expect(url.searchParams.get('country')).toBe('de')
          expect(url.searchParams.get('search_lang')).toBe('de')
        },
      },
      {
        label: 'duckduckgo numResults',
        config: { provider: 'duckduckgo', numResults: 2 },
        assert: () => { /* enforced client-side by the mapper slice */ },
      },
      {
        label: 'perplexity recency',
        config: { provider: 'perplexity', searchRecency: 'week' },
        assert: (spy) => {
          const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
          expect(JSON.parse(init.body as string)).toMatchObject({ search_recency_filter: 'week' })
        },
      },
    ]
    for (const { label, config, assert } of cases) {
      const { ctx, spy } = await mounted(config)
      try {
        await expect(ctx.web.search({ query: 'q' })).resolves.toBeDefined()
        assert(spy)
      } catch (error: unknown) {
        throw new Error(`optional options case failed: ${label}`, { cause: error })
      } finally {
        spy.mockRestore()
        await ctx.fiber.dispose()
      }
    }
  })

  it('fails loud at load when a field does not apply to the selected provider', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await expect(ctx.plugin(webSearchPlugin, { provider: 'exa', maxUses: 3 }))
      .rejects.toThrow(/"maxUses" does not apply to provider "exa"/u)
    await ctx.fiber.dispose()
  })

  it('fails loud at load when a key field is set for the keyless provider', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await expect(ctx.plugin(webSearchPlugin, { provider: 'duckduckgo', apiKeyEnv: 'SOME_KEY' }))
      .rejects.toThrow(/"apiKeyEnv" does not apply to provider "duckduckgo"/u)
    await ctx.fiber.dispose()
  })

  it('serves duckduckgo without any credential plane', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(webSearchPlugin, { provider: 'duckduckgo' })
    expect(await searchOnce(ctx, '<a class="result__a" href="https://a.test">A</a>'))
      .toBe('https://html.duckduckgo.com/html/')
    await ctx.fiber.dispose()
  })

  it('threads claude config into its defaults and resolves ANTHROPIC_API_KEY from the environment', async () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key'
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(jsonResponse(ONE_ANTHROPIC_RESULT)))
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(webSearchPlugin, { provider: 'claude', model: 'claude-test-model' })
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('env-anthropic-key')
      expect(JSON.parse(init.body as string)).toMatchObject({ model: 'claude-test-model' })
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })

  it('resolves the credential for each search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-credentials-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(ONE_ANTHROPIC_RESULT))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(webSearchPlugin, { baseURL: 'https://api.deepseek.test/anthropic/v1' })

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('DEEPSEEK_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = fetchMock.mock.calls.map(call => (call[1]?.headers ?? {}) as Record<string, string>)
      expect(headers.map(value => value['x-api-key'])).toEqual(['stored-key', 'rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })
})

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function bootWithSettings(entry: webSearchPlugin.WebSearchPluginConfig): Promise<{
  ctx: Context
  settingsFiber: Fiber
  pluginFiber: Fiber
}> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(webSearchPlugin, entry)
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

describe('web-search settings section', () => {
  it('serves a stored endpoint to the next search without re-registering the provider', async () => {
    const bench = await bootWithSettings({ apiKey: 'ds-key', baseURL: 'https://search.entry.test/v1' })
    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test/v1')

    await bench.ctx.settings.update(WEB_SEARCH_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test/v1',
    })

    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test/v1')
    await bench.ctx.fiber.dispose()
  })

  it('switches the provider live: a committed section change swaps the registry id', async () => {
    const bench = await bootWithSettings({ apiKey: 'unused-entry-key' })
    expect(await searchOnce(bench.ctx)).toContain('api.deepseek.com')

    await bench.ctx.settings.update(WEB_SEARCH_SETTINGS_NAMESPACE, {
      provider: 'exa',
      apiKey: 'exa-key',
    })
    expect(await searchOnce(bench.ctx, ONE_EXA_RESULT)).toBe('https://api.exa.ai/search')
    await bench.ctx.fiber.dispose()
  })

  it('refuses a write naming fields the selected provider ignores', async () => {
    const bench = await bootWithSettings({ apiKey: 'ds-key' })
    await expect(bench.ctx.settings.update(WEB_SEARCH_SETTINGS_NAMESPACE, { searchType: 'neural' }))
      .rejects.toThrow(/"searchType" does not apply to provider "deepseek"/u)
    await bench.ctx.fiber.dispose()
  })

  it('refuses empty-string field values on write', async () => {
    const bench = await bootWithSettings({ apiKey: 'ds-key' })
    await expect(bench.ctx.settings.update(WEB_SEARCH_SETTINGS_NAMESPACE, { model: '' }))
      .rejects.toThrow(/"model" must not be an empty string/u)
    await expect(bench.ctx.settings.update(WEB_SEARCH_SETTINGS_NAMESPACE, { baseURL: '' }))
      .rejects.toThrow(/"baseURL" must not be an empty string/u)
    await expect(bench.ctx.settings.update(WEB_SEARCH_SETTINGS_NAMESPACE, { apiKeyEnv: '' }))
      .rejects.toThrow(/"apiKeyEnv" must not be an empty string/u)
    await bench.ctx.fiber.dispose()
  })

  it('keeps the literal key out of every described layer', async () => {
    const bench = await bootWithSettings({ apiKey: 'ds-key' })
    await bench.ctx.settings.update(WEB_SEARCH_SETTINGS_NAMESPACE, { apiKey: 'ds-stored-secret' })

    const [descriptor] = bench.ctx.settings.describe({ redactSecrets: true })
      .filter(row => String(row.ns) === 'web-search')

    expect(JSON.stringify(descriptor)).not.toContain('ds-stored-secret')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await bootWithSettings({ apiKey: 'ds-key', baseURL: 'https://search.entry.test/v1' })
    await bench.ctx.settings.update(WEB_SEARCH_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test/v1',
    })
    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test/v1')

    await bench.settingsFiber.dispose()

    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test/v1')
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const bench = await bootWithSettings({ apiKey: 'ds-key' })
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search')
    await bench.ctx.fiber.dispose()
  })
})
