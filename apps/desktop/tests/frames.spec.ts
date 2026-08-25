import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { FrameChannel, type FrameResponseFrame } from '../src/frames.ts'

interface Harness {
  channel: FrameChannel
  toChild: PassThrough
  fromChild: PassThrough
}

function harness(): Harness {
  const toChild = new PassThrough()
  const fromChild = new PassThrough()
  return { channel: new FrameChannel(toChild, fromChild), toChild, fromChild }
}

/** Read the next `count` complete request lines the parent wrote. */
async function readRequestLines(toChild: PassThrough, count: number): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      if (lines.length - 1 >= count) {
        toChild.off('data', onData)
        resolve(lines.slice(0, count).map(line => JSON.parse(line) as Record<string, unknown>))
      }
    }
    toChild.on('data', onData)
  })
}

/** Read the next complete request line the parent wrote. */
function nextRequestLine(toChild: PassThrough): Promise<Record<string, unknown>> {
  return readRequestLines(toChild, 1).then(lines => lines[0] ?? {})
}

function respond(fromChild: PassThrough, lines: string[]): void {
  fromChild.write(lines.join('\n') + '\n')
}

describe('FrameChannel', () => {
  it('round-trips a unary exchange: request line in, head/chunk/end out', async () => {
    const { channel, toChild, fromChild } = harness()
    const pending = channel.request({ method: 'GET', url: '/assets/app.js' })
    const frame = await nextRequestLine(toChild)
    expect(frame).toMatchObject({ id: 1, method: 'GET', url: '/assets/app.js' })
    respond(fromChild, [
      JSON.stringify({ id: 1, t: 'head', status: 200, headers: { 'content-type': 'text/html' } }),
      JSON.stringify({ id: 1, t: 'chunk', data: Buffer.from('<!doctype html>').toString('base64') }),
      JSON.stringify({ id: 1, t: 'end' }),
    ])
    await expect(pending).resolves.toEqual({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<!doctype html>'),
    })
  })

  it('encodes a POST body as base64 and concatenates multi-chunk bodies', async () => {
    const { channel, toChild, fromChild } = harness()
    const pending = channel.request({ method: 'POST', url: '/api/x', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"a":1}') })
    const frame = await nextRequestLine(toChild)
    expect(frame.body).toBe(Buffer.from('{"a":1}').toString('base64'))
    respond(fromChild, [
      JSON.stringify({ id: 1, t: 'head', status: 201, headers: {} }),
      JSON.stringify({ id: 1, t: 'chunk', data: Buffer.from('part1').toString('base64') }),
      JSON.stringify({ id: 1, t: 'chunk', data: Buffer.from('part2').toString('base64') }),
      JSON.stringify({ id: 1, t: 'end' }),
    ])
    const response = await pending
    expect(response.status).toBe(201)
    expect(response.body.toString('utf8')).toBe('part1part2')
  })

  it('rejects when the child destroys the response and defaults head-less ends to 200', async () => {
    const { channel, toChild, fromChild } = harness()
    const doomed = channel.request({ method: 'GET', url: '/boom' })
    void nextRequestLine(toChild).then(() => {
      respond(fromChild, [JSON.stringify({ id: 1, t: 'destroy' })])
    })
    await expect(doomed).rejects.toThrow(/child destroyed the response/u)

    const headless = channel.request({ method: 'GET', url: '/plain' })
    void nextRequestLine(toChild).then(() => {
      respond(fromChild, [
        JSON.stringify({ id: 2, t: 'chunk', data: Buffer.from('y').toString('base64') }),
        JSON.stringify({ id: 2, t: 'end' }),
      ])
    })
    await expect(headless).resolves.toMatchObject({ status: 200 })
  })

  it('delivers chunk/end frames to stream subscribers without buffering', async () => {
    const { channel, toChild, fromChild } = harness()
    const seen: string[] = []
    let ended = false
    channel.subscribe(
      { method: 'GET', url: '/api/events', headers: { accept: 'text/event-stream' } },
      (frame) => {
        if (frame.t === 'chunk') seen.push(Buffer.from(frame.data, 'base64').toString('utf8'))
        if (frame.t === 'end' || frame.t === 'destroy') ended = true
      },
    )
    const frame = await nextRequestLine(toChild)
    expect(frame.url).toBe('/api/events')
    const id = Number(frame.id)
    respond(fromChild, [
      JSON.stringify({ id, t: 'head', status: 200, headers: { 'content-type': 'text/event-stream' } }),
      JSON.stringify({ id, t: 'chunk', data: Buffer.from('data: one\n\n').toString('base64') }),
      JSON.stringify({ id, t: 'chunk', data: Buffer.from('data: two\n\n').toString('base64') }),
      JSON.stringify({ id, t: 'end' }),
    ])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toEqual(['data: one\n\n', 'data: two\n\n'])
    expect(ended).toBe(true)
  })

  it('writes a cancel frame when a stream subscription is disposed', async () => {
    const { channel, toChild } = harness()
    const detach = channel.subscribe({ method: 'GET', url: '/api/events.mux', headers: {} }, () => {})
    await nextRequestLine(toChild)
    detach()
    // The child-side SSE generator only unwinds on this cancel; without it an
    // abandoned stream pumps frames no one reads.
    const cancelLine = await nextRequestLine(toChild)
    expect(cancelLine).toEqual({ id: 1, t: 'cancel' })
    // A second dispose is a no-op: the subscription is already gone.
    let written = 0
    toChild.on('data', (chunk: Buffer) => { written += chunk.byteLength })
    detach()
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(written).toBe(0)
  })

  it('ignores malformed lines and buffers split frames across chunks', async () => {
    const { channel, toChild, fromChild } = harness()
    const pending = channel.request({ method: 'GET', url: '/ok' })
    const frame = await nextRequestLine(toChild)
    const id = Number(frame.id)
    fromChild.write(`not json at all\n{"id":9,"t":"end"}\n{"id":${String(id)},"t":"ch`)
    fromChild.write('unk","data":"' + Buffer.from('half').toString('base64') + '"}\n')
    fromChild.write(JSON.stringify({ id, t: 'end' }) + '\n')
    await expect(pending).resolves.toMatchObject({ status: 200, body: Buffer.from('half') })
  })

  it('fails every in-flight request on close()', async () => {
    const { channel, toChild } = harness()
    const pending = channel.request({ method: 'GET', url: '/slow' })
    void nextRequestLine(toChild)
    channel.close()
    await expect(pending).rejects.toThrow(/channel closed/u)
    // A closed channel detaches its reader; further writes are ignored.
    expect(() => { channel.close() }).not.toThrow()
  })

  it('aborts a unary request: rejects, writes a cancel frame, and stops the exchange', async () => {
    const { channel, toChild, fromChild } = harness()
    const controller = new AbortController()
    const pending = channel.request({ method: 'GET', url: '/slow' }, controller.signal)
    await readRequestLines(toChild, 1)
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/u)
    const lines = await readRequestLines(toChild, 1)
    expect(lines[0]).toEqual({ id: 1, t: 'cancel' })
    // Trailing child frames for the dead id find no pending entry.
    respond(fromChild, ['{"id":1,"t":"end"}'])
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('rejects an already-aborted unary without writing a request line', async () => {
    const { channel, toChild } = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(channel.request({ method: 'GET', url: '/x' }, controller.signal)).rejects.toThrow(/aborted/u)
    let wrote = false
    toChild.on('data', () => { wrote = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(wrote).toBe(false)
  })

  it('fails every in-flight unary when the output pipe closes', async () => {
    const { channel, toChild, fromChild } = harness()
    const pending = channel.request({ method: 'GET', url: '/y' })
    await readRequestLines(toChild, 1)
    fromChild.destroy()
    await expect(pending).rejects.toThrow(/channel closed/u)
  })

  it('settles a unary exchange when the child reports a handler error', async () => {
    const { channel, toChild, fromChild } = harness()
    const pending = channel.request({ method: 'GET', url: '/boom' })
    await readRequestLines(toChild, 1)
    respond(fromChild, [JSON.stringify({ id: 1, t: 'handler-error', message: 'route exploded' })])
    // The child's own message surfaces; without this member the request
    // would hang until the channel closes.
    await expect(pending).rejects.toThrow('frames: route exploded')
  })

  it('keeps the response-frame codec in parity with the stdio carrier contract', () => {
    // `frames.ts` mirrors the wire contract in
    // `@deepseek-ai/dsh-host-webserver`'s `stdio-frames.ts` by hand (the
    // desktop stays dependency-free of Host packages). The tag sets must move
    // together: update both unions or this test names the drift.
    // The desktop keeps no dependency edge on Host packages, so parity is
    // pinned on both sides: this literal and its twin in
    // `packages/host/webserver/tests/stdio-carrier.spec.ts`. Changing one
    // union without the other fails one of these two tests.
    const tags = Object.entries({
      head: 0, chunk: 0, end: 0, destroy: 0, 'handler-error': 0,
    } satisfies Record<FrameResponseFrame['t'], number>)
    expect(tags.map(([tag]) => tag)).toEqual(['head', 'chunk', 'end', 'destroy', 'handler-error'])
  })

  it('multiplexes concurrent requests by id', async () => {
    const { channel, toChild, fromChild } = harness()
    const first = channel.request({ method: 'GET', url: '/one' })
    const second = channel.request({ method: 'GET', url: '/two' })
    const [line1, line2] = await readRequestLines(toChild, 2)
    if (line1 === undefined || line2 === undefined) throw new Error('channel wrote fewer than two request lines')
    expect(line2).toMatchObject({ id: 2, url: '/two' })
    respond(fromChild, [
      JSON.stringify({ id: Number(line2.id), t: 'head', status: 204, headers: {} }),
      JSON.stringify({ id: Number(line2.id), t: 'end' }),
      JSON.stringify({ id: Number(line1.id), t: 'head', status: 200, headers: {} }),
      JSON.stringify({ id: Number(line1.id), t: 'end' }),
    ])
    expect((await second).status).toBe(204)
    expect((await first).status).toBe(200)
  })
})
