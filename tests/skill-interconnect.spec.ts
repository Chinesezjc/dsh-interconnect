/** Companion skill plugin: registers the bundled dsh-interconnect skill only when the interconnect service is present. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillInterconnect from '../src/skill-interconnect/index.ts'
import type { InterconnectService } from '../src/interconnect/index.ts'

const fakeInterconnect = {
  instanceId: 'self',
} as unknown as InterconnectService

async function mounted(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  ctx.provide('interconnect', fakeInterconnect)
  const fiber = await ctx.plugin(skillInterconnect)
  return { ctx, dispose: async () => { await fiber.dispose() } }
}

describe('skill-interconnect', () => {
  it('declares the skill registry and interconnect service as dependencies', () => {
    expect(skillInterconnect.inject).toEqual(['skills', 'interconnect'])
  })

  it('registers the bundled dsh-interconnect skill', async () => {
    const { ctx, dispose } = await mounted()
    const listed = await ctx.skills.list()
    expect(listed).toEqual([{
      name: 'dsh-interconnect',
      description: 'Use the dsh-interconnect tools to exchange messages between DSH sessions, instances, and machines: list live sessions on a known peer instance, send messages, reply to the last sender, and probe liveness. Use whenever you need to message another DSH agent, coordinate across sessions, or respond to an incoming interconnect handoff.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-interconnect',
      source: 'bundled',
    }])
    await dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('loads the skill body with usage guidance', async () => {
    const { ctx, dispose } = await mounted()
    const loaded = await ctx.skills.get('dsh-interconnect')
    expect(loaded?.content).toContain('interconnect_reply')
    expect(loaded?.content).toContain('attached automatically')
    expect(loaded?.content).toContain('Sender identity is automatic')
    await dispose()
  })

  it('ships the skill body file unchanged', async () => {
    const body = await readFile(new URL('../assets/dsh-interconnect.md', import.meta.url), 'utf8')
    expect(body).toContain('# dsh-interconnect')
    expect(body).toContain('interconnect_send')
    expect(body).toContain('interconnect_list')
    expect(body).toContain('interconnect_ping')
    expect(body).toContain('interconnect_reply')
  })
})

describe('skill-interconnect Loader shape', () => {
  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in skillInterconnect).toBe(false)
    expect(skillInterconnect.name).toBe('skill-interconnect')
    expect(skillInterconnect.inject).toEqual(['skills', 'interconnect'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(skillInterconnect) as Record<string, unknown>
    expect(unwrapped).toBe(skillInterconnect)
    expect(unwrapped.name).toBe('skill-interconnect')
    expect(unwrapped.inject).toEqual(['skills', 'interconnect'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
