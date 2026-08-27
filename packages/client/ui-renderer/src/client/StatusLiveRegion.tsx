/**
 * Polite live region for screen-reader status announcements.
 *
 * Screen readers do not announce in-page text changes unless a live region
 * exists. Boot progress, error toasts, and the connection-reset signal are
 * silent to AT without one. The region is visually hidden — it exists purely
 * to carry text into the AT layer — and is rendered at the application root
 * so every status update lands in the same node the AT already follows.
 *
 * `aria-atomic="true"` makes the whole region re-read on each update (the
 * default polite behavior would only read the changed suffix, which loses
 * context for short messages like "Connected" or "Session X").
 */
import { useEffect, useState } from 'react'

/** Announcer service: write text into the polite live region. */
export interface StatusAnnounceService {
  /** Replace the current announcement; the AT will read it on the next idle. */
  announce: (message: string) => void
  /** Current announcement text (exposed for tests). */
  readonly current: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Renderer status announcer. */
    statusAnnounce: StatusAnnounceService
  }
}

/** Props for the live region element. */
export interface StatusLiveRegionProps {
  /** Announcer service the region subscribes to. */
  announcer: StatusAnnounceService
}

/**
 * Visually-hidden polite live region wired to the announcer service.
 * @param props - see {@link StatusLiveRegionProps}.
 * @returns the live region element.
 */
export function StatusLiveRegion({ announcer }: StatusLiveRegionProps): ReactNode {
  // Subscribe to the announcer by polling its current text on a microtask.
  // The announcer is a thin mutable holder so the service face stays
  // stable across renders (no cascading re-renders when other plugins
  // announce).
  const [, force] = useState(0)
  useEffect(() => {
    const tick = (): void => { force(n => n + 1) }
    const interval = setInterval(tick, 200)
    return () => { clearInterval(interval) }
  }, [])
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-dsh-status-live=""
      style={{
        position: 'absolute',
        width: 1,
        height: 1,
        margin: -1,
        padding: 0,
        overflow: 'hidden',
        clip: 'rect(0 0 0 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {announcer.current}
    </div>
  )
}

/**
 * Create the announcer service. The holder is a plain object so callers can
 * write to it without re-rendering every subscriber on each call.
 * @returns the announcer service.
 */
export function createStatusAnnouncer(): StatusAnnounceService {
  const holder: { current: string } = { current: '' }
  return {
    get current() { return holder.current },
    announce: (message) => { holder.current = message },
  }
}
