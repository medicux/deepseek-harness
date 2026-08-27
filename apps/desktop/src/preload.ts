/**
 * Preload for the desktop shell's renderer.
 *
 * Exposes exactly two surfaces — the window-control bridge and the IPC
 * carrier seat (`__DSH_IPC_CARRIER__`) that flips the client's connection
 * package onto the desktop carrier. Runs sandboxed; these bridges are the
 * only crossings. Ships as CommonJS because sandboxed preloads cannot be ESM.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  minimize: (): void => { ipcRenderer.send('dsh-desktop:window', 'minimize') },
  toggleMaximize: (): void => { ipcRenderer.send('dsh-desktop:window', 'toggle-maximize') },
  close: (): void => { ipcRenderer.send('dsh-desktop:window', 'close') },
  // Main-process menu (e.g. the macOS Settings… item with Cmd+,) sends
  // `dsh-desktop:open-settings` via webContents. The renderer subscribes
  // here and re-fires as a DOM CustomEvent so the settings shell can listen
  // without importing the preload module.
  onOpenSettings(callback: () => void): () => void {
    const listener = (): void => { callback() }
    ipcRenderer.on('dsh-desktop:open-settings', listener)
    return () => { ipcRenderer.removeListener('dsh-desktop:open-settings', listener) }
  },
})

let fetchToken = 0

contextBridge.exposeInMainWorld('__DSH_IPC_CARRIER__', {
  // `init.token` is an opaque correlation string generated renderer-side:
  // live AbortSignals cannot cross contextBridge (their methods are
  // stripped), so abort wiring stays in the renderer and reaches the main
  // process through abortFetch.
  fetch: (path: string, init: { method?: string; body?: string; headers?: Record<string, string>; token?: string }) => {
    const token = `fetch-${String(++fetchToken)}`
    return ipcRenderer.invoke('dsh-desktop:carrier-fetch', token, path, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      ...(init.token === undefined ? {} : { token: init.token }),
    })
  },
  abortFetch: (token: string): void => {
    ipcRenderer.send('dsh-desktop:carrier-abort', token)
  },
  openStream: (path: string) => {
    const id = `stream-${String(++fetchToken)}`
    const frameChannel = `dsh-desktop:stream:${id}`
    let frameCallback: ((data: string) => void) | undefined
    let endCallback: (() => void) | undefined
    const onFrame = (_event: unknown, data: string): void => { frameCallback?.(data) }
    const onEnd = (): void => {
      ipcRenderer.removeListener(frameChannel, onFrame)
      ipcRenderer.removeListener(`${frameChannel}:end`, onEnd)
      endCallback?.()
    }
    ipcRenderer.on(frameChannel, onFrame)
    ipcRenderer.on(`${frameChannel}:end`, onEnd)
    ipcRenderer.send('dsh-desktop:carrier-stream-open', id, path)
    return {
      onFrame: (callback: (data: string) => void): void => { frameCallback = callback },
      onEnd: (callback: () => void): void => { endCallback = callback },
      abort: (): void => { ipcRenderer.send('dsh-desktop:carrier-stream-abort', id) },
    }
  },
  /**
   * Native directory chooser answered by the shell's dialog. The Host's
   * OS-chooser backends have no macOS dialog, so the desktop shell owns this
   * one; `null` is the user's cancellation.
   */
  pickDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke('dsh-desktop:pick-directory')
  },
})
