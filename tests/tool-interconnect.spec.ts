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
    list: vi.fn(async () => ({
      instance: 'peer',
      sessions: [
        { sessionId: 'sess-1', title: 'first', status: 'idle' },
        { sessionId: 'sess-2' },
      ],
    })),
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

  it('surfaces the failure reason and points at interconnect_list for a not-live target', async () => {
    const interconnect = fakeInterconnect({
      send: vi.fn(async () => ({
        delivered: false,
        instance: 'peer',
        reason: 'session-not-live' as const,
      })),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001', sessionId: 'sess-gone', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toEqual({ delivered: false, instance: 'peer', reason: 'session-not-live' })
    const rendered = tool.output!.render!({ baseUrl: 'http://peer:9001', sessionId: 'sess-gone', text: 'hi' }, value as never)
    const text = (rendered as { type: 'text'; text: string }[])[0]!.text
    expect(text).toContain('sess-gone')
    expect(text).toContain('interconnect_list')
    await dispose()
  })

  it('renders an unreachable peer without blaming the target session', async () => {
    const interconnect = fakeInterconnect({
      send: vi.fn(async () => ({
        delivered: false,
        instance: 'self',
        reason: 'unreachable' as const,
      })),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    const rendered = tool.output!.render!({ baseUrl: 'http://peer:9001', sessionId: 'sess-1', text: 'hi' }, value as never)
    const text = (rendered as { type: 'text'; text: string }[])[0]!.text
    expect(text).toContain('did not answer')
    // The old single-line render claimed "no live session" for this case too.
    expect(text).not.toContain('no live session')
    await dispose()
  })

  it('forwards an explicit delivery mode to the service and reports it back', async () => {
    const interconnect = fakeInterconnect({
      send: vi.fn(async () => ({ delivered: true, instance: 'peer', delivery: 'steer' as const })),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001', sessionId: 'sess-1', text: 'urgent', delivery: 'steer' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.send).toHaveBeenCalledWith({
      baseUrl: 'http://peer:9001',
      sessionId: 'sess-1',
      text: 'urgent',
      delivery: 'steer',
    })
    expect(value).toEqual({ delivered: true, instance: 'peer', delivery: 'steer' })
    await dispose()
  })

  it('omits the delivery key entirely when the caller passes no mode', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    await tool.execute(
      { baseUrl: 'http://peer:9001', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    // An explicit `delivery: undefined` would serialize into the wire payload and
    // fail the receiver's schema, so the key must be absent rather than undefined.
    const mock = interconnect.send as unknown as { mock: { calls: [Record<string, unknown>][] } }
    expect('delivery' in mock.mock.calls[0]![0]).toBe(false)
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

  it('registers interconnect_list and returns the peer session rows', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_list')!
    expect(tool.name).toBe('interconnect_list')
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.list).toHaveBeenCalledWith('http://peer:9001')
    expect(value).toEqual({
      reachable: true,
      instance: 'peer',
      sessions: [
        { sessionId: 'sess-1', title: 'first', status: 'idle' },
        { sessionId: 'sess-2' },
      ],
    })
    await dispose()
  })

  it('omits absent title and status keys instead of sending explicit undefined', async () => {
    // The wire schema forbids additional/undefined properties, so an untitled
    // row must not carry the key at all.
    const interconnect = fakeInterconnect({
      list: vi.fn(async () => ({ instance: 'peer', sessions: [{ sessionId: 'bare' }] })),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_list')!
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001' },
      { signal: new AbortController().signal } as never,
    ) as { sessions: Record<string, unknown>[] }
    expect('title' in value.sessions[0]!).toBe(false)
    expect('status' in value.sessions[0]!).toBe(false)
    await dispose()
  })

  it('reports unreachable from interconnect_list when the peer answers nothing', async () => {
    const interconnect = fakeInterconnect({ list: vi.fn(async () => undefined) })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_list')!
    const value = await tool.execute(
      { baseUrl: 'http://peer:9001' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toEqual({ reachable: false })
    await dispose()
  })
})
