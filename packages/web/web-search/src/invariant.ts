/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-web-search`.
 * @module @deepseek-ai/dsh-web-search/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search'

/** Cordis companion plugin name. */
export const name = 'web-search-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the native backends emit a pre-dispatch log event but
 * own no later authoritative dispatch event to relate it to (the HTTP call is
 * provider-private), and external backends emit no model-visible event at all.
 * Exact envelope equality is pinned at the provider boundary instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
