// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as TerminalInvariant from '@deepseek-ai/dsh-client-ui-terminal/invariant'
import * as TerminalRoot from '@deepseek-ai/dsh-client-ui-terminal/src/index.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('ui-terminal invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(TerminalInvariant).await()).resolves.toBeDefined()
  })

  it('host-half apply is deliberately behaviorless', () => {
    expect(() => { TerminalRoot.apply() }).not.toThrow()
  })
})
