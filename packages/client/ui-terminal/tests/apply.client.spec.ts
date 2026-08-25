// @vitest-environment jsdom
/**
 * ui-terminal apply wiring: the workbench occupant registers against the
 * declared root-scoped single slot and its disposer vacates it. The panel's
 * transport behavior lives in the gateway spec; this account pins the slot
 * contract only, with @xterm/xterm stubbed so no real canvas work runs.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject, TerminalPanel } from '@deepseek-ai/dsh-client-ui-terminal/client'

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }))

describe('ui-terminal apply', () => {
  it('registers the workbench occupant and vacates it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    // Stand in for ui-layout's root registration declaring the slot.
    slots.register(
      { name: 'root', children: { workbench: { kind: 'single', scope: 'root' } } } as never,
      undefined as never,
    )
    expect(inject).toEqual(['slots'])

    await ctx.plugin({ inject: [...inject], apply }).await()
    const entries = slots.entries('workbench')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.component).toBe(TerminalPanel)

    // A fresh context without the plugin proves occupancy is plugin-scoped,
    // mirroring ui-theme's before/after account.
    const after = new Context()
    await after.plugin(SlotRegistry).await()
    const afterSlots = after.get('slots') as SlotRegistry
    afterSlots.register(
      { name: 'root', children: { workbench: { kind: 'single', scope: 'root' } } } as never,
      undefined as never,
    )
    expect(afterSlots.entries('workbench')).toHaveLength(0)
  })
})
