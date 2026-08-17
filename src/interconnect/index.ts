/**
 * Cross-instance message handoff service: inbound half owns one HTTP route on
 * the host webserver and delivers authenticated messages into live sessions;
 * outbound half POSTs the same wire shape to a peer instance.
 *
 * Transport is deliberately NOT the Connection RPC channel: that registry's
 * handler sees only `(endpoint, payload, signal)` and the trust fence is the
 * DNS-rebinding `trustedHosts` check, neither of which carries the shared-key
 * `Authorization` header this service authenticates on. Owning a plain HTTP
 * route keeps bearer-token auth at the boundary where the header is readable
 * and fails closed when the token is unconfigured.
 * @module @deepseek-ai/dsh-interconnect
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  clientRequestSchema,
  serverResponseSchema,
  RpcId,
  type RpcError,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import WebSocket, { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import {
  INTERCONNECT_CHANNEL,
  INTERCONNECT_TOKEN_REF,
  type Config,
  type DeliveryMode,
  type EventNotification,
  type EventPayload,
  type LinkFrame,
  type ListResult,
  type PingResult,
  type SendPayload,
  type SendResult,
  type SendRequest,
  type SessionSummary,
  type WebSocketLinkHandle,
} from './types.ts'

export type * from './types.ts'
export { INTERCONNECT_CHANNEL, INTERCONNECT_TOKEN_REF } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    interconnect: InterconnectService
  }
  interface Events {
    /**
     * A remote peer instance pushed one authenticated lifecycle notification
     * into this instance. Payload is the exact {@link EventNotification} that
     * crossed the wire; listeners may react but must not block the HTTP ack.
     */
    'interconnect/event'(notification: EventNotification, peer: string): void
  }
}

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
/** Headroom for the request body so a malicious sender cannot pin the process. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

/** `source.plugin` for messages this service splices into a local inbox. */
const PLUGIN_SOURCE = 'dsh-interconnect'

/** WebSocket upgrade pathname owning the persistent peer link. */
const LINK_CHANNEL = '/interconnect/link'

/** Wire union for the discriminated EventNotification fact (shared by HTTP and WS). */
const notificationSchema = z.union([
  z.object({ kind: z.const('agent/created'), sessionId: z.string() }),
  z.object({ kind: z.const('agent/disposed'), sessionId: z.string() }),
  z.object({ kind: z.const('agent/status'), sessionId: z.string(), status: z.union([z.const('idle'), z.const('running')]) }),
  z.object({ kind: z.const('session/created'), sessionId: z.string(), parentSessionId: z.string() }),
  z.object({ kind: z.const('session/disposed'), sessionId: z.string() }),
  z.object({ kind: z.const('subagent/end'), provider: z.string(), childSessionId: z.string(), stopReason: z.string() }),
])

/** Wire union for one WebSocket link text frame. */
const linkFrameSchema = z.union([
  z.object({ type: z.const('hello'), sender: z.string() }),
  z.object({ type: z.const('event'), notification: notificationSchema }),
])

/**
 * Wire union the send endpoint expects inside the ClientRequest payload slot.
 * `delivery` is optional and constrained to the same three names the config
 * accepts, so an unknown mode fails the envelope instead of reaching a method
 * lookup on `Agent`.
 */
const sendPayloadSchema = z.object({
  sessionId: z.string(),
  text: z.string(),
  delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]),
})

/** Wire union the event endpoint expects — sender identity wrapping a discriminated fact. */
const eventPayloadSchema = z.object({
  sender: z.string(),
  notification: notificationSchema,
})

/**
 * Live cross-instance handoff service, registered as `ctx.interconnect`.
 * Requires the host webserver, the live agent registry, and the credential
 * store; activation is availability-driven like every other host service.
 */
