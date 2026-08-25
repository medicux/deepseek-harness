import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships two entries with different module systems:
 * `main.js` (ESM, the Electron main process) and `preload.cjs` — sandboxed
 * preloads must be CommonJS, and the package's `"type": "module"` would make
 * a `.js` output ESM regardless of format. Both bundle from the emitted
 * `lib/types` faces; declarations come from `tsc -b` (dts: false). `electron`
 * is provided by the host runtime at execution time and never bundled.
 */
export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
  {
    entry: ['lib/types/preload.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.cjs' }),
    deps: { neverBundle: ['electron'] },
  },
])
