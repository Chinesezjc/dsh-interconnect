/** Host half: bearer-auth boundary, envelope dispatch, and peer-session delivery. */
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import InterconnectService, { INTERCONNECT_CHANNEL, INTERCONNECT_TOKEN_REF } from '../src/interconnect/index.ts'
import type { DeliveryMode, EventNotification } from '../src/interconnect/index.ts'
import WebSocket from 'ws'

/** Structural httpServer fake recording the route and upgrade registries this service touches. */
function fakeHttpServer(routes: WebRoute[], upgrades: WebUpgradeRoute[]): Pick<WebServer, 'register' | 'registerUpgrade'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
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
 * three delivery modes differ only in that choice — a fake that aliases them to
 * one recorder cannot observe the mode at all.
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
        followup: record('followup'),
        steer: record('steer'),
        inject: record('inject'),
      } as unknown as Agent
    },
  }
}

/** Bodyless POST with headers, or a JSON POST with a body. */
function fakeRequest(init: { url: string; headers: Record<string, string>; body?: unknown }): IncomingMessage {
  const body = init.body === undefined ? null : JSON.stringify(init.body)
  const stream = Readable.from(body === null ? [] : [Buffer.from(body)])
  return Object.assign(stream, {
    url: init.url,
    method: 'POST',
    headers: {
      ...(body === null ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  }) as unknown as IncomingMessage
}

/** Response recorder compatible with this service's writeHead/end sequence. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writeHead(value: number) { state.status = value; return this },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value as string))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

const SESSION_ID = 'session-1'

function envelope(method: string, payload: unknown) {
  return { type: 'client-request', rpcId: 'rpc-1', method, payload }
}

async function mounted(token?: string, liveIds: ReadonlySet<string> = new Set([SESSION_ID]), peers: string[] = [], delivery: DeliveryMode = 'followup'): Promise<{
  ctx: Context
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  deliveries: Map<string, string[]>
  sources: Map<string, MessageSource[]>
  methods: Map<string, string[]>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  const deliveries = new Map<string, string[]>()
  const sources = new Map<string, MessageSource[]>()
  const methods = new Map<string, string[]>()
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  ctx.provide('agents', fakeAgents(deliveries, liveIds, sources, methods))
  ctx.provide('credentials', fakeCredentials(token) as CredentialProvider)
  const fiber = ctx.plugin(InterconnectService, { instanceId: 'test-instance', requestTimeoutMs: 10000, peers, delivery })
  await fiber.await()
  return {
    ctx,
    routes,
    upgrades,
    deliveries,
    sources,
    methods,
    dispose: async () => { await fiber.dispose() },
  }
}

describe('interconnect host half', () => {
  it('registers the /interconnect prefix route and removes it with the fiber', async () => {
    const { routes, dispose } = await mounted('secret')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: INTERCONNECT_CHANNEL })
    await dispose()
    expect(routes).toHaveLength(0)
  })

  it('fails closed when the token is unconfigured', async () => {
    const { routes, dispose } = await mounted(undefined)
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ url: `${INTERCONNECT_CHANNEL}/ping`, headers: { authorization: 'Bearer whatever' } }),
      response,
    )
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('rejects a missing or wrong bearer token before any envelope dispatch', async () => {
    const { routes, dispose } = await mounted('secret')
    for (const authorization of [undefined, 'Bearer wrong', 'secret', '']) {
      const { response, state } = fakeResponse()
      const headers: Record<string, string> = authorization === undefined ? {} : { authorization }
      await routes[0]!.handler(
        fakeRequest({ url: `${INTERCONNECT_CHANNEL}/ping`, headers, body: {} }),
        response,
      )
      expect(state.status).toBe(401)
      expect(state.body).toBe('unauthorized')
    }
    await dispose()
  })

  it('answers ping for an authenticated caller', async () => {
    const { routes, dispose } = await mounted('secret')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/ping`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('ping', {}),
      }),
      response,
    )
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body!)).toMatchObject({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { pong: true, instance: 'test-instance' } },
    })
    await dispose()
  })

  it('attributes a delivered message to the plugin, never to the human user', async () => {
    const { routes, sources, dispose } = await mounted('secret')
    const { response } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: SESSION_ID, text: 'hello peer' }),
      }),
      response,
    )
    const recorded = sources.get(SESSION_ID)
    expect(recorded).toHaveLength(1)
    // A receiving agent must be able to tell a cross-instance handoff from text
    // the local operator typed, so `kind: 'user'` is specifically wrong here.
    expect(recorded![0]).toEqual({
      kind: 'plugin',
      plugin: 'dsh-interconnect',
      form: 'notice',
      summary: 'interconnect handoff delivered on instance test-instance',
    })
    await dispose()
  })

  it('delivers a send into the target live session and reports it', async () => {
    const { routes, deliveries, dispose } = await mounted('secret')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: SESSION_ID, text: 'hello peer' }),
      }),
      response,
    )
    expect(deliveries.get(SESSION_ID)).toEqual(['hello peer'])
    expect(JSON.parse(state.body!)).toMatchObject({
      result: { ok: true, value: { delivered: true, instance: 'test-instance' } },
    })
    await dispose()
  })

  it('delivers via inject instead of followup when delivery is inject', async () => {
    const { routes, deliveries, methods, dispose } = await mounted('secret', new Set([SESSION_ID]), [], 'inject')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: SESSION_ID, text: 'quiet inject' }),
      }),
      response,
    )
    expect(deliveries.get(SESSION_ID)).toEqual(['quiet inject'])
    // Assert the method, not just the text: all three modes deliver the same
    // text and differ only in which Agent method they call.
    expect(methods.get(SESSION_ID)).toEqual(['inject'])
    expect(JSON.parse(state.body!)).toMatchObject({
      result: { ok: true, value: { delivered: true, delivery: 'inject' } },
    })
    await dispose()
  })

  it('delivers via steer when the configured default is steer', async () => {
    const { routes, methods, dispose } = await mounted('secret', new Set([SESSION_ID]), [], 'steer')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: SESSION_ID, text: 'cut in' }),
      }),
      response,
    )
    expect(methods.get(SESSION_ID)).toEqual(['steer'])
    expect(JSON.parse(state.body!)).toMatchObject({
      result: { ok: true, value: { delivered: true, delivery: 'steer' } },
    })
    await dispose()
  })

  it('lets one message override the configured mode and steer into a running turn', async () => {
    // Configured default is followup; the message asks for steer.
    const { routes, methods, dispose } = await mounted('secret')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: SESSION_ID, text: 'urgent', delivery: 'steer' }),
      }),
      response,
    )
    expect(methods.get(SESSION_ID)).toEqual(['steer'])
    expect(JSON.parse(state.body!)).toMatchObject({
      result: { ok: true, value: { delivered: true, delivery: 'steer' } },
    })
    await dispose()
  })

  it('falls back to the configured mode when a message omits the override', async () => {
    const { routes, methods, dispose } = await mounted('secret', new Set([SESSION_ID]), [], 'inject')
    const { response } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: SESSION_ID, text: 'no override' }),
      }),
      response,
    )
    expect(methods.get(SESSION_ID)).toEqual(['inject'])
    await dispose()
  })

  it('rejects an unknown delivery mode instead of delivering it', async () => {
    const { routes, methods, deliveries, dispose } = await mounted('secret')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: SESSION_ID, text: 'bad mode', delivery: 'cancel' }),
      }),
      response,
    )
    // An unvalidated mode would reach a method lookup on Agent, so the envelope
    // must fail before any delivery happens.
    expect(methods.get(SESSION_ID)).toBeUndefined()
    expect(deliveries.get(SESSION_ID)).toBeUndefined()
    expect(JSON.parse(state.body!)).toMatchObject({
      result: { ok: false },
    })
    await dispose()
  })

  it('reports not delivered for an absent session without throwing', async () => {
    const { routes, deliveries, dispose } = await mounted('secret')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: 'missing', text: 'hello' }),
      }),
      response,
    )
    expect(JSON.parse(state.body!)).toMatchObject({
      result: { ok: true, value: { delivered: false } },
    })
    expect(deliveries.size).toBe(0)
    await dispose()
  })

  it('rejects a malformed send payload as an internal error', async () => {
    const { routes, dispose } = await mounted('secret')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/send`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('send', { sessionId: 42 }),
      }),
      response,
    )
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body!)).toMatchObject({
      result: { ok: false, error: { code: 'internal' } },
    })
    await dispose()
  })

  it('404s an unknown endpoint and a non-POST method', async () => {
    const { routes, dispose } = await mounted('secret')
    for (const url of [`${INTERCONNECT_CHANNEL}/nope`, '/other/ping']) {
      const { response, state } = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ url, headers: { authorization: 'Bearer secret' }, body: envelope('nope', {}) }),
        response,
      )
      expect(state.status).toBe(404)
    }
    await dispose()
  })
})

describe('interconnect event notification', () => {
  /** Fire one local agent/status event with a fake agent carrying the session id. */
  function emitAgentStatus(ctx: Context, sessionId: string, status: 'idle' | 'running'): void {
    const agent = {
      id: SessionId(sessionId),
      session: { id: SessionId(sessionId), header: {} },
    } as Agent
    ctx.emit('agent/status', { agent, status })
  }

  it('emits interconnect/event locally for an authenticated inbound event', async () => {
    const { ctx, routes, dispose } = await mounted('secret')
    const received: [EventNotification, string][] = []
    ctx.on('interconnect/event', (notification, sender) => { received.push([notification, sender]) })

    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/event`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('event', {
          sender: 'peer-instance',
          notification: { kind: 'agent/status', sessionId: 's-1', status: 'running' },
        }),
      }),
      response,
    )
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body!)).toMatchObject({ result: { ok: true, value: { accepted: true } } })
    expect(received).toEqual([[
      { kind: 'agent/status', sessionId: 's-1', status: 'running' },
      'peer-instance',
    ]])
    await dispose()
  })

  it('rejects a malformed inbound event payload as internal error', async () => {
    const { routes, dispose } = await mounted('secret')
    const { response, state } = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({
        url: `${INTERCONNECT_CHANNEL}/event`,
        headers: { authorization: 'Bearer secret' },
        body: envelope('event', { sender: 'peer', notification: { kind: 'nope' } }),
      }),
      response,
    )
    expect(JSON.parse(state.body!)).toMatchObject({ result: { ok: false, error: { code: 'internal' } } })
    await dispose()
  })

  it('fans local events out to configured peers over real HTTP', async () => {
    // The receiving peer is a bare HTTP server capturing what reaches /interconnect/event.
    const received: unknown[] = []
    const peerServer = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        if (request.url?.startsWith(`${INTERCONNECT_CHANNEL}/event`)) {
          received.push(JSON.parse(Buffer.concat(chunks).toString()))
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { accepted: true } } }))
      })
    })
    await new Promise<void>(resolve => peerServer.listen(0, '127.0.0.1', resolve))
    const peerPort = (peerServer.address() as AddressInfo).port
    const peerUrl = `http://127.0.0.1:${String(peerPort)}`

    const { ctx, dispose } = await mounted('secret', new Set([SESSION_ID]), [peerUrl])
    try {
      emitAgentStatus(ctx, SESSION_ID, 'running')
      // The fan-out is fire-and-forget; give the in-flight POST a moment to land.
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        method: 'event',
        payload: {
          sender: 'test-instance',
          notification: { kind: 'agent/status', sessionId: SESSION_ID, status: 'running' },
        },
      })
    } finally {
      await dispose()
      await new Promise<void>((resolve, reject) => {
        peerServer.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
  })
})

describe('interconnect over a real HTTP server', () => {
  async function serve(routes: WebRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void routes[0]!.handler(request, response)
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

  it('round-trips an authenticated ping over real HTTP', async () => {
    const { routes, dispose } = await mounted('secret')
    const { port, close } = await serve(routes)
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}${INTERCONNECT_CHANNEL}/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        body: JSON.stringify(envelope('ping', {})),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        result: { ok: true, value: { pong: true, instance: 'test-instance' } },
      })
    } finally {
      await close()
      await dispose()
    }
  })
})

