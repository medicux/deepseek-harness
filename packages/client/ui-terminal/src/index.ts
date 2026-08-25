/**
 * Host plugin body — no host-side behavior for this surface plugin. The
 * browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration; the PTY seam it drives lives in
 * `@deepseek-ai/dsh-host-terminal-gateway`.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
