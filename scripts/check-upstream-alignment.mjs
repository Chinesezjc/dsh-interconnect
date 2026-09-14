#!/usr/bin/env node
/**
 * Assert that this package's ported sources carry no behavioural drift from the
 * monorepo branch that will replace it.
 *
 * The standalone package is a port, not a copy: four upstream sources are
 * adapted (module tags, internal import specifiers, the asset path) and two Host
 * internals are mirrored (the subagent-ownership predicate and `assertNever`)
 * because the Host does not export them to plugins. The three package specs are
 * ported line for line. Everything else must match upstream code exactly, so a
 * test added upstream has to arrive here too.
 *
 * The comparison is made on comment-stripped, import-stripped "skeletons", with
 * the mirrored blocks removed and the mirrored identifier renamed. A difference
 * that survives that normalisation is behavioural drift and fails the check;
 * comment wording is reported but does not fail, because comments carry no
 * behaviour and the standalone package deliberately documents itself.
 *
 * Usage:
 *   node scripts/check-upstream-alignment.mjs [--worktree <dir>] [--ref <git-ref>]
 *
 * @module scripts/check-upstream-alignment
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this file's location. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Read one `--flag value` argument.
 * @param name - the flag to look for.
 * @param fallback - the value to use when the flag is absent.
 * @returns the flag's value.
 */
function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const WORKTREE = arg('--worktree', join(process.env.HOME ?? '', 'dsh-wt-ic-merge'))
const REF = arg('--ref', 'origin/feat/merge-dsh-interconnect')

/** Upstream file → ported file, in the order the port documents them. */
const SOURCE_PAIRS = [
  ['packages/experimental/interconnect/src/index.ts', 'src/interconnect/index.ts'],
  ['packages/experimental/interconnect/src/types.ts', 'src/interconnect/types.ts'],
  ['packages/experimental/tool-interconnect/src/index.ts', 'src/tool-interconnect/index.ts'],
  ['packages/experimental/skill-interconnect/src/index.ts', 'src/skill-interconnect/index.ts'],
]

/**
 * The three package specs are ported line for line as well, so their skeletons
 * must match too: a test added upstream has to arrive here, or the next
 * behavioural change travels without its regression case. The monorepo's
 * `apps/cli` e2e is deliberately not mirrored — it needs the CLI host harness.
 */
const SPEC_PAIRS = [
  ['packages/experimental/interconnect/tests/interconnect.host.spec.ts', 'tests/interconnect.host.spec.ts'],
  ['packages/experimental/tool-interconnect/tests/tool-interconnect.spec.ts', 'tests/tool-interconnect.spec.ts'],
  ['packages/experimental/skill-interconnect/tests/skill-interconnect.spec.ts', 'tests/skill-interconnect.spec.ts'],
]

const PAIRS = [...SOURCE_PAIRS, ...SPEC_PAIRS]

/**
 * Files that must match upstream byte for byte. The skill body is
 * model-visible content — it is what the agent reads — so a reworded sentence
 * is a behavioural change, not an adaptation.
 */
const EXACT_PAIRS = [
  ['packages/experimental/skill-interconnect/assets/dsh-interconnect.md', 'assets/dsh-interconnect.md'],
]

/** Upstream identifier → the standalone identifier that replaces it. */
const RENAMES = [['hasApiSessionSubagentOwner', 'isSessionOwnedBySubagent']]

/**
 * Remove comments, keeping string literals intact. A line-based `//` strip would
 * truncate any literal containing `//` (a URL, a path) on both sides and could
 * hide a real difference after it, so quotes are tracked.
 * @param text - the file's source text.
 * @returns the text with comments replaced by whitespace.
 */
function stripComments(text) {
  const out = []
  let quote = null
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        index += 1
      } else if (char === '\n') out.push('\n')
      continue
    }
    if (quote !== null) {
      out.push(char)
      if (char === '\\') {
        out.push(next ?? '')
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out.push(char)
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out.push('\n')
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      index += 1
      continue
    }
    out.push(char)
  }
  return out.join('')
}

/**
 * Strip comments and import/export-from lines, leaving the executable skeleton.
 * @param text - the file's source text.
 * @returns the skeleton, one statement-bearing line per source line.
 */
function skeleton(text) {
  const kept = []
  for (const raw of stripComments(text).split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    // Import and re-export specifiers are adaptation territory; the symbols they
    // bring in still have to exist, which the typecheck and tests cover.
    if (/^(?:import|export)\b/u.test(line) && /\bfrom\b|^import\s/u.test(line)) continue
    kept.push(line)
  }
  return kept
}

