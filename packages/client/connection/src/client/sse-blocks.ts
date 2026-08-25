/**
 * Server-Sent Events block parsing shared by the connection package's
 * stream consumers. One block is the newline-separated text between blank
 * lines; field values follow the SSE rule of stripping exactly one leading
 * space after the colon.
 * @module sse-blocks
 */

/** Split one block into its `field: value` pairs, in order. */
function fields(block: string): Array<{ field: string; value: string }> {
  return block.split('\n').map((line) => {
    const colon = line.indexOf(':')
    if (colon === -1) return { field: line.trimEnd(), value: '' }
    const value = line.slice(colon + 1)
    return { field: line.slice(0, colon), value: value.startsWith(' ') ? value.slice(1) : value }
  })
}

/**
 * Extract the concatenated `data:` payload of one SSE block.
 * @param block - one complete block's text, without its blank-line terminator.
 * @returns the joined payload, or undefined when the block carries none.
 */
export function sseDataPayload(block: string): string | undefined {
  const lines = fields(block).filter(entry => entry.field === 'data')
  if (lines.length === 0) return undefined
  return lines.map(entry => entry.value).join('\n')
}

/**
 * Extract the `event:` name of one SSE block.
 * @param block - one complete block's text, without its blank-line terminator.
 * @returns the event name, or undefined when the block declares none.
 */
export function sseEventName(block: string): string | undefined {
  const named = fields(block).find(entry => entry.field === 'event')
  return named?.value === '' ? undefined : named?.value
}
