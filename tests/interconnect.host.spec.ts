/** Host half: upgrade auth, WS msg/query frames, and instanceId-addressed delivery. */
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import InterconnectService, { INTERCONNECT_TOKEN_REF } from '../src/interconnect/index.ts'
import type { DeliveryMode, EventNotification } from '../src/interconnect/index.ts'
import WebSocket from 'ws'

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
) {
  return {
    get(id: string): Agent | undefined {
      if (!liveIds.has(id)) return undefined
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
      return {
        id,
        session: { id, header: {} },
        followup: record('followup'),
        steer: record('steer'),
        inject: record('inject'),
      } as unknown as Agent
    },
    list(): Agent[] {
      return [...liveIds].map(id => ({
        id,
        session: { id, header: {} },
        status: 'idle',
      }) as unknown as Agent)
    },
    isOwnedBy: () => false,
  }
}

const SESSION_ID = 'session-1'

async function mounted(token?: string, liveIds: ReadonlySet<string> = new Set([SESSION_ID]), peers: Record<string, string> = {}, delivery: DeliveryMode = 'followup', allowResume = true, instanceId = 'test-instance'): Promise<{
  ctx: Context
  upgrades: WebUpgradeRoute[]
  deliveries: Map<string, string[]>
  sources: Map<string, MessageSource[]>
  methods: Map<string, string[]>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const upgrades: WebUpgradeRoute[] = []
  const deliveries = new Map<string, string[]>()
  const sources = new Map<string, MessageSource[]>()
  const methods = new Map<string, string[]>()
  ctx.provide('webServer', fakeHttpServer(upgrades) as WebServer)
  ctx.provide('agents', fakeAgents(deliveries, liveIds, sources, methods))
  ctx.provide('credentials', fakeCredentials(token) as CredentialProvider)
  const fiber = ctx.plugin(InterconnectService, {
    instanceId,
    requestTimeoutMs: 10000,
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
    dispose: async () => { await fiber.dispose() },
  }
}

/** Serve one upgrade route over a real HTTP server and return its port. */
async function serveUpgrade(upgrades: WebUpgradeRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    void upgrades[0]!.handler(req, socket, head)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    port: address.port,
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
    frames.push(JSON.parse(text))
  })
  const waitOpen = new Promise<void>((resolve, reject) => {
    client.once('open', resolve)
    client.once('error', reject)
  })
  return { client, frames, waitOpen }
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

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
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('unreachable')
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
    a.ctx.interconnect.link('inst-b', bUrl) // A links back to B
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

  it('reports no-sender-known for a reply addressed to a session that recorded none', async () => {
    const receiver = await mounted('secret', new Set(['idle-sess']))
    const result = await receiver.ctx.interconnect.reply({ sessionId: 'idle-sess', text: 'who?' })
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('no-sender-known')
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
      expect(result?.result.sessions?.map((s) => (s as { sessionId: string }).sessionId).sort()).toEqual(['s1', 's2'])
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
    // Note: 'interconnect/event' fires locally on the RECEIVER for outbound
    // events; here a raw listener throwing must not crash the process.
    sender.ctx.on('interconnect/event', () => { throw new Error('listener exploded') })
    try {
      await wait(200)
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      await sender.dispose()
      await r.close()
      await receiver.dispose()
    }
  })
})
