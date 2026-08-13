/** Model-facing interconnect tools: register, validate, and dispatch to the interconnect service. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolInterconnect from '../src/tool-interconnect/index.ts'
import type { InterconnectService } from '../src/interconnect/index.ts'

/** Minimal fake interconnect service recording calls and returning fixed results. */
function fakeInterconnect(overrides: Partial<InterconnectService> = {}): InterconnectService {
  return {
    send: vi.fn(async () => ({ delivered: true, instance: 'peer' })),
    ping: vi.fn(async () => ({ pong: true, instance: 'peer' })),
    ...overrides,
  } as unknown as InterconnectService
}

async function mounted(interconnect: InterconnectService): Promise<{
  ctx: Context
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('interconnect', interconnect)
  const fiber = await ctx.plugin(toolInterconnect)
  return { ctx, dispose: async () => { await fiber.dispose() } }
}

describe('tool-interconnect', () => {
  it('declares the interconnect service and tools registry as dependencies', () => {
    expect(toolInterconnect.inject).toEqual(['interconnect', 'tools'])
  })

  it('registers interconnect_send and interconnect_ping', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    expect(ctx.tools.get('interconnect_send')?.name).toBe('interconnect_send')
    expect(ctx.tools.get('interconnect_ping')?.name).toBe('interconnect_ping')
    await dispose()
  })

  it('dispatches interconnect_send to the service and returns delivered/instance', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.send).toHaveBeenCalledWith({
      baseUrl: 'http://peer:9001',
      sessionId: 'sess-1',
      text: 'hi',
    })
    expect(value).toEqual({ delivered: true, instance: 'peer' })
    await dispose()
  })

  it('reports unreachable when the peer pongs nothing', async () => {
    const interconnect = fakeInterconnect({ ping: vi.fn(async () => undefined) })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_ping')!
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toEqual({ reachable: false })
    await dispose()
  })

  it('reports reachable with the peer instance when ping succeeds', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_ping')!
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toEqual({ reachable: true, instance: 'peer' })
    await dispose()
  })
})
