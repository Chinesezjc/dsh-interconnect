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
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
// The Host's own subagent-ownership predicate, reused rather than reimplemented:
// this is a safety rule, and a local copy of it would drift from the Host's.
import { hasApiRemoteSubagentOwner } from '@deepseek-ai/dsh-api-remotes'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import WebSocket, { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import {
  INTERCONNECT_TOKEN_REF,
  type Config,
  type DeliveryMode,
  type EventNotification,
  type EventPayload,
  type LinkFrame,
  type LinkMessage,
  type ListResult,
  type PingResult,
  type QueryMessage,
  type ReplyPayload,
  type ReplyRequest,
  type SendPayload,
  type SendResult,
  type SendRequest,
  type SendFailure,
  type SenderIdentity,
  type SessionSummary,
  type WebSocketLinkHandle,
} from './types.ts'

export type * from './types.ts'
export { INTERCONNECT_TOKEN_REF } from './types.ts'

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

/** Wire shape of an address-free {@link SenderIdentity}. */
const senderSchema = z.object({ instanceId: z.string(), sessionId: z.string() })

/** Wire union for the send/reply message carried by a `msg` link frame. */
const messageSchema = z.union([
  z.object({
    kind: z.const('send'),
    sessionId: z.string(),
    text: z.string(),
    sender: senderSchema,
    delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]),
    resume: z.boolean(),
  }),
  z.object({
    kind: z.const('reply'),
    sessionId: z.string(),
    text: z.string(),
    sender: senderSchema,
    delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]),
    resume: z.boolean(),
  }),
])

/** Wire union for the discovery query carried by a `query` link frame. */
const querySchema = z.union([
  z.object({ kind: z.const('ping') }),
  z.object({ kind: z.const('list') }),
  z.object({ kind: z.const('event'), notification: notificationSchema }),
])

