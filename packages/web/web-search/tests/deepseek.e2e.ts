import { describe, expect, it } from 'vitest'
import { AnthropicNativeSearchProvider } from '../src/native-anthropic.ts'
import { ANTHROPIC_PROVIDER_DEFAULTS } from '../src/config.ts'

/**
 * Disabled real-API probe for the DeepSeek native search backend. The live
 * endpoint can complete without structured source blocks, so this is not a
 * reliable merge signal. Its body remains because mocks cannot confirm the
 * wire shape.
 */
const apiKey = process.env.DEEPSEEK_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('AnthropicNativeSearchProvider real API', () => {
  it.skip('returns citeable sources for a live query via native web_search', async () => {
    const defaults = ANTHROPIC_PROVIDER_DEFAULTS.deepseek
    const provider = new AnthropicNativeSearchProvider('deepseek', 'DeepSeek', () => ({
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: process.env.DEEPSEEK_SEARCH_BASE_URL ?? defaults.baseURL,
      model: process.env.DEEPSEEK_SEARCH_MODEL ?? defaults.model,
      apiVersion: defaults.apiVersion,
      maxTokens: defaults.maxTokens,
      maxUses: defaults.maxUses,
    }))
    const result = await provider.search({ query: 'What is DeepSeek Harness?', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//u)
  }, 60_000)
})
