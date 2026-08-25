import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SERVER_CWD, resolveLaunchTarget } from '../src/launch.ts'

describe('resolveLaunchTarget', () => {
  it('defaults to the repository source launch through the tsx ESM hook', () => {
    const { command } = resolveLaunchTarget({})
    const [program, ...args] = command
    expect(program).toBe('node')
    expect(args[0]).toBe('--import')
    const tsxEntry = args[1]!
    expect(tsxEntry.startsWith('file://')).toBe(true)
    expect(tsxEntry).toContain('tsx')
    const bin = args.find(argument => argument.endsWith('apps/cli/src/bin.ts'))
    expect(bin?.startsWith(SERVER_CWD)).toBe(true)
    expect(command.slice(-5)).toEqual(['--profile', 'web', '--no-open', '--carrier', 'stdio'])
  })

  it('pins the tsx tsconfig so workspace paths apply from any child cwd', () => {
    const { env } = resolveLaunchTarget({})
    expect(env?.TSX_TSCONFIG_PATH).toBe(join(SERVER_CWD, 'tsconfig.base.json'))

    const override = resolveLaunchTarget({ ...process.env, DSH_DESKTOP_CARRIER: 'tcp' })
    expect(override.command.slice(-2)).toEqual(['--port', '0'])
  })

  it('runs the deployed entry under Electron-as-Node when runtime and entry are set', () => {
    const { command, env } = resolveLaunchTarget({
      DSH_DESKTOP_RUNTIME_BIN: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      DSH_DESKTOP_SERVER_ENTRY: '/Applications/DeepSeek Harness.app/Contents/Resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    })
    expect(command[0]).toBe('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')
    expect(command[1]).toBe('--expose-internals')
    expect(command[2]?.endsWith('lib/bin.js')).toBe(true)
    expect(command.slice(-5)).toEqual(['--profile', 'web', '--no-open', '--carrier', 'stdio'])
    expect(env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env?.TSX_TSCONFIG_PATH).toBeUndefined()
    const entry = command[2]!
    expect(entry.includes('/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')).toBe(true)
  })

  it('anchors the packaged child cwd at its deploy root', () => {
    const { cwd } = resolveLaunchTarget({
      DSH_DESKTOP_RUNTIME_BIN: '/app/electron',
      DSH_DESKTOP_SERVER_ENTRY: '/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    })
    expect(cwd).toBe('/resources/dsh-runtime')
  })

  it('prefers the standalone server binary when only that is set', () => {
    const { command, env } = resolveLaunchTarget({ DSH_DESKTOP_SERVER_BIN: '/opt/dsh/bin/dsh' })
    expect(command[0]).toBe('/opt/dsh/bin/dsh')
    expect(env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('replaces only the program when DSH_DESKTOP_SERVER_BIN is set', () => {
    const { command, env } = resolveLaunchTarget({ DSH_DESKTOP_SERVER_BIN: '/opt/dsh/bin/dsh' })
    expect(command[0]).toBe('/opt/dsh/bin/dsh')
    expect(command.slice(-5)).toEqual(['--profile', 'web', '--no-open', '--carrier', 'stdio'])
    expect(env).toBeUndefined()
  })

  it('pins the child Node runtime through DSH_DESKTOP_NODE_BIN for a source launch', () => {
    const { command } = resolveLaunchTarget({ DSH_DESKTOP_NODE_BIN: '/usr/local/bin/node' })
    expect(command[0]).toBe('/usr/local/bin/node')
  })

  it('treats an empty override like an unset one', () => {
    const { command } = resolveLaunchTarget({ DSH_DESKTOP_SERVER_BIN: '' })
    expect(command[0]).toBe('node')
  })
})