export class InterconnectService extends Service {
  static inject = ['webServer', 'agents', 'credentials']
  static Config: z<Config> = z.object({
    instanceId: z.string().default('dsh'),
    requestTimeoutMs: z.natural().max(60000).default(10000),
    peers: z.array(z.string()).default([]),
    delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]).default('followup'),
  })

  private readonly instanceId: string
  private readonly requestTimeoutMs: number
  private readonly delivery: DeliveryMode
  private readonly peers = new Set<string>()
  private readonly subscriptions: (() => void)[] = []
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly sockets = new Set<WebSocket>()
  private readonly linkStates = new Map<string, LinkState>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  /** Peer identity each live socket announced via its `hello` frame, if any. */
  private readonly peerOf = new WeakMap<WebSocket, string>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'interconnect')
    this.instanceId = config.instanceId
    this.requestTimeoutMs = config.requestTimeoutMs
    this.delivery = config.delivery ?? 'followup'
    for (const peer of config.peers ?? []) this.peers.add(trimBase(peer))

    const route: WebRoute = {
      kind: 'prefix',
      path: INTERCONNECT_CHANNEL,
      handler: (req, res) => this.handle(req, res),
    }
    ctx.effect(() => ctx.webServer.register(route), 'interconnect: /interconnect route')

    const upgrade: WebUpgradeRoute = {
      path: LINK_CHANNEL,
      handler: (req, socket, head) => { void this.handleUpgrade(req, socket, head) },
    }
    ctx.effect(() => ctx.webServer.registerUpgrade(upgrade), 'interconnect: /interconnect/link websocket')

    // Liveness sweep: terminate sockets that stopped answering protocol pings.
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.sockets) {
        if ((socket as WebSocket & { isAlive?: boolean }).isAlive === false) {
          socket.terminate()
          this.sockets.delete(socket)
          continue
        }
        ;(socket as WebSocket & { isAlive?: boolean }).isAlive = false
        socket.ping()
      }
    }, 30000)

    this.subscriptions.push(ctx.on('agent/status', ({ agent, status }) => {
      this.fanout({ kind: 'agent/status', sessionId: String(agent.session.id), status })
    }))
    this.subscriptions.push(ctx.on('agent/created', ({ agent }) => {
      this.fanout({ kind: 'agent/created', sessionId: String(agent.session.id) })
    }))
    this.subscriptions.push(ctx.on('agent/disposed', ({ agent }) => {
      this.fanout({ kind: 'agent/disposed', sessionId: String(agent.session.id) })
    }))
    this.subscriptions.push(ctx.on('session/created', (session: Session) => {
      const parentSessionId = session.header.parentSession === undefined
        ? undefined
        : String(session.header.parentSession)
      this.fanout({
        kind: 'session/created',
        sessionId: String(session.id),
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
      })
    }))
    this.subscriptions.push(ctx.on('session/disposed', (session: Session) => {
      this.fanout({ kind: 'session/disposed', sessionId: String(session.id) })
    }))
    this.subscriptions.push(ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
      // Only in-process children are this instance's own work; remote provider
      // runs settle through a different, non-local path.
      if (!info.local) return
      this.fanout({
        kind: 'subagent/end',
        provider: info.provider,
        childSessionId: String(info.id),
        stopReason: info.stopReason,
      })
    }))

    // Clean up the event listeners with the service fiber.
    ctx.effect(() => () => {
      for (const dispose of this.subscriptions.splice(0)) dispose()
    }, 'interconnect: event subscriptions')

    // Terminate every live socket, outbound dial loop, and the no-server
    // acceptor when the service fiber unwinds.
    ctx.effect(() => () => {
      if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
      for (const state of this.linkStates.values()) state.close()
      this.linkStates.clear()
      for (const socket of this.sockets) socket.terminate()
      this.sockets.clear()
      this.server.close()
    }, 'interconnect: websocket teardown')
  }

  async send(request: SendRequest): Promise<SendResult> {
    // Spread the override only when present: JSON.stringify would otherwise
    // drop an explicit `delivery: undefined` anyway, but building the key
    // conditionally keeps the wire shape identical to a caller that omitted it.
    const payload: SendPayload = {
      sessionId: request.sessionId,
      text: request.text,
      ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
    }
    const result = await this.post<SendResult>(request.baseUrl, 'send', payload)
    // No usable answer means the receiver never spoke, so the instance id here
    // is this sender's own — hence `unreachable` rather than any claim about
    // the target session, which may be perfectly fine.
    return result ?? { delivered: false, instance: this.instanceId, reason: 'unreachable' }
  }

  async ping(baseUrl: string): Promise<PingResult | undefined> {
    return this.post<PingResult>(baseUrl, 'ping', {})
  }

  /**
   * List the peer's live sessions so a caller can discover a valid `send`
   * target. `undefined` on transport or auth failure, matching `ping`.
   */
  async list(baseUrl: string): Promise<ListResult | undefined> {
    return this.post<ListResult>(baseUrl, 'list', {})
  }

  /**
   * Add a peer origin to the event fan-out set at runtime. Returns a disposer
   * that removes it. Duplicate origins are idempotent.
   * @param peer - receiver origin, e.g. `http://127.0.0.1:3080`.
   * @returns disposer removing the peer from the fan-out set.
   */
  subscribe(peer: string): () => void {
    const trimmed = trimBase(peer)
    this.peers.add(trimmed)
    return () => { this.peers.delete(trimmed) }
  }

  /** Remove a peer origin from the event fan-out set. */
  unsubscribe(peer: string): void {
    this.peers.delete(trimBase(peer))
  }

  /**
   * Open (and, on drop, re-open) a persistent WebSocket link to a peer. Local
   * events stream over the link in real time, and events the peer pushes are
   * surfaced as `interconnect/event`. Repeating for the same peer returns the
   * existing handle.
   * @param peer - receiver origin, e.g. `http://127.0.0.1:3080` (dialed as `ws:`).
   * @returns a handle closing the link and cancelling reconnection.
   */
  link(peer: string): WebSocketLinkHandle {
    const trimmed = trimBase(peer)
    const existing = this.linkStates.get(trimmed)
    if (existing !== undefined) return existing
    const state = new LinkState(this, trimmed)
    this.linkStates.set(trimmed, state)
    state.dial()
    return state
  }

  /** Remove a closed outbound link's state so a later `link` re-dials fresh. */
  forgetLink(peer: string): void {
    this.linkStates.delete(peer)
  }

  /** Fan one serialized lifecycle fact out to every registered peer, fire-and-forget. */
  private fanout(notification: EventNotification): void {
    const payload: EventPayload = { sender: this.instanceId, notification }
    for (const peer of this.peers) {
      void this.post(peer, 'event', payload)
    }
    this.broadcast(notification)
  }

  /** Push one fact over every live WebSocket link, dropping closed sockets. */
  private broadcast(notification: EventNotification): void {
    if (this.sockets.size === 0) return
    const frame: LinkFrame = { type: 'event', notification }
    const encoded = JSON.stringify(frame)
    for (const socket of this.sockets) {
      if (socket.readyState !== WebSocket.OPEN) {
        this.sockets.delete(socket)
        continue
      }
      socket.send(encoded)
    }
  }

  /** Inbound route handler: bearer auth first, then envelope dispatch. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = await this.resolveToken()
    if (token === undefined) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const expected = `Bearer ${token}`
    const header = req.headers.authorization
    // Timing-safe compare so an attacker cannot siphon the token by timing.
    if (header === undefined || !timingSafeEqual(header, expected)) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    await this.dispatch(req, res)
  }

  /** Parse the ClientRequest envelope and route to the named endpoint. */
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const endpoint = endpointFromPath(INTERCONNECT_CHANNEL, pathname)
    if (req.method !== 'POST' || endpoint === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }

    const mediaType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      res.writeHead(415)
      res.end('content type must be application/json')
      return
    }

    const body = await readBody(req)
    if (body === undefined) {
      res.writeHead(413)
      res.end('body too large')
      return
    }

    let envelope: { rpcId: unknown; method: unknown; payload: unknown }
    try {
      envelope = JSON.parse(body) as { rpcId: unknown; method: unknown; payload: unknown }
    } catch {
      res.writeHead(400)
      res.end('body is not JSON')
      return
    }

    const parsed = clientRequestSchema.safeParse(envelope)
    const rpcId = typeof envelope.rpcId === 'string' ? RpcId(envelope.rpcId) : INVALID_REQUEST_RPC_ID
    if (!parsed.success) {
      writeError(res, rpcId, {
        code: 'bad-request',
        message: 'invalid client-request message',
        details: { issues: parsed.error.issues },
      })
      return
    }
    if (parsed.data.method !== endpoint) {
      writeError(res, rpcId, {
        code: 'bad-request',
        message: `method ${JSON.stringify(parsed.data.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: { issues: [] },
      })
      return
    }

    try {
      const value = this.runEndpoint(endpoint, parsed.data.payload)
      writeFull(res, rpcId, { ok: true, value })
    } catch (error) {
      if (error instanceof UnknownEndpointError) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      // A payload the endpoint schema rejects is the caller's error, so it gets
      // `bad-request` and no warning: logging it would let a peer fill this
      // instance's log by sending malformed payloads.
      if (error instanceof InvalidPayloadError) {
        writeError(res, rpcId, {
          code: 'bad-request',
          message: error.message,
          details: { issues: [] },
        })
        return
      }
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      writeError(res, rpcId, {
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      })
    }
  }

  /** Dispatch one authenticated business call. */
  private runEndpoint(endpoint: string, payload: unknown): unknown {
    if (endpoint === 'ping') {
      return { pong: true, instance: this.instanceId }
    }
    if (endpoint === 'send') {
      let parsed: SendPayload
      try {
        parsed = z.resolve(payload, sendPayloadSchema, {})[0] as SendPayload
      } catch (error) {
        throw new InvalidPayloadError(`send payload invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
      return this.deliver(parsed)
    }
    if (endpoint === 'list') {
      return this.listSessions()
    }
    if (endpoint === 'event') {
      let eventPayload: EventPayload
      try {
        eventPayload = z.resolve(payload, eventPayloadSchema, {})[0] as EventPayload
      } catch (error) {
        throw new InvalidPayloadError(`event payload invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.receiveEvent(eventPayload)
      return { accepted: true }
    }
    throw new UnknownEndpointError(endpoint)
  }

  /** Surface one remote notification to local listeners and the log. */
  private receiveEvent(eventPayload: EventPayload): void {
    this.ctx.logger.info(`interconnect: remote event ${eventPayload.notification.kind} from ${eventPayload.sender}`)
    this.ctx.emit('interconnect/event', eventPayload.notification, eventPayload.sender)
  }

  /**
   * Summarize every live local session so a sender can discover valid targets
   * instead of having to know a session id already. Only live agents are listed
   * because `send` can reach exactly those.
   *
   * Title and status are best-effort: the title projection is an optional
   * service, and a receiver without it still returns the ids. A projection that
   * throws degrades that one row rather than failing the whole listing, which
   * matches how the Host's own session listing treats its projection column.
   */
  private listSessions(): ListResult {
    const sessions = this.ctx.agents.list().map((agent): SessionSummary => {
      let title: string | undefined
      try {
        const snapshot = this.ctx.get('sessionProjections')?.snapshot(agent.session)
        const value = snapshot?.values.title
        if (typeof value === 'string' && value !== '') title = value
      } catch {
        // A failing projection must not hide a reachable session.
        title = undefined
      }
      return {
        sessionId: agent.id,
        ...(title === undefined ? {} : { title }),
        ...(typeof agent.status === 'string' ? { status: agent.status } : {}),
      }
    })
    return { sessions, instance: this.instanceId }
  }

  /** Deliver one message to a live local session, if it exists. */
  private deliver(payload: SendPayload): SendResult {
    const agent = this.ctx.agents.get(payload.sessionId as Agent['id'])
    if (agent === undefined) {
      // Name the cause: this instance answered, so the id is simply not live
      // here. Resuming a persisted session is deliberately NOT done — the
      // resumed agent's lifecycle would follow this plugin's fiber, so
      // unloading the plugin would tear down a session its user is still
      // using. The caller lists live sessions and picks a reachable target.
      return { delivered: false, instance: this.instanceId, reason: 'session-not-live' }
    }
    // Attribute the message to this plugin, not to the human operator: the
    // receiving agent must be able to tell a cross-instance handoff from text
    // its own user typed. `SendPayload` carries no sender field (the wire shape
    // is unauthenticated beyond the shared token), so the notice names the
    // receiving instance the handoff landed on.
    const message = createUserMessage({
      source: {
        kind: 'plugin',
        plugin: PLUGIN_SOURCE,
        form: 'notice',
        summary: boundContextSummary(`interconnect handoff delivered on instance ${this.instanceId}`),
      },
      content: [{ type: 'text', text: payload.text }],
    })
    // The sender may override the mode per message, because urgency belongs to
    // one message rather than to the link; an absent override leaves the
    // receiver's configured default in force. The switch is exhaustive over
    // DeliveryMode so adding a mode fails the type check here instead of
    // silently falling through to `followup`.
    const mode: DeliveryMode = payload.delivery ?? this.delivery
    switch (mode) {
      case 'steer':
        agent.steer(message)
        break
      case 'inject':
        agent.inject(message)
        break
      case 'followup':
        agent.followup(message)
        break
    }
    return { delivered: true, instance: this.instanceId, delivery: mode }
  }

  /** POST one business call to a peer instance; undefined on transport/auth failure. */
  private async post<T>(baseUrl: string, endpoint: string, payload: unknown): Promise<T | undefined> {
    const token = await this.resolveToken()
    if (token === undefined) return undefined
    const url = `${trimBase(baseUrl)}${INTERCONNECT_CHANNEL}/${endpoint}`
    const envelope = {
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: endpoint,
      payload,
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as { result?: { ok?: boolean; value?: unknown } }
      if (body.result?.ok !== true) return undefined
      return body.result.value as T
    } catch (error) {
      this.ctx.logger.warn(`interconnect: ${endpoint} to ${baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async resolveToken(): Promise<string | undefined> {
    const credential = await this.ctx.credentials.resolve(credentialRef(INTERCONNECT_TOKEN_REF))
    return credential === undefined || credential.value.length === 0 ? undefined : credential.value
  }

  /** Resolve the shared token for an outbound dial (same source as inbound). */
  resolveTokenForDial(): Promise<string | undefined> {
    return this.resolveToken()
  }

  /** Inbound WebSocket upgrade: authenticate the bearer header, then accept. */
  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const token = await this.resolveToken()
    if (token === undefined) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden')
      return
    }
    const expected = `Bearer ${token}`
    const header = req.headers.authorization
    if (header === undefined || !timingSafeEqual(header, expected)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nunauthorized')
      return
    }
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      this.attachSocket(websocket)
    })
  }

  /**
   * Install frame + liveness handling on one socket and add it to the live
   * pool. Used by both the server half (accepted upgrade) and the client half
   * (outbound dial), so a single socket carries events both directions.
   */
  attachSocket(websocket: WebSocket): void {
    this.sockets.add(websocket)
    ;(websocket as WebSocket & { isAlive: boolean }).isAlive = true
    websocket.on('pong', () => {
      ;(websocket as WebSocket & { isAlive: boolean }).isAlive = true
    })
    websocket.on('message', (data: RawData) => {
      this.handleFrame(websocket, data)
    })
    websocket.on('close', () => {
      this.sockets.delete(websocket)
      this.peerOf.delete(websocket)
    })
    websocket.on('error', () => {
      this.sockets.delete(websocket)
    })
    // Announce this instance's identity so the dialer can attribute pushes.
    websocket.send(JSON.stringify({ type: 'hello', sender: this.instanceId } satisfies LinkFrame))
  }

  /** Parse and route one inbound link frame, attributing events to the socket's announced peer. */
  private handleFrame(socket: WebSocket, data: RawData): void {
    if (Array.isArray(data)) return // binary frames are a protocol violation; ignore
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
    let frame: LinkFrame
    try {
      frame = z.resolve(JSON.parse(text), linkFrameSchema, {})[0] as LinkFrame
    } catch {
      this.ctx.logger.warn('interconnect: dropping malformed link frame')
      return
    }
    if (frame.type === 'hello') {
      this.peerOf.set(socket, frame.sender)
      return
    }
    const sender = this.peerOf.get(socket) ?? 'unknown-peer'
    this.receiveEvent({ sender, notification: frame.notification })
  }
}

/** Thrown for an endpoint this channel does not own; mapped to HTTP 404. */
class UnknownEndpointError extends Error {
  constructor(endpoint: string) {
    super(`unknown interconnect endpoint ${JSON.stringify(endpoint)}`)
    this.name = 'UnknownEndpointError'
  }
}

/**
 * Thrown when an authenticated envelope carries a business payload its endpoint
 * schema rejects. Typed so the request catch can answer `bad-request` instead of
 * `internal`: the caller sent an unusable payload, so retrying it unchanged can
 * never succeed, and the receiver is not faulty.
 */
class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPayloadError'
  }
}

