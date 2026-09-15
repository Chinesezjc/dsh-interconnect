/** Host half: upgrade auth, WS msg/query frames, and instanceId-addressed delivery. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import InterconnectService, { INTERCONNECT_TOKEN_REF, linkUrl } from '../src/interconnect/index.ts'
import type { DeliveryMode, EventNotification } from '../src/interconnect/index.ts'
import WebSocket, { WebSocketServer } from 'ws'

/** Structural httpServer fake recording the upgrade registries this service touches. */
function fakeHttpServer(upgrades: WebUpgradeRoute[]): Pick<WebServer, 'registerUpgrade'> {
  return {
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
  }
}

/** Credentials fake resolving one ref to a fixed non-empty value. */
function fakeCredentials(token: string | undefined): Pick<CredentialProvider, 'resolve'> {
  return {
    async resolve(ref: CredentialRef) {
      if (ref === credentialRef(INTERCONNECT_TOKEN_REF) && token !== undefined) {
        return { value: token, source: 'env' }
      }
      return undefined
    },
  }
}

/** Options extending the agent-registry fake beyond plain live sessions. */
interface FakeAgentsOptions {
  /** Sessions reserved to subagent routing; their header carries `origin: 'subagent'`. */
  readonly subagentOwned?: ReadonlySet<string>
  /** Session ids whose header records a `parentSession` (drives the ownership predicate's parent read). */
  readonly parentSessionOf?: Readonly<Record<string, string>>
  /** Ids whose `get` throws, to exercise throwing ownership reads. */
  readonly throwOnGet?: ReadonlySet<string>
  /** The value `get` throws for ids in `throwOnGet`; defaults to an Error. */
  readonly throwOnGetValue?: unknown
  /** Omit the `status` column from `list()` rows. */
  readonly noStatus?: boolean
}

/**
 * Agent registry fake recording deliveries per session; only liveIds resolve an
 * Agent. `methods` records which Agent method each delivery called, because the
 * three delivery modes differ only in that choice.
 */
function fakeAgents(
  deliveries: Map<string, string[]>,
  liveIds: ReadonlySet<string>,
  sources?: Map<string, MessageSource[]>,
  methods?: Map<string, string[]>,
  options: FakeAgentsOptions = {},
) {
  const agentFor = (id: string): Agent => {
    const record = (method: string) => (message: {
      content: readonly { type: 'text'; text: string }[]
      source: MessageSource
    }): void => {
      const texts = deliveries.get(id) ?? []
      for (const block of message.content) texts.push(block.text)
      deliveries.set(id, texts)
      if (sources !== undefined) {
        const recorded = sources.get(id) ?? []
        recorded.push(message.source)
        sources.set(id, recorded)
      }
      if (methods !== undefined) {
        const called = methods.get(id) ?? []
        called.push(method)
        methods.set(id, called)
      }
    }
    const header = options.subagentOwned?.has(id) === true
      ? { origin: 'subagent' }
      : options.parentSessionOf?.[id] === undefined
        ? {}
        : { parentSession: options.parentSessionOf[id] }
    return {
      id,
      session: { id, header },
      followup: record('followup'),
      steer: record('steer'),
      inject: record('inject'),
    } as unknown as Agent
  }
  return {
    get(id: string): Agent | undefined {
      if (options.throwOnGet?.has(id) === true) {
        throw options.throwOnGetValue ?? new Error(`agent registry get threw for ${id}`)
      }
      if (!liveIds.has(id)) return undefined
      return agentFor(id)
    },
    list(): Agent[] {
      return [...liveIds].map(id => ({
        id,
        session: {
          id,
          header: options.subagentOwned?.has(id) === true
            ? { origin: 'subagent' }
            : options.parentSessionOf?.[id] === undefined
              ? {}
              : { parentSession: options.parentSessionOf[id] },
        },
        ...(options.noStatus === true ? {} : { status: 'idle' }),
      }) as unknown as Agent)
    },
    isOwnedBy: () => false,
  }
}

/** Deliver one inbound `msg` frame over a fake socket and return the frames the service wrote. */
async function deliverInbound(service: InterconnectService, message: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { socket, handlers } = fakeSocket()
  attachSocket(service, socket)
  const sentBefore = socket.sent.length
  handlers.get('message')!(JSON.stringify({ type: 'msg', reqId: 'w-1', message }))
  await wait(30)
  return socket.sent.slice(sentBefore).map(text => JSON.parse(text) as Record<string, unknown>)
}

/** Ask one inbound `query list` frame over a fake socket and return the answered frames. */
async function queryList(service: InterconnectService): Promise<Record<string, unknown>[]> {
  const { socket, handlers } = fakeSocket()
  attachSocket(service, socket)
  const sentBefore = socket.sent.length
  handlers.get('message')!(JSON.stringify({ type: 'query', reqId: 'list-1', query: { kind: 'list' } }))
  await wait(30)
  return socket.sent.slice(sentBefore).map(text => JSON.parse(text) as Record<string, unknown>)
}

const SESSION_ID = 'session-1'

/** One event-payload agent carrying only the session identity the service reads. */
const agentPayload = (id: string): { agent: Agent; source: SessionStartSource } => ({
  agent: { id, session: { id, header: {} } } as unknown as Agent,
  source: 'startup',
})


/** One fake WebSocket recording events and captured handlers for direct invocation. */
function fakeSocket(state: { readyState?: number; isAlive?: boolean } = {}): {
  socket: WebSocket & { sent: string[]; isAlive: boolean }
  handlers: Map<string, (...args: unknown[]) => void>
} {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const socket = {
    readyState: state.readyState ?? WebSocket.OPEN,
    isAlive: state.isAlive ?? true,
    sent: [] as string[],
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => { handlers.set(event, cb) }),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => { handlers.set(event, cb) }),
    send: vi.fn((data: string) => { socket.sent.push(data) }),
    terminate: vi.fn(),
    ping: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as WebSocket & { sent: string[]; isAlive: boolean }
  return { socket, handlers }
}

/** Attach a fake socket through the private seam the outbound dial uses. */
function attachSocket(service: InterconnectService, socket: WebSocket & { sent: string[]; isAlive: boolean }): void {
  ;(service as unknown as { attachSocket(s: WebSocket): void }).attachSocket(socket)
}

/** Attach a fake socket as one outbound dialed link for a configured peer. */
function attachDialedSocket(
  service: InterconnectService,
  socket: WebSocket & { sent: string[]; isAlive: boolean },
  peerInstanceId: string,
): void {
  ;(service as unknown as { attachDialedSocket(s: WebSocket, peer: string): void }).attachDialedSocket(socket, peerInstanceId)
}

/** Dial one peer route through the private seam service activation uses. */
function linkRoute(service: InterconnectService, instanceId: string, origin: string): void {
  ;(service as unknown as { link(id: string, origin: string): void }).link(instanceId, origin)
}

/** Close one dialed route through the private route table, simulating fiber teardown. */
function closeRoute(service: InterconnectService, instanceId: string): void {
  const states = (service as unknown as { linkStates: Map<string, { close(): void }> }).linkStates
  const state = states.get(instanceId)
  if (state !== undefined) state.close()
  states.delete(instanceId)
}

interface MountOptions {
  readonly requestTimeoutMs?: number
  readonly agents?: ReturnType<typeof fakeAgents>
  /** Services provided on the root context before the service activates. */
  readonly provides?: Record<string, unknown>
  /** Set false to mount without a `webServer` row (outbound-only mode). */
  readonly webServer?: boolean
}

async function mounted(token?: string, liveIds: ReadonlySet<string> = new Set([SESSION_ID]), peers: Record<string, string> = {}, delivery: DeliveryMode = 'followup', allowResume = true, instanceId = 'test-instance', options: MountOptions = {}): Promise<{
  ctx: Context
  upgrades: WebUpgradeRoute[]
  deliveries: Map<string, string[]>
  sources: Map<string, MessageSource[]>
  methods: Map<string, string[]>
  service: InterconnectService
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const upgrades: WebUpgradeRoute[] = []
  const deliveries = new Map<string, string[]>()
  const sources = new Map<string, MessageSource[]>()
  const methods = new Map<string, string[]>()
  if (options.webServer !== false) {
    ctx.provide('webServer', fakeHttpServer(upgrades) as WebServer)
  }
  ctx.provide('agents', options.agents ?? fakeAgents(deliveries, liveIds, sources, methods))
  ctx.provide('credentials', fakeCredentials(token) as CredentialProvider)
  for (const [serviceName, value] of Object.entries(options.provides ?? {})) {
    ctx.provide(serviceName, value)
  }
  const fiber = ctx.plugin(InterconnectService, {
    instanceId,
    requestTimeoutMs: options.requestTimeoutMs ?? 10000,
    peers,
    delivery,
    allowResume,
  })
  await fiber.await()
  return {
    ctx,
    upgrades,
    deliveries,
    sources,
    methods,
    service: ctx.interconnect,
    dispose: async () => { await fiber.dispose() },
  }
}

/** Serve one upgrade route over a real HTTP server and return its port. */
async function serveUpgrade(
  upgrades: WebUpgradeRoute[],
): Promise<{ port: number; connections: () => Promise<number>; close: () => Promise<void> }> {
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    void upgrades[0]!.handler(req, socket, head)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    connections: () => new Promise<number>((resolve, reject) => {
      server.getConnections((error, count) => { if (error === null) resolve(count); else reject(error) })
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

/** Open a raw WS client to a served upgrade route, collecting incoming frames. */
async function dial(
  port: number,
  token = 'secret',
): Promise<{ client: WebSocket; frames: Record<string, unknown>[]; waitOpen: Promise<void> }> {
  const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const frames: Record<string, unknown>[] = []
  client.on('message', (data) => {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data).toString('utf8')
    frames.push(JSON.parse(text) as Record<string, unknown>)
  })
  const waitOpen = new Promise<void>((resolve, reject) => {
    client.once('open', resolve)
    client.once('error', reject)
  })
  return { client, frames, waitOpen }
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Poll a predicate until it holds or the timeout expires; fails the test on timeout. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    await wait(intervalMs)
  }
}

describe('interconnect host half', () => {
  it('registers the /interconnect/link upgrade route and removes it with the fiber', async () => {
    const { upgrades, dispose } = await mounted('secret')
    expect(upgrades).toHaveLength(1)
    expect(upgrades[0]).toMatchObject({ path: '/interconnect/link' })
    await dispose()
    expect(upgrades).toHaveLength(0)
  })

  it('registers no HTTP prefix route when transport is WS-only', async () => {
    const { upgrades, dispose } = await mounted('secret')
    // Only the upgrade route exists; there is no /interconnect prefix handler.
    expect(upgrades).toHaveLength(1)
    await dispose()
  })

  it('rejects an upgrade without a valid bearer token', async () => {
    const { upgrades, dispose } = await mounted('secret')
    const { port, close } = await serveUpgrade(upgrades)
    // Wrong token: the server rejects the upgrade before accepting the socket.
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
      headers: { authorization: 'Bearer wrong' },
    })
    const err = await new Promise<Error>((resolve) => { client.once('error', resolve) })
    expect(err).toBeDefined()
    client.terminate()
    await close()
    await dispose()
  })
})

