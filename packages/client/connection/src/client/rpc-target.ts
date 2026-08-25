/**
 * Shared RPC-target validation for the connection package's callers.
 *
 * Both the fetch-backed and IPC-carried generic RPC callers accept a
 * channel/endpoint pair that becomes a request path; one validator owns the
 * accepted grammar so the two transports cannot drift into different trust
 * postures.
 * @module rpc-target
 */

/** Channel segment: one `/`-rooted path component of URL-safe characters. */
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
/** Endpoint segment: non-empty, no path separators, no traversal. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Reject any target whose channel or endpoint could change the request path
 * (traversal, empty segments, separator characters).
 * @param channel - the Connection RPC channel name.
 * @param endpoint - the endpoint method path inside the channel.
 * @throws when either part fails the shared grammar.
 */
export function assertRpcTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
