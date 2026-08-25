import { PassThrough } from 'node:stream'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_APP_URL, forwardTarget, installDesktopProtocol, resetDesktopProtocol } from '../src/protocol.ts'
import { FrameChannel } from '../src/frames.ts'

interface FakeRequest {
  url: string
  method: string
  headers: { forEach: (cb: (value: string, key: string) => void) => void }
  arrayBuffer: () => Promise<ArrayBuffer>
}
type SchemeHandler = (request: FakeRequest) => Promise<Response>
let schemeHandler: SchemeHandler | undefined

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: (): void => {},
    handle: (_scheme: string, handler: SchemeHandler): void => { schemeHandler = handler },
    unhandle: (): void => { schemeHandler = undefined },
  },
}))

function makeRequest(url: string, method = 'GET'): FakeRequest {
  return {
    url,
    method,
    headers: { forEach: (): void => {} },
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

describe('forwardTarget', () => {
  it('maps app-scheme paths and queries onto the base URL', () => {
    expect(forwardTarget('dsh://app/', 'http://127.0.0.1:5001')).toBe('http://127.0.0.1:5001/')
    expect(forwardTarget('dsh://app/assets/index.js?v=2', 'http://127.0.0.1:5001'))
      .toBe('http://127.0.0.1:5001/assets/index.js?v=2')
    expect(DESKTOP_APP_URL).toBe('dsh://app/')
  })

  it('rejects foreign schemes, hosts and missing bases', () => {
    expect(forwardTarget('http://app/', 'http://127.0.0.1:5001')).toBeUndefined()
    expect(forwardTarget('dsh://other/', 'http://127.0.0.1:5001')).toBeUndefined()
    expect(forwardTarget('not a url', 'http://127.0.0.1:5001')).toBeUndefined()
    expect(forwardTarget('dsh://app/', undefined)).toBeUndefined()
  })
})

describe('installDesktopProtocol over the frame channel', () => {
  it('forwards app-scheme requests through frames and copies passthrough headers', async () => {
    const toChild = new PassThrough()
    const fromChild = new PassThrough()
    const channel = new FrameChannel(toChild, fromChild)
    installDesktopProtocol(() => undefined, () => channel)
    if (schemeHandler === undefined) throw new Error('electron.protocol.handle captured no handler')
    const pending = schemeHandler(makeRequest('dsh://app/assets/app.js?v=2'))
    const linePromise = await new Promise<string>((resolve) => {
      let buffer = ''
      toChild.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline !== -1) resolve(buffer.slice(0, newline))
      })
    })
    expect(JSON.parse(linePromise)).toMatchObject({ id: 1, method: 'GET', url: '/assets/app.js?v=2' })
    fromChild.write([
      JSON.stringify({ id: 1, t: 'head', status: 200, headers: { 'content-type': 'text/javascript', 'x-private': 'hidden' } }),
      JSON.stringify({ id: 1, t: 'chunk', data: Buffer.from('export {}').toString('base64') }),
      JSON.stringify({ id: 1, t: 'end' }),
    ].join('\n') + '\n')
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(response.headers.get('x-private')).toBeNull()
    expect(await response.text()).toBe('export {}')
    resetDesktopProtocol()
  })

  it('fails loud on a second install and allows reinstall after reset', () => {
    installDesktopProtocol(() => undefined)
    expect(() => { installDesktopProtocol(() => undefined) }).toThrow(/already installed/u)
    resetDesktopProtocol()
    expect(() => { installDesktopProtocol(() => undefined) }).not.toThrow()
    resetDesktopProtocol()
  })
})