describe('interconnect WebSocket link', () => {
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

  it('registers one /interconnect/link upgrade route and removes it with the fiber', async () => {
    const { upgrades, dispose } = await mounted('secret')
    expect(upgrades).toHaveLength(1)
    expect(upgrades[0]).toMatchObject({ path: '/interconnect/link' })
    await dispose()
    expect(upgrades).toHaveLength(0)
  })

  it('announces hello to an authenticated dialer and receives its event frames', async () => {
    const { ctx, upgrades, dispose } = await mounted('secret')
    const { port, close } = await serveUpgrade(upgrades)
    const received: [EventNotification, string][] = []
    ctx.on('interconnect/event', (notification, sender) => { received.push([notification, sender]) })

    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`, {
      headers: { authorization: 'Bearer secret' },
    })
    const frames: unknown[] = []
    client.on('message', (data: import('ws').RawData) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8')
      frames.push(JSON.parse(text))
    })
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    // The server announces its identity over the link.
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(frames).toContainEqual({ type: 'hello', sender: 'test-instance' })

    // Client announces its identity, then pushes an event; the server attributes
    // the event to the announced peer.
    client.send(JSON.stringify({ type: 'hello', sender: 'dialer-x' }))
    client.send(JSON.stringify({ type: 'event', notification: { kind: 'agent/status', sessionId: 's-1', status: 'running' } }))
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(received).toEqual([[
      { kind: 'agent/status', sessionId: 's-1', status: 'running' },
      'dialer-x',
    ]])

    client.terminate()
    await close()
    await dispose()
  })

  it('rejects an upgrade without a valid bearer token', async () => {
    const { upgrades, dispose } = await mounted('secret')
    const { port, close } = await serveUpgrade(upgrades)
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}/interconnect/link`)
    const err = new Promise<Error>((resolve) => { client.once('error', resolve) })
    await err
    client.terminate()
    await close()
    await dispose()
  })
})
