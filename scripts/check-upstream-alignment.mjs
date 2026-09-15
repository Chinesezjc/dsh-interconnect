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
 * Two passes run over every ported file. The first compares comment-stripped,
 * import-stripped "skeletons", with the mirrored blocks removed and the mirrored
 * identifier renamed: a difference that survives that normalisation is
 * behavioural drift. The second compares the raw text with comments included and
 * requires every difference to be a recorded adaptation. Comments are ported
 * from upstream like code, so a comment that no longer matches upstream is
 * drift: the skeleton pass strips comments and therefore cannot see one.
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

/**
 * The commit the verdict is about. `--ref` accepts a remote-tracking branch, and
 * that ref is only as fresh as the worktree's last fetch, so the resolved commit
 * is printed and used in the verdict: a verdict against a stale ref would
 * otherwise name only the branch and read as current. Resolution failing (the
 * worktree is missing, or the commit was never fetched there) exits before any
 * comparison rather than reporting a verdict about nothing.
 */
let RESOLVED
try {
  RESOLVED = execFileSync('git', ['-C', WORKTREE, 'rev-parse', `${REF}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
} catch (error) {
  process.stderr.write(
    `cannot resolve ${REF} in ${WORKTREE}: ${String(error.stderr ?? error.message).trim()}\n`
    + `fetch that worktree first (git -C ${WORKTREE} fetch origin), or pass --ref <sha> and --worktree <dir>\n`,
  )
  process.exit(2)
}
const SHORT = RESOLVED.slice(0, 10)
process.stdout.write(`comparing this mirror against ${REF} (${SHORT}) in ${WORKTREE}\n\n`)

/**
 * Read one upstream blob at the resolved ref.
 * A ref that does not contain the ported paths — pre-merge `origin/master`, for
 * example — is the answer to "has the merge landed yet?", so it is reported as
 * that rather than as a git stack trace. Both text and binary reads go through
 * here so neither can surface a raw error.
 * @param path - the upstream path to read.
 * @param binary - read bytes instead of text, for byte-compared assets.
 * @returns the blob's text, or its bytes when `binary` is set.
 */
function upstreamBlob(path, binary = false) {
  try {
    return execFileSync('git', ['-C', WORKTREE, 'show', `${REF}:${path}`], {
      ...(binary ? {} : { encoding: 'utf8' }),
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    process.stderr.write(
      `cannot read ${path} at ${REF} in ${WORKTREE}: ${String(error.stderr ?? error.message).trim()}\n`
      + 'that ref does not carry the upstream package, so there is nothing to compare against\n',
    )
    process.exit(2)
  }
}

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

/**
 * Raw differences that are documented adaptations, keyed by ported path. These
 * are the only lines allowed to differ once comments count. Everything else must
 * match upstream text, so an upstream comment edit that is ported incompletely
 * fails here instead of passing as "no behavioural drift". A line is listed when
 * it is local-only or upstream-only in the raw comparison; the mirrored block
 * itself is not listed because {@link withoutMirroredBlock} removes it whole.
 */
const RAW_ADAPTATIONS = new Map([
  ['src/interconnect/index.ts', [
    ' * @module @deepseek-ai/dsh-experimental-interconnect',
    ' * @module dsh-interconnect',
    "import { createHash, timingSafeEqual as constantTimeEqual } from 'node:crypto'",
    "import { createHash, randomUUID, timingSafeEqual as constantTimeEqual } from 'node:crypto'",
    "// The Host's own subagent-ownership predicate, reused rather than reimplemented:",
    "// this is a safety rule, and a local copy of it would drift from the Host's.",
    "import { hasApiSessionSubagentOwner } from '@deepseek-ai/dsh-api-session-controller'",
    '// Loads the `RemoteErrorDetailsMap` augmentation that declares `session/agent-busy`,',
    '// the code the Host raises when a resume hits a subagent-owned session. Type-only:',
    '// no runtime dependency, and this subpath exists in every host revision in use.',
    "import type {} from '@deepseek-ai/dsh-api-session-controller/types'",
    "import { randomUUID } from '@deepseek-ai/dsh-util-crypto'",
    "import { assertNever } from '@deepseek-ai/dsh-util-values'",
    '      .filter(agent => !hasApiSessionSubagentOwner(this.ctx, agent.session, agent))',
    '      .filter(agent => !isSessionOwnedBySubagent(this.ctx, agent.session, agent))',
    '    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {',
    '    if (isSessionOwnedBySubagent(this.ctx, agent.session, agent)) {',
  ]],
  ['src/interconnect/types.ts', [
    ' * Wire contracts for `@deepseek-ai/dsh-experimental-interconnect`.',
    ' * Wire contracts for `dsh-interconnect`.',
    ' * @module @deepseek-ai/dsh-experimental-interconnect',
    ' * @module dsh-interconnect',
  ]],
  ['src/tool-interconnect/index.ts', [
    "import { MAX_LISTED_SESSIONS } from '@deepseek-ai/dsh-experimental-interconnect'",
    "import { MAX_LISTED_SESSIONS } from '../interconnect/index.ts'",
  ]],
  ['src/skill-interconnect/index.ts', [
    "import type {} from '@deepseek-ai/dsh-experimental-interconnect'",
    "import type {} from '../interconnect/index.ts'",
    "const SKILL_BODY_URL = new URL('../assets/dsh-interconnect.md', import.meta.url)",
    "const SKILL_BODY_URL = new URL('../../assets/dsh-interconnect.md', import.meta.url)",
  ]],
  ['tests/interconnect.host.spec.ts', [
    "import InterconnectService, { INTERCONNECT_TOKEN_REF, linkUrl } from '../src/index.ts'",
    "import InterconnectService, { INTERCONNECT_TOKEN_REF, linkUrl } from '../src/interconnect/index.ts'",
    "import type { DeliveryMode, EventNotification } from '../src/index.ts'",
    "import type { DeliveryMode, EventNotification } from '../src/interconnect/index.ts'",
    "import type { LinkFrame } from '../src/types.ts'",
    "import type { LinkFrame } from '../src/interconnect/types.ts'",
  ]],
  ['tests/tool-interconnect.spec.ts', [
    "import * as toolInterconnect from '../src/index.ts'",
    "import * as toolInterconnect from '../src/tool-interconnect/index.ts'",
    "import { MAX_LISTED_SESSIONS } from '@deepseek-ai/dsh-experimental-interconnect'",
    "import { MAX_LISTED_SESSIONS } from '../src/interconnect/index.ts'",
    "import type { InterconnectService, SendResult } from '@deepseek-ai/dsh-experimental-interconnect'",
    "import type { InterconnectService, SendResult } from '../src/interconnect/index.ts'",
  ]],
  ['tests/skill-interconnect.spec.ts', [
    "import * as skillInterconnect from '../src/index.ts'",
    "import * as skillInterconnect from '../src/skill-interconnect/index.ts'",
    "import type { InterconnectService } from '@deepseek-ai/dsh-experimental-interconnect'",
    "import type { InterconnectService } from '../src/interconnect/index.ts'",
  ]],
])

/** The ported file that carries the macOS-independent local-only mirrored block. */
const MIRRORED_BLOCK_PATH = 'src/interconnect/index.ts'

/**
 * Anchors of the local-only block in `src/interconnect/index.ts`: the Host's
 * subagent-ownership predicate and `assertNever`, which the Host does not export
 * to plugins. The block has no upstream counterpart, so the raw pass removes it
 * before comparing. It is located by content rather than by line number, and a
 * missing anchor fails the check rather than silently skipping the removal.
 */
const MIRRORED_BLOCK = {
  body: /Mirror of the Host's subagent-ownership predicate/u,
  open: /^\/\*\*$/u,
  tail: /interconnect: unhandled variant/u,
  close: /^\}$/u,
}

/**
 * Remove the mirrored block so its lines are not reported as unrecorded drift.
 * @param lines - the local file's lines.
 * @returns the lines without the block, or null when an anchor is absent.
 */
function withoutMirroredBlock(lines) {
  const body = lines.findIndex(line => MIRRORED_BLOCK.body.test(line))
  const tail = lines.findIndex(line => MIRRORED_BLOCK.tail.test(line))
  if (body === -1 || tail === -1) return null
  let open = body
  while (open >= 0 && !MIRRORED_BLOCK.open.test(lines[open])) open -= 1
  let close = tail
  while (close < lines.length && !MIRRORED_BLOCK.close.test(lines[close])) close += 1
  if (open < 0 || close >= lines.length) return null
  return [...lines.slice(0, open), ...lines.slice(close + 1)]
}

/**
 * Lines present in `left` more often than in `right`, ignoring allowed text and
 * blank lines. Occurrence counts rather than a set: a duplicated comment line
 * dropped on one side is drift a set difference cannot see. Blank lines carry no
 * content and are ignored so that removing the mirrored block leaves no artifact.
 * @param left - the lines to account for.
 * @param right - the lines that may account for them.
 * @param allowed - exact line texts that are recorded adaptations.
 * @returns the unaccounted lines.
 */
function unaccounted(left, right, allowed) {
  const skip = line => line.trim() === '' || allowed.has(line)
  const counts = new Map()
  for (const line of right) {
    if (skip(line)) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  const out = []
  for (const line of left) {
    if (skip(line)) continue
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) counts.set(line, remaining - 1)
    else out.push(line)
  }
  return out
}

/**
 * The retirement plan repoints a deployment profile at the monorepo's
 * `interconnect-profile` layer while keeping that profile's own override rows,
 * which keeps working only while both patches insert the same row ids with the
 * same config keys — the deployment overrides patch `config.instanceId` and
 * `config.peers` by row id. The `name` values differ by design (this package's
 * subpaths versus the scoped packages), so they are not compared.
 */
const PATCH_ID_PAIRS = [
  ['packages/experimental/interconnect-profile/cordis.patch.yml', 'cordis.patch.yml'],
]

/**
 * Row ids a cordis patch inserts, mapped to their sorted `config` key names.
 * @param text - the patch file's text.
 * @returns one entry per inserted row, keyed by id.
 */
function patchRows(text) {
  const rows = new Map()
  let current = null
  let configIndent = null
  for (const line of text.split('\n')) {
    const id = /^(\s*)-\s*id:\s*(\S+)\s*$/u.exec(line)
    if (id !== null) {
      current = id[2]
      rows.set(current, [])
      configIndent = null
      continue
    }
    if (current === null) continue
    const configLine = /^(\s*)config:\s*$/u.exec(line)
    if (configLine !== null) {
      configIndent = configLine[1].length
      continue
    }
    if (configIndent === null) continue
    const key = /^(\s+)([A-Za-z_][\w]*):/u.exec(line)
    if (key === null || key[1].length <= configIndent) {
      configIndent = null
      continue
    }
    rows.get(current).push(key[2])
  }
  for (const [id, keys] of rows) rows.set(id, [...keys].sort())
  return rows
}

/** Render a row map for diagnostics. */
function describeRows(rows) {
  if (rows.size === 0) return '(none found)'
  return [...rows].map(([id, keys]) => `${id}{${keys.join(',')}}`).join(' ')
}

let failed = false
for (const [upstreamPath, portedPath] of PAIRS) {
  const upstream = upstreamBlob(upstreamPath)
  const ported = readFileSync(join(ROOT, portedPath), 'utf8')
  const { missing, extra } = compare(upstream, ported)
  const drift = missing.length + extra.length
  if (drift === 0) {
    process.stdout.write(`ok    ${portedPath} (skeleton identical to ${SHORT})\n`)
    continue
  }
  failed = true
  process.stdout.write(`DRIFT ${portedPath}: ${String(missing.length)} upstream lines absent, ${String(extra.length)} local lines unaccounted\n`)
  for (const line of missing.slice(0, 20)) process.stdout.write(`  - ${line}\n`)
  for (const line of extra.slice(0, 20)) process.stdout.write(`  + ${line}\n`)
}

for (const [upstreamPath, portedPath] of PAIRS) {
  const upstream = upstreamBlob(upstreamPath)
  const allowed = new Set(RAW_ADAPTATIONS.get(portedPath) ?? [])
  const lines = readFileSync(join(ROOT, portedPath), 'utf8').split('\n')
  const local = portedPath === MIRRORED_BLOCK_PATH ? withoutMirroredBlock(lines) : lines
  if (local === null) {
    failed = true
    process.stdout.write(
      `DRIFT ${portedPath}: the mirrored block anchors are absent from ${MIRRORED_BLOCK_PATH}; `
      + 'the raw pass cannot tell the local-only block from unported upstream text\n',
    )
    continue
  }
  const upstreamLines = upstream.split('\n')
  const missing = unaccounted(upstreamLines, local, allowed)
  const extra = unaccounted(local, upstreamLines, allowed)
  if (missing.length === 0 && extra.length === 0) {
    process.stdout.write(`ok    ${portedPath} (raw text matches ${SHORT} outside ${String(allowed.size)} recorded adaptations)\n`)
    continue
  }
  failed = true
  process.stdout.write(
    `DRIFT ${portedPath}: ${String(missing.length)} upstream line(s) not ported, `
    + `${String(extra.length)} local line(s) not a recorded adaptation\n`,
  )
  for (const line of missing.slice(0, 12)) process.stdout.write(`  - ${line}\n`)
  for (const line of extra.slice(0, 12)) process.stdout.write(`  + ${line}\n`)
}

for (const [upstreamPath, portedPath] of EXACT_PAIRS) {
  const upstream = upstreamBlob(upstreamPath, true)
  const ported = readFileSync(join(ROOT, portedPath))
  if (upstream.equals(ported)) {
    process.stdout.write(`ok    ${portedPath} (byte-identical to ${SHORT})\n`)
    continue
  }
  failed = true
  process.stdout.write(
    `DRIFT ${portedPath}: bytes differ from ${upstreamPath} `
    + `(${String(upstream.length)} upstream bytes vs ${String(ported.length)} local)\n`,
  )
}

for (const [upstreamPath, portedPath] of PATCH_ID_PAIRS) {
  const upstream = upstreamBlob(upstreamPath)
  const upstreamRows = patchRows(upstream)
  const portedRows = patchRows(readFileSync(join(ROOT, portedPath), 'utf8'))
  if (upstreamRows.size > 0 && describeRows(upstreamRows) === describeRows(portedRows)) {
    process.stdout.write(`ok    ${portedPath} (rows and config keys match: ${describeRows(upstreamRows)})\n`)
    continue
  }
  failed = true
  process.stdout.write(
    `DRIFT ${portedPath}: inserted rows diverge from ${upstreamPath}\n`
    + `  upstream: ${describeRows(upstreamRows)}\n`
    + `  local:    ${describeRows(portedRows)}\n`,
  )
}

/**
 * The bundle the retirement migration repoints every deployment profile at. The
 * migration writes this package name into `dsh.profile.bundles`, so a rename
 * upstream would leave the runbook naming a bundle that does not exist — and
 * nothing else here would notice, because the other checks compare patch rows
 * and peers rather than `name`. Both directions are asserted: upstream must still
 * carry this name and a patch layer, and RELEASING.md must still name it, so the
 * constant, the upstream package, and the runbook cannot drift apart.
 */
const PROFILE_BUNDLE = {
  path: 'packages/experimental/interconnect-profile/package.json',
  name: '@deepseek-ai/dsh-experimental-interconnect-profile',
  patch: './cordis.patch.yml',
  documentedIn: 'RELEASING.md',
}

{
  const manifest = JSON.parse(upstreamBlob(PROFILE_BUNDLE.path))
  const patch = manifest.dsh?.bundle?.patch
  const runbook = readFileSync(join(ROOT, PROFILE_BUNDLE.documentedIn), 'utf8')
  const problems = []
  if (manifest.name !== PROFILE_BUNDLE.name) {
    problems.push(`upstream name is ${String(manifest.name)}, the migration names ${PROFILE_BUNDLE.name}`)
  }
  if (patch !== PROFILE_BUNDLE.patch) {
    problems.push(`bundle patch is ${String(patch)}, expected ${PROFILE_BUNDLE.patch}`)
  }
  if (!runbook.includes(PROFILE_BUNDLE.name)) {
    problems.push(`${PROFILE_BUNDLE.documentedIn} does not name ${PROFILE_BUNDLE.name}`)
  }
  if (problems.length === 0) {
    process.stdout.write(`ok    ${PROFILE_BUNDLE.path} (migration bundle ${PROFILE_BUNDLE.name} with patch ${PROFILE_BUNDLE.patch})\n`)
  } else {
    failed = true
    process.stdout.write(
      `DRIFT ${PROFILE_BUNDLE.path}: the retirement migration would name the wrong bundle\n`
      + problems.map(problem => `  - ${problem}\n`).join(''),
    )
  }
}

/**
 * Manifests whose `peerDependenciesMeta` must agree. Marking a peer optional is
 * install-visible: a deployment without that peer still installs the plugin
 * instead of failing peer resolution, so a hand-copied manifest can silently
 * change what `npm install` does. Only this map is compared; the peer NAMES
 * differ by design between the scoped monorepo package and this one.
 */
const PEER_META_PAIRS = [
  ['packages/experimental/interconnect/package.json', 'package.json'],
]

/**
 * Manifests whose peer NAMES are compared as a subset. A peer here is a service
 * the host provides, so every peer the monorepo plugin declares must also be
 * declared by this mirror; otherwise a newly host-provided service (or a newly
 * promoted dependency) would be silently absent from this package's manifest.
 * The reverse direction is not drift: this mirror declares extra peers and
 * mirrors two util packages instead of depending on them, both documented in
 * RELEASING.md.
 */
const PEER_SUBSET_PAIRS = [
  ['packages/experimental/interconnect/package.json', 'package.json'],
]

/**
 * Read one manifest's peer names.
 * @param text - the manifest's JSON text.
 * @returns the sorted peer names.
 */
function peerNames(text) {
  return Object.keys(JSON.parse(text).peerDependencies ?? {}).sort()
}

/**
 * Normalize one manifest's `peerDependenciesMeta` into a comparable string.
 * @param text - the manifest's JSON text.
 * @returns such as `@deepseek-ai/dsh-host-webserver{optional=true}`, or `(none)`.
 */
function peerMeta(text) {
  const meta = JSON.parse(text).peerDependenciesMeta ?? {}
  const entries = Object.keys(meta).sort().map((name) => {
    const flags = Object.keys(meta[name]).sort().map(key => `${key}=${String(meta[name][key])}`).join(',')
    return `${name}{${flags}}`
  })
  return entries.length === 0 ? '(none)' : entries.join(' ')
}

for (const [upstreamPath, portedPath] of PEER_META_PAIRS) {
  const upstream = upstreamBlob(upstreamPath)
  const upstreamMeta = peerMeta(upstream)
  const portedMeta = peerMeta(readFileSync(join(ROOT, portedPath), 'utf8'))
  if (upstreamMeta === portedMeta) {
    process.stdout.write(`ok    ${portedPath} (peerDependenciesMeta matches: ${upstreamMeta})\n`)
    continue
  }
  failed = true
  process.stdout.write(
    `DRIFT ${portedPath}: peerDependenciesMeta diverges from ${upstreamPath}\n`
    + `  upstream: ${upstreamMeta}\n`
    + `  local:    ${portedMeta}\n`,
  )
}

for (const [upstreamPath, portedPath] of PEER_SUBSET_PAIRS) {
  const upstream = upstreamBlob(upstreamPath)
  const upstreamPeers = peerNames(upstream)
  const localPeers = new Set(peerNames(readFileSync(join(ROOT, portedPath), 'utf8')))
  const missing = upstreamPeers.filter(name => !localPeers.has(name))
  if (missing.length === 0) {
    process.stdout.write(`ok    ${portedPath} (declares every upstream peer: ${String(upstreamPeers.length)})\n`)
    continue
  }
  failed = true
  process.stdout.write(
    `DRIFT ${portedPath}: ${String(missing.length)} upstream peer(s) not declared from ${upstreamPath}\n`
    + missing.map(name => `  - ${name}\n`).join(''),
  )
}

if (failed) {
  process.stdout.write(`\nbehavioural drift against ${REF} (${SHORT}) in ${WORKTREE}; port the change or extend the adaptation rules\n`)
  process.exit(1)
}
process.stdout.write(`\nno behavioural drift and no unrecorded text drift against ${REF} (${SHORT}) across ${String(PAIRS.length)} ported files, ${String(EXACT_PAIRS.length)} byte-exact asset, ${String(PATCH_ID_PAIRS.length)} patch row set, ${String(PEER_META_PAIRS.length)} optional-peer set, 1 migration bundle, and ${String(PEER_SUBSET_PAIRS.length)} peer subset\n`)
