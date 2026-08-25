/**
 * Internal helpers shared by the search backends: the attribution header, the
 * positive-integer predicate every request-limit check repeats, and the one
 * place that owns translating transport failure, response-body failure,
 * credential absence, and provider error envelopes into the seam's stable
 * errors. Not part of the public package surface.
 * @module @deepseek-ai/dsh-web-search/internal
 */

import { createRequire } from 'node:module'
import { isAbortError, resolveProviderKey, searchAborted, WebError } from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

// The manifest sits one level up from both `src/` and built `lib/`.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Attribution header sent on every backend request; derived from the manifest version. */
export const USER_AGENT = `deepseek-harness/${version}`

/**
 * True for a request limit a backend can actually send (a positive whole number).
 * @param value - the configured limit to test.
 * @returns whether the limit is a positive integer.
 */
export function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/**
 * True when a keyed backend's credential plane can produce a key for the next
 * operation: a non-empty literal or a resolver thunk.
 * @param apiKey - the configured literal key, when present.
 * @param resolveApiKey - the per-operation resolver thunk, when present.
 * @returns whether `resolveSearchKey` can yield a key without failing.
 */
export function hasCredential(
  apiKey: string | undefined,
  resolveApiKey: (() => Promise<string | undefined>) | undefined,
): boolean {
  return (apiKey?.length ?? 0) > 0 || resolveApiKey !== undefined
}

/** Inputs {@link resolveSearchKey} resolves for one keyed search operation. */
export interface SearchKeyInput {
  /** Human-readable backend name used in diagnostics. */
  readonly product: string
  /** Literal API key; when present it wins over `resolveApiKey`. */
  readonly apiKey?: string | undefined
  /** Resolve the current API key for one search operation. */
  readonly resolveApiKey?: (() => Promise<string | undefined>) | undefined
  /** Credential reference named by missing-credential diagnostics. */
  readonly apiKeyEnv?: CredentialRef | undefined
  /** Conventional environment-variable name used when no reference is configured. */
  readonly fallbackEnv: string
}

/**
 * Resolve one operation's credential, failing as `WEB_PROVIDER_CREDENTIAL_MISSING`
 * when neither the literal nor the resolver yields a value.
 * @param input - the product name, credential plane, and fallback reference name.
 * @param signal - abort signal for the surrounding search, when one exists.
 * @returns the resolved key.
 */
export async function resolveSearchKey(input: SearchKeyInput, signal?: AbortSignal): Promise<string> {
  const key = await resolveProviderKey({
    product: input.product,
    apiKey: input.apiKey,
    resolveApiKey: input.resolveApiKey,
    ...signal !== undefined ? { signal } : {},
  })
  if (key !== undefined) return key
  const ref = input.apiKeyEnv ?? input.fallbackEnv
  throw new WebError(
    `${input.product} search has no API key for "${ref}"; store it through the credentials service`
    + ', export it in the launching environment, or set a literal "apiKey" in the web-search config',
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/**
 * Throw the given product's stable cancellation error when the caller already aborted.
 * @param product - human-readable backend name used in the error.
 * @param signal - the caller's cancellation signal, when one exists.
 */
export function throwIfSearchAborted(product: string, signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(product, signal)
}

/**
 * Translate one transport-level fetch failure into the seam's stable errors:
 * an already-aborted or aborted-mid-flight request surfaces as the product's
 * `WEB_ABORTED` error; any other failure as `WEB_PROVIDER_ERROR` naming the
 * product. Always throws.
 * @param product - human-readable backend name used in both messages.
 * @param error - the caught transport error.
 * @param signal - the caller's cancellation signal, when one exists.
 * @returns Never; declared so call sites can end their catch block with this call.
 */
export function translateSearchTransportError(product: string, error: unknown, signal: AbortSignal | undefined): never {
  if (signal?.aborted === true || isAbortError(error)) throw searchAborted(product, signal, error)
  throw new WebError(`${product} search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * POST one JSON request body and return the response, translating transport
 * failure like every other backend request ({@link translateSearchTransportError}).
 * @param product - human-readable backend name used in both error messages.
 * @param url - absolute endpoint URL.
 * @param headers - complete header record; `content-type` included.
 * @param body - the JSON-serializable request body.
 * @param signal - the caller's cancellation signal, when one exists.
 * @returns the raw response; status handling stays with the caller.
 */
export async function postJson(
  product: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(body),
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error: unknown) {
    translateSearchTransportError(product, error, signal)
  }
}

/**
 * Shared body+map guard: an abort racing the read surfaces as `WEB_ABORTED`, a
 * well-formed body of the wrong shape as the unprocessable-response error, and
 * a mapper's own `WebError` passes through unchanged. Always throws.
 * @param product - human-readable backend name used in both messages.
 * @param error - the caught read or mapping failure.
 * @param signal - the caller's cancellation signal, when one exists.
 */
function translateBodyFailure(product: string, error: unknown, signal: AbortSignal | undefined): never {
  if (error instanceof WebError) throw error
  if (signal?.aborted === true || isAbortError(error)) throw searchAborted(product, signal, error)
  throw new WebError(`${product} returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * Read one response body as JSON and map it, translating transport failure:
 * an abort racing the read surfaces as the product's `WEB_ABORTED` error, a
 * well-formed body of the wrong shape as the unprocessable-response error
 * naming the product, and the mapper's own {@link WebError} passes through.
 * @param product - human-readable backend name used in both error messages.
 * @param response - the completed response whose body is being mapped.
 * @param signal - the caller's cancellation signal, when one exists.
 * @param map - the backend's envelope-to-result mapping; its parameter type
 *   names the expected envelope.
 * @returns the mapped result.
 */
export async function mapResponseJson<M extends (body: object) => unknown>(
  product: string,
  response: Response,
  signal: AbortSignal | undefined,
  map: M,
): Promise<ReturnType<M>> {
  try {
    // A naked type-parameter callable resolves to its constraint's return
    // type, so the mapped result asserts back to the mapper's own return type.
    return map(await response.json() as Parameters<M>[0]) as ReturnType<M>
  } catch (error: unknown) {
    translateBodyFailure(product, error, signal)
  }
}

/**
 * Read one response body as text and map it, translating transport failure
 * exactly like {@link mapResponseJson}.
 * @param product - human-readable backend name used in both error messages.
 * @param response - the completed response whose body is being mapped.
 * @param signal - the caller's cancellation signal, when one exists.
 * @param map - the backend's body-to-result mapping.
 * @returns the mapped result.
 */
export async function mapResponseText<M extends (body: string) => unknown>(
  product: string,
  response: Response,
  signal: AbortSignal | undefined,
  map: M,
): Promise<ReturnType<M>> {
  try {
    return map(await response.text()) as ReturnType<M>
  } catch (error: unknown) {
    translateBodyFailure(product, error, signal)
  }
}

/**
 * Extract the best human-readable detail line from any observed provider error
 * envelope (`{error: "…"}`, `{error: {message: "…"}}`, `{message: "…"}`), so
 * every backend hands `throwProviderHttpError` the same extractor instead of
 * five shape-specific lambdas.
 * @param raw - the parsed error body of any shape.
 * @returns the detail line, or `undefined` when the envelope carries none.
 */
export function providerErrorDetail(raw: unknown): string | undefined {
  const parsed = raw as { error?: string | { message?: string }; message?: string }
  if (typeof parsed.error === 'string') return parsed.error
  return parsed.error?.message ?? parsed.message
}
