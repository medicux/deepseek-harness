import { describe, expect, it } from 'vitest'
import {
  DRAG_REGION_ATTRIBUTE,
  DESKTOP_BRIDGE,
  DESKTOP_TOP_STRIP_ID,
  WINDOW_CONTROLS_ID,
  applyWindowOp,
  buildTopStripScript,
  buildWindowControlsScript,
  DRAG_REGION_CSS,
  type WindowChromeTarget,
  TOP_STRIP_CSS,
  WINDOW_CONTROLS_CSS,
} from '../src/window-chrome.ts'

describe('DRAG_REGION_CSS', () => {
  it('marks the attribute carrier as the drag region', () => {
    expect(DRAG_REGION_CSS).toContain(`[${DRAG_REGION_ATTRIBUTE}] { -webkit-app-region: drag; }`)
  })

  it('keeps every interactive descendant clickable inside the drag region', () => {
    const noDragRule = DRAG_REGION_CSS.split('\n').find(line => line.includes(':is('))
    expect(noDragRule).toBeDefined()
    for (const selector of ['button', 'input', 'textarea', 'a', "[role='button']", '[contenteditable]']) {
      expect(noDragRule).toContain(selector)
    }
    expect(noDragRule).toContain('-webkit-app-region: no-drag;')
  })

  it('exempts the injected control overlay and hides it in fullscreen', () => {
    expect(DRAG_REGION_CSS).toContain(`#${WINDOW_CONTROLS_ID}, #${WINDOW_CONTROLS_ID} *`)
    expect(DRAG_REGION_CSS).toContain('body:fullscreen')
  })
})

describe('applyWindowOp', () => {
  function recordingTarget(): WindowChromeTarget & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      minimize: () => { calls.push('minimize') },
      isMaximized: () => calls.includes('maximized'),
      maximize: () => { calls.push('maximize') },
      unmaximize: () => { calls.push('unmaximize') },
      close: () => { calls.push('close') },
    }
  }

  it('dispatches minimize and close directly', () => {
    const target = recordingTarget()
    applyWindowOp(target, 'minimize')
    applyWindowOp(target, 'close')
    expect(target.calls).toEqual(['minimize', 'close'])
  })

  it('toggles maximize based on the window state', () => {
    const target = recordingTarget()
    applyWindowOp(target, 'toggle-maximize')
    expect(target.calls).toEqual(['maximize'])
    target.calls.push('maximized')
    applyWindowOp(target, 'toggle-maximize')
    expect(target.calls).toEqual(['maximize', 'maximized', 'unmaximize'])
  })

  it('rejects unknown operations loudly', () => {
    const target = recordingTarget()
    expect(() => { applyWindowOp(target, 'destroy') }).toThrow(/unknown window operation "destroy"/u)
    expect(() => { applyWindowOp(target, undefined) }).toThrow(/unknown window operation/u)
    expect(target.calls).toEqual([])
  })
})

describe('buildWindowControlsScript', () => {
  it('installs an idempotent overlay wired to the preload bridge', () => {
    const script = buildWindowControlsScript()
    expect(script).toContain(`getElementById('${WINDOW_CONTROLS_ID}')`)
    expect(script).toContain(`window['${DESKTOP_BRIDGE}']`)
    for (const op of ['close', 'toggle-maximize', 'minimize']) {
      expect(script).toContain(`'${op}'`)
    }
  })
})

describe('WINDOW_CONTROLS_CSS', () => {
  it('pins the overlay to the top-right corner above all content', () => {
    expect(WINDOW_CONTROLS_CSS).toContain(`#${WINDOW_CONTROLS_ID} {`)
    expect(WINDOW_CONTROLS_CSS).toContain('position: fixed;')
    expect(WINDOW_CONTROLS_CSS).toContain('z-index: 2147483647;')
  })
})

describe('TOP_STRIP_CSS', () => {
  it('drops the brand row below the window-control band without touching other rows', () => {
    expect(TOP_STRIP_CSS).toContain("[data-dsh-window-drag='brand'] { padding-top:")
    // The presence selector in DRAG_REGION_CSS keeps every marked value a
    // drag region; only the brand value carries layout here.
    expect(TOP_STRIP_CSS).not.toContain('[data-dsh-window-drag]')
  })

  it('keeps the app surface flush — no reserved band or root inset', () => {
    expect(TOP_STRIP_CSS).not.toContain('#root')
    expect(TOP_STRIP_CSS).not.toContain('--dsh-desktop-top-inset')
  })

  it('adds an invisible full-width grab edge that hides in fullscreen', () => {
    expect(TOP_STRIP_CSS).toContain(`#${DESKTOP_TOP_STRIP_ID} {`)
    expect(TOP_STRIP_CSS).toContain('-webkit-app-region: drag;')
    expect(TOP_STRIP_CSS).toContain('height: 6px;')
    expect(TOP_STRIP_CSS).toContain('body:fullscreen')
  })
})

describe('buildTopStripScript', () => {
  it('installs the edge idempotently', () => {
    const script = buildTopStripScript()
    expect(script).toContain(`getElementById('${DESKTOP_TOP_STRIP_ID}')`)
    expect(script).toContain(`'${DESKTOP_TOP_STRIP_ID}'`)
  })
})
