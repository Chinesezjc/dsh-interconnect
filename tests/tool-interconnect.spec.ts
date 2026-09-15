/** Model-facing interconnect tools: register, validate, and dispatch to the interconnect service. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolInterconnect from '../src/tool-interconnect/index.ts'
import { MAX_LISTED_SESSIONS } from '../src/interconnect/index.ts'
import type { InterconnectService, SendResult } from '../src/interconnect/index.ts'

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

  it('removes every registered tool when the contributing fiber is disposed', async () => {
    const names = ['interconnect_list', 'interconnect_ping', 'interconnect_reply', 'interconnect_send']
    const { ctx, dispose } = await mounted(fakeInterconnect())
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining(names))
    await dispose()
    expect(ctx.tools.schemas()).toEqual([])
    for (const name of names) expect(ctx.tools.get(name)).toBeUndefined()
  })

  it('forwards resume only when asked, keeping the key absent by default', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    await tool.execute(
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
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
    const refused = tool.output.render(args, { delivered: false, instance: 'peer', reason: 'resume-refused' })
    const failed = tool.output.render(args, { delivered: false, instance: 'peer', reason: 'resume-failed' })
    expect((refused as { text: string }[])[0]!.text).toContain('does not allow waking')
    expect((failed as { text: string }[])[0]!.text).toContain('could not wake')
    // Neither should be mistaken for the plain not-live advice.
    expect((refused as { text: string }[])[0]!.text).not.toContain('interconnect_list')
    const owned = tool.output.render(args, { delivered: false, instance: 'peer', reason: 'session-owned-by-subagent' })
    const ownedText = (owned as { text: string }[])[0]!.text
    expect(ownedText).toContain('subagent')
    expect(ownedText).toContain('parent')
    // Waking cannot help here, so the wake advice must not appear.
    expect(ownedText).not.toContain('set resume')
    await dispose()
  })

  it('renders an over-cap message as a size limit rather than a transport failure', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const send = ctx.tools.get('interconnect_send')!
    const sendArgs = { instanceId: 'peer', sessionId: 'sess-x', text: 'x' }
    const sendText = (send.output.render(sendArgs, { delivered: false, instance: 'peer', reason: 'message-too-large' }) as { text: string }[])[0]!.text
    expect(sendText).toContain('too large')
    expect(sendText).toContain('shorten')
    // Retrying the same text cannot help, so the unreachable advice must not appear.
    expect(sendText).not.toContain('retrying may succeed')
    const reply = ctx.tools.get('interconnect_reply')!
    const replyText = (reply.output.render({ text: 'x' }, { delivered: false, instance: 'peer', reason: 'message-too-large' }) as { text: string }[])[0]!.text
    expect(replyText).toContain('too large')
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
    const rendered = tool.output.render({ instanceId: 'peer', sessionId: 'sess-gone', text: 'hi' }, value as never)
    const text = (rendered as { type: 'text'; text: string }[])[0]!.text
    expect(text).toContain('sess-gone')
    expect(text).toContain('interconnect_list')
    await dispose()
  })

  it('stops suggesting resume when the caller already asked for it', async () => {
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
      { instanceId: 'peer', sessionId: 'sess-gone', text: 'hi', resume: true },
      { signal: new AbortController().signal } as never,
    )
    const rendered = tool.output.render({ instanceId: 'peer', sessionId: 'sess-gone', text: 'hi', resume: true }, value as never)
    const text = (rendered as { type: 'text'; text: string }[])[0]!.text
    expect(text).toContain('interconnect_list')
    expect(text).not.toContain('set resume')
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
    const rendered = tool.output.render({ instanceId: 'peer', sessionId: 'sess-1', text: 'hi' }, value as never)
    const text = (rendered as { type: 'text'; text: string }[])[0]!.text
    expect(text).toContain('did not answer')
    expect(text).toContain('retrying may succeed')
    // An unreachable peer is a delivery outcome, not a liveness claim about the target.
    expect(text).not.toContain('no live session')
    await dispose()
  })

  it('forwards an explicit delivery mode to the service and reports it back', async () => {
    const interconnect = fakeInterconnect({
      send: vi.fn(async (): Promise<SendResult> => ({ delivered: true, instance: 'peer', delivery: 'steer' })),
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
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
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
      { text: 'hi back' },
      { agent: { session: { id: 'local-sess' } }, signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.reply).toHaveBeenCalledWith({ sessionId: 'local-sess', text: 'hi back' })
    expect(value).toEqual({ delivered: true, instance: 'peer' })
    await dispose()
  })

  it('forwards an explicit delivery mode on a reply and reports it back', async () => {
    const interconnect = fakeInterconnect({
      reply: vi.fn(async (): Promise<SendResult> => ({ delivered: true, instance: 'peer', delivery: 'inject' })),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_reply')!
    const value = await tool.execute(
      { text: 'quiet reply', delivery: 'inject' },
      { agent: { session: { id: 'local-sess' } }, signal: new AbortController().signal } as never,
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
      { text: 'plain' },
      { agent: { session: { id: 'local-sess' } }, signal: new AbortController().signal } as never,
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
    const args = { text: 'hello?' }
    const value = await tool.execute(args, { agent: { session: { id: 'local-sess' } }, signal: new AbortController().signal } as never)
    const rendered = tool.output.render(args, value as never)
    const text = (rendered as { text: string }[])[0]!.text
    expect(text).toContain('no sender identity is known to reply to')
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
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.send).toHaveBeenCalledWith({
      instanceId: 'peer',
      sessionId: 'sess-1',
      text: 'hi',
      sender: { instanceId: 'me', sessionId: 'sender-sess' },
    })
    await dispose()
  })

  it('attaches no sender when no executing agent supplies a session', async () => {
    // `interconnect_reply` refuses this same precondition, and an empty session
    // id would become a reply target the peer can never reach.
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    await tool.execute(
      { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    const mock = interconnect.send as unknown as { mock: { calls: [Record<string, unknown>][] } }
    expect(mock.mock.calls[0]![0]).not.toHaveProperty('sender')
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.selfSender).not.toHaveBeenCalled()
    await dispose()
  })
})

describe('tool-interconnect rendering', () => {
  it('renders a delivered send with and without the delivery mode', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_send')!
    const args = { instanceId: 'peer', sessionId: 'sess-1', text: 'hi' }
    const plain = tool.output.render(args, { delivered: true, instance: 'peer' })
    expect((plain as { text: string }[])[0]!.text).toBe('delivered to peer')
    const steered = tool.output.render(args, { delivered: true, instance: 'peer', delivery: 'steer' })
    expect((steered as { text: string }[])[0]!.text).toBe('delivered to peer via steer')
    await dispose()
  })

  it('renders ping reachable and unreachable distinctly', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_ping')!
    const args = { instanceId: 'peer' }
    const reachable = tool.output.render(args, { reachable: true, instance: 'peer' })
    expect((reachable as { text: string }[])[0]!.text).toBe('reachable: peer')
    const unknown = tool.output.render(args, { reachable: true })
    expect((unknown as { text: string }[])[0]!.text).toBe('reachable: (unknown instance)')
    const unreachable = tool.output.render(args, { reachable: false })
    expect((unreachable as { text: string }[])[0]!.text).toBe('unreachable')
    await dispose()
  })

  it('marks a full listing as possibly truncated', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_list')!
    const args = { instanceId: 'peer' }
    const rows = Array.from(
      { length: MAX_LISTED_SESSIONS },
      (_unused, index) => ({ sessionId: `s-${String(index)}` }),
    )
    const full = tool.output.render(args, { reachable: true, instance: 'peer', sessions: rows })
    const fullText = (full as { text: string }[])[0]!.text
    expect(fullText).toContain('possibly more live sessions')
    const short = tool.output.render(args, { reachable: true, instance: 'peer', sessions: rows.slice(1) })
    expect((short as { text: string }[])[0]!.text).not.toContain('possibly more live sessions')
    await dispose()
  })

  it('renders interconnect_list rows including absent title/status', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_list')!
    const args = { instanceId: 'peer' }
    const unreachable = tool.output.render(args, { reachable: false })
    expect((unreachable as { text: string }[])[0]!.text).toBe('unreachable')
    const empty = tool.output.render(args, { reachable: true, instance: 'peer', sessions: [] })
    expect((empty as { text: string }[])[0]!.text).toBe('no live sessions on peer')
    const rows = tool.output.render(args, {
      reachable: true,
      instance: 'peer',
      sessions: [
        { sessionId: 'sess-1', title: 'first', status: 'idle' },
        { sessionId: 'sess-2' },
      ],
    })
    expect((rows as { text: string }[])[0]!.text).toBe('sess-1 first [idle]\nsess-2')
    await dispose()
  })

  it('renders each interconnect_reply failure reason distinctly', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_reply')!
    const args = { text: 'hello?' }
    const delivered = tool.output.render(args, { delivered: true, instance: 'peer' })
    expect((delivered as { text: string }[])[0]!.text).toBe('replied to peer')
    const steered = tool.output.render(args, { delivered: true, instance: 'peer', delivery: 'inject' })
    expect((steered as { text: string }[])[0]!.text).toBe('replied to peer via inject')
    const owned = tool.output.render(args, { delivered: false, instance: 'peer', reason: 'session-owned-by-subagent' })
    expect((owned as { text: string }[])[0]!.text).toContain('parent agent owns delivery')
    const unreachable = tool.output.render(args, { delivered: false, instance: 'peer', reason: 'unreachable' })
    expect((unreachable as { text: string }[])[0]!.text).toContain('did not answer')
    const refused = tool.output.render(args, { delivered: false, instance: 'peer', reason: 'resume-refused' })
    expect((refused as { text: string }[])[0]!.text).toContain('does not allow waking')
    const failed = tool.output.render(args, { delivered: false, instance: 'peer', reason: 'resume-failed' })
    expect((failed as { text: string }[])[0]!.text).toContain('could not wake')
    const notLive = tool.output.render(args, { delivered: false, instance: 'peer', reason: 'session-not-live' })
    expect((notLive as { text: string }[])[0]!.text).toContain('session is not live')
    await dispose()
  })
})

describe('tool-interconnect list and reply optionals', () => {
  it('renders an interconnect_list answer with no sessions or instance', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_list')!
    const rendered = tool.output.render({ instanceId: 'peer' }, { reachable: true })
    expect((rendered as { text: string }[])[0]!.text).toBe('no live sessions on (unknown instance)')
    await dispose()
  })

  it('forwards an explicit resume on a reply', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_reply')!
    await tool.execute(
      { text: 'wake them', resume: true },
      { agent: { session: { id: 'local-sess' } }, signal: new AbortController().signal } as never,
    )
    // oxlint-disable-next-line typescript/unbound-method -- mock arrow, no `this`
    expect(interconnect.reply).toHaveBeenCalledWith({
      sessionId: 'local-sess',
      text: 'wake them',
      resume: true,
    })
    await dispose()
  })
})

describe('tool-interconnect Loader shape', () => {
  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // Postmortem 0001 guard: a stray `export default apply` would collapse the
    // module via unwrapExports (`exports.default ?? exports`), drop `inject`,
    // and crash at load. Guard the shape directly.
    expect('default' in toolInterconnect).toBe(false)
    expect(toolInterconnect.name).toBe('tool-interconnect')
    expect(toolInterconnect.inject).toEqual(['interconnect', 'tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolInterconnect) as Record<string, unknown>
    expect(unwrapped).toBe(toolInterconnect)
    expect(unwrapped.name).toBe('tool-interconnect')
    expect(unwrapped.inject).toEqual(['interconnect', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})

describe('tool-interconnect reply without an executing agent', () => {
  it('answers no-sender-known when no agent executes the call', async () => {
    const { ctx, dispose } = await mounted(fakeInterconnect())
    const tool = ctx.tools.get('interconnect_reply')!
    const value = await tool.execute(
      { text: 'hi' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toEqual({ delivered: false, instance: 'unknown', reason: 'no-sender-known' })
    await dispose()
  })
})

describe('tool-interconnect cancellation', () => {
  it('rejects a pending call when the agent signal fires', async () => {
    const interconnect = fakeInterconnect({
      ping: vi.fn(() => new Promise<never>(() => {})), // never settles
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_ping')!
    const controller = new AbortController()
    const pending = tool.execute(
      { instanceId: 'peer' },
      { signal: controller.signal } as never,
    )
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    await dispose()
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const interconnect = fakeInterconnect()
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute(
      { instanceId: 'peer', sessionId: 's', text: 'hi' },
      { signal: controller.signal } as never,
    )).rejects.toThrow(/aborted/)
    // A nullish abort reason falls back to a generic 'aborted' error.
    const controllerNull = new AbortController()
    controllerNull.abort(null)
    await expect(tool.execute(
      { instanceId: 'peer', sessionId: 's', text: 'hi' },
      { signal: controllerNull.signal } as never,
    )).rejects.toThrow(/aborted/)
    await dispose()
  })
})

describe('tool-interconnect service rejection', () => {
  it('propagates a service rejection through raceSignal', async () => {
    const interconnect = fakeInterconnect({
      send: vi.fn(async () => { throw new Error('link lost') }),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_send')!
    await expect(tool.execute(
      { instanceId: 'peer', sessionId: 's', text: 'hi' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('link lost')
    await dispose()
  })
})

describe('tool-interconnect raceSignal edge reasons', () => {
  it('uses the abort reason when it is not an Error', async () => {
    const interconnect = fakeInterconnect({
      ping: vi.fn(() => new Promise<never>(() => {})), // never settles
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_ping')!
    const controller = new AbortController()
    const pending = tool.execute(
      { instanceId: 'peer' },
      { signal: controller.signal } as never,
    )
    controller.abort('plain-reason')
    await expect(pending).rejects.toThrow(/plain-reason/)
    await dispose()
  })

  it('wraps a non-Error service rejection', async () => {
    const interconnect = fakeInterconnect({
      list: vi.fn(async () => { throw 'string failure' }),
    })
    const { ctx, dispose } = await mounted(interconnect)
    const tool = ctx.tools.get('interconnect_list')!
    await expect(tool.execute(
      { instanceId: 'peer' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('string failure')
    await dispose()
  })
})
