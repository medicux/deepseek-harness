/**
 * Desktop IPC carrier bridge (main process side).
 *
 * The renderer's `__DSH_IPC_CARRIER__` seat lands here: unary requests are
 * forwarded to the supervised server's loopback URL with plain `fetch`, and
 * downstream event streams are pumped as ServerRequest JSON text over
 * per-stream IPC event channels. The supervised child stays byte-identical
 * to `dsh web`; only who talks to it changes — the shell's webContents
 * instead of the page's network stack.
 * @module carrier
 */

import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { Buffer } from 'node:buffer'
import { FrameChannel } from './frames.ts'
import { trace } from './trace.ts'

interface StreamPump {
  controller: AbortController
}

/** Active stream pumps by renderer-issued id. */
const pumps = new Map<string, StreamPump>()

/**
 * Whether this process already owns a registered carrier surface. The IPC
 * channels are process-global: a second registration would either throw
 * inside Electron (`ipcMain.handle`) or strand the first window's streams,
 * so re-installation is a caller bug and fails loud instead.
 */
let installed = false

/**
 * Register the carrier's IPC surface for the process.
 * @param getBaseUrl - the supervised server's loopback origin in tcp mode.
 * @param getChannel - the frame channel onto the supervised child in stdio
 *   mode; when present it answers every surface instead of the network stack.
 * @throws when called twice without an intervening {@link resetDesktopCarrier}.
 */
