#!/usr/bin/env node
/**
 * Mechanically transplant one upstream head-to-head change into this mirror.
 *
 * The runbook's recipe is a per-file `git diff | sed | patch` pipeline; doing
 * that by hand for every changed file is where a wrong path mapping or a
 * leftover `.orig` has slipped in before. This script applies the same
 * pipeline from an explicit mapping table, byte-copies the asset instead of
 * patching it, removes `patch`'s `.orig` backups, and reports every reject
 * plus every changed upstream file it does not manage.
 *
 * It does NOT port manifest-level changes (`peerDependenciesMeta`, the peer
 * set) and it does not resolve rejects: after it runs, run the alignment gate
 * and hand-fix what it reports (see RELEASING.md).
 *
 * Usage:
 *   node scripts/port-upstream-change.mjs --from <sha> --to <sha> [--worktree <dir>] [--no-gate]
 *
 * @module scripts/port-upstream-change
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Upstream path to this repository's path. Every entry is patched, except `copy`. */
const MANAGED = [
  ['packages/experimental/interconnect/src/index.ts', 'src/interconnect/index.ts', 'patch'],
  ['packages/experimental/interconnect/src/types.ts', 'src/interconnect/types.ts', 'patch'],
  ['packages/experimental/tool-interconnect/src/index.ts', 'src/tool-interconnect/index.ts', 'patch'],
  ['packages/experimental/skill-interconnect/src/index.ts', 'src/skill-interconnect/index.ts', 'patch'],
  ['packages/experimental/interconnect/tests/interconnect.host.spec.ts', 'tests/interconnect.host.spec.ts', 'patch'],
  ['packages/experimental/tool-interconnect/tests/tool-interconnect.spec.ts', 'tests/tool-interconnect.spec.ts', 'patch'],
  ['packages/experimental/skill-interconnect/tests/skill-interconnect.spec.ts', 'tests/skill-interconnect.spec.ts', 'patch'],
  // Model-visible content, never patched: a fuzz-tolerant apply could accept a
  // near-miss. Byte copy is the whole point of this entry.
  ['packages/experimental/skill-interconnect/assets/dsh-interconnect.md', 'assets/dsh-interconnect.md', 'copy'],
]

/** Read one command-line flag value. */
function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const from = arg('--from')
const to = arg('--to')
const worktree = arg('--worktree', join(process.env.HOME ?? '', 'dsh-wt-ic-merge'))
if (from === undefined || to === undefined) {
  process.stderr.write('usage: port-upstream-change.mjs --from <sha> --to <sha> [--worktree <dir>] [--no-gate]\n')
  process.exit(2)
}

/** Run git in the upstream worktree and return its stdout. */
function git(args) {
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const changed = new Set(git(['diff', '--name-only', from, to]).split('\n').filter(line => line !== ''))
const managed = new Map(MANAGED.map(([upstream, local, mode]) => [upstream, { local, mode }]))

let rejects = 0
const ported = []
for (const [upstream, { local, mode }] of managed) {
  if (!changed.has(upstream)) continue
  if (mode === 'copy') {
    writeFileSync(join(ROOT, local), git(['show', `${to}:${upstream}`]))
    ported.push(`${local} (byte copy)`)
    continue
  }
  const diff = git(['diff', from, to, '--', upstream]).replaceAll(
    `--- a/${upstream}`, `--- ${local}`,
  ).replaceAll(`+++ b/${upstream}`, `+++ ${local}`)
  let applied = true
  try {
    execFileSync('patch', ['-p0', '--forward'], { cwd: ROOT, input: diff, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) {
    applied = false
    rejects += 1
    process.stdout.write(`REJECT ${local}\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`)
  }
  // `patch` writes a `.orig` backup whether or not the hunk applied; it is a
  // byproduct, never a deliverable, and would otherwise land in a commit.
  rmSync(join(ROOT, `${local}.orig`), { force: true })
  ported.push(`${local}${applied ? '' : ' (rejected)'}`)
}

process.stdout.write(`ported ${String(ported.length)} file(s) across ${from}..${to}:\n`)
for (const line of ported) process.stdout.write(`  ${line}\n`)

const unmanaged = [...changed].filter(path => !managed.has(path)).sort()
if (unmanaged.length > 0) {
  process.stdout.write(`\n${String(unmanaged.length)} changed upstream file(s) this script does not manage:\n`)
  for (const path of unmanaged) process.stdout.write(`  ${path}\n`)
  process.stdout.write('  (docs/i18n are not mirrored; manifest changes need a manual edit)\n')
}

const leftover = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' })
  .split('\n').filter(line => line.endsWith('.rej'))
if (leftover.length > 0) {
  process.stdout.write(`\n${String(leftover.length)} reject file(s) to resolve by hand:\n`)
  for (const line of leftover) process.stdout.write(`  ${line}\n`)
}

if (process.argv.includes('--no-gate')) {
  process.stdout.write(rejects > 0 ? '\nrejects present; resolve them, then run the gate\n' : '\nrun the gate to confirm alignment\n')
} else {
  process.stdout.write('\n=== alignment gate ===\n')
  try {
    process.stdout.write(execFileSync('node', [join(ROOT, 'scripts/check-upstream-alignment.mjs'), '--ref', to], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }))
  } catch (error) {
    process.stdout.write(String(error.stdout ?? ''))
    process.stdout.write(String(error.stderr ?? ''))
    process.exit(1)
  }
}

// A clean gate is the success condition; a reject means a human still has to
// port that region, so it must not read as success.
process.exit(rejects === 0 ? 0 : 1)
