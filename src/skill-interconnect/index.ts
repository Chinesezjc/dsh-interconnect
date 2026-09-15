/**
 * Companion skill for the dsh-interconnect tools: tells the model how to use
 * `interconnect_list`, `interconnect_ping`, `interconnect_send`, and
 * `interconnect_reply`, including the automatic sender-identity injection.
 *
 * This is a thin skill provider, intentionally separate from
 * `tool-interconnect`: the service and tools remain usable without the skill,
 * and the profile layer that enables cross-instance handoff mounts this row
 * with them. It injects the `interconnect` service so the skill only appears
 * when the transport it describes is actually present.
 * @module @deepseek-ai/dsh-experimental-skill-interconnect
 */

import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
// Activates the `Context.interconnect` merge declared by the interconnect service plugin.
import type {} from '../interconnect/index.ts'

const PROVIDER_NAME = 'dsh-interconnect'
const SKILL_BODY_URL = new URL('../../assets/dsh-interconnect.md', import.meta.url)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Use the dsh-interconnect tools to exchange messages between DSH sessions, instances, and machines: list live sessions on a known peer instance, send messages, reply to the last sender, and probe liveness. Use whenever you need to message another DSH agent, coordinate across sessions, or respond to an incoming interconnect handoff.'
/* jscpd:ignore-start -- the bundled-skill provider shape is the same required boilerplate as skill-badge. */
// Unlike skill-badge, this candidate carries no `resourceBase`: `assets/` holds
// only the body already inlined as `<skill_instructions>`, and a directory base
// renders this installation's absolute path into model-visible text, which a
// recorded session cannot replay elsewhere.
const CANDIDATE: SkillCandidate = {
  name: 'dsh-interconnect',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}
/* jscpd:ignore-end */

/** Cordis plugin name. */
export const name = 'skill-interconnect'
/** Services required by the companion provider. */
export const inject = ['skills', 'interconnect']

/** Register the bundled `dsh-interconnect` skill on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