describe('interconnect over real WS links', () => {
  it('links a configured peer automatically and delivers a send over the link', async () => {
    const receiver = await mounted('secret', new Set(['R-sess']))
    const r = await serveUpgrade(receiver.upgrades)
    const rUrl = `http://127.0.0.1:${String(r.port)}`
    const sender = await mounted('secret', new Set([]), { 'peer-b': rUrl })
    try {
      await wait(200) // let the auto-link dial + hello land
      const result = await sender.ctx.interconnect.send({
        instanceId: 'peer-b',
        sessionId: 'R-sess',
        text: 'via link',
      })
      expect(result.delivered).toBe(true)
      expect(receiver.deliveries.get('R-sess')).toEqual(['via link'])
    } finally {
      await sender.dispose()
      await r.close()
      await receiver.dispose()
    }
  })

  it('reports unreachable for a send to a peer with no live link (not configured/connected)', async () => {
    const sender = await mounted('secret', new Set([]))
    // No peer route for 'missing' was configured, so no link exists here.
    const result = await sender.ctx.interconnect.send({
      instanceId: 'missing',
      sessionId: 'X-sess',
      text: 'hello',
    })
    expect(result).toMatchObject({ delivered: false, reason: 'unreachable' })
    await sender.dispose()
  })

  it('answers ping and list for a configured peer over the link', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const r = await serveUpgrade(receiver.upgrades)
    const rUrl = `http://127.0.0.1:${String(r.port)}`
    const sender = await mounted('secret', new Set([]), { 'peer-b': rUrl })
    try {
      await wait(200)
      const ping = await sender.ctx.interconnect.ping('peer-b')
      expect(ping?.pong).toBe(true)
      expect(ping?.instance).toBe('test-instance')
      const list = await sender.ctx.interconnect.list('peer-b')
      expect(list?.sessions.map(s => s.sessionId)).toContain(SESSION_ID)
    } finally {
      await sender.dispose()
      await r.close()
      await receiver.dispose()
    }
  })

  it('returns undefined for ping/list to a peer with no live link', async () => {
    const sender = await mounted('secret', new Set([]))
    expect(await sender.ctx.interconnect.ping('missing')).toBeUndefined()
    expect(await sender.ctx.interconnect.list('missing')).toBeUndefined()
    await sender.dispose()
  })

  it('records a sender on an inbound send and replies back over a live link', async () => {
    // B receives a send from A; B then replies to A, which A delivers. Both
    // sides link each other so the reply can flow back.
    const a = await mounted('secret', new Set(['A-sess']), {}, 'followup', true, 'inst-a')
    const aServ = await serveUpgrade(a.upgrades)
    const aUrl = `http://127.0.0.1:${String(aServ.port)}`
    const b = await mounted('secret', new Set(['B-sess']), { 'inst-a': aUrl }, 'followup', true, 'inst-b')
    const bServ = await serveUpgrade(b.upgrades)
    const bUrl = `http://127.0.0.1:${String(bServ.port)}`
    linkRoute(a.ctx.interconnect, 'inst-b', bUrl) // A links back to B
    try {
      await wait(250) // both links dial + hello
      const sent = await b.ctx.interconnect.send({
        instanceId: 'inst-a',
        sessionId: 'A-sess',
        text: 'hi A',
        sender: b.ctx.interconnect.selfSender('B-sess'),
      })
      expect(sent.delivered).toBe(true)
      // A received "hi A"; A's senders recorded B. A replies back to B.
      expect(a.deliveries.get('A-sess')).toEqual(['hi A'])
      const replied = await a.ctx.interconnect.reply({ sessionId: 'A-sess', text: 'hi B' })
      expect(replied.delivered).toBe(true)
      expect(b.deliveries.get('B-sess')).toEqual(['hi B'])
    } finally {
      await b.dispose()
      await bServ.close()
      await aServ.close()
      await a.dispose()
    }
  })

  it('clears a stale reply target when a later message carries no sender', async () => {
    const receiver = await mounted('secret', new Set(['recv-sess']))
    // First, record a sender for the session via a send with identity.
    await deliverInbound(receiver.service, {
      kind: 'send',
      sessionId: 'recv-sess',
      text: 'hi from A',
      sender: { instanceId: 'inst-a', sessionId: 'a-sess' },
    })
    // A later message from an old peer omits the sender: the earlier mapping
    // must not survive, or the reply would go back to A.
    await deliverInbound(receiver.service, { kind: 'send', sessionId: 'recv-sess', text: 'anonymous' })
    const result = await receiver.ctx.interconnect.reply({ sessionId: 'recv-sess', text: 'back' })
    expect(result).toEqual({ delivered: false, instance: 'test-instance', reason: 'no-sender-known' })
    await receiver.dispose()
  })

  it('reports no-sender-known for a reply addressed to a session that recorded none', async () => {
    const receiver = await mounted('secret', new Set(['idle-sess']))
    const result = await receiver.ctx.interconnect.reply({ sessionId: 'idle-sess', text: 'who?' })
    expect(result).toMatchObject({ delivered: false, reason: 'no-sender-known' })
    await receiver.dispose()
  })
})

describe('inbound msg/query frames on a served link', () => {
  it('delivers an inbound msg (send) frame and answers a msg-result on the same socket', async () => {
    const { upgrades, deliveries, dispose } = await mounted('secret', new Set([SESSION_ID]))
    const { port, close } = await serveUpgrade(upgrades)
    const { client, frames, waitOpen } = await dial(port)
    try {
      await waitOpen
      await wait(50) // hello
      client.send(JSON.stringify({
        type: 'msg',
        reqId: 'req-1',
        message: { kind: 'send', sessionId: SESSION_ID, text: 'ws hello' },
      }))
      await wait(80)
      expect(deliveries.get(SESSION_ID)).toEqual(['ws hello'])
      expect(frames).toContainEqual({
        type: 'msg-result',
        reqId: 'req-1',
        result: { delivered: true, instance: 'test-instance', delivery: 'followup' },
      })
    } finally {
      client.terminate()
      await close()
      await dispose()
    }
  })

  it('answers an inbound query ping frame with the instance identity', async () => {
    const { upgrades, dispose } = await mounted('secret', new Set([SESSION_ID]))
    const { port, close } = await serveUpgrade(upgrades)
    const { client, frames, waitOpen } = await dial(port)
    try {
      await waitOpen
      await wait(50)
      client.send(JSON.stringify({ type: 'query', reqId: 'q-1', query: { kind: 'ping' } }))
      await wait(80)
      expect(frames).toContainEqual({
        type: 'query-result',
        reqId: 'q-1',
        result: { pong: true, instance: 'test-instance' },
      })
    } finally {
      client.terminate()
      await close()
      await dispose()
    }
  })

  it('answers an inbound query list frame with live session rows', async () => {
    const { upgrades, dispose } = await mounted('secret', new Set(['s1', 's2']))
    const { port, close } = await serveUpgrade(upgrades)
    const { client, frames, waitOpen } = await dial(port)
    try {
      await waitOpen
      await wait(50)
      client.send(JSON.stringify({ type: 'query', reqId: 'q-2', query: { kind: 'list' } }))
      await wait(80)
      const result = frames.find(f => f.type === 'query-result' && f.reqId === 'q-2') as { result: { sessions: unknown[] } } | undefined
      expect(result?.result.sessions?.map(s => (s as { sessionId: string }).sessionId).sort()).toEqual(['s1', 's2'])
    } finally {
      client.terminate()
      await close()
      await dispose()
    }
  })

  it('announces hello to an authenticated dialer', async () => {
    const { upgrades, dispose } = await mounted('secret', new Set([SESSION_ID]))
    const { port, close } = await serveUpgrade(upgrades)
    const { client, frames, waitOpen } = await dial(port)
    try {
      await waitOpen
      await wait(80)
      expect(frames).toContainEqual({ type: 'hello', sender: 'test-instance' })
    } finally {
      client.terminate()
      await close()
      await dispose()
    }
  })
})

describe('interconnect WebSocket link liveness', () => {
  it('survives a local listener that throws on a peer-pushed event', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const r = await serveUpgrade(receiver.upgrades)
    const rUrl = `http://127.0.0.1:${String(r.port)}`
    const sender = await mounted('secret', new Set([]), { 'peer-b': rUrl })
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtException', onUncaught)
    const warns: string[] = []
    vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation((message: string) => { warns.push(message) })
    // The receiver's interconnect/event listener throws; the pushed event must
    // be contained by the frame handler, not escape as an uncaughtException.
    receiver.ctx.on('interconnect/event', () => { throw new Error('listener exploded') })
    try {
      await waitUntil(async () => (await sender.ctx.interconnect.ping('peer-b'))?.pong === true)
      // A local lifecycle event on the sender fans out to the receiver.
      sender.ctx.emit('agent/created', agentPayload('sender-sess'))
      await waitUntil(() => warns.some(line => line.includes('listener for a agent/created event from')))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      await sender.dispose()
      await r.close()
      await receiver.dispose()
    }
  })
})

describe('interconnect outbound-only mode without a webserver', () => {
  it('activates, dials peers, and delivers over the outbound link', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const r = await serveUpgrade(receiver.upgrades)
    const rUrl = `http://127.0.0.1:${String(r.port)}`
    // No webServer row: the service skips the inbound upgrade registration and
    // still dials the configured peer and delivers outbound.
    const sender = await mounted('secret', new Set([]), { 'peer-o': rUrl }, 'followup', true, 'inst-send', {
      webServer: false,
    })
    try {
      await wait(200)
      const result = await sender.ctx.interconnect.send({
        instanceId: 'peer-o',
        sessionId: SESSION_ID,
        text: 'outbound hello',
      })
      expect(result.delivered).toBe(true)
      expect(result.instance).toBe('test-instance') // the delivering receiver
    } finally {
      await sender.dispose()
      await r.close()
      await receiver.dispose()
    }
  })
})

describe('interconnect config defaults and route lifecycle', () => {
  it('mounts with omitted delivery/allowResume/peers falling back to their defaults', async () => {
    const { dispose } = await mounted('secret', new Set([]), undefined, undefined, undefined, 'defaults-instance')
    await dispose()
  })

})