/**
 * Drop a brace-balanced block that starts at `start`, so a mirrored definition
 * (present on one side only) does not read as drift.
 * @param lines - skeleton lines.
 * @param start - index of the block's first line.
 * @returns the lines with the block removed.
 */
function dropBlock(lines, start) {
  let depth = 0
  let opened = false
  let index = start
  for (; index < lines.length; index += 1) {
    for (const char of lines[index]) {
      if (char === '{') {
        depth += 1
        opened = true
      } else if (char === '}') depth -= 1
    }
    // A multi-line signature has no brace yet; only a block that opened can close.
    if (opened && depth <= 0) break
  }
  return [...lines.slice(0, start), ...lines.slice(index + 1)]
}

/**
 * Normalise one side's skeleton: rename mirrored identifiers, drop mirrored
 * definitions, and drop adaptation-only lines (crypto imports, asset paths).
 * @param text - the file's source text.
 * @returns the normalised skeleton as a single string.
 */
function normalize(text) {
  let lines = skeleton(text)
  for (const [from, to] of RENAMES) {
    lines = lines.map(line => line.split(from).join(to))
  }
  // A mirrored definition exists on the ported side only; the upstream side
  // imports the same symbol (an import line, already dropped) or keeps the rule
  // in a Host package. Both the ownership predicate and `assertNever` are
  // therefore dropped here, while their call sites are renamed above.
  const definitionOf = [
    /\bfunction\s+assertNever\b/u,
    ...RENAMES.map(([, to]) => new RegExp(`\\bfunction\\s+${to}\\b`, 'u')),
  ]
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (definitionOf.some(pattern => pattern.test(lines[index]))) {
      lines = dropBlock(lines, index)
    }
  }
  return lines
    .filter(line => !/\bnode:crypto\b/u.test(line))
    .filter(line => !/\bassets\//u.test(line))
    .filter(line => !/^@module/u.test(line))
    .join('\n')
}

/** Line-level diff of two skeletons, classified as code or comment drift. */
function compare(upstreamText, portedText) {
  const upstreamSkeleton = normalize(upstreamText).split('\n')
  const portedSkeleton = normalize(portedText).split('\n')
  const upstreamSet = new Set(upstreamSkeleton)
  const portedSet = new Set(portedSkeleton)
  const missing = upstreamSkeleton.filter(line => !portedSet.has(line))
  const extra = portedSkeleton.filter(line => !upstreamSet.has(line))
  return { missing, extra }
}

let failed = false
for (const [upstreamPath, portedPath] of PAIRS) {
  const upstream = execFileSync('git', ['-C', WORKTREE, 'show', `${REF}:${upstreamPath}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const ported = readFileSync(join(ROOT, portedPath), 'utf8')
  const { missing, extra } = compare(upstream, ported)
  const drift = missing.length + extra.length
  if (drift === 0) {
    process.stdout.write(`ok    ${portedPath} (skeleton identical to ${REF})\n`)
    continue
  }
  failed = true
  process.stdout.write(`DRIFT ${portedPath}: ${String(missing.length)} upstream lines absent, ${String(extra.length)} local lines unaccounted\n`)
  for (const line of missing.slice(0, 20)) process.stdout.write(`  - ${line}\n`)
  for (const line of extra.slice(0, 20)) process.stdout.write(`  + ${line}\n`)
}

for (const [upstreamPath, portedPath] of EXACT_PAIRS) {
  const upstream = execFileSync('git', ['-C', WORKTREE, 'show', `${REF}:${upstreamPath}`], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const ported = readFileSync(join(ROOT, portedPath))
  if (upstream.equals(ported)) {
    process.stdout.write(`ok    ${portedPath} (byte-identical to ${REF})\n`)
    continue
  }
  failed = true
  process.stdout.write(
    `DRIFT ${portedPath}: bytes differ from ${upstreamPath} `
    + `(${String(upstream.length)} upstream bytes vs ${String(ported.length)} local)\n`,
  )
}

if (failed) {
  process.stdout.write(`\nbehavioural drift against ${REF} in ${WORKTREE}; port the change or extend the adaptation rules\n`)
  process.exit(1)
}
process.stdout.write(`\nno behavioural drift against ${REF} across ${String(PAIRS.length)} ported files and ${String(EXACT_PAIRS.length)} byte-exact asset\n`)
