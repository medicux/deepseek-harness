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
})

let fetchToken = 0

contextBridge.exposeInMainWorld('__DSH_IPC_CARRIER__', {
  fetch: (path: string, init: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
    const token = `fetch-${String(++fetchToken)}`
    // A pre-aborted signal must fail the call here: the main-side token is
    // registered only inside the later invoke, so an abort sent now would be
    // dropped and the call would run to completion.
    if (init.signal?.aborted === true) return Promise.reject(new Error('This operation was aborted'))
    const onAbort = (): void => { ipcRenderer.send('dsh-desktop:carrier-abort', token) }
    if (init.signal !== undefined) init.signal.addEventListener('abort', onAbort, { once: true })
    return ipcRenderer.invoke('dsh-desktop:carrier-fetch', token, path, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    })
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