describe('interconnect lifecycle event fan-out', () => {
  it('fans local lifecycle events out to linked peers, skipping remote subagent/end', async () => {
    const receiver = await mounted('secret', new Set([]), {}, 'followup', true, 'inst-recv')
    const r = await serveUpgrade(receiver.upgrades)
    const rUrl = `http://127.0.0.1:${String(r.port)}`
    const sender = await mounted('secret', new Set([]), { 'peer-b': rUrl }, 'followup', true, 'inst-send')
    const seen: EventNotification[] = []
    receiver.ctx.on('interconnect/event', (notification: EventNotification) => { seen.push(notification) })
    try {
      await wait(200)
      sender.ctx.emit('agent/status', { agent: { session: { id: 's1' } }, status: 'idle' } as never)
      sender.ctx.emit('agent/created', agentPayload('s2'))
      sender.ctx.emit('agent/disposed', { agent: { session: { id: 's3' } } } as never)
      sender.ctx.emit('session/created', { id: 's4', header: {} } as never)
      sender.ctx.emit('session/created', { id: 's5', header: { parentSession: 'p5' } } as never)
      sender.ctx.emit('session/disposed', { id: 's6' } as never)
      sender.ctx.emit('subagent/end', { local: false, provider: 'remote', id: 'c1', stopReason: 'done' } as never)
      sender.ctx.emit('subagent/end', { local: true, provider: 'spawn', id: 'c2', stopReason: 'done' } as never)
      await wait(120)
      expect(seen).toEqual(expect.arrayContaining([
        { kind: 'agent/status', sessionId: 's1', status: 'idle' },
        { kind: 'agent/created', sessionId: 's2' },
        { kind: 'agent/disposed', sessionId: 's3' },
        { kind: 'session/created', sessionId: 's4' },
        { kind: 'session/created', sessionId: 's5', parentSessionId: 'p5' },
        { kind: 'session/disposed', sessionId: 's6' },
        { kind: 'subagent/end', provider: 'spawn', childSessionId: 'c2', stopReason: 'done' },
      ]))
      expect(seen.some(event => event.kind === 'subagent/end' && event.provider === 'remote')).toBe(false)
    } finally {
      await sender.dispose()
      await r.close()
      await receiver.dispose()
    }
  })

  it('sends each lifecycle event once per peer, preferring the link this instance dials', async () => {
    const receiver = await mounted('secret', new Set([]))
    const sockets = (receiver.service as unknown as { sockets: Set<WebSocket> }).sockets
    const events = (socket: { sent: string[] }): string[] => socket.sent.filter(line => line.includes('"type":"event"'))
    const dialed = fakeSocket()
    const inbound = fakeSocket()
    const other = fakeSocket()
    const anonymous = fakeSocket()
    attachDialedSocket(receiver.service, dialed.socket, 'peer-b')
    for (const socket of [inbound, other, anonymous]) attachSocket(receiver.service, socket.socket)
    // The dialed link and an inbound socket both announce peer-b: a
    // bidirectional pair. peer-z is a peer that dialed in, and the last socket
    // announced no identity at all.
    for (const socket of [dialed, inbound]) {
      socket.handlers.get('message')!(JSON.stringify({ type: 'hello', sender: 'peer-b' }))
    }
    other.handlers.get('message')!(JSON.stringify({ type: 'hello', sender: 'peer-z' }))
    receiver.ctx.emit('agent/created', agentPayload('s1'))
    expect(events(dialed.socket)).toHaveLength(1)
    // The inbound duplicate of the dialed peer is skipped, so peer-b still
    // receives the event exactly once, over the link this instance owns.
    expect(events(inbound.socket)).toHaveLength(0)
    // An announced id no dialed link covers, and a socket that announced no
    // identity, both receive the event: an announcement can only suppress a
    // duplicate a controlled link already carries.
    expect(events(other.socket)).toHaveLength(1)
    expect(events(anonymous.socket)).toHaveLength(1)
    expect(sockets.has(dialed.socket)).toBe(true)
    await receiver.dispose()
  })

  it('broadcasts nothing and drops closed sockets when no frame can be delivered', async () => {
    const { ctx, service, dispose } = await mounted('secret', new Set([]))
    try {
      const sockets = (service as unknown as { sockets: Set<WebSocket> }).sockets
      // No live sockets: fan-out returns without sending.
      ctx.emit('agent/created', agentPayload('s1'))
      // A closed socket is dropped instead of written to.
      const closed = fakeSocket({ readyState: WebSocket.CLOSED })
      sockets.add(closed.socket)
      ctx.emit('agent/created', agentPayload('s2'))
      expect(sockets.has(closed.socket)).toBe(false)
      // oxlint-disable-next-line typescript/unbound-method -- fake socket arrow, no `this`
      expect(closed.socket.send).not.toHaveBeenCalled()
    } finally {
      await dispose()
    }
  })
})

describe('interconnect heartbeat sweep', () => {
  it('terminates sockets that stopped answering protocol pings and pings the rest', async () => {
    vi.useFakeTimers()
    const { service, dispose } = await mounted('secret', new Set([]))
    try {
      const sockets = (service as unknown as { sockets: Set<WebSocket> }).sockets
      const dead = fakeSocket({ readyState: WebSocket.OPEN, isAlive: false })
      const alive = fakeSocket({ readyState: WebSocket.OPEN, isAlive: true })
      sockets.add(dead.socket)
      sockets.add(alive.socket)
      vi.advanceTimersByTime(30000)
      // oxlint-disable-next-line typescript/unbound-method -- fake socket arrow, no `this`
      expect(dead.socket.terminate).toHaveBeenCalled()
      expect(sockets.has(dead.socket)).toBe(false)
      // oxlint-disable-next-line typescript/unbound-method -- fake socket arrow, no `this`
      expect(alive.socket.ping).toHaveBeenCalled()
      expect(alive.socket.isAlive).toBe(false)
    } finally {
      vi.useRealTimers()
      await dispose()
    }
  })

  it('skips a socket that closed between sweeps without pinging it', async () => {
    vi.useFakeTimers()
    const { service, dispose } = await mounted('secret', new Set([]))
    try {
      const sockets = (service as unknown as { sockets: Set<WebSocket> }).sockets
      const closed = fakeSocket({ readyState: WebSocket.CLOSED, isAlive: true })
      sockets.add(closed.socket)
      vi.advanceTimersByTime(30000)
      // A non-OPEN socket is dropped from the pool; ping() is never called on
      // it, since ws throws synchronously on a non-OPEN ping.
      // oxlint-disable-next-line typescript/unbound-method -- fake socket arrow, no `this`
      expect(closed.socket.ping).not.toHaveBeenCalled()
      expect(sockets.has(closed.socket)).toBe(false)
    } finally {
      vi.useRealTimers()
      await dispose()
    }
  })
})

describe('interconnect delivery modes and wake', () => {
  it('delivers with steer and inject modes when the sender asks', async () => {
    const { upgrades, methods, dispose } = await mounted('secret', new Set([SESSION_ID]))
    const { port, close } = await serveUpgrade(upgrades)
    const { client, frames, waitOpen } = await dial(port)
    try {
      await waitOpen
      await wait(50)
      client.send(JSON.stringify({
        type: 'msg',
        reqId: 'r1',
        message: { kind: 'send', sessionId: SESSION_ID, text: 'steer now', delivery: 'steer' },
      }))
      client.send(JSON.stringify({
        type: 'msg',
        reqId: 'r2',
        message: { kind: 'send', sessionId: SESSION_ID, text: 'inject now', delivery: 'inject' },
      }))
      await wait(80)
      expect(methods.get(SESSION_ID)).toEqual(['steer', 'inject'])
      expect(frames).toContainEqual({
        type: 'msg-result',
        reqId: 'r1',
        result: { delivered: true, instance: 'test-instance', delivery: 'steer' },
      })
      expect(frames).toContainEqual({
        type: 'msg-result',
        reqId: 'r2',
        result: { delivered: true, instance: 'test-instance', delivery: 'inject' },
      })
    } finally {
      client.terminate()
      await close()
      await dispose()
    }
  })

  it('refuses an inbound send to a not-live session unless resume is requested', async () => {
    const receiver = await mounted('secret', new Set([]))
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'ghost', text: 'hi' })
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: false, instance: 'test-instance', reason: 'session-not-live' },
    })
    await receiver.dispose()
  })

  it('refuses wake when the receiver does not allow it', async () => {
    const receiver = await mounted('secret', new Set([]), {}, 'followup', false)
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'ghost', text: 'hi', resume: true })
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: false, instance: 'test-instance', reason: 'resume-refused' },
    })
    await receiver.dispose()
  })

  it('degrades to session-not-live when no agent lookup exists on the receiver', async () => {
    const receiver = await mounted('secret', new Set([]))
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'ghost', text: 'hi', resume: true })
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: false, instance: 'test-instance', reason: 'session-not-live' },
    })
    await receiver.dispose()
  })

  it('reports resume-failed when the agent lookup resolves nothing', async () => {
    const receiver = await mounted('secret', new Set([]), {}, 'followup', true, 'test-instance', {
      provides: {
        typert: { lookups: { get: () => ({ resolve: async () => undefined }) } },
      },
    })
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'ghost', text: 'hi', resume: true })
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: false, instance: 'test-instance', reason: 'session-not-live' },
    })
    await receiver.dispose()
  })

  it('reports resume-failed when the agent lookup rejects', async () => {
    const receiver = await mounted('secret', new Set([]), {}, 'followup', true, 'test-instance', {
      provides: {
        typert: { lookups: { get: () => ({ resolve: async () => { throw new Error('owner holds it') } }) } },
      },
    })
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'ghost', text: 'hi', resume: true })
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: false, instance: 'test-instance', reason: 'resume-failed' },
    })
    await receiver.dispose()
  })

  it('reports resume-failed when the agent lookup rejects with a non-Error', async () => {
    const receiver = await mounted('secret', new Set([]), {}, 'followup', true, 'test-instance', {
      provides: {
        typert: { lookups: { get: () => ({ resolve: async () => { throw 'plain-string-refusal' } }) } },
      },
    })
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'ghost', text: 'hi', resume: true })
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: false, instance: 'test-instance', reason: 'resume-failed' },
    })
    await receiver.dispose()
  })

  it('maps the Host ownership refusal on the wake path to session-owned-by-subagent', async () => {
    const receiver = await mounted('secret', new Set([]), {}, 'followup', true, 'test-instance', {
      provides: {
        typert: {
          lookups: {
            // Exactly what the Host's `agent` resolver throws for a cold
            // subagent-owned session, where no local header carries ownership.
            get: () => ({
              resolve: async () => {
                throw new RemoteError('session/agent-busy', 'session "ghost" is owned by subagent routing', { reason: 'use subagent delivery for this child session' })
              },
            }),
          },
        },
      },
    })
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'ghost', text: 'hi', resume: true })
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: false, instance: 'test-instance', reason: 'session-owned-by-subagent' },
    })
    await receiver.dispose()
  })

  it('wakes a persisted session when the lookup resolves an agent', async () => {
    const deliveries = new Map<string, string[]>()
    const woken = {
      id: 'ghost',
      session: { id: 'ghost', header: {} },
      followup: (message: { content: readonly { type: 'text'; text: string }[] }) => {
        deliveries.set('ghost', message.content.map(block => block.text))
      },
      steer: () => {},
      inject: () => {},
    }
    const receiver = await mounted('secret', new Set([]), {}, 'followup', true, 'test-instance', {
      provides: {
        typert: { lookups: { get: () => ({ resolve: async () => woken }) } },
      },
    })
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'ghost', text: 'woken hi', resume: true })
    expect(deliveries.get('ghost')).toEqual(['woken hi'])
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: true, instance: 'test-instance', delivery: 'followup' },
    })
    await receiver.dispose()
  })

  it('refuses delivery to a session reserved to subagent routing', async () => {
    const deliveries = new Map<string, string[]>()
    const agents = fakeAgents(deliveries, new Set(['sub-sess']), undefined, undefined, { subagentOwned: new Set(['sub-sess']) })
    const receiver = await mounted('secret', new Set(['sub-sess']), {}, 'followup', true, 'test-instance', { agents })
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: 'sub-sess', text: 'hi' })
    expect(deliveries.get('sub-sess')).toBeUndefined()
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: false, instance: 'test-instance', reason: 'session-owned-by-subagent' },
    })
    await receiver.dispose()
  })

  it('forwards delivery and resume overrides on an outbound send', async () => {
    const sender = await mounted('secret', new Set(['S-sess']), {}, 'followup', true, 'inst-send')
    const sServ = await serveUpgrade(sender.upgrades)
    const sUrl = `http://127.0.0.1:${String(sServ.port)}`
    const receiver = await mounted('secret', new Set(['R-sess']), { 'inst-send': sUrl }, 'followup', true, 'inst-recv')
    const rServ = await serveUpgrade(receiver.upgrades)
    const rUrl = `http://127.0.0.1:${String(rServ.port)}`
    linkRoute(sender.ctx.interconnect, 'inst-recv', rUrl)
    try {
      await wait(250)
      const result = await sender.ctx.interconnect.send({
        instanceId: 'inst-recv',
        sessionId: 'R-sess',
        text: 'urgent',
        sender: sender.ctx.interconnect.selfSender('S-sess'),
        delivery: 'steer',
        resume: true,
      })
      expect(result.delivered).toBe(true)
      expect(receiver.methods.get('R-sess')).toEqual(['steer'])
      // The receiver recalls the recorded sender and replies over its own link.
      const reply = await receiver.ctx.interconnect.reply({
        sessionId: 'R-sess',
        text: 'back',
        delivery: 'inject',
        resume: true,
      })
      expect(reply.delivered).toBe(true)
      expect(sender.methods.get('S-sess')).toEqual(['inject'])
    } finally {
      await sender.dispose()
      await rServ.close()
      await receiver.dispose()
      await sServ.close()
    }
  })

  it('refuses a woken delivery when the service is disposed during the wake', async () => {
    let releaseWake!: () => void
    const wakeGate = new Promise<void>((resolve) => { releaseWake = resolve })
    const receiver = await mounted('secret', new Set([]), {}, 'followup', true, 'test-instance', {
      provides: {
        typert: {
          lookups: {
            get: () => ({ async resolve() { await wakeGate; return { id: 'woken-sess', session: { id: 'woken-sess' } } } }),
          },
        },
      },
    })
    const deliverPromise = (
      receiver.service as unknown as { deliver(payload: Record<string, unknown>): Promise<Record<string, unknown>> }
    ).deliver({ sessionId: 'woken-sess', text: 'wake me', resume: true })
    await wait(20)
    await receiver.dispose()
    releaseWake()
    const result = await deliverPromise
    expect(result).toEqual({ delivered: false, instance: 'test-instance', reason: 'unreachable' })
  })
})

