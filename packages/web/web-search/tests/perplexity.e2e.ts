import { describe, expect, it } from 'vitest'
import { PerplexitySearchProvider } from '../src/external-perplexity.ts'
import { PERPLEXITY_PROVIDER_DEFAULTS } from '../src/config.ts'

/**
 * Real-API smoke for the Perplexity search provider. Self-skips without
 * `$PERPLEXITY_API_KEY`, per the with-key e2e policy in docs/testing.md.
 */
const apiKey = process.env.PERPLEXITY_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('PerplexitySearchProvider real API', () => {
  it('returns a generated answer and sources for a live query', async () => {
    const provider = new PerplexitySearchProvider(() => ({
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: process.env.PERPLEXITY_BASE_URL ?? PERPLEXITY_PROVIDER_DEFAULTS.baseURL,
      model: process.env.PERPLEXITY_MODEL ?? PERPLEXITY_PROVIDER_DEFAULTS.model,
      maxTokens: PERPLEXITY_PROVIDER_DEFAULTS.maxTokens,
    }))
    const result = await provider.search({ query: 'What is DeepSeek Harness?', maxResults: 5 })
    expect(result.content ?? '').not.toBe('')
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//u)
  }, 30_000)
})
