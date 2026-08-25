/**
 * Desktop app-origin protocol.
 *
 * The product window loads `dsh://app/` instead of the child's loopback URL:
 * every request under the scheme is forwarded main-process-side to the
 * supervised server, so the renderer never learns the port (or any TCP
 * authority at all) while the child stays the sole composition owner — the
 * boot manifest arrives inside the forwarded HTML and plugin bundles keep
 * their registry-computed paths. Unary and stream API calls bypass this
 * handler entirely via the IPC carrier; forwarding them too keeps non-carrier
 * consumers working as a fallback.
 * @module protocol
 */

import { protocol } from 'electron'
import type { FrameChannel } from './frames.ts'

/** The custom scheme; must be registered privileged before app ready. */
const DESKTOP_SCHEME = 'dsh'
/** The origin the product window is loaded from. */
export const DESKTOP_APP_URL = 'dsh://app/'

/**
 * Parse one app-scheme request into its path and query.
 * @returns the `/path?query` string, or `undefined` for foreign shapes.
 */
function parseAppPath(rawUrl: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${DESKTOP_SCHEME}:` || parsed.hostname !== 'app') return undefined
  return `${parsed.pathname}${parsed.search}`
}

/** Privileges: standard URL parsing, secure context, fetch/stream support. */
export function registerDesktopScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: DESKTOP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

/**
 * Map one app-scheme request to its loopback forward target.
 * @param rawUrl - the request URL to parse.
 * @param baseUrl - the supervised server's origin; absence disables forwarding.
 * @returns the absolute forward URL, or `undefined` for foreign shapes.
 */
export function forwardTarget(rawUrl: string, baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined
  const path = parseAppPath(rawUrl)
  return path === undefined ? undefined : `${baseUrl}${path}`
}

/** Response headers worth copying back to the renderer. */
const PASSTHROUGH_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag', 'location'] as const

/**
 * Whether this process already owns the app-scheme handler; Electron throws
 * on a duplicate `protocol.handle`, so re-installation is a caller bug and
 * fails loud here with the owning message instead.
 */
let installed = false

/**
 * Install the handler that forwards app-scheme requests to the child.
 * @param getBaseUrl - the supervised server's loopback origin in tcp mode.
 * @param getChannel - the frame channel in stdio mode; when present every
 *   request rides it and no network stack is involved at all.
 * @throws when called twice without an intervening {@link resetDesktopProtocol}.
 */
export function installDesktopProtocol(getBaseUrl: () => string | undefined, getChannel?: () => FrameChannel | undefined): void {
  if (installed) throw new Error('desktop protocol: already installed for this process')
  installed = true
  protocol.handle(DESKTOP_SCHEME, async (request) => {
    const path = parseAppPath(request.url)
    if (path === undefined) return new Response('desktop: server not ready', { status: 503 })
    try {
      const channel = getChannel?.()
      if (channel !== undefined) {
        const headers: Record<string, string> = {}
        request.headers.forEach((value, key) => { headers[key] = value })
        const body = request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : new Uint8Array(await request.arrayBuffer())
        const response = await channel.request({
          method: request.method,
          url: path,
          headers,
          ...(body === undefined ? {} : { body }),
        })
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          if ((PASSTHROUGH_HEADERS as readonly string[]).includes(key)) responseHeaders.set(key, value)
        }
        return new Response(new Uint8Array(response.body), { status: response.status, headers: responseHeaders })
      }
      const base = getBaseUrl()
      if (base === undefined) return new Response('desktop: server not ready', { status: 503 })
      const target = `${base}${path}`
      const reqBody = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
      const response = await fetch(target, {
        method: request.method,
        headers: new Headers(request.headers),
        ...(reqBody === undefined ? {} : { body: reqBody }),
      })
      const headers = new Headers()
      response.headers.forEach((value, key) => {
        if ((PASSTHROUGH_HEADERS as readonly string[]).includes(key)) headers.set(key, value)
      })
      return new Response(response.body, { status: response.status, headers })
    } catch (error) {
      console.error('dsh-desktop: app-origin forward failed:', error)
      return new Response('desktop: forward failed', { status: 502 })
    }
  })
}

/** Drop the handler; used at app teardown. */
export function resetDesktopProtocol(): void {
  protocol.unhandle(DESKTOP_SCHEME)
  installed = false
}