export function registerDesktopCarrier(
  getBaseUrl: () => string | undefined,
  getChannel?: () => FrameChannel | undefined,
): void {
  if (installed) throw new Error('desktop carrier: already installed for this process')
  installed = true
  const aborts = new Map<string, AbortController>()

  ipcMain.handle('dsh-desktop:carrier-fetch', async (_event, token: unknown, path: unknown, init: unknown) => {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`carrier: invalid path ${JSON.stringify(String(path))}`)
    const request = readInit(init)
    const channel = getChannel?.()
    const controller = new AbortController()
    if (typeof token === 'string' && token !== '') aborts.set(token, controller)
    try {
      if (channel === undefined) {
        const base = getBaseUrl()
        if (base === undefined) return { status: 503, body: JSON.stringify({ error: 'server not ready' }) }
        const response = await fetch(`${base}${path}`, {
          method: request.method,
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: controller.signal,
        })
        return { status: response.status, body: await response.text() }
      }
      // An aborted signal rejects the request promise and writes the child a
      // cancel frame, so server-side work for a dead call stops.
      const response = await channel.request({
        method: request.method,
        url: path,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: Buffer.from(request.body, 'utf8') }),
      }, controller.signal)
      return { status: response.status, body: response.body.toString('utf8') }
    } finally {
      if (typeof token === 'string') aborts.delete(token)
    }
  })

  ipcMain.on('dsh-desktop:carrier-abort', (_event, token: unknown) => {
    if (typeof token !== 'string') return
    aborts.get(token)?.abort()
  })

  ipcMain.on('dsh-desktop:carrier-stream-open', (event, id: unknown, path: unknown) => {
    // The bridge seat is reachable from any page script; a malformed message
    // ends that one stream request instead of crashing the shell.
    if (typeof id !== 'string' || typeof path !== 'string' || !path.startsWith('/api/')) {
      trace(`rejected stream open: ${JSON.stringify([id, path])}`)
      if (typeof id === 'string' && id !== '') event.sender.send(`dsh-desktop:stream:${id}:end`)
      return
    }
    const channel = getChannel?.()
    if (channel !== undefined) {
      pumpStreamOverFrames(event.sender, id, path, channel)
      return
    }
    const base = getBaseUrl()
    if (base === undefined) {
      event.sender.send(`dsh-desktop:stream:${id}:end`)
      return
    }
    void pumpStream(event.sender, id, `${base}${path}`)
  })

  ipcMain.on('dsh-desktop:carrier-stream-abort', (_event, id: unknown) => {
    if (typeof id !== 'string') return
    pumps.get(id)?.controller.abort()
  })

  // Native directory chooser. The Host's OS-chooser backends cover Win32 and
  // Linux only; on macOS the shell owns the dialog instead. The parent
  // window resolves lazily — registration precedes any window's creation.
  ipcMain.handle('dsh-desktop:pick-directory', async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = parent === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

/** Drop every registered handler, listener, and pump; used at app teardown. */
export function resetDesktopCarrier(): void {
  for (const pump of pumps.values()) pump.controller.abort()
  pumps.clear()
  ipcMain.removeHandler('dsh-desktop:carrier-fetch')
  ipcMain.removeHandler('dsh-desktop:pick-directory')
  ipcMain.removeAllListeners('dsh-desktop:carrier-stream-open')
  ipcMain.removeAllListeners('dsh-desktop:carrier-stream-abort')
  ipcMain.removeAllListeners('dsh-desktop:carrier-abort')
  installed = false
}

async function pumpStream(sender: WebContents, id: string, url: string): Promise<void> {
  const controller = new AbortController()
  pumps.set(id, { controller })
  const frameChannel = `dsh-desktop:stream:${id}`
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) throw new Error(`HTTP ${String(response.status)}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawBlock = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        // Whole blocks forward verbatim: named events (the terminal's
        // `exit`) must survive the pump; consumers parse the block.
        if (rawBlock.trim() !== '' && !sender.isDestroyed()) sender.send(frameChannel, rawBlock)
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch {
    // Aborts and closed sockets both land here; the end sentinel is the only
    // contract the renderer side relies on.
  } finally {
    pumps.delete(id)
    if (!sender.isDestroyed()) sender.send(`${frameChannel}:end`)
  }
}

/**
 * Pump one event stream through the frame channel: chunk frames carry the
 * same SSE bytes the loopback response body would, so the block parser and
 * the per-stream IPC channels are shared with the tcp path.
 */
function pumpStreamOverFrames(sender: WebContents, id: string, path: string, channel: FrameChannel): void {
  const controller = new AbortController()
  pumps.set(id, { controller })
  const frameChannel = `dsh-desktop:stream:${id}`
  let buffer = ''
  let closed = false
  const finish = (): void => {
    if (closed) return
    closed = true
    detach()
    pumps.delete(id)
    if (!sender.isDestroyed()) sender.send(`${frameChannel}:end`)
  }
  const detach = channel.subscribe(
    { method: 'GET', url: path, headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' } },
    (frame) => {
      if (frame.t === 'chunk') {
        buffer += Buffer.from(frame.data, 'base64').toString('utf8')
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const rawBlock = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          // Whole blocks forward verbatim so named events survive the pump.
          if (rawBlock.trim() !== '' && !sender.isDestroyed()) sender.send(frameChannel, rawBlock)
          boundary = buffer.indexOf('\n\n')
        }
        return
      }
      if (frame.t === 'end' || frame.t === 'destroy') finish()
    },
  )
  // A renderer abort detaches the subscription, whose disposer writes a
  // cancel frame; the child destroys the response and its SSE generator
  // unwinds instead of pumping frames nobody reads.
  controller.signal.addEventListener('abort', () => { finish() }, { once: true })
}

interface ForwardedInit {
  method: string
  headers?: Record<string, string> | undefined
  body?: string | undefined
}

function readInit(init: unknown): ForwardedInit {
  if (typeof init !== 'object' || init === null) return { method: 'GET' }
  const record = init as { method?: unknown; headers?: unknown; body?: unknown }
  const method = typeof record.method === 'string' ? record.method : 'GET'
  const headers = typeof record.headers === 'object' && record.headers !== null
    ? Object.fromEntries(
      Object.entries(record.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
    : undefined
  const body = typeof record.body === 'string' ? record.body : undefined
  return {
    method,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  }
}