describe('interconnect session listing', () => {
  it('filters subagent-owned sessions and omits absent title/status keys', async () => {
    const deliveries = new Map<string, string[]>()
    const agents = fakeAgents(
      deliveries,
      new Set(['normal', 'sub-sess']),
      undefined,
      undefined,
      { subagentOwned: new Set(['sub-sess']), noStatus: true },
    )
    const receiver = await mounted('secret', new Set(['normal', 'sub-sess']), {}, 'followup', true, 'test-instance', { agents })
    const frames = await queryList(receiver.service)
    expect(frames).toContainEqual({
      type: 'query-result',
      reqId: 'list-1',
      result: { instance: 'test-instance', sessions: [{ sessionId: 'normal' }] },
    })
    await receiver.dispose()
  })

  it('includes the projected title and agent status when available', async () => {
    const receiver = await mounted('secret', new Set(['titled']), {}, 'followup', true, 'test-instance', {
      provides: {
        sessionProjections: { snapshot: () => ({ values: { title: 'My Session' } }) },
      },
    })
    const frames = await queryList(receiver.service)
    expect(frames).toContainEqual({
      type: 'query-result',
      reqId: 'list-1',
      result: { instance: 'test-instance', sessions: [{ sessionId: 'titled', title: 'My Session', status: 'idle' }] },
    })
    await receiver.dispose()
  })

  it('degrades a throwing title projection to an untitled row', async () => {
    const receiver = await mounted('secret', new Set(['broken-title']), {}, 'followup', true, 'test-instance', {
      provides: {
        sessionProjections: { snapshot: () => { throw new Error('projection exploded') } },
      },
    })
    const frames = await queryList(receiver.service)
    expect(frames).toContainEqual({
      type: 'query-result',
      reqId: 'list-1',
      result: { instance: 'test-instance', sessions: [{ sessionId: 'broken-title', status: 'idle' }] },
    })
    await receiver.dispose()
  })

  it('omits empty and non-string title projections', async () => {
    const empty = await mounted('secret', new Set(['empty-title']), {}, 'followup', true, 'test-instance', {
      provides: {
        sessionProjections: { snapshot: () => ({ values: { title: '' } }) },
      },
    })
    const emptyFrames = await queryList(empty.service)
    expect(emptyFrames).toContainEqual({
      type: 'query-result',
      reqId: 'list-1',
      result: { instance: 'test-instance', sessions: [{ sessionId: 'empty-title', status: 'idle' }] },
    })
    await empty.dispose()

    const numeric = await mounted('secret', new Set(['numeric-title']), {}, 'followup', true, 'test-instance', {
      provides: {
        sessionProjections: { snapshot: () => ({ values: { title: 42 } }) },
      },
    })
    const numericFrames = await queryList(numeric.service)
    expect(numericFrames).toContainEqual({
      type: 'query-result',
      reqId: 'list-1',
      result: { instance: 'test-instance', sessions: [{ sessionId: 'numeric-title', status: 'idle' }] },
    })
    await numeric.dispose()
  })
})

describe('interconnect upgrade auth edge paths', () => {
  it('rejects an upgrade when no token is configured', async () => {
    const { upgrades, dispose } = await mounted(undefined)
    const { port, close } = await serveUpgrade(upgrades)
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
      headers: { authorization: 'Bearer anything' },
    })
    const err = await new Promise<Error>((resolve) => { client.once('error', resolve) })
    expect(err).toBeDefined()
    client.terminate()
    await close()
    await dispose()
  })

  it('rejects an upgrade when the configured token is empty', async () => {
    const { upgrades, dispose } = await mounted('')
    const { port, close } = await serveUpgrade(upgrades)
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
      headers: { authorization: 'Bearer anything' },
    })
    const err = await new Promise<Error>((resolve) => { client.once('error', resolve) })
    expect(err).toBeDefined()
    client.terminate()
    await close()
    await dispose()
  })

  it('rejects an upgrade without an authorization header', async () => {
    const { upgrades, dispose } = await mounted('secret')
    const { port, close } = await serveUpgrade(upgrades)
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`)
    const err = await new Promise<Error>((resolve) => { client.once('error', resolve) })
    expect(err).toBeDefined()
    client.terminate()
    await close()
    await dispose()
  })

  it('rejects an upgrade whose token differs only in one character', async () => {
    const { upgrades, dispose } = await mounted('12345678')
    const { port, close } = await serveUpgrade(upgrades)
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
      headers: { authorization: 'Bearer 12345679' },
    })
    const err = await new Promise<Error>((resolve) => { client.once('error', resolve) })
    expect(err).toBeDefined()
    client.terminate()
    await close()
    await dispose()
  })

  it('rejects a multi-byte authorization header without crashing', async () => {
    const { upgrades, dispose } = await mounted('12345678')
    const { port, close } = await serveUpgrade(upgrades)
    // Same UTF-16 length as `Bearer 12345678` but a different UTF-8 byte
    // length: the digest-normalized comparison must reject cleanly, never
    // throw a crypto RangeError that surfaces as an unhandled rejection.
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
      headers: { authorization: 'Bearer 12345ééé' },
    })
    const err = await new Promise<Error>((resolve) => { client.once('error', resolve) })
    expect(err).toBeDefined()
    client.terminate()
    await close()
    await dispose()
  })

  /** Minimal upgrade request/socket pair for driving the route handler directly. */
  function fakeUpgradePair(headers: Record<string, string> = {}): {
    req: IncomingMessage
    socket: { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }
    writes: string[]
  } {
    const writes: string[] = []
    const socket = {
      end: vi.fn((chunk?: string, callback?: () => void) => {
        if (chunk !== undefined) writes.push(chunk)
        callback?.()
      }),
      destroy: vi.fn(),
    }
    return { req: { headers } as unknown as IncomingMessage, socket, writes }
  }

  it('brings a token-less peer link up when the credential arrives later', async () => {
    const receiver = await mounted('secret')
    const r = await serveUpgrade(receiver.upgrades)
    let token: string | undefined
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer([]) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set([SESSION_ID])))
    ctx.provide('credentials', {
      async resolve() {
        return token === undefined ? undefined : { value: token, source: 'env' }
      },
    } as unknown as CredentialProvider)
    // The warn fires from the activation dial, so the spy installs first.
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = ctx.plugin(InterconnectService, {
      instanceId: 'late-token',
      requestTimeoutMs: 10000,
      peers: { 'peer-b': `http://127.0.0.1:${String(r.port)}` },
    })
    await fiber.await()
    try {
      // The first dial resolves no token and must warn once, then retry on the
      // reconnect backoff so a credential added later still links the peer.
      await waitUntil(() => warn.mock.calls.some(([line]) => String(line).includes('no shared token configured')))
      expect(await ctx.interconnect.ping('peer-b')).toBeUndefined()
      token = 'secret'
      await waitUntil(async () => (await ctx.interconnect.ping('peer-b')) !== undefined, 5000)
    } finally {
      warn.mockRestore()
      await fiber.dispose()
      await r.close()
      await receiver.dispose()
    }
  })

  it('refuses an inbound upgrade that resolves its token after teardown', async () => {
    let settleToken!: (value: { value: string; source: string }) => void
    const pendingToken = new Promise<{ value: string; source: string }>((resolve) => { settleToken = resolve })
    const ctx = new Context()
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeHttpServer(upgrades) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set([SESSION_ID])))
    ctx.provide('credentials', { resolve: () => pendingToken } as unknown as CredentialProvider)
    const fiber = ctx.plugin(InterconnectService, { instanceId: 'closing-upgrade', requestTimeoutMs: 10000, peers: {} })
    await fiber.await()
    const { req, socket, writes } = fakeUpgradePair({ authorization: 'Bearer secret' })
    // The route handler is detached by the webserver, so the token read can
    // straddle teardown; accepting then would pool a socket no owner closes.
    void upgrades[0]!.handler(req, socket as never, Buffer.alloc(0))
    await fiber.dispose()
    settleToken({ value: 'secret', source: 'env' })
    await wait(30)
    expect(writes.join('')).toContain('503 Service Unavailable')
    // A refusal closes the socket for real: a client that keeps its own writing
    // side open would otherwise hold the connection after the response.
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('closes the connection of a refused upgrade for a client that stays writable', async () => {
    const receiver = await mounted('secret')
    const served = await serveUpgrade(receiver.upgrades)
    // A raw client that never half-closes its own side. `socket.end()` on the
    // server only sends FIN, which would leave this connection live with its
    // descriptor held; the refusal has to destroy it.
    const client = connect({ host: '127.0.0.1', port: served.port, allowHalfOpen: true })
    try {
      await once(client, 'connect')
      const answered = once(client, 'data')
      client.write(
        'GET /interconnect/link HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${String(served.port)}\r\n`
        + 'Authorization: Bearer wrong-token\r\n'
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      )
      const [chunk] = await answered as [Buffer]
      expect(chunk.toString('utf8')).toContain('401 Unauthorized')
      await waitUntil(async () => (await served.connections()) === 0)
    } finally {
      client.destroy()
      await served.close()
      await receiver.dispose()
    }
  })

  it('formats a non-Error rejection raised while refusing an upgrade', async () => {
    const receiver = await mounted(undefined)
    const { req, socket } = fakeUpgradePair({ authorization: 'Bearer secret' })
    // Refusing a token-less upgrade ends the socket; a throw from that write is
    // not necessarily an Error, and the managed catch still has to report it.
    socket.end.mockImplementation(() => { throw 'socket wedged' })
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    void receiver.upgrades[0]!.handler(req, socket as never, Buffer.alloc(0))
    await waitUntil(() => socket.destroy.mock.calls.length > 0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('socket wedged'))
    warn.mockRestore()
    await receiver.dispose()
  })

  it('logs and destroys the socket when an upgrade fails after authentication', async () => {
    const receiver = await mounted('secret')
    const { req, socket } = fakeUpgradePair({ authorization: 'Bearer secret' })
    // A socket the ws server cannot upgrade makes the detached handler throw;
    // the route's managed catch reports it and drops the client.
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    void receiver.upgrades[0]!.handler(req, socket as never, Buffer.alloc(0))
    await waitUntil(() => socket.destroy.mock.calls.length > 0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('upgrade failed'))
    warn.mockRestore()
    await receiver.dispose()
  })

  it('warns once across the token-less dials the reconnect backoff repeats', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeHttpServer(upgrades) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set([SESSION_ID])))
    let resolveCalls = 0
    ctx.provide('credentials', {
      resolve: () => {
        resolveCalls += 1
        return Promise.resolve(undefined)
      },
    } as unknown as CredentialProvider)
    const fiber = ctx.plugin(InterconnectService, {
      instanceId: 'token-less',
      requestTimeoutMs: 10000,
      peers: { 'peer-b': 'http://127.0.0.1:1' },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const noTokenWarns = (): number =>
      warn.mock.calls.filter(([message]) => String(message).includes('no shared token configured')).length
    try {
      await fiber.await()
      await vi.advanceTimersByTimeAsync(0)
      expect(noTokenWarns()).toBe(1)
      // The backoff re-dials and re-reads the token; the operator has already
      // been told the link is down, so the retry must stay quiet.
      await vi.advanceTimersByTimeAsync(1000)
      expect(resolveCalls).toBe(2)
      expect(noTokenWarns()).toBe(1)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
      await fiber.dispose()
    }
  })

  it('keeps a token-less peer down when the service closes before the token resolves', async () => {
    let settleToken!: (value: undefined) => void
    const pendingToken = new Promise<undefined>((resolve) => { settleToken = resolve })
    let resolveCalls = 0
    const ctx = new Context()
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeHttpServer(upgrades) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set([SESSION_ID])))
    ctx.provide('credentials', {
      resolve: () => {
        resolveCalls += 1
        return pendingToken
      },
    } as unknown as CredentialProvider)
    const fiber = ctx.plugin(InterconnectService, {
      instanceId: 'closing',
      requestTimeoutMs: 10000,
      peers: { 'peer-b': 'http://127.0.0.1:1' },
    })
    await fiber.await()
    // Disposal lands while the token read is still pending, so the dial resumes
    // with no token on a closed service and must stop instead of scheduling a
    // reconnect against a fiber that no longer exists.
    await fiber.dispose()
    settleToken(undefined)
    await wait(30)
    expect(resolveCalls).toBe(1)
  })

  it('fails closed when the token read itself rejects', async () => {
    const throwingCredentials = {
      async resolve() {
        throw new Error('credential store unavailable')
      },
    } as unknown as CredentialProvider
    const ctx = new Context()
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeHttpServer(upgrades) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set([SESSION_ID])))
    ctx.provide('credentials', throwingCredentials)
    const fiber = ctx.plugin(InterconnectService, { instanceId: 'throwing-token', requestTimeoutMs: 10000, peers: {} })
    await fiber.await()
    const { port, close } = await serveUpgrade(upgrades)
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
      headers: { authorization: 'Bearer secret' },
    })
    const err = await new Promise<Error>((resolve) => { client.once('error', resolve) })
    expect(err).toBeDefined()
    client.terminate()
    await close()
    await fiber.dispose()
  })
})

