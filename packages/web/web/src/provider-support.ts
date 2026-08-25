/**
 * Support shared by the bundled search providers: per-operation API-key
 * resolution across the three recognized sources, and the HTTP error mapping
 * every provider repeats. Kept beside the seam's error types so providers
 * import one package for the whole contract.
 * @module @deepseek-ai/dsh-web/provider-support
 */

import { WebError } from './types.ts'

/** One provider's per-operation API-key options, as the provider options carry them. */
export interface ProviderKeyOptions<Reference extends string> {
  /** Literal key from config when present; it wins over every other source. */
  apiKey?: string
  /** Resolve the current key for one operation. */
  resolveApiKey: () => Promise<string | undefined>
  /** Credential reference named by missing-key diagnostics. */
  apiKeyEnv: Reference
}

/**
 * Build one provider's key options from the three sources the product
 * recognizes: a non-empty literal config key, the optional `credentials`
 * seam, and the launching environment. Without the seam the environment is
 * the whole credential plane — every layer may name the key, and the managed
 * store is not involved.
 * @param input.credentials - the plugin context's credential seam, when mounted.
 * @param input.ambientValues - launch-environment snapshot supplying fallback values.
 * @param input.apiKeyEnv - credential reference the missing-key diagnostics name.
 * @param input.literalApiKey - config-supplied key; empty or absent defers to resolution.
 * @returns the provider-options fragment carrying key state and resolution.
 */
export function resolveProviderKeyOptions<Reference extends string>(input: {
  credentials: { resolve(reference: Reference): Promise<{ value?: string } | undefined> } | undefined
  ambientValues: { get(name: string): { value: string } | undefined }
  apiKeyEnv: Reference
  literalApiKey: string | undefined
}): ProviderKeyOptions<Reference> {
  const literal = input.literalApiKey !== undefined && input.literalApiKey.length > 0
    ? input.literalApiKey
    : undefined
  return {
    ...literal === undefined ? {} : { apiKey: literal },
    resolveApiKey: async () => {
      if (input.credentials !== undefined) return (await input.credentials.resolve(input.apiKeyEnv))?.value
      const ambient = input.ambientValues.get(input.apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv: input.apiKeyEnv,
  }
}

/**
 * Resolve one operation's API key from the provider's option snapshot: a
 * non-empty literal key wins, otherwise `resolveApiKey` runs raced against
 * caller cancellation. Cancellation surfaces as `WEB_ABORTED`; a failing
 * resolution surfaces as `WEB_PROVIDER_ERROR`.
 * @param input.product - provider name opening every message.
 * @param input.apiKey - the snapshot's literal key, when present.
 * @param input.resolveApiKey - the snapshot's resolver, when supplied.
 * @param input.signal - abort signal of the surrounding search.
 * @returns the resolved key, or `undefined` when no source supplies one.
 */
export async function resolveProviderKey(input: {
  product: string
  apiKey: string | undefined
  resolveApiKey: (() => Promise<string | undefined>) | undefined
  signal?: AbortSignal
}): Promise<string | undefined> {
  // A pre-aborted call starts nothing: the resolver must not run at all, so
  // cancellation is checked before any key source is touched.
  if (input.signal?.aborted === true) throw searchAborted(input.product, input.signal)
  if (input.apiKey !== undefined && input.apiKey.length > 0) return input.apiKey
  // The flag flips across the await below, so the post-race check reads it
  // through a call: control-flow narrowing must not erase the re-check.
  const abortedNow = (): boolean => input.signal?.aborted === true
  let resolved: string | undefined
  try {
    resolved = await raceAbort(input.resolveApiKey?.() ?? Promise.resolve(undefined), input.signal, input.product)
  } catch (error: unknown) {
    if (abortedNow() || isAbortError(error)) throw searchAborted(input.product, input.signal, error)
    throw new WebError(`${input.product} search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  return resolved !== undefined && resolved.length > 0 ? resolved : undefined
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function raceAbort(operation: Promise<string | undefined>, signal: AbortSignal | undefined, product: string): Promise<string | undefined> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(product, signal))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(product, signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/**
 * True for a fetch/`AbortSignal` abort; callers surface it as `WEB_ABORTED`.
 * @param error - the caught value from a fetch or stream read.
 * @returns whether the value is the platform's abort error.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Build the seam's stable cancellation error while retaining the caller's reason.
 * @param product - provider name opening the message, e.g. `'Exa'`.
 * @param signal - abort signal of the surrounding search.
 * @param fallback - secondary cause when the signal carries no reason.
 * @returns a branded `WEB_ABORTED` error carrying that reason.
 */
export function searchAborted(product: string, signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError(`${product} search aborted`, 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/**
 * Map one non-2xx provider response to the seam's stable provider error;
 * always throws. An abort racing the body read surfaces as `WEB_ABORTED` —
 * cancellation is not a provider error (the seam's cancellation contract). A
 * malformed or non-JSON error body keeps the HTTP-status message: a gateway
 * 5xx/429 body can only cost the richer detail, never the real status.
 * @param response - the completed response; call only when `!response.ok`.
 * @param input.product - provider name opening the fallback message.
 * @param input.signal - abort signal of the surrounding search.
 * @param input.extractDetail - pulls the provider's own message from its parsed body.
 * @returns never; the promise only rejects with `WEB_ABORTED` or
 *   `WEB_PROVIDER_ERROR`.
 */
export async function throwProviderHttpError(
  response: Response,
  input: { product: string; signal?: AbortSignal; extractDetail: (parsed: unknown) => string | undefined },
): Promise<never> {
  let message = `${input.product} API error (HTTP ${response.status})`
  try {
    const detail = input.extractDetail(await response.json() as unknown)
    if (detail !== undefined && detail.length > 0) message = detail
  } catch (error: unknown) {
    if (input.signal?.aborted === true || isAbortError(error)) throw searchAborted(input.product, input.signal, error)
  }
  throw new WebError(message, 'WEB_PROVIDER_ERROR')
}
