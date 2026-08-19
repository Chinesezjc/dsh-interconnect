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
    reply: vi.fn(async () => ({ delivered: true, instance: 'peer' })),
    selfSender: vi.fn(() => ({ instanceId: 'self', sessionId: '' })),
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

  it('forwards resume only when asked, keeping the key absent by default', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    await tool.execute(
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    const mock = interconnect.send as unknown as { mock: { calls: [Record<string, unknown>][] } }
    expect('resume' in mock.mock.calls[0]![0]).toBe(false)

    await tool.execute(
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi', resume: true },
      { signal: new AbortController().signal } as never,
    )
    expect(mock.mock.calls[1]![0].resume).toBe(true)
    await dispose()
  })

  it('renders resume-refused and resume-failed distinctly', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_send')!
    const args = { instanceId: 'peer', sessionId: 'sess-x', text: 'hi' }
    const refused = tool.output!.render!(args, { delivered: false, instance: 'peer', reason: 'resume-refused' } as never)
    const failed = tool.output!.render!(args, { delivered: false, instance: 'peer', reason: 'resume-failed' } as never)
    expect((refused as { text: string }[])[0]!.text).toContain('does not allow waking')
    expect((failed as { text: string }[])[0]!.text).toContain('could not wake')
    // Neither should be mistaken for the plain not-live advice.
    expect((refused as { text: string }[])[0]!.text).not.toContain('interconnect_list')
    const owned = tool.output!.render!(args, { delivered: false, instance: 'peer', reason: 'session-owned-by-subagent' } as never)
    const ownedText = (owned as { text: string }[])[0]!.text
    expect(ownedText).toContain('subagent')
    expect(ownedText).toContain('parent')
    // Waking cannot help here, so the wake advice must not appear.
    expect(ownedText).not.toContain('set resume')
    await dispose()
  })

  it('dispatches interconnect_send to the service and returns delivered/instance', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    const value = await tool.execute(
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.send).toHaveBeenCalledWith({
      instanceId: 'peer',
      sessionId: 'sess-1',
      text: 'hi',
      sender: { instanceId: 'self', sessionId: '' },
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
      { instanceId: 'peer', sessionId: 'sess-gone', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toEqual({ delivered: false, instance: 'peer', reason: 'session-not-live' })
    const rendered = tool.output!.render!({ instanceId: 'peer', sessionId: 'sess-gone', text: 'hi' }, value as never)
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
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    const rendered = tool.output!.render!({ instanceId: 'peer', sessionId: 'sess-1', text: 'hi' }, value as never)
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
      { instanceId: 'peer', sessionId: 'sess-1', text: 'urgent', delivery: 'steer' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.send).toHaveBeenCalledWith({
      instanceId: 'peer',
      sessionId: 'sess-1',
      text: 'urgent',
      delivery: 'steer',
      sender: { instanceId: 'self', sessionId: '' },
    })
    expect(value).toEqual({ delivered: true, instance: 'peer', delivery: 'steer' })
    await dispose()
  })

  it('omits the delivery key entirely when the caller passes no mode', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    await tool.execute(
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' },
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
      { instanceId: 'peer' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toEqual({ reachable: false })
    await dispose()
  })

  it('reports reachable with the peer instance when ping succeeds', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_ping')!
    const value = await tool.execute(
      { instanceId: 'peer' },
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
      { instanceId: 'peer' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.list).toHaveBeenCalledWith('peer')
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
      { instanceId: 'peer' },
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
      { instanceId: 'peer' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toEqual({ reachable: false })
    await dispose()
  })

  it('registers interconnect_reply and dispatches the local-session reply to the service', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_reply')!
    expect(tool.name).toBe('interconnect_reply')
    const value = await tool.execute(
      { sessionId: 'local-sess', text: 'hi back' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.reply).toHaveBeenCalledWith({ sessionId: 'local-sess', text: 'hi back' })
    expect(value).toEqual({ delivered: true, instance: 'peer' })
    await dispose()
  })

  it('forwards an explicit delivery mode on a reply and reports it back', async () => {
    const interconnect = fakeInterconnect({
      reply: vi.fn(async () => ({ delivered: true, instance: 'peer', delivery: 'inject' as const })),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_reply')!
    const value = await tool.execute(
      { sessionId: 'local-sess', text: 'quiet reply', delivery: 'inject' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.reply).toHaveBeenCalledWith({
      sessionId: 'local-sess',
      text: 'quiet reply',
      delivery: 'inject',
    })
    expect(value).toEqual({ delivered: true, instance: 'peer', delivery: 'inject' })
    await dispose()
  })

  it('omits the delivery key on a reply when the caller passes no mode', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_reply')!
    await tool.execute(
      { sessionId: 'local-sess', text: 'plain' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    const mock = interconnect.reply as unknown as { mock: { calls: [Record<string, unknown>][] } }
    expect('delivery' in mock.mock.calls[0]![0]).toBe(false)
    await dispose()
  })

  it('renders no-sender-known distinctly for a reply with no recorded sender', async () => {
    const interconnect = fakeInterconnect({
      reply: vi.fn(async () => ({
        delivered: false,
        instance: 'peer',
        reason: 'no-sender-known' as const,
      })),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_reply')!
    const args = { sessionId: 'local-sess', text: 'hello?' }
    const value = await tool.execute(args, { signal: new AbortController().signal } as never)
    const rendered = tool.output!.render!(args, value as never)
    const text = (rendered as { text: string }[])[0]!.text
    expect(text).toContain('no sender recorded')
    expect(value).toEqual({ delivered: false, instance: 'peer', reason: 'no-sender-known' })
    await dispose()
  })

  it('attaches the session identity as sender on interconnect_send', async () => {
    const interconnect = fakeInterconnect({
      selfSender: vi.fn((sessionId: string) => ({
        instanceId: 'me',
        sessionId,
      })),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    // The executing agent is the session that sends, so its id becomes the
    // reply target the peer can use.
    const agent = { session: { id: 'sender-sess' } }
    await tool.execute(
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' },
      { agent, signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.selfSender).toHaveBeenCalledWith('sender-sess')
    expect(interconnect.send).toHaveBeenCalledWith({
      instanceId: 'peer',
      sessionId: 'sess-1',
      text: 'hi',
      sender: { instanceId: 'me', sessionId: 'sender-sess' },
    })
    await dispose()
  })

  it('attributes the sender even when the executing agent id is absent', async () => {
    // With address-free addressing the sender no longer depends on a config
    // origin; it is always attached (with whatever session id is known).
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    await tool.execute(
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    const mock = interconnect.send as unknown as { mock: { calls: [Record<string, unknown>][] } }
    expect(typeof (mock.mock.calls[0]![0] as { sender: { sessionId: string } }).sender.sessionId).toBe('string')
    await dispose()
  })
})