describe('interconnect inbound frame handling on a fake socket', () => {
  it('drops binary frames without touching the socket', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(Buffer.from('not-a-frame'), true) // isBinary=true: ws flags the opcode
    // oxlint-disable-next-line typescript/unbound-method -- fake socket arrow, no `this`
    expect(socket.send).toHaveBeenCalledTimes(1) // only the hello announcement
    await receiver.dispose()
  })

  it('warns and ignores malformed frames', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    handlers.get('message')!('{not json')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    warn.mockRestore()
    await receiver.dispose()
  })

  it('caps a list answer at the row limit the link frame can carry', async () => {
    const live = new Set(Array.from({ length: 120 }, (_unused, index) => `session-${String(index)}`))
    const receiver = await mounted('secret', live)
    try {
      const answers = await queryList(receiver.service)
      const result = answers[0]?.result as { sessions?: unknown[] } | undefined
      expect(result?.sessions).toHaveLength(100)
    } finally {
      await receiver.dispose()
    }
  })

  it('bounds a list answer by the serialized bytes of its rows', async () => {
    const long = 'x'.repeat(20_000)
    const liveIds = Array.from({ length: 100 }, (_unused, index) => `session-${String(index)}`)
    const receiver = await mounted('secret', new Set(liveIds), {}, 'followup', true, 'test-instance', {
      provides: {
        sessionProjections: {
          snapshot: (session: { id: string }) => ({ values: { title: `${session.id}:${long}` } }),
        },
      },
    })
    try {
      const answers = await queryList(receiver.service)
      expect(Buffer.byteLength(JSON.stringify(answers[0]), 'utf8')).toBeLessThan(1024 * 1024)
      const rows = (answers[0]?.result as { sessions: { sessionId: string; title?: string }[] }).sessions
      // A title that does not fit is dropped before its row is, so the listing
      // stays a prefix of the live order and never exceeds the frame cap.
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThanOrEqual(100)
      expect(rows.map(row => row.sessionId)).toEqual(liveIds.slice(0, rows.length))
      expect(rows.some(row => row.title === undefined)).toBe(true)
    } finally {
      await receiver.dispose()
    }
  })

  it('keeps the complete answer inside the frame cap for the longest request id and instance id it accepts', async () => {
    const long = 'x'.repeat(20_000)
    const liveIds = Array.from({ length: 100 }, (_unused, index) => `session-${String(index)}`)
    // Both the request id the answer echoes and this instance's own id are part
    // of the frame, so the row budget has to be measured against them rather
    // than reserved with a constant.
    const instanceId = `inst-${'i'.repeat(5000)}`
    const receiver = await mounted('secret', new Set(liveIds), {}, 'followup', true, instanceId, {
      provides: {
        sessionProjections: {
          snapshot: (session: { id: string }) => ({ values: { title: `${session.id}:${long}` } }),
        },
      },
    })
    try {
      const { socket, handlers } = fakeSocket()
      attachSocket(receiver.service, socket)
      const sentBefore = socket.sent.length
      const reqId = `q-${'r'.repeat(254)}`
      handlers.get('message')!(JSON.stringify({ type: 'query', reqId, query: { kind: 'list' } }))
      await wait(30)
      const frames = socket.sent.slice(sentBefore).map(text => JSON.parse(text) as Record<string, unknown>)
      expect(frames).toHaveLength(1)
      expect(Buffer.byteLength(JSON.stringify(frames[0]), 'utf8')).toBeLessThanOrEqual(1024 * 1024)
      // The measured budget still lists as many rows as fit, so the bound
      // truncates the listing instead of emptying it.
      const rows = (frames[0]?.result as { sessions: unknown[] }).sessions
      expect(rows.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(JSON.stringify(frames[0]), 'utf8')).toBeGreaterThan(1024 * 1024 - 20_000)
    } finally {
      await receiver.dispose()
    }
  })

  it('drops a request whose id exceeds the identifier bound instead of echoing it into an over-cap answer', async () => {
    const long = 'x'.repeat(20_000)
    const liveIds = Array.from({ length: 100 }, (_unused, index) => `session-${String(index)}`)
    const receiver = await mounted('secret', new Set(liveIds), {}, 'followup', true, 'test-instance', {
      provides: {
        sessionProjections: {
          snapshot: (session: { id: string }) => ({ values: { title: `${session.id}:${long}` } }),
        },
      },
    })
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const { socket, handlers } = fakeSocket()
      attachSocket(receiver.service, socket)
      const sentBefore = socket.sent.length
      handlers.get('message')!(JSON.stringify({ type: 'query', reqId: `q-${'r'.repeat(8192)}`, query: { kind: 'list' } }))
      await wait(30)
      expect(socket.sent.slice(sentBefore)).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    } finally {
      warn.mockRestore()
      await receiver.dispose()
    }
  })

  it('does not answer a list request whose envelope alone exceeds the frame cap', async () => {
    // An instance id larger than the link cap makes even an empty answer
    // unsendable; writing one would make the peer's ws drop the link.
    const receiver = await mounted('secret', new Set([SESSION_ID]), {}, 'followup', true, 'i'.repeat(1024 * 1024 + 1))
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const { socket, handlers } = fakeSocket()
      attachSocket(receiver.service, socket)
      const sentBefore = socket.sent.length
      handlers.get('message')!(JSON.stringify({ type: 'query', reqId: 'list-1', query: { kind: 'list' } }))
      await wait(30)
      expect(socket.sent.slice(sentBefore)).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot fit the link frame cap'))
    } finally {
      warn.mockRestore()
      await receiver.dispose()
    }
  })

  it('counts a multibyte title by its serialized bytes', async () => {
    // 200k code points, 600 KB once serialized as UTF-8.
    const long = '解'.repeat(200_000)
    const receiver = await mounted('secret', new Set(['cjk-1', 'cjk-2', 'cjk-3']), {}, 'followup', true, 'test-instance', {
      provides: {
        sessionProjections: {
          snapshot: (session: { id: string }) => ({ values: { title: `${session.id}:${long}` } }),
        },
      },
    })
    try {
      const answers = await queryList(receiver.service)
      expect(Buffer.byteLength(JSON.stringify(answers[0]), 'utf8')).toBeLessThan(1024 * 1024)
      const rows = (answers[0]?.result as { sessions: { title?: string }[] }).sessions
      // One 600 KB title fits; a character-count budget would have admitted all
      // three into a frame the peer's maxPayload closes the link over.
      expect(rows).toHaveLength(3)
      expect(rows[0]?.title).toBeDefined()
      expect(rows.slice(1).every(row => row.title === undefined)).toBe(true)
    } finally {
      await receiver.dispose()
    }
  })

  it('drops a title that does not fit from a row without a status', async () => {
    const long = 'x'.repeat(20_000)
    const liveIds = Array.from({ length: 100 }, (_unused, index) => `nostatus-${String(index)}`)
    const agents = fakeAgents(new Map(), new Set(liveIds), undefined, undefined, { noStatus: true })
    const receiver = await mounted('secret', new Set(liveIds), {}, 'followup', true, 'test-instance', {
      agents,
      provides: {
        sessionProjections: {
          snapshot: (session: { id: string }) => ({ values: { title: `${session.id}:${long}` } }),
        },
      },
    })
    try {
      const answers = await queryList(receiver.service)
      expect(Buffer.byteLength(JSON.stringify(answers[0]), 'utf8')).toBeLessThan(1024 * 1024)
      const rows = (answers[0]?.result as { sessions: { title?: string; status?: string }[] }).sessions
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.some(row => row.title === undefined)).toBe(true)
      expect(rows.every(row => row.status === undefined)).toBe(true)
    } finally {
      await receiver.dispose()
    }
  })

  it('ends the listing when a row does not fit even without its title', async () => {
    const receiver = await mounted('secret', new Set([`huge-${'x'.repeat(1_100_000)}`]))
    try {
      const answers = await queryList(receiver.service)
      expect(answers[0]?.result).toEqual({ instance: 'test-instance', sessions: [] })
    } finally {
      await receiver.dispose()
    }
  })

  it('drops an event frame whose notification is missing or null', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    // `notification: null` and `{type:'event'}` (missing key) both fail the
    // required wire schema and must be dropped, not crash the handler.
    handlers.get('message')!(JSON.stringify({ type: 'event', notification: null }))
    handlers.get('message')!(JSON.stringify({ type: 'event' }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    expect(socket.sent.length).toBe(1) // only the hello announcement
    warn.mockRestore()
    await receiver.dispose()
  })

  it('drops an oversized link frame before parsing it', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    handlers.get('message')!(Buffer.alloc(1024 * 1024 + 1))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping oversized link frame'))
    warn.mockRestore()
    await receiver.dispose()
  })

  it('answers a query frame delivered as an array of buffers', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const sentBefore = socket.sent.length
    // ws hands fragmented deliveries to the same listener as an array; the
    // size cap and the decode must read every part.
    const text = JSON.stringify({ type: 'query', reqId: 'arr-1', query: { kind: 'list' } })
    const split = Math.floor(text.length / 2)
    handlers.get('message')!([Buffer.from(text.slice(0, split)), Buffer.from(text.slice(split))], false)
    await wait(30)
    expect(socket.sent.slice(sentBefore).map(frame => JSON.parse(frame) as Record<string, unknown>))
      .toEqual([expect.objectContaining({ type: 'query-result', reqId: 'arr-1' })])
    await receiver.dispose()
  })

  it('answers a query frame delivered as a raw ArrayBuffer', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const sentBefore = socket.sent.length
    // A configured binaryType delivers frames as ArrayBuffers rather than Buffers.
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'query', reqId: 'buf-1', query: { kind: 'list' } }))
    handlers.get('message')!(bytes.buffer, false)
    await wait(30)
    expect(socket.sent.slice(sentBefore).map(frame => JSON.parse(frame) as Record<string, unknown>))
      .toEqual([expect.objectContaining({ type: 'query-result', reqId: 'buf-1' })])
    await receiver.dispose()
  })

  it('attributes an event frame to the socket-announced peer', async () => {
    const receiver = await mounted('secret', new Set([]))
    const seen: { notification: EventNotification; peer: string }[] = []
    receiver.ctx.on('interconnect/event', (notification: EventNotification, peer: string) => {
      seen.push({ notification, peer })
    })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'hello', sender: 'announced-peer' }))
    handlers.get('message')!(JSON.stringify({ type: 'event', notification: { kind: 'agent/created', sessionId: 's1' } }))
    expect(seen).toEqual([{ notification: { kind: 'agent/created', sessionId: 's1' }, peer: 'announced-peer' }])
    await receiver.dispose()
  })

  it('attributes an event frame from a silent socket to unknown-peer', async () => {
    const receiver = await mounted('secret', new Set([]))
    const seen: string[] = []
    receiver.ctx.on('interconnect/event', (_notification: EventNotification, peer: string) => { seen.push(peer) })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'event', notification: { kind: 'agent/created', sessionId: 's1' } }))
    expect(seen).toEqual(['unknown-peer'])
    await receiver.dispose()
  })

  it('contains a throwing event listener instead of crashing the process', async () => {
    const receiver = await mounted('secret', new Set([]))
    const warns: string[] = []
    vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation((message: string) => { warns.push(message) })
    receiver.ctx.on('interconnect/event', () => { throw new Error('listener exploded') })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'event', notification: { kind: 'agent/created', sessionId: 's1' } }))
    await waitUntil(() => warns.some(line => line.includes('listener for a agent/created event')))
    await receiver.dispose()
  })

  it('renders a non-Error listener throw as a string', async () => {
    const receiver = await mounted('secret', new Set([]))
    const warns: string[] = []
    vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation((message: string) => { warns.push(message) })
    receiver.ctx.on('interconnect/event', () => { throw 'plain-string-boom' })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'event', notification: { kind: 'agent/created', sessionId: 's1' } }))
    await waitUntil(() => warns.some(line => line.includes('plain-string-boom')))
    await receiver.dispose()
  })

  it('contains an event listener that rejects asynchronously', async () => {
    const receiver = await mounted('secret', new Set([]))
    const warns: string[] = []
    vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation((message: string) => { warns.push(message) })
    // `ctx.emit` would leave this rejection unhandled; the service dispatches
    // through `ctx.parallel` so the failure is logged like a synchronous throw.
    receiver.ctx.on(
      'interconnect/event',
      // oxlint-disable-next-line typescript/no-misused-promises -- the listener's rejected promise is exactly the case under test.
      async () => { throw new Error('async listener exploded') },
    )
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'event', notification: { kind: 'agent/created', sessionId: 's1' } }))
    await waitUntil(() => warns.some(line => line.includes('async listener exploded')))
    await receiver.dispose()
  })

  it('ignores msg-result and query-result frames for unknown request ids', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'msg-result', reqId: 'nope', result: { delivered: true, instance: 'x' } }))
    handlers.get('message')!(JSON.stringify({ type: 'query-result', reqId: 'nope', result: { pong: true, instance: 'x' } }))
    // oxlint-disable-next-line typescript/unbound-method -- fake socket arrow, no `this`
    expect(socket.send).toHaveBeenCalledTimes(1) // only the hello announcement
    await receiver.dispose()
  })

  it('answers an inbound ping query frame', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'query', reqId: 'q-1', query: { kind: 'ping' } }))
    await wait(30)
    expect(socket.sent).toContain(JSON.stringify({
      type: 'query-result',
      reqId: 'q-1',
      result: { pong: true, instance: 'test-instance' },
    }))
    await receiver.dispose()
  })

  it('answers an inbound event query while containing a throwing listener', async () => {
    const receiver = await mounted('secret', new Set([]))
    const warns: string[] = []
    vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation((message: string) => { warns.push(message) })
    receiver.ctx.on('interconnect/event', () => { throw new Error('query listener exploded') })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({
      type: 'query',
      reqId: 'q-2',
      query: { kind: 'event', notification: { kind: 'agent/created', sessionId: 's1' } },
    }))
    // The listener failure is contained inside the event dispatch, so the
    // query still lands its ack and the handler itself never throws.
    await waitUntil(() => warns.some(line => line.includes('query listener exploded')))
    expect(warns.some(line => line.includes('query q-2 handler threw'))).toBe(false)
    expect(socket.sent).toContainEqual(JSON.stringify({
      type: 'query-result',
      reqId: 'q-2',
      result: { accepted: true },
    }))
    await receiver.dispose()
  })

  it('reports unreachable when the inbound msg handler throws', async () => {
    const deliveries = new Map<string, string[]>()
    const agents = fakeAgents(
      deliveries,
      new Set(['boom-sess']),
      undefined,
      undefined,
      { parentSessionOf: { 'boom-sess': 'parent-boom' }, throwOnGet: new Set(['parent-boom']) },
    )
    const receiver = await mounted('secret', new Set(['boom-sess']), {}, 'followup', true, 'test-instance', { agents })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    // A parent-session lookup that throws makes the ownership predicate throw
    // inside deliver(); the frame handler must answer unreachable, not crash.
    handlers.get('message')!(JSON.stringify({ type: 'msg', reqId: 'm-1', message: { kind: 'send', sessionId: 'boom-sess', text: 'hi' } }))
    await wait(30)
    expect(socket.sent).toContain(JSON.stringify({
      type: 'msg-result',
      reqId: 'm-1',
      result: { delivered: false, instance: 'test-instance', reason: 'unreachable' },
    }))
    await receiver.dispose()
  })

  it('does not answer a msg frame on a closed socket', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const { socket, handlers } = fakeSocket({ readyState: WebSocket.CLOSED })
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'msg', reqId: 'm-2', message: { kind: 'send', sessionId: SESSION_ID, text: 'hi' } }))
    await wait(30)
    expect(receiver.deliveries.get(SESSION_ID)).toEqual(['hi'])
    expect(socket.sent).not.toContain(JSON.stringify({
      type: 'msg-result',
      reqId: 'm-2',
      result: { delivered: true, instance: 'test-instance', delivery: 'followup' },
    }))
    await receiver.dispose()
  })

  it('removes a socket from the pool on close and on error', async () => {
    const receiver = await mounted('secret', new Set([]))
    const sockets = (receiver.service as unknown as { sockets: Set<WebSocket> }).sockets
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    expect(sockets.has(socket)).toBe(true)
    handlers.get('close')!()
    expect(sockets.has(socket)).toBe(false)
    const errored = fakeSocket()
    attachSocket(receiver.service, errored.socket)
    expect(sockets.has(errored.socket)).toBe(true)
    errored.handlers.get('error')!()
    expect(sockets.has(errored.socket)).toBe(false)
    await receiver.dispose()
  })

  it('drops a query-result frame whose result key is missing', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    handlers.get('message')!(JSON.stringify({ type: 'query-result', reqId: 'q-1' }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    expect(socket.sent.length).toBe(1) // only the hello announcement
    warn.mockRestore()
    await receiver.dispose()
  })

  it('drops a query-result frame whose result has no ping/list/accepted shape', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    handlers.get('message')!(JSON.stringify({ type: 'query-result', reqId: 'q-1', result: { instance: 'x' } }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    expect(socket.sent.length).toBe(1)
    warn.mockRestore()
    await receiver.dispose()
  })

  it('drops a msg-result frame whose reason is outside the failure vocabulary', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    handlers.get('message')!(JSON.stringify({ type: 'msg-result', reqId: 'm-1', result: { delivered: false, instance: 'x', reason: 'unknown-reason' } }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    expect(socket.sent.length).toBe(1)
    warn.mockRestore()
    await receiver.dispose()
  })

  it('drops a frame whose type discriminant is missing', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    // A sender-only object must not be read as the hello variant: `type` is
    // required on every frame.
    handlers.get('message')!(JSON.stringify({ sender: 'x' }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    expect(socket.sent.length).toBe(1)
    warn.mockRestore()
    await receiver.dispose()
  })

  it('drops a query frame whose query is an empty object', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    // `kind` is required on every query variant; an empty query must not fall
    // through to the event branch and dereference a missing notification.
    handlers.get('message')!(JSON.stringify({ type: 'query', reqId: 'q-1', query: {} }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    expect(socket.sent.length).toBe(1)
    warn.mockRestore()
    await receiver.dispose()
  })
})

describe('interconnect outbound reply timeouts', () => {
  it('answers unreachable when the recalled sender has no live link', async () => {
    const receiver = await mounted('secret', new Set(['recv-sess']), {}, 'followup', true, 'test-instance')
    await deliverInbound(receiver.service, {
      kind: 'send',
      sessionId: 'recv-sess',
      text: 'hi',
      sender: { instanceId: 'inst-send', sessionId: 'send-sess' },
    })
    // No peer link named 'inst-send' exists: msgRequest resolves undefined and
    // reply reports unreachable without a timeout.
    const result = await receiver.ctx.interconnect.reply({ sessionId: 'recv-sess', text: 'back' })
    expect(result).toEqual({ delivered: false, instance: 'inst-send', reason: 'unreachable' })
    await receiver.dispose()
  })

  it('normalizes an unanswered reply to unreachable', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    const address = wss.address() as AddressInfo
    const receiver = await mounted('secret', new Set(['recv-sess']), { 'inst-send': `http://127.0.0.1:${String(address.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 100 })
    try {
      // Record a sender for the local session, then reply over the silent link.
      await deliverInbound(receiver.service, {
        kind: 'send',
        sessionId: 'recv-sess',
        text: 'hi',
        sender: { instanceId: 'inst-send', sessionId: 'send-sess' },
      })
      await wait(250)
      const result = await receiver.ctx.interconnect.reply({ sessionId: 'recv-sess', text: 'back' })
      expect(result).toEqual({ delivered: false, instance: 'inst-send', reason: 'unreachable' })
    } finally {
      await receiver.dispose()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })
})

describe('interconnect outbound timeouts', () => {
  it('rejects an unanswered outbound send after the request timeout', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    const address = wss.address() as AddressInfo
    const sender = await mounted('secret', new Set([]), { 'silent-peer': `http://127.0.0.1:${String(address.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 100 })
    try {
      await wait(250) // link opens; the raw server never answers frames
      const result = await sender.ctx.interconnect.send({
        instanceId: 'silent-peer',
        sessionId: 'R-sess',
        text: 'hello?',
      })
      expect(result).toEqual({ delivered: false, instance: 'silent-peer', reason: 'unreachable' })
    } finally {
      await sender.dispose()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })
})

describe('interconnect dial and teardown edge paths', () => {
  it('falls back to defaults when config keys are omitted', async () => {
    const ctx = new Context()
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeHttpServer(upgrades) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set()))
    ctx.provide('credentials', fakeCredentials('secret') as CredentialProvider)
    const fiber = ctx.plugin(InterconnectService, { instanceId: 'defaults-instance' } as never)
    await fiber.await()
    await fiber.dispose()
  })

  it('dials an https origin with a wss protocol', async () => {
    const sender = await mounted('secret', new Set([]), { 'https-peer': 'https://127.0.0.1:1' })
    try {
      // The wss dial to a closed port fails and schedules reconnection.
      expect(await sender.ctx.interconnect.ping('https-peer')).toBeUndefined()
      await wait(1100)
    } finally {
      await sender.dispose()
    }
  })

  it('stops an in-flight dial when the link is closed mid-token-read', async () => {
    const delayedCredentials = {
      async resolve() {
        await new Promise<void>(resolve => setTimeout(resolve, 300))
        return { value: 'secret', source: 'env' }
      },
    } as unknown as CredentialProvider
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer([]) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set()))
    ctx.provide('credentials', delayedCredentials)
    const fiber = ctx.plugin(InterconnectService, {
      instanceId: 'slow-token',
      requestTimeoutMs: 10000,
      peers: { 'peer-b': 'http://127.0.0.1:1' },
    })
    await fiber.await()
    closeRoute(ctx.interconnect, 'peer-b')
    await wait(400) // the resolving token lands after close; the dial stops
    await fiber.dispose()
  })

  it('stops the reconnect loop when the token read rejects after close', async () => {
    const delayedRejectCredentials = {
      async resolve() {
        await new Promise<void>(resolve => setTimeout(resolve, 300))
        throw 'credential store unavailable'
      },
    } as unknown as CredentialProvider
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer([]) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set()))
    ctx.provide('credentials', delayedRejectCredentials)
    const fiber = ctx.plugin(InterconnectService, {
      instanceId: 'slow-reject',
      requestTimeoutMs: 10000,
      peers: { 'peer-b': 'http://127.0.0.1:1' },
    })
    await fiber.await()
    closeRoute(ctx.interconnect, 'peer-b')
    await wait(400) // the rejecting token lands after close; no reconnect is scheduled
    await fiber.dispose()
  })

  it('fails an upgrade closed when the token read rejects with a non-Error', async () => {
    const throwingCredentials = {
      async resolve() {
        throw 'credential store unavailable'
      },
    } as unknown as CredentialProvider
    const ctx = new Context()
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeHttpServer(upgrades) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set([SESSION_ID])))
    ctx.provide('credentials', throwingCredentials)
    const fiber = ctx.plugin(InterconnectService, {
      instanceId: 'string-token',
      requestTimeoutMs: 10000,
      peers: { 'peer-b': 'http://127.0.0.1:1' },
    })
    await fiber.await()
    const { port, close } = await serveUpgrade(upgrades)
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
      headers: { authorization: 'Bearer secret' },
    })
    const err = await new Promise<Error>((resolve) => { client.once('error', resolve) })
    expect(err).toBeDefined()
    client.terminate()
    await close()
    await fiber.dispose()
  })

  it('schedules reconnection when a peer link drops and answers sends unreachable', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    const address = wss.address() as AddressInfo
    const sender = await mounted('secret', new Set([]), { 'peer-b': `http://127.0.0.1:${String(address.port)}` })
    try {
      await wait(200) // the link dials and opens against the raw server
      // Kill the server and its sockets: the sender's link closes and reconnects.
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
      await wait(1300) // the 1s backoff retry fires once against the dead origin
      const result = await sender.ctx.interconnect.send({ instanceId: 'peer-b', sessionId: 'R-sess', text: 'x' })
      expect(result).toMatchObject({ delivered: false, reason: 'unreachable' })
    } finally {
      await sender.dispose() // close() observes a pending reconnect timer
    }
  })
})

