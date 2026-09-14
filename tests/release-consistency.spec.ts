/**
 * Guards this repository's own release bookkeeping.
 *
 * The three ported specs cover upstream behaviour; this one covers the packaging
 * steps a release must not forget. `dsh.plugin.json` was bumped on every release
 * up to 0.11.8 and then missed on 0.11.9, so the published manifest advertised a
 * version the package no longer was.
 * @module tests/release-consistency
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** The published package manifest. */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  files: string[]
  dsh: { bundle: { patch: string } }
}

/** The plugin manifest shipped alongside it. */
const plugin = JSON.parse(readFileSync(new URL('../dsh.plugin.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
}

describe('release consistency', () => {
  it('keeps dsh.plugin.json in step with package.json', () => {
    expect(plugin.name).toBe(manifest.name)
    expect(plugin.version).toBe(manifest.version)
  })

  it('packages the bundle manifest and the patch it names', () => {
    expect(manifest.files).toContain('dsh.plugin.json')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })
})
