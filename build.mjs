/**
 * ESM host build for dsh-interconnect: two host plugins (compiled from their
 * TypeScript sources) plus their invariant companions. `@deepseek-ai/dsh-*`
 * and cordis stay external (the profile's healed node_modules provides them);
 * schemastery is bundled because the Loader validates Config against it.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

// `ws` is a peer-provided CommonJS package; keep it external alongside the
// dsh/cordis host packages so the ESM bundle never inlines its `require`.
const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*', 'ws']

for (const [entry, outfile] of [
  ['src/interconnect/index.ts', 'lib/interconnect/index.js'],
  ['src/interconnect/invariant.ts', 'lib/interconnect/invariant.js'],
  ['src/tool-interconnect/index.ts', 'lib/tool-interconnect/index.js'],
  ['src/tool-interconnect/invariant.ts', 'lib/tool-interconnect/invariant.js'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    sourcemap: true,
    external: dshExternal,
    logLevel: 'info',
  })
}

// Re-export the two plugin surfaces from the package root for `.` importers.
await build({
  entryPoints: ['src/interconnect/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  external: dshExternal,
  logLevel: 'info',
})