describe('interconnect inbound reply frames and socket liveness', () => {
  it('marks a socket alive on pong', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    socket.isAlive = false
    handlers.get('pong')!()
    expect(socket.isAlive).toBe(true)
    await receiver.dispose()
  })

  it('renders a non-Error msg handler failure as a string', async () => {
    const deliveries = new Map<string, string[]>()
    const agents = fakeAgents(deliveries, new Set(['boom-sess']), undefined, undefined, {
      parentSessionOf: { 'boom-sess': 'parent-boom' },
      throwOnGet: new Set(['parent-boom']),
      throwOnGetValue: 'plain-string-boom',
    })
    const receiver = await mounted('secret', new Set(['boom-sess']), {}, 'followup', true, 'test-instance', { agents })
    const warns: string[] = []
    vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation((message: string) => { warns.push(message) })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'msg', reqId: 'm-3', message: { kind: 'send', sessionId: 'boom-sess', text: 'hi' } }))
    await wait(30)
    expect(warns.some(line => line.includes('plain-string-boom'))).toBe(true)
    await receiver.dispose()
  })

  it('reports a query handler failure instead of letting it escape the socket', async () => {
    const agents = {
      ...fakeAgents(new Map(), new Set()),
      list: (): never => { throw new Error('agent listing exploded') },
    }
    const receiver = await mounted('secret', new Set(), {}, 'followup', true, 'test-instance', { agents })
    const warns: string[] = []
    vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation((message: string) => { warns.push(message) })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'query', reqId: 'q-3', query: { kind: 'list' } }))
    await waitUntil(() => warns.some(line => line.includes('query q-3 handler threw: agent listing exploded')))
    await receiver.dispose()
  })

  it('renders a non-Error query handler failure as a string', async () => {
    const agents = {
      ...fakeAgents(new Map(), new Set()),
      list: (): never => { throw 'plain-string-query-boom' },
    }
    const receiver = await mounted('secret', new Set(), {}, 'followup', true, 'test-instance', { agents })
    const warns: string[] = []
    vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation((message: string) => { warns.push(message) })
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    handlers.get('message')!(JSON.stringify({ type: 'query', reqId: 'q-4', query: { kind: 'list' } }))
    await waitUntil(() => warns.some(line => line.includes('query q-4 handler threw: plain-string-query-boom')))
    await receiver.dispose()
  })
})