/** Wire union for one WebSocket link text frame. */
const linkFrameSchema = z.union([
  z.object({ type: z.const('hello'), sender: z.string() }),
  z.object({ type: z.const('event'), notification: notificationSchema }),
  z.object({ type: z.const('msg'), reqId: z.string(), message: messageSchema }),
  z.object({ type: z.const('msg-result'), reqId: z.string(), result: z.object({
    delivered: z.boolean(),
    instance: z.string(),
    delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]),
    reason: z.string(),
  }) }),
  z.object({ type: z.const('query'), reqId: z.string(), query: querySchema }),
  z.object({ type: z.const('query-result'), reqId: z.string(), result: z.any() }),
])

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
    peers: z.object({}).default({}),
    delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]).default('followup'),
    allowResume: z.boolean().default(true),
  })

  private readonly instanceId: string
  private readonly requestTimeoutMs: number
  private readonly delivery: DeliveryMode
  private readonly allowResume: boolean
  private readonly subscriptions: (() => void)[] = []
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly sockets = new Set<WebSocket>()
  /** Outbound peer links keyed by the peer's `instanceId`. */
  private readonly linkStates = new Map<string, LinkState>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  /** Peer identity each live socket announced via its `hello` frame, if any. */
  private readonly peerOf = new WeakMap<WebSocket, string>()
  /** Sender each local session last received a send from, keyed by local session id. */
  private readonly senders = new Map<string, SenderIdentity>()
  /** In-flight frames sent over a peer link, keyed by `reqId`, awaiting a correlated result. */
  private readonly pendingMessages = new Map<string, PendingMessage>()
  private reqIdCounter = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'interconnect')
    this.instanceId = config.instanceId
    this.requestTimeoutMs = config.requestTimeoutMs
    this.delivery = config.delivery ?? 'followup'
    this.allowResume = config.allowResume ?? true
    // Link every configured peer at activation: all delivery is over these
    // persistent links, and addressing is by instanceId through them.
    for (const [peerInstanceId, origin] of Object.entries(config.peers ?? {})) {
      this.link(peerInstanceId, origin)
    }

    const upgrade: WebUpgradeRoute = {
      path: LINK_CHANNEL,
      handler: (req, socket, head) => { void this.handleUpgrade(req, socket, head) },
    }
    ctx.effect(() => ctx.webServer.registerUpgrade(upgrade), 'interconnect: /interconnect/link websocket')

    // Liveness sweep: terminate sockets that stopped answering protocol pings.
    // Deleting the CURRENT element of a `Set` while iterating is safe: Set
    // iterators traverse live in insertion order, and a delete of an already
    // visited element is a no-op for the traversal. `socket.terminate()` from
    // `ws` fires its `close` handler asynchronously, so the `close` handler's
    // own `this.sockets.delete(socket)` cannot run mid-iteration either
    // (measured against the real `ws`). Neither delete removes a not-yet-visited
    // element, so nothing is skipped.
    // This timer is created before its cleanup effect below, so it could leak if
    // any statement between here and that effect threw. The only statements in
    // that window are `ctx.on(...)` registrations, and Cordis's `ctx.on` does not
    // throw for any of the event names used here (verified against a real
    // Context), so the window is not reachable. The teardown effect clears the
    // timer when the fiber unwinds.
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

  /**
   * This instance's identity to attach to outbound messages. Always present:
   * it needs no address, only this instance's id and the calling session.
   * @param sessionId - the local session that is sending, used as the reply target.
   */
  selfSender(sessionId: string): SenderIdentity {
    return { instanceId: this.instanceId, sessionId }
  }

  async send(request: SendRequest): Promise<SendResult> {
    const payload: SendPayload = {
      sessionId: request.sessionId,
      text: request.text,
      ...(request.sender === undefined ? {} : { sender: request.sender }),
      ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
      ...(request.resume === undefined ? {} : { resume: request.resume }),
    }
    const result = await this.msgRequest(request.instanceId, 'send', payload)
    return result ?? { delivered: false, instance: this.instanceId, reason: 'unreachable' }
  }

  /**
   * Deliver one text message back to the peer that a local session last
   * received a send from. `sessionId` names the LOCAL replying session; the
   * outbound target is the `sender` that session recorded, addressed through
   * this instance's own link to the sender's instance.
   */
  async reply(request: ReplyRequest): Promise<SendResult> {
    const sender = this.senders.get(request.sessionId)
    if (sender === undefined) {
      return { delivered: false, instance: this.instanceId, reason: 'no-sender-known' }
    }
    const payload: SendPayload = {
      sessionId: sender.sessionId,
      text: request.text,
      ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
      ...(request.resume === undefined ? {} : { resume: request.resume }),
      // Attribute the reply to this instance so the peer, in turn, can reply
      // back — chaining the conversation.
      sender: this.selfSender(request.sessionId),
    }
    const result = await this.msgRequest(sender.instanceId, 'send', payload)
    return result ?? { delivered: false, instance: this.instanceId, reason: 'unreachable' }
  }

  /**
   * Probe a peer instance for liveness and identity over its persistent link.
   * Returns the peer identity when reachable, or undefined when the link is
   * not up or no answer arrives.
   */
  async ping(instanceId: string): Promise<PingResult | undefined> {
    return this.queryRequest(instanceId, { kind: 'ping' }) as Promise<PingResult | undefined>
  }

  /**
   * List a peer instance's live sessions over its persistent link. Undefined on
   * transport failure, matching `ping`.
   */
  async list(instanceId: string): Promise<ListResult | undefined> {
    return this.queryRequest(instanceId, { kind: 'list' }) as Promise<ListResult | undefined>
  }

  /** The origin this instance dials to reach a configured peer, or undefined. */
  private originOf(instanceId: string): string | undefined {
    const state = this.linkStates.get(instanceId)
    return state?.peer
  }

  /**
   * Send a `msg` frame over the live link to a peer and resolve with its
   * correlated `msg-result`. Undefined when the peer has no live link here
   * (not configured, or the link is down) — sends can only address configured+
   * connected peers by design.
   */
  private async msgRequest(
    instanceId: string,
    kind: LinkMessage['kind'],
    payload: SendPayload,
  ): Promise<SendResult | undefined> {
    const state = this.linkStates.get(instanceId)
    if (state === undefined || !state.writable()) return undefined
    const reqId = `m${++this.reqIdCounter}-${crypto.randomUUID()}`
    const message: LinkMessage = {
      kind,
      sessionId: payload.sessionId,
      text: payload.text,
      ...(payload.sender === undefined ? {} : { sender: payload.sender }),
      ...(payload.delivery === undefined ? {} : { delivery: payload.delivery }),
      ...(payload.resume === undefined ? {} : { resume: payload.resume }),
    }
    return this.waitForResult(reqId, (failure) => {
      const wrote = state.sendFrame({ type: 'msg', reqId, message })
      if (!wrote) failure(new Error(`interconnect: peer link to ${instanceId} closed while sending`))
    }) as Promise<SendResult | undefined>
  }

  /** Send a `query` frame over the live link to a peer and resolve its result. */
  private async queryRequest(instanceId: string, query: QueryMessage): Promise<unknown> {
    const state = this.linkStates.get(instanceId)
    if (state === undefined || !state.writable()) return undefined
    const reqId = `q${++this.reqIdCounter}-${crypto.randomUUID()}`
    return this.waitForResult(reqId, (failure) => {
      const wrote = state.sendFrame({ type: 'query', reqId, query })
      if (!wrote) failure(new Error(`interconnect: peer link to ${instanceId} closed while querying`))
    })
  }

  /** Settle a `reqId` frame against its `*-result`, timing out at `requestTimeoutMs`. */
  private waitForResult(reqId: string, send: (failure: (error: unknown) => void) => void): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(reqId)
        reject(new Error(`interconnect: no result for ${reqId} within ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
      this.pendingMessages.set(reqId, { timer })
      const pending = this.pendingMessages.get(reqId)
      if (pending === undefined) return
      ;(pending as MutablePendingMessage).resolve = (result: unknown) => {
        clearTimeout(timer)
        this.pendingMessages.delete(reqId)
        resolve(result)
      }
      ;(pending as MutablePendingMessage).reject = (error: unknown) => {
        clearTimeout(timer)
        this.pendingMessages.delete(reqId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      send((error: unknown) => {
        clearTimeout(timer)
        this.pendingMessages.delete(reqId)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /**
   * Add a peer route at runtime. Returns a disposer that removes it. Re-adding
   * an existing instanceId re-routes it to the new origin.
   * @param instanceId - the peer's `instanceId`.
   * @param origin - origin this instance dials to reach that peer.
   * @returns disposer removing the peer route.
   */
  subscribe(instanceId: string, origin: string): () => void {
    this.link(instanceId, origin)
    return () => {
      this.forgetLink(instanceId)
    }
  }

  /** Remove a peer route, closing its outbound link. */
  unsubscribe(instanceId: string): void {
    const state = this.linkStates.get(instanceId)
    if (state !== undefined) state.close()
    this.linkStates.delete(instanceId)
  }

  /**
   * Open (and, on drop, re-open) a persistent WebSocket link to a peer. Local
   * events stream over the link in real time, and events the peer pushes are
   * surfaced as `interconnect/event`. Repeating for the same instanceId
   * re-routes the link to the new origin.
   * @param instanceId - the peer's `instanceId`.
   * @param origin - receiver origin this instance dials, e.g. `http://127.0.0.1:13080`.
   * @returns a handle closing the link and cancelling reconnection.
   */
  link(instanceId: string, origin: string): WebSocketLinkHandle {
    const existing = this.linkStates.get(instanceId)
    if (existing !== undefined) {
      existing.reroute(trimBase(origin))
      return existing
    }
    const state = new LinkState(this, instanceId, trimBase(origin))
    this.linkStates.set(instanceId, state)
    state.dial()
    return state
  }

  /** Remove a closed outbound link's state so a later `link` re-dials fresh. */
  forgetLink(instanceId: string): void {
    this.linkStates.delete(instanceId)
  }

  /** Push one serialized lifecycle fact out to every linked peer over WS. */
  private fanout(notification: EventNotification): void {
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

  /**
   * Dispatch one inbound `msg` frame: deliver a `send`/`reply` and answer the
   * correlated `msg-result` on the same socket. Errors are surfaced as the
   * result so a throwing handler cannot escape the socket's message callback.
   */
  private async handleMsgFrame(socket: WebSocket, reqId: string, message: LinkMessage): Promise<void> {
    let result: SendResult
    if (message.kind === 'reply') {
      result = await this.replyForSession({
        sessionId: message.sessionId,
        text: message.text,
        ...(message.delivery === undefined ? {} : { delivery: message.delivery }),
        ...(message.resume === undefined ? {} : { resume: message.resume }),
      })
    } else {
      result = await this.deliver({
        sessionId: message.sessionId,
        text: message.text,
        ...(message.sender === undefined ? {} : { sender: message.sender }),
        ...(message.delivery === undefined ? {} : { delivery: message.delivery }),
        ...(message.resume === undefined ? {} : { resume: message.resume }),
      })
    }
    this.sendFrame(socket, { type: 'msg-result', reqId, result })
  }

  /** Dispatch one inbound `query` frame (ping/list/event) and answer on the socket. */
  private async handleQueryFrame(socket: WebSocket, reqId: string, query: QueryMessage): Promise<void> {
    let result: unknown
    if (query.kind === 'ping') {
      result = { pong: true, instance: this.instanceId }
    } else if (query.kind === 'list') {
      result = this.listSessions()
    } else {
      const payload: EventPayload = {
        sender: this.peerOf.get(socket) ?? 'unknown-peer',
        notification: query.notification,
      }
      this.receiveEvent(payload)
      result = { accepted: true }
    }
    this.sendFrame(socket, { type: 'query-result', reqId, result })
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
    // `agents.list()` includes subagent children; a row this instance would
    // refuse to deliver to must not be advertised as a target, or the listing
    // contradicts `send`.
    const reachable = this.ctx.agents.list()
      .filter(agent => !hasApiRemoteSubagentOwner(this.ctx, agent.session, agent))
    const sessions = reachable.map((agent): SessionSummary => {
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

  /**
   * Resolve a session that is not currently live, when the sender asked to wake
   * it. Returns the agent, or the reason it stays undelivered.
   *
   * The resume is delegated to the Host's configured `agent` lookup rather than
   * calling `ctx.agents.resume()` here, and that is the whole point: a handle
   * from `resume()` is owned by the CALLING context, so resuming on this
   * plugin's fiber would tear the session down again the moment the plugin
   * unloads (measured: the same call through the root context leaves it alive).
   * The Host's resolver owns it instead, and it also composes the preset the
   * session recorded — so a woken agent comes back with the toolset its history
   * was produced under, not an empty one.
   */
  private async wake(payload: SendPayload): Promise<{ agent: Agent } | { reason: SendFailure }> {
    if (payload.resume !== true) return { reason: 'session-not-live' }
    if (!this.allowResume) return { reason: 'resume-refused' }
    // Optional by design: a deployment without the Host's lookup (headless, or
    // a profile with no api-proxy) degrades to the plain not-live answer rather
    // than failing the call.
    const lookup = this.ctx.get('typert')?.lookups.get('agent')
    if (lookup === undefined) return { reason: 'session-not-live' }
    try {
      const resolved = await lookup.resolve(payload.sessionId as never)
      // `undefined` is not a failed wake: the base `agent` provider is a plain
      // registry read, so a deployment without the Host's resuming resolver
      // answers undefined for every id that is not already live. Reporting
      // `resume-failed` there would send the caller chasing a wake that was
      // never possible, when the honest answer is that nothing is live here.
      if (resolved === undefined || resolved === null) return { reason: 'session-not-live' }
      return { agent: resolved as Agent }
    } catch (error) {
      // A refusing resolver is an expected outcome, not a fault of this
      // instance: the id may not exist, or a subagent owner may hold it.
      this.ctx.logger.info(`interconnect: resume refused for ${payload.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return { reason: 'resume-failed' }
    }
  }

  /**
   * Deliver one message to a live local session, waking a persisted one only
   * when the sender asked and this receiver allows it.
   */
  private async deliver(payload: SendPayload): Promise<SendResult> {
    let agent = this.ctx.agents.get(payload.sessionId as Agent['id'])
    if (agent === undefined) {
      const woken = await this.wake(payload)
      if ('reason' in woken) {
        return { delivered: false, instance: this.instanceId, reason: woken.reason }
      }
      agent = woken.agent
    }
    // Fence the live-hit path too, exactly as the Host does before handing out a
    // live agent: a session reserved to subagent routing is delivered to by its
    // parent, and splicing into its inbox from here would race that parent. The
    // wake path needs no separate check because the Host's resolver applies the
    // same fence internally.
    if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) {
      return { delivered: false, instance: this.instanceId, reason: 'session-owned-by-subagent' }
    }
    // Remember who sent this message so the receiving session can reply later.
    // `source` never reaches the model, so recording the sender here only sets
    // up reply attribution; the model-facing `content` stays exactly the text
    // that crossed the wire. An absent sender resolves to `{}` under schematery,
    // so test for a real identity rather than `undefined`.
    const sender = ((): SenderIdentity | undefined => {
      const candidate = payload.sender
      return candidate === undefined || typeof candidate.instanceId !== 'string'
        ? undefined
        : candidate
    })()
    if (sender !== undefined) {
      this.senders.set(payload.sessionId, sender)
    }
    // Attribute the message to this plugin, not to the human operator: the
    // receiving agent must be able to tell a cross-instance handoff from text
    // its own user typed. The summary names the sender when one was carried, so
    // a GUI/archive can show where the handoff came from without touching the
    // model-facing content.
    const message = createUserMessage({
      source: {
        kind: 'plugin',
        plugin: PLUGIN_SOURCE,
        form: 'notice',
        summary: boundContextSummary(
          sender === undefined
            ? `interconnect handoff delivered on instance ${this.instanceId}`
            : `interconnect handoff from ${sender.instanceId} (session ${sender.sessionId}) delivered on instance ${this.instanceId}`,
        ),
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

  /**
   * Inbound `reply` dispatch: forward a request to {link reply}, resolving the
   * outbound sender for the named local session. Kept separate from {link
   * deliver} so the two wire endpoints stay distinct in the request pipeline.
   */
  private async replyForSession(payload: ReplyPayload): Promise<SendResult> {
    return this.reply({
      sessionId: payload.sessionId,
      text: payload.text,
      ...(payload.delivery === undefined ? {} : { delivery: payload.delivery }),
      ...(payload.resume === undefined ? {} : { resume: payload.resume }),
    })
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
    let token: string | undefined
    try {
      token = await this.resolveToken()
    } catch (error) {
      // Fail closed and end the socket: the caller invokes this as
      // `void handleUpgrade(...)`, so letting the rejection escape would both
      // leave this client hanging on an open socket and surface as an unhandled
      // rejection.
      this.ctx.logger.warn(`interconnect: upgrade token read failed: ${error instanceof Error ? error.message : String(error)}`)
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden')
      return
    }
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
    if (frame.type === 'event') {
      const sender = this.peerOf.get(socket) ?? 'unknown-peer'
      try {
        this.receiveEvent({ sender, notification: frame.notification })
      } catch (error) {
        // `receiveEvent` emits `interconnect/event`, and Cordis propagates a
        // listener throw back to the emitter. This runs inside the socket's
        // synchronous `message` handler, so an escaping throw becomes an
        // uncaughtException — letting any remote peer kill this process by sending
        // an event a local listener happens to mishandle.
        this.ctx.logger.warn(`interconnect: listener for a ${frame.notification.kind} event from ${sender} threw: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (frame.type === 'msg-result') {
      const pending = this.pendingMessages.get(frame.reqId)
      if (pending !== undefined) {
        ;(pending as MutablePendingMessage).resolve?.(frame.result)
      }
      return
    }
    if (frame.type === 'query-result') {
      const pending = this.pendingMessages.get(frame.reqId)
      if (pending !== undefined) {
        ;(pending as MutablePendingMessage).resolve?.(frame.result)
      }
      return
    }
    if (frame.type === 'msg') {
      void Promise.resolve().then(async () => {
        await this.handleMsgFrame(socket, frame.reqId, frame.message)
      }).catch((error: unknown) => {
        this.ctx.logger.warn(`interconnect: msg ${frame.reqId} handler threw: ${error instanceof Error ? error.message : String(error)}`)
        void this.sendFrame(socket, {
          type: 'msg-result',
          reqId: frame.reqId,
          result: { delivered: false, instance: this.instanceId, reason: 'unreachable' },
        })
      })
      return
    }
    // `query`: an inbound discovery/event request. Answer asynchronously and
    // never let a throw escape the socket's synchronous message callback.
    void Promise.resolve().then(async () => {
      await this.handleQueryFrame(socket, frame.reqId, frame.query)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`interconnect: query ${frame.reqId} handler threw: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Write one frame to a socket, returning false when the socket cannot take it. */
  private sendFrame(socket: WebSocket, frame: LinkFrame): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }
}

/**
 * One in-flight `msg` delivered over a peer link, awaiting its `msg-result`.
 * `resolve`/`reject` are installed by `emitViaLink` after the promise is
 * created; `handleFrame` settles the matching entry on a `msg-result`.
 */
interface PendingMessage {
  readonly timer: ReturnType<typeof setTimeout>
}
interface MutablePendingMessage extends PendingMessage {
  resolve?: (result: unknown) => void
  reject?: (error: unknown) => void
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

  // `peer` is mutable so `reroute` can point the link at a new origin.
  peer: string
  readonly instanceId: string

  constructor(
    private readonly owner: InterconnectService,
    instanceId: string,
    origin: string,
  ) {
    this.instanceId = instanceId
    this.peer = origin
  }

  /** Point this link at a different origin; re-dials immediately. */
  reroute(origin: string): void {
    if (origin === this.peer) return
    this.peer = origin
    const socket = this.socket
    if (socket !== undefined) {
      socket.removeAllListeners()
      socket.terminate()
      this.socket = undefined
    }
    this.dial()
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
    }).catch(() => {
      // A rejecting token read must not become an unhandled rejection, and must
      // not silently end the dial loop either: without this the link would stay
      // down until the process restarted, since no socket was ever created and
      // so no `close` will arrive to schedule the retry.
      if (this.closed) return
      this.scheduleReconnect()
    })
  }

  /** Whether this link currently holds an open socket that can carry frames. */
  writable(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN
  }

  /** Write one frame over this link's outbound socket; false when not open. */
  sendFrame(frame: LinkFrame): boolean {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
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

export default InterconnectService
