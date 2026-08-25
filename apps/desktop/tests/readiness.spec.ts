import { describe, expect, it } from 'vitest'
import { hasStdioReadyLine } from '../src/readiness.ts'
import { extractReadyUrl } from '../src/readiness.ts'

describe('extractReadyUrl', () => {
  it('finds the readiness line among other boot output', () => {
    const output = [
      'dsh: booting profile web',
      'some plugin mounted',
      'dsh web: http://127.0.0.1:4123',
      '',
    ].join('\n')
    expect(extractReadyUrl(output)).toBe('http://127.0.0.1:4123')
  })

  it('keeps only the loopback URL when a LAN parenthetical follows', () => {
    expect(extractReadyUrl('dsh web: http://127.0.0.1:4123 (LAN: http://192.168.0.7:4123)\n')).toBe(
      'http://127.0.0.1:4123',
    )
  })

  it('skips sibling announcements that share the prefix', () => {
    const output = [
      'dsh web: opening the default browser; pass --no-open to disable',
      'dsh web: http://127.0.0.1:4123',
      '',
    ].join('\n')
    expect(extractReadyUrl(output)).toBe('http://127.0.0.1:4123')
  })

  it('handles CRLF line endings', () => {
    expect(extractReadyUrl('noise\r\ndsh web: http://127.0.0.1:4123\r\n')).toBe('http://127.0.0.1:4123')
  })

  it('waits for the completing chunk before resolving a split URL', () => {
    expect(extractReadyUrl('booting\ndsh web: http://127.')).toBeUndefined()
    expect(extractReadyUrl('booting\ndsh web: http://127.0.0.1:4123\n')).toBe('http://127.0.0.1:4123')
  })

  it('rejects non-http, pathed, and query-bearing candidates', () => {
    expect(extractReadyUrl('dsh web: https://127.0.0.1:4123\n')).toBeUndefined()
    expect(extractReadyUrl('dsh web: http://127.0.0.1:4123/sessions\n')).toBeUndefined()
    expect(extractReadyUrl('dsh web: http://127.0.0.1:4123?x=1\n')).toBeUndefined()
  })

  it('returns undefined while no candidate has arrived', () => {
    expect(extractReadyUrl('')).toBeUndefined()
    expect(extractReadyUrl('unrelated output\n')).toBeUndefined()
  })
})

describe('hasStdioReadyLine', () => {
  it('matches only the exact stdio readiness line', () => {
    expect(hasStdioReadyLine('noise\ndsh web-stdio: ready\n')).toBe(true)
    expect(hasStdioReadyLine('dsh web-stdio: ready')).toBe(false)
    expect(hasStdioReadyLine('dsh web: http://127.0.0.1:5001\n')).toBe(false)
    expect(hasStdioReadyLine('dsh web-stdio: readyish\n')).toBe(false)
  })

  it('accepts CRLF endings and waits for incomplete lines', () => {
    expect(hasStdioReadyLine('boot\r\ndsh web-stdio: ready\r\n')).toBe(true)
    expect(hasStdioReadyLine('dsh web-std')).toBe(false)
  })
})