describe('interconnect frame field defaults', () => {
  it('delivers a send frame without a sender identity', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]), {}, 'followup', true, 'test-instance')
    const frames = await deliverInbound(receiver.service, { kind: 'send', sessionId: SESSION_ID, text: 'anonymous' })
    expect(receiver.deliveries.get(SESSION_ID)).toEqual(['anonymous'])
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: true, instance: 'test-instance', delivery: 'followup' },
    })
    await receiver.dispose()
  })
})

describe('interconnect query-result answer validation', () => {
  /** Raw server answering every inbound query frame with one canned result. */
  async function answeringPeer(answer: Record<string, unknown>): Promise<{ port: number; close: () => Promise<void> }> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data).toString('utf8')
        const frame = JSON.parse(text) as { type: string; reqId: string }
        if (frame.type === 'query') {
          socket.send(JSON.stringify({ type: 'query-result', reqId: frame.reqId, result: answer }))
        }
      })
    })
    const address = wss.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      }),
    }
  }

  it('answers undefined when a peer answers a list query with a ping-shaped result', async () => {
    const peer = await answeringPeer({ pong: true, instance: 'liar' })
    const sender = await mounted('secret', new Set([]), { 'lying-peer': `http://127.0.0.1:${String(peer.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 100 })
    try {
      await wait(250)
      const result = await sender.ctx.interconnect.list('lying-peer')
      expect(result).toBeUndefined()
    } finally {
      await sender.dispose()
      await peer.close()
    }
  })

  it('answers undefined when a peer answers a ping query with a list-shaped result', async () => {
    const peer = await answeringPeer({ instance: 'liar', sessions: [] })
    const sender = await mounted('secret', new Set([]), { 'lying-peer': `http://127.0.0.1:${String(peer.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 100 })
    try {
      await wait(250)
      const result = await sender.ctx.interconnect.ping('lying-peer')
      expect(result).toBeUndefined()
    } finally {
      await sender.dispose()
      await peer.close()
    }
  })

  it('answers undefined when a peer returns a list row that is not a session', async () => {
    // The union admits a ping-shaped payload for a list request, and its object
    // resolver merges unknown keys, so a `sessions` array of nulls would pass a
    // mere Array.isArray check and then throw in the consumer.
    const peer = await answeringPeer({ pong: true, instance: 'liar', sessions: [null] })
    const sender = await mounted('secret', new Set([]), { 'lying-peer': `http://127.0.0.1:${String(peer.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 100 })
    try {
      await wait(250)
      const result = await sender.ctx.interconnect.list('lying-peer')
      expect(result).toBeUndefined()
    } finally {
      await sender.dispose()
      await peer.close()
    }
  })

  it('answers undefined when a peer returns a result with no ping/list shape', async () => {
    const peer = await answeringPeer({ instance: 'x' })
    const sender = await mounted('secret', new Set([]), { 'lying-peer': `http://127.0.0.1:${String(peer.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 100 })
    try {
      await wait(250)
      const result = await sender.ctx.interconnect.list('lying-peer')
      expect(result).toBeUndefined()
    } finally {
      await sender.dispose()
      await peer.close()
    }
  })

  it('answers undefined when a peer never answers a ping', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    const address = wss.address() as AddressInfo
    const sender = await mounted('secret', new Set([]), { 'silent-peer': `http://127.0.0.1:${String(address.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 100 })
    try {
      await wait(250)
      const result = await sender.ctx.interconnect.ping('silent-peer')
      expect(result).toBeUndefined()
    } finally {
      await sender.dispose()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })

  it('settles an in-flight send as unreachable when the service is disposed', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    const address = wss.address() as AddressInfo
    const sender = await mounted('secret', new Set([]), { 'silent-peer': `http://127.0.0.1:${String(address.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 10000 })
    try {
      await wait(250) // link opens; the raw server never answers frames
      const sendPromise = sender.ctx.interconnect.send({ instanceId: 'silent-peer', sessionId: 'R-sess', text: 'hello?' })
      await wait(50)
      await sender.dispose()
      const result = await sendPromise
      expect(result).toEqual({ delivered: false, instance: 'silent-peer', reason: 'unreachable' })
    } finally {
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })
})

describe('interconnect dial and origin validation', () => {
  it('fails loudly when a configured peer origin is not a URL', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer([]) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set()))
    ctx.provide('credentials', fakeCredentials('secret') as CredentialProvider)
    const fiber = ctx.plugin(InterconnectService, { instanceId: 'bad-origin', requestTimeoutMs: 10000, peers: { bad: 'not a url' } })
    await expect(fiber.await()).rejects.toThrow()
  })

  it('fails loudly when a peer origin maps to a non-WebSocket protocol', async () => {
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer([]) as WebServer)
    ctx.provide('agents', fakeAgents(new Map(), new Set()))
    ctx.provide('credentials', fakeCredentials('secret') as CredentialProvider)
    const fiber = ctx.plugin(InterconnectService, { instanceId: 'bad-proto', requestTimeoutMs: 10000, peers: { bad: 'ftp://example.com' } })
    await expect(fiber.await()).rejects.toThrow()
  })

  it('keeps a route with an invalid origin down without throwing', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    linkRoute(receiver.service, 'bad-peer', 'not a url')
    await wait(50)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid peer origin'))
    const result = await receiver.ctx.interconnect.ping('bad-peer')
    expect(result).toBeUndefined()
    warn.mockRestore()
    await receiver.dispose()
  })

  it('refuses a delivery that outlives the service fiber', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    await receiver.dispose()
    const result = await (
      receiver.service as unknown as { deliver(payload: Record<string, unknown>): Promise<Record<string, unknown>> }
    ).deliver({
      sessionId: SESSION_ID,
      text: 'too late',
    })
    expect(result).toEqual({ delivered: false, instance: 'test-instance', reason: 'unreachable' })
  })
})