/**
 * One outbound WebSocket peer link: dials, re-dials with backoff after an
 * unexpected drop, and pushes local events over the live socket. The owning
 * service streams events via {@link InterconnectService.broadcast} only to
 * sockets it accepted; this dialer keeps its own socket OUT of that set and
 * instead subscribes to local events through the service's fan-out via a
 * dedicated route below.
 */
class LinkState implements WebSocketLinkHandle {
  private socket: WebSocket | undefined
  private closed = false
  private retry = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  readonly peer: string

  constructor(
    private readonly owner: InterconnectService,
    peer: string,
  ) {
    this.peer = peer
  }

  /** Open the socket; reconnect is scheduled by the close handler. */
  dial(): void {
    if (this.closed) return
    const url = new URL('/interconnect/link', this.peer)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    void this.owner.resolveTokenForDial().then((token) => {
      if (token === undefined || this.closed) return
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
      })
      this.socket = socket
      socket.once('open', () => {
        this.retry = 0
        // Same handler as the server half: adds to the live pool and announces
        // this instance's identity over the now-open link.
        this.owner.attachSocket(socket)
      })
      socket.once('close', () => {
        if (this.closed) return
        this.scheduleReconnect()
      })
      socket.on('error', () => {
        // close follows; reconnect is scheduled there.
      })
    })
  }

  close(): void {
    this.closed = true
    this.owner.forgetLink(this.peer)
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    const socket = this.socket
    if (socket !== undefined) {
      socket.removeAllListeners()
      socket.terminate()
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30000, 1000 * 2 ** this.retry)
    this.retry += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.dial()
    }, delay)
  }
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  return pathname.slice(channel.length + 1)
}

/** Read a request body up to the cap; undefined when it exceeds the cap. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_REQUEST_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString()
}

/** Constant-time string comparison over the ASCII-encoded lengths. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function writeFull(
  res: ServerResponse,
  rpcId: unknown,
  result: { ok: true; value?: unknown } | { ok: false; error: RpcError },
): void {
  const body = serverResponseSchema.parse({
    type: 'server-response',
    rpcId,
    result,
  })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function writeError(res: ServerResponse, rpcId: unknown, error: RpcError): void {
  writeFull(res, rpcId, { ok: false, error })
}

export default InterconnectService