describe('interconnect link URL mapping', () => {
  it('maps an http origin to a ws link URL', () => {
    expect(linkUrl('http://127.0.0.1:13080').href).toBe('ws://127.0.0.1:13080/interconnect/link')
  })

  it('maps an https origin to a wss link URL', () => {
    expect(linkUrl('https://example.com').href).toBe('wss://example.com/interconnect/link')
  })

  it('preserves an explicit wss origin instead of downgrading it', () => {
    expect(linkUrl('wss://example.com:4430').href).toBe('wss://example.com:4430/interconnect/link')
  })

  it('preserves an explicit ws origin', () => {
    expect(linkUrl('ws://example.com').href).toBe('ws://example.com/interconnect/link')
  })

  it('throws on an origin that is not a URL', () => {
    expect(() => linkUrl('not a url')).toThrow()
  })

  it('throws on a non-WebSocket protocol origin', () => {
    expect(() => linkUrl('ftp://example.com')).toThrow(/unsupported peer origin protocol/)
  })
})

describe('interconnect sender identity validation', () => {
  it('treats a partial wire sender as no sender', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    // A sender with only instanceId passes the lenient wire schema but must
    // not become a reply target: reply needs both fields.
    const frames = await deliverInbound(receiver.service, {
      kind: 'send',
      sessionId: SESSION_ID,
      text: 'partial sender',
      sender: { instanceId: 'inst-x' },
    })
    expect(receiver.deliveries.get(SESSION_ID)).toEqual(['partial sender'])
    expect(frames).toContainEqual({
      type: 'msg-result',
      reqId: 'w-1',
      result: { delivered: true, instance: 'test-instance', delivery: 'followup' },
    })
    const reply = await receiver.ctx.interconnect.reply({ sessionId: SESSION_ID, text: 'back' })
    expect(reply).toEqual({ delivered: false, instance: 'test-instance', reason: 'no-sender-known' })
    await receiver.dispose()
  })

  it('treats a non-object direct sender as no sender', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const result = await (
      receiver.service as unknown as { deliver(payload: Record<string, unknown>): Promise<Record<string, unknown>> }
    ).deliver({ sessionId: SESSION_ID, text: 'garbage sender', sender: 'garbage' })
    expect(result).toEqual({ delivered: true, instance: 'test-instance', delivery: 'followup' })
    expect(receiver.deliveries.get(SESSION_ID)).toEqual(['garbage sender'])
    await receiver.dispose()
  })
})

describe('interconnect result frame typing', () => {
  it('does not settle a query with a mis-typed msg-result frame', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data).toString('utf8')
        const frame = JSON.parse(text) as { type: string; reqId: string }
        if (frame.type === 'query') {
          // Answer the query with the WRONG frame type; the pending must not
          // be settled by it, so the list call times out to undefined.
          socket.send(JSON.stringify({ type: 'msg-result', reqId: frame.reqId, result: { delivered: true, instance: 'x' } }))
        }
      })
    })
    const address = wss.address() as AddressInfo
    const sender = await mounted('secret', new Set([]), { 'mis-typing-peer': `http://127.0.0.1:${String(address.port)}` }, 'followup', true, 'test-instance', { requestTimeoutMs: 100 })
    try {
      await wait(250)
      const result = await sender.ctx.interconnect.list('mis-typing-peer')
      expect(result).toBeUndefined()
    } finally {
      await sender.dispose()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })
})

describe('interconnect explicit null wire fields', () => {
  it('reads a null optional field as absent', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    const address = wss.address() as AddressInfo
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data).toString('utf8')
        const frame = JSON.parse(text) as { type: string; reqId: string }
        // A peer written against JSON's absent-value convention sends `null`
        // for a field it has no value for instead of omitting the key.
        if (frame.type === 'msg') {
          socket.send(JSON.stringify({
            type: 'msg-result',
            reqId: frame.reqId,
            result: { delivered: true, instance: 'null-peer', delivery: null },
          }))
        } else if (frame.type === 'query') {
          socket.send(JSON.stringify({
            type: 'query-result',
            reqId: frame.reqId,
            result: { instance: 'null-peer', sessions: [{ sessionId: 'peer-sess', title: null, status: null }] },
          }))
        }
      })
    })
    const sender = await mounted('secret', new Set([]), { 'null-peer': `http://127.0.0.1:${String(address.port)}` })
    try {
      await wait(250) // link opens before either request goes out
      expect(await sender.ctx.interconnect.send({ instanceId: 'null-peer', sessionId: 'peer-sess', text: 'hi' }))
        .toEqual({ delivered: true, instance: 'null-peer' })
      expect(await sender.ctx.interconnect.list('null-peer'))
        .toEqual({ instance: 'null-peer', sessions: [{ sessionId: 'peer-sess' }] })
    } finally {
      await sender.dispose()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })

  it('drops the fields an answer branch does not declare', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    const address = wss.address() as AddressInfo
    let answered = 0
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data).toString('utf8')
        const frame = JSON.parse(text) as { type: string; reqId: string }
        if (frame.type !== 'msg') return
        answered += 1
        // The failure branch keeps whatever the success branch's `delivery`
        // field carried, and the success branch keeps a stray `reason` or an
        // unknown key, because the union merges every branch's keys.
        const result = answered === 1
          ? { delivered: false, instance: 'stray-peer', reason: 'unreachable', delivery: 'steer', junk: 1 }
          : { delivered: true, instance: 'stray-peer', reason: 123, junk: 1 }
        socket.send(JSON.stringify({ type: 'msg-result', reqId: frame.reqId, result }))
      })
    })
    const sender = await mounted('secret', new Set([]), { 'stray-peer': `http://127.0.0.1:${String(address.port)}` })
    try {
      await wait(250) // link opens before either request goes out
      expect(await sender.ctx.interconnect.send({ instanceId: 'stray-peer', sessionId: 'peer-sess', text: 'first' }))
        .toEqual({ delivered: false, instance: 'stray-peer', reason: 'unreachable' })
      expect(await sender.ctx.interconnect.send({ instanceId: 'stray-peer', sessionId: 'peer-sess', text: 'second' }))
        .toEqual({ delivered: true, instance: 'stray-peer' })
    } finally {
      await sender.dispose()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })

  it('drops the fields a query answer kind does not declare', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { wss.once('listening', resolve) })
    const address = wss.address() as AddressInfo
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data).toString('utf8')
        const frame = JSON.parse(text) as { type: string; reqId: string; query?: { kind?: string } }
        if (frame.type !== 'query') return
        // The union merges keys across its branches, so a ping answer can carry
        // a `sessions` list and a list answer the `accepted` ack.
        socket.send(JSON.stringify({
          type: 'query-result',
          reqId: frame.reqId,
          result: frame.query?.kind === 'ping'
            ? { pong: true, instance: 'stray-peer', sessions: [{ sessionId: 'junk' }] }
            : {
              instance: 'stray-peer',
              accepted: true,
              sessions: [{ sessionId: 'peer-sess', title: 'T', status: 'idle', junk: 1 }],
            },
        }))
      })
    })
    const sender = await mounted('secret', new Set([]), { 'stray-peer': `http://127.0.0.1:${String(address.port)}` })
    try {
      await wait(250) // link opens before either request goes out
      expect(await sender.ctx.interconnect.ping('stray-peer')).toEqual({ pong: true, instance: 'stray-peer' })
      expect(await sender.ctx.interconnect.list('stray-peer'))
        .toEqual({ instance: 'stray-peer', sessions: [{ sessionId: 'peer-sess', title: 'T', status: 'idle' }] })
    } finally {
      await sender.dispose()
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })
})

describe('interconnect msg-result discriminant schema', () => {
  it('drops a failed msg-result frame that omits the reason', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    handlers.get('message')!(JSON.stringify({ type: 'msg-result', reqId: 'm-1', result: { delivered: false, instance: 'x' } }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    expect(socket.sent.length).toBe(1)
    warn.mockRestore()
    await receiver.dispose()
  })

  it('accepts a successful msg-result frame without a delivery mode', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    handlers.get('message')!(JSON.stringify({ type: 'msg-result', reqId: 'm-1', result: { delivered: true, instance: 'x' } }))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    warn.mockRestore()
    await receiver.dispose()
  })
})

describe('interconnect socket pool cleanup', () => {
  it('removes the terminated socket from the live pool when the route closes', async () => {
    const receiver = await mounted('secret', new Set([SESSION_ID]))
    const serv = await serveUpgrade(receiver.upgrades)
    const sender = await mounted('secret', new Set([]))
    const pool = (sender.service as unknown as { sockets: Set<WebSocket> }).sockets
    const url = `http://127.0.0.1:${String(serv.port)}`
    try {
      linkRoute(sender.ctx.interconnect, 'peer-p', url)
      await waitUntil(() => pool.size === 1)
      closeRoute(sender.ctx.interconnect, 'peer-p')
      // The pool-cleanup handler must survive the close, or the heartbeat
      // would ping() a terminated socket.
      await waitUntil(() => pool.size === 0)
    } finally {
      await sender.dispose()
      await receiver.dispose()
      await serv.close()
    }
  })
})

describe('interconnect malformed frame handling', () => {
  it('drops a JSON null frame without crashing', async () => {
    const receiver = await mounted('secret', new Set([]))
    const { socket, handlers } = fakeSocket()
    attachSocket(receiver.service, socket)
    const warn = vi.spyOn(receiver.ctx.logger, 'warn').mockImplementation(() => {})
    // schemastery passes a JSON null through the frame union untouched; the
    // handler must reject it instead of dereferencing null.
    handlers.get('message')!(Buffer.from('null'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping malformed link frame'))
    expect(socket.sent.length).toBe(1)
    warn.mockRestore()
    await receiver.dispose()
  })
})
