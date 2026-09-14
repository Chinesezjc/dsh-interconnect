/**
 * Cross-instance message handoff service: the inbound half owns one WebSocket
 * upgrade route on the host webserver and delivers authenticated messages into
 * live sessions; the outbound half dials the same route on peer instances.
 *
 * Transport is deliberately NOT the Connection RPC channel: that registry's
 * handler sees only `(endpoint, payload, signal)` and the trust fence is the
 * DNS-rebinding `trustedHosts` check, neither of which carries the shared-key
 * `Authorization` header this service authenticates on. Owning a plain
 * upgrade route keeps bearer-token auth at the boundary where the header is
 * readable and fails closed when the token is unconfigured.
 * @module dsh-interconnect
 */

import { Context, Service, LoggerService } from '@deepseek-ai/cordis'
import { createHash, randomUUID, timingSafeEqual as constantTimeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import WebSocket, { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import {
  type Config,
  type DeliveryMode,
  type EventNotification,
  type EventPayload,
  type LinkFrame,
  type LinkMessage,
  type ListResult,
  type PingResult,
  type QueryMessage,
  type ReplyRequest,
  type SendPayload,
  type SendResult,
  type SendRequest,
  type SendFailure,
  type SenderIdentity,
  type InterconnectSessionSummary,
  type WebSocketLinkHandle,
} from './types.ts'

/**
 * Mirror of the Host's subagent-ownership predicate. The Host keeps that rule
 * in `@deepseek-ai/dsh-api-session-controller` (as `hasApiSessionSubagentOwner`)
 * without publishing it as a binding host plugins may import, and adding that
 * runtime package as a peer dependency would repeat the broken-published-
 * artifact failure this repository exists to avoid. The body is copied verbatim
 * from the Host; keep it in sync if the Host changes the rule, because this is
 * a safety fence.
 * @param ctx - host context carrying the live agent registry.
 * @param session - attached or live session whose ownership is tested.
 * @param agent - live agent when one exists for the session.
 * @returns whether subagent routing owns the session identity.
 */
function isSessionOwnedBySubagent(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/** Exhaustiveness guard for closed unions. */
function assertNever(value: never): never {
  throw new Error(`interconnect: unhandled variant ${JSON.stringify(value)}`)
}

export type * from './types.ts'

/**
 * Credential reference holding the shared auth token. Both halves of a link
 * must resolve the same value: inbound requests are rejected unless their
 * `Authorization: Bearer <token>` matches this secret, and outbound requests
 * send it. An unconfigured token fails closed on the inbound side.
 */
export const INTERCONNECT_TOKEN_REF = 'DSH_INTERCONNECT_TOKEN'

declare module '@deepseek-ai/cordis' {
  interface Context {
    interconnect: InterconnectService
  }
  interface Events {
    /**
     * A remote peer instance pushed one authenticated lifecycle notification
     * into this instance. Payload is the exact {@link EventNotification} that
     * crossed the wire; listeners react synchronously on the frame handler.
     * @mode emit
     * @param notification - the serialized lifecycle fact that crossed the wire.
     * @param peer - the sender's self-reported instance id.
     */
    'interconnect/event'(notification: EventNotification, peer: string): void
  }
}

const PLUGIN_SOURCE = 'dsh-interconnect'

/** Maximum inbound link-frame size in bytes; larger frames are dropped as protocol violations. */
const MAX_LINK_FRAME_BYTES = 1024 * 1024
/** Handshake window for an outbound dial; a CONNECTING socket past this is terminated and re-dialed. */
const LINK_HANDSHAKE_TIMEOUT_MS = 10_000
/** WebSocket upgrade pathname owning the persistent peer link. */
const LINK_CHANNEL = '/interconnect/link'
/**
 * Bytes reserved inside {@link MAX_LINK_FRAME_BYTES} for one `query-result`
 * frame's envelope: its type, `reqId`, instance id, and JSON syntax.
 */
const LIST_FRAME_ENVELOPE_BYTES = 4096
/**
 * Bytes one `list` answer may spend on its `sessions` rows. The answer has to
 * stay inside {@link MAX_LINK_FRAME_BYTES} because ws closes a link that
 * receives an over-cap frame, and the sender then reads the call as
 * unreachable. A row's title comes from the session-title projection, whose
 * configured length bound is independent of this frame, so the row count alone
 * cannot bound the answer.
 */
const MAX_LIST_ROWS_BYTES = MAX_LINK_FRAME_BYTES - LIST_FRAME_ENVELOPE_BYTES
/**
 * Maximum session rows one `list` answer carries, so a very large live set
 * still answers with a bounded number of targets. A consumer that renders the
 * answer can compare a full page against this bound to tell a complete listing
 * from a truncated one.
 */
export const MAX_LISTED_SESSIONS = 100

/** Serialized size of one row inside a frame's `sessions` array: UTF-8 bytes plus its separating comma. */
const rowBytes = (row: InterconnectSessionSummary): number =>
  Buffer.byteLength(JSON.stringify(row), 'utf8') + 1

/** Wire union for the discriminated EventNotification fact carried by an `event` frame. */
const notificationSchema = z.union([
  z.object({ kind: z.const('agent/created').required(), sessionId: z.string().required() }),
  z.object({ kind: z.const('agent/disposed').required(), sessionId: z.string().required() }),
  z.object({ kind: z.const('agent/status').required(), sessionId: z.string().required(), status: z.union([z.const('idle'), z.const('running')]).required() }),
  z.object({ kind: z.const('session/created').required(), sessionId: z.string().required(), parentSessionId: z.string() }),
  z.object({ kind: z.const('session/disposed').required(), sessionId: z.string().required() }),
  z.object({ kind: z.const('subagent/end').required(), provider: z.string().required(), childSessionId: z.string().required(), stopReason: z.string().required() }),
])

/**
 * Wire shape of an address-free {@link SenderIdentity}. Fields stay optional
 * so an absent `sender` key (schemastery resolves it to an empty object)
 * still passes; `deliver()` treats a partial identity as no sender.
 */
const senderSchema = z.object({ instanceId: z.string(), sessionId: z.string() })

/**
 * Wire shape of the ping answer. Validated against the KIND of query the
 * caller asked, not only the frame union: the union's branches merge their
 * unknown keys, so a `list`-shaped payload would otherwise satisfy a `ping`
 * request.
 */
const pingResultSchema = z.object({ pong: z.const(true).required(), instance: z.string().required() })

/**
 * Wire shape of the live-session list. Every row must carry a `sessionId`
 * string: the consumer builds its tool result by reading that field, so an
 * unvalidated row would throw instead of reading as an unreachable peer.
 */
const listResultSchema = z.object({
  instance: z.string().required(),
  sessions: z.array(z.object({
    sessionId: z.string().required(),
    title: z.string().required(false),
    status: z.string().required(false),
  })).required(),
})

/**
 * Drop the explicit `null` values of one decoded frame. Schemastery accepts
 * `null` for a field that is not required and keeps it in the parsed result,
 * while every declared field on these frames is present-or-absent only: a peer
 * whose JSON writer emits `null` for a value it has none of would otherwise
 * hand a `null` title, status, or delivery to the tool output schemas, which
 * accept the field's own type and reject the whole result.
 * @param value - decoded frame, or any nested value of one.
 * @returns the value with every `null`-valued object key removed.
 */
const withoutNullFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(item => withoutNullFields(item))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== null)
    .map(([key, field]) => [key, withoutNullFields(field)]))
}

/**
 * Project one decoded `msg-result` payload onto the fields its discriminant
 * branch declares. Schemastery's union keeps the keys of every branch it
 * considered, so a failing answer still carries the `delivery` a peer sent
 * beside it and a successful one carries a stray `reason` or an unknown key;
 * the tool output schemas accept only the branch's own string fields, so
 * nothing else may leave this service. `delivered` selects the branch and the
 * schema has already validated the fields that branch declares.
 * @param result - decoded `msg-result` payload.
 * @returns the payload restricted to its branch's fields.
 */
const projectMsgResult = (result: SendResult): SendResult =>
  result.delivered
    ? { delivered: true, instance: result.instance, ...(result.delivery === undefined ? {} : { delivery: result.delivery }) }
    : { delivered: false, instance: result.instance, reason: result.reason }

/**
 * Decode one `query-result` payload against the schema for the request kind
 * that asked for it. `z.resolve` rejects with a `ValidationError` on a
 * mismatch, so the parse is contained here instead of throwing out of the frame
 * handler; the frame schema requires the `result` field, so a payload that
 * reaches this function is an object. The projections below read the fields the
 * schema validated, and schemastery types every optional field as `null`-capable,
 * so each field is read through the wire view its kind declares.
 * @param schema - the answer schema for the request kind.
 * @param result - the decoded `query-result` payload.
 * @returns the parsed payload's fields, or undefined when it does not match.
 */
const parseQueryResult = (
  schema: Parameters<typeof z.resolve>[1],
  result: unknown,
): Record<string, unknown> | undefined => {
  try {
    const [parsed] = z.resolve(result, schema, {}) as [Record<string, unknown>]
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Project one decoded `ping` answer onto its declared fields. Schemastery keeps
 * the keys of every union branch it considered, so an answer must not carry the
 * `sessions` rows or any other key this kind does not declare.
 * @param result - the decoded `query-result` payload.
 * @returns the answer as a {@link PingResult}, or undefined on a mismatch.
 */
const projectPingResult = (result: unknown): PingResult | undefined => {
  const parsed = parseQueryResult(pingResultSchema, result)
  return parsed === undefined ? undefined : { pong: true, instance: parsed.instance as string }
}

/**
 * Project one decoded `list` answer onto its declared fields, rows included,
 * for the same reason {@link projectPingResult} exists.
 * @param result - the decoded `query-result` payload.
 * @returns the answer as a {@link ListResult}, or undefined on a mismatch.
 */
const projectListResult = (result: unknown): ListResult | undefined => {
  const parsed = parseQueryResult(listResultSchema, result)
  if (parsed === undefined) return undefined
  const rows = parsed.sessions as Array<Record<string, unknown>>
  return {
    instance: parsed.instance as string,
    sessions: rows.map((row): InterconnectSessionSummary => ({
      sessionId: row.sessionId as string,
      ...(row.title === undefined || row.title === null ? {} : { title: row.title as string }),
      ...(row.status === undefined || row.status === null ? {} : { status: row.status as string }),
    })),
  }
}

/** Wire shape of one `query-result`: the ping answer, the live-session list, or the event-query ack. */
const queryResultSchema = z.union([
  pingResultSchema,
  listResultSchema,
  z.object({ accepted: z.const(true).required() }),
])

/** Wire shape of a `send` message carried by a `msg` link frame. */
const messageSchema = z.object({
  kind: z.const('send').required(),
  sessionId: z.string().required(),
  text: z.string().required(),
  sender: senderSchema,
  delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]),
  resume: z.boolean(),
})

/** Wire union for the discovery query carried by a `query` link frame. */
const querySchema = z.union([
  z.object({ kind: z.const('ping').required() }),
  z.object({ kind: z.const('list').required() }),
  z.object({ kind: z.const('event').required(), notification: notificationSchema.required() }),
])

/** Wire shape of one `send` answer: success carries the mode used, failure must carry the reason. */
const msgResultSchema = z.union([
  z.object({ delivered: z.const(true).required(), instance: z.string().required(), delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]) }),
  z.object({ delivered: z.const(false).required(), instance: z.string().required(), reason: z.union([
    z.const('session-not-live'),
    z.const('unreachable'),
    z.const('resume-refused'),
    z.const('resume-failed'),
    z.const('session-owned-by-subagent'),
    z.const('no-sender-known'),
  ]).required() }),
])

/** Wire union for one WebSocket link text frame. */
const linkFrameSchema = z.union([
  z.object({ type: z.const('hello').required(), sender: z.string().required() }),
  z.object({ type: z.const('event').required(), notification: notificationSchema.required() }),
  z.object({ type: z.const('msg').required(), reqId: z.string().required(), message: messageSchema.required() }),
  z.object({ type: z.const('msg-result').required(), reqId: z.string().required(), result: msgResultSchema.required() }),
  z.object({ type: z.const('query').required(), reqId: z.string().required(), query: querySchema.required() }),
  z.object({ type: z.const('query-result').required(), reqId: z.string().required(), result: queryResultSchema.required() }),
])

/**
 * Live cross-instance handoff service, registered as `ctx.interconnect`.
 * Requires the live agent registry and the credential store; the webserver is
 * optional — with one, the service accepts inbound links on
 * `/interconnect/link`; without one it still dials configured peers and
 * delivers over those outbound links. Activation is availability-driven like
 * every other host service.
 */
export class InterconnectService extends Service {
  static inject = ['agents', 'credentials']
  static Config: z<Config> = z.object({
    instanceId: z.string().default('dsh'),
    requestTimeoutMs: z.natural().max(60000).default(10000),
    peers: z.dict(z.string()).default({}),
    delivery: z.union([z.const('followup'), z.const('steer'), z.const('inject')]).default('followup'),
    allowResume: z.boolean().default(true),
  })

  private readonly instanceId: string
  private readonly requestTimeoutMs: number
  private readonly delivery: DeliveryMode
  private readonly allowResume: boolean
  private readonly subscriptions: (() => void)[] = []
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_FRAME_BYTES })
  private readonly sockets = new Set<WebSocket>()
  /** Outbound peer links keyed by the peer's `instanceId`. */
  private readonly linkStates = new Map<string, LinkState>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  /** Peer identity each live socket announced via its `hello` frame, if any. */
  private readonly peerOf = new WeakMap<WebSocket, string>()
  /** Sender each local session last received a send from, keyed by local session id. */
  private readonly senders = new Map<string, SenderIdentity>()
  /** In-flight frames sent over a peer link, keyed by `reqId`, awaiting a correlated result. */
  private readonly pendingMessages = new Map<string, MutablePendingMessage>()
  private reqIdCounter = 0
  /** Set when the service fiber unwinds; guards late inbound deliveries against driving disposed agents. */
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'interconnect')
    this.instanceId = config.instanceId
    this.requestTimeoutMs = config.requestTimeoutMs
    /* v8 ignore next 1 -- the Config schema applies its delivery default before the constructor runs. */
    this.delivery = config.delivery ?? 'followup'
    /* v8 ignore next 1 -- the Config schema applies its allowResume default before the constructor runs. */
    this.allowResume = config.allowResume ?? true
    // Validate every peer origin before dialing any of them: the same URL
    // construction dial() uses, so a malformed origin fails the load before a
    // socket or reconnect loop exists to leak (misconfiguration fails loud).
    /* v8 ignore next 2 -- the Config schema applies its peers default before the constructor runs. */
    for (const origin of Object.values(config.peers ?? {})) {
      linkUrl(trimBase(origin))
    }
    // Link every configured peer at activation: all delivery is over these
    // persistent links, and addressing is by instanceId through them.
    /* v8 ignore next 1 -- the Config schema applies its peers default before the constructor runs. */
    for (const [peerInstanceId, origin] of Object.entries(config.peers ?? {})) {
      this.link(peerInstanceId, origin)
    }

    const upgrade: WebUpgradeRoute = {
      path: LINK_CHANNEL,
      handler: (req, socket, head) => {
        // `handleUpgrade` handles its own refusals; this catch keeps an
        // unexpected failure from becoming an unhandled rejection behind a
        // client left waiting on an open socket.
        void this.handleUpgrade(req, socket, head).catch((error: unknown) => {
          this.ctx.logger.warn(`interconnect: upgrade failed: ${error instanceof Error ? error.message : String(error)}`)
          socket.destroy()
        })
      },
    }
    // The webserver is optional: without one the service still dials peers and
    // delivers over those outbound links (outbound-only mode). Registering the
    // inbound route through a waiting inject fiber instead of a constructor
    // `ctx.get` means composition order cannot leave the route unregistered —
    // the fiber activates whenever a webserver is available, and headless
    // profiles simply never get one.
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.registerUpgrade(upgrade), 'interconnect: /interconnect/link websocket')
    })

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
        // A socket that closed between sweeps must not reach ping(): ws
        // throws synchronously when ping() is called on a non-OPEN socket.
        if (socket.readyState !== WebSocket.OPEN) {
          this.sockets.delete(socket)
          continue
        }
        if ((socket as WebSocket & { isAlive?: boolean }).isAlive === false) {
          socket.terminate()
          this.sockets.delete(socket)
          continue
        }
        ;(socket as WebSocket & { isAlive?: boolean }).isAlive = false
        socket.ping()
      }
    }, 30000)

    // Protocol constants, not deployment tunables: the heartbeat cadence is
    // fixed by the link-layer liveness contract and the backoff schedule by the
    // reconnect policy, so both stay hardcoded like the frame vocabulary.
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
      this.senders.delete(String(session.id))
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
      /* v8 ignore next 1 -- the constructor sets the interval before registering this teardown effect, so dispose always observes it. */
      if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
      for (const state of this.linkStates.values()) state.close()
      this.linkStates.clear()
      for (const socket of this.sockets) socket.terminate()
      this.sockets.clear()
      this.server.close()
      // Settle every in-flight request as unreachable: without this their
      // timers keep the process alive until they fire, and a late `*-result`
      // could resolve a pending that outlived its caller.
      for (const pending of this.pendingMessages.values()) {
        clearTimeout(pending.timer)
        pending.resolve?.(undefined)
      }
      this.pendingMessages.clear()
      this.disposed = true
    }, 'interconnect: websocket teardown')
  }

  /**
   * This instance's identity to attach to outbound messages. Always present:
   * it needs no address, only this instance's id and the calling session.
   * @param sessionId - the local session that is sending, used as the reply target.
   * @returns this instance's address-free identity for the calling session.
   */
  selfSender(sessionId: string): SenderIdentity {
    return { instanceId: this.instanceId, sessionId }
  }

  /**
   * Deliver one text message to a live session on a peer instance.
   * @param request - the peer instance id, target session, text, and optional delivery/resume overrides.
   * @returns the peer's answer, or an unreachable result when no link answers.
   */
  async send(request: SendRequest): Promise<SendResult> {
    const payload: SendPayload = {
      sessionId: request.sessionId,
      text: request.text,
      ...(request.sender === undefined ? {} : { sender: request.sender }),
      ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
      ...(request.resume === undefined ? {} : { resume: request.resume }),
    }
    try {
      const result = await this.msgRequest(request.instanceId, 'send', payload)
      return result ?? { delivered: false, instance: request.instanceId, reason: 'unreachable' }
    } catch {
      return { delivered: false, instance: request.instanceId, reason: 'unreachable' }
    }
  }

  /**
   * Deliver one text message back to the peer that a local session last
   * received a send from. `sessionId` names the LOCAL replying session; the
   * outbound target is the `sender` that session recorded, addressed through
   * this instance's own link to the sender's instance.
   * @param request - the LOCAL replying session id, the reply text, and optional delivery/resume overrides.
   * @returns the recalled sender's answer, or an unreachable result when no link answers.
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
    try {
      const result = await this.msgRequest(sender.instanceId, 'send', payload)
      return result ?? { delivered: false, instance: sender.instanceId, reason: 'unreachable' }
    } catch {
      return { delivered: false, instance: sender.instanceId, reason: 'unreachable' }
    }
  }

  /**
   * Probe a peer instance for liveness and identity over its persistent link.
   * Returns the peer identity when reachable, or undefined when the link is
   * not up or no answer arrives.
   * @param instanceId - the peer's `instanceId` as configured under {@link Config.peers}.
   * @returns the peer's identity, or undefined when the link is not up or no answer arrives.
   */
  async ping(instanceId: string): Promise<PingResult | undefined> {
    return this.queryRequest(instanceId, { kind: 'ping' }) as Promise<PingResult | undefined>
  }

  /**
   * List a peer instance's live sessions over its persistent link. Undefined on
   * transport failure, matching `ping`.
   * @param instanceId - the peer's `instanceId` as configured under {@link Config.peers}.
   * @returns the peer's live session rows, or undefined on transport failure.
   */
  async list(instanceId: string): Promise<ListResult | undefined> {
    return this.queryRequest(instanceId, { kind: 'list' }) as Promise<ListResult | undefined>
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
    const reqId = `m${++this.reqIdCounter}-${randomUUID()}`
    const message: LinkMessage = {
      kind,
      sessionId: payload.sessionId,
      text: payload.text,
      ...(payload.sender === undefined ? {} : { sender: payload.sender }),
      ...(payload.delivery === undefined ? {} : { delivery: payload.delivery }),
      ...(payload.resume === undefined ? {} : { resume: payload.resume }),
    }
    return this.waitForResult(reqId, 'msg', (failure) => {
      const wrote = state.sendFrame({ type: 'msg', reqId, message })
      /* v8 ignore next 1 -- writable() and sendFrame read the same socket.readyState synchronously, so this guard is unreachable. */
      if (!wrote) failure(new Error(`interconnect: peer link to ${instanceId} closed while sending`))
    }) as Promise<SendResult | undefined>
  }

  /** Send a `query` frame over the live link to a peer and resolve its result. */
  private async queryRequest(instanceId: string, query: { kind: 'ping' } | { kind: 'list' }): Promise<unknown> {
    const state = this.linkStates.get(instanceId)
    if (state === undefined || !state.writable()) return undefined
    const reqId = `q${++this.reqIdCounter}-${randomUUID()}`
    // Validate the answer against the KIND of query this request asked, not
    // just the frame union: a peer answering a `list` with a ping-shaped
    // result would otherwise crash the tool on `result.sessions.map`. An
    // answer that fails its kind's shape is treated as no answer at all.
    const accept = query.kind === 'ping' ? projectPingResult : projectListResult
    try {
      return await this.waitForResult(reqId, 'query', (failure) => {
        const wrote = state.sendFrame({ type: 'query', reqId, query })
        /* v8 ignore next 1 -- writable() and sendFrame read the same socket.readyState synchronously. */
        if (!wrote) failure(new Error(`interconnect: peer link to ${instanceId} closed while querying`))
      }, accept)
    } catch {
      // A peer that never answers must read as transport failure, matching the
      // public JSDoc: `ping`/`list` return undefined when no answer arrives.
      return undefined
    }
  }

  /** Settle a `reqId` frame against its `*-result`, timing out at `requestTimeoutMs`. */
  private waitForResult(
    reqId: string,
    kind: 'msg' | 'query',
    send: (failure: (error: unknown) => void) => void,
    accept?: (result: unknown) => unknown,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(reqId)
        reject(new Error(`interconnect: no result for ${reqId} within ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
      const settle = (result: unknown): void => {
        clearTimeout(timer)
        this.pendingMessages.delete(reqId)
        resolve(result)
      }
      // Only a query pending carries a projector; a `msg-result` is projected by
      // `projectMsgResult` at its own settle site.
      this.pendingMessages.set(reqId, kind === 'query'
        ? { timer, kind, accept: accept as (result: unknown) => unknown, resolve: settle }
        : { timer, kind, resolve: settle })
      /* v8 ignore start -- the failure callback is gated by the writable() check; the timeout rejects instead. */
      send((error: unknown) => {
        clearTimeout(timer)
        this.pendingMessages.delete(reqId)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      /* v8 ignore stop */
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
    const linked = this.link(instanceId, origin)
    const dialedOrigin = trimBase(origin)
    return () => {
      // Close only the state this subscription established AND that still
      // dials the origin it subscribed: link() reuses the same state object
      // for a re-route, so an identity check alone would let an older
      // disposer tear down a route another caller re-pointed. The peer guard
      // covers re-routes to a different origin; an A→B→A round trip that
      // lands back on the subscribed origin is treated as the same route.
      const state = this.linkStates.get(instanceId)
      if (state === linked && state.peer === dialedOrigin) {
        state.close()
        this.linkStates.delete(instanceId)
      }
    }
  }

  /**
   * Remove a peer route, closing its outbound link.
   * @param instanceId - the peer route to remove.
   */
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
    if (existing !== undefined && !existing.isClosed()) {
      existing.reroute(trimBase(origin))
      return existing
    }
    // A closed state is replaced fresh: a handle `close()` followed by a
    // re-link must re-establish the route, not silently reuse a dead state
    // whose reroute/dial both no-op.
    const state = new LinkState(
      (socket) => { this.attachSocket(socket) },
      this.ctx.logger,
      () => this.resolveToken(),
      instanceId,
      trimBase(origin),
    )
    this.linkStates.set(instanceId, state)
    state.dial()
    return state
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
    // A bidirectional pair owns two sockets (its dialed outbound link plus the
    // peer's inbound link); send to each peer once so an event is not echoed
    // back and delivered twice.
    const sent = new Set<string>()
    for (const socket of this.sockets) {
      if (socket.readyState !== WebSocket.OPEN) {
        this.sockets.delete(socket)
        continue
      }
      const peer = this.peerOf.get(socket)
      if (peer !== undefined && sent.has(peer)) continue
      if (peer !== undefined) sent.add(peer)
      socket.send(encoded)
    }
  }

  /**
   * Dispatch one inbound `msg` frame: deliver a `send`/`reply` and answer the
   * correlated `msg-result` on the same socket. Errors are surfaced as the
   * result so a throwing handler cannot escape the socket's message callback.
   */
  private async handleMsgFrame(socket: WebSocket, reqId: string, message: LinkMessage): Promise<void> {
    // Only `send` arrives over the wire: `reply` originates locally (the tool
    // calls `reply()` which sends a regular `send` frame to the recalled
    // sender). A remote `reply` frame would relay arbitrary text through this
    // instance's sender map, so the schema does not admit it.
    const result = await this.deliver({
      sessionId: message.sessionId,
      text: message.text,
      /* v8 ignore next 1 -- schemastery resolves an absent optional `sender` to an empty object, never undefined. */
      ...(message.sender === undefined ? {} : { sender: message.sender }),
      ...(message.delivery === undefined ? {} : { delivery: message.delivery }),
      ...(message.resume === undefined ? {} : { resume: message.resume }),
    })
    this.sendFrame(socket, { type: 'msg-result', reqId, result })
  }

  /** Dispatch one inbound `query` frame (ping/list/event) and answer on the socket. */
  private handleQueryFrame(socket: WebSocket, reqId: string, query: QueryMessage): void {
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
   * Summarize the live local sessions so a sender can discover valid targets
   * instead of having to know a session id already. Only live agents are listed
   * because `send` can reach exactly those, and the answer carries at most
   * {@link MAX_LISTED_SESSIONS} rows so a large live set cannot push the
   * `query-result` frame past the link's frame cap.
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
      .filter(agent => !isSessionOwnedBySubagent(this.ctx, agent.session, agent))
    const sessions: InterconnectSessionSummary[] = []
    let used = 0
    for (const agent of reachable.slice(0, MAX_LISTED_SESSIONS)) {
      const row = this.sessionRow(agent)
      const sized = used + rowBytes(row)
      if (sized > MAX_LIST_ROWS_BYTES) {
        // A title is best-effort: a row whose title does not fit keeps its
        // target and drops the title before it drops out of the listing.
        const untitled = {
          sessionId: row.sessionId,
          ...(row.status === undefined ? {} : { status: row.status }),
        }
        const untitledSized = used + rowBytes(untitled)
        // A row that does not fit even untitled ends the listing: adding a
        // shorter later row would report the set out of order.
        if (untitledSized > MAX_LIST_ROWS_BYTES) break
        sessions.push(untitled)
        used = untitledSized
        continue
      }
      sessions.push(row)
      used = sized
    }
    return { sessions, instance: this.instanceId }
  }

  /** One listing row for a live agent; the title projection is best-effort. */
  private sessionRow(agent: Agent): InterconnectSessionSummary {
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
      const resolved = await lookup.resolve(payload.sessionId)
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
      this.ctx.logger.info(
        `interconnect: resume refused for ${payload.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return { reason: 'resume-failed' }
    }
  }

  /**
   * Deliver one message to a live local session, waking a persisted one only
   * when the sender asked and this receiver allows it.
   */
  private async deliver(payload: SendPayload): Promise<SendResult> {
    // A delivery that outlived the service fiber (an inbound frame already in
    // flight when the plugin unloaded) must not drive a disposed agent.
    if (this.disposed) return { delivered: false, instance: this.instanceId, reason: 'unreachable' }
    let agent = this.ctx.agents.get(payload.sessionId as Agent['id'])
    if (agent === undefined) {
      const woken = await this.wake(payload)
      // The fiber may have unwound while the wake resolution was in flight;
      // re-check before touching a woken agent. oxlint's flow analysis treats
      // the two `disposed` reads as the same value, but `await` is a yield
      // point at which the teardown effect can run.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the service can dispose during the wake await
      if (this.disposed) return { delivered: false, instance: this.instanceId, reason: 'unreachable' }
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
    if (isSessionOwnedBySubagent(this.ctx, agent.session, agent)) {
      return { delivered: false, instance: this.instanceId, reason: 'session-owned-by-subagent' }
    }
    // Remember who sent this message so the receiving session can reply later.
    // `source` never reaches the model, so recording the sender here only sets
    // up reply attribution; the model-facing `content` stays exactly the text
    // that crossed the wire. An absent sender resolves to `{}` under schematery,
    // so test for a real identity rather than `undefined`.
    // The wire shape is untrusted here: a peer may send a partial identity,
    // so validate both fields at runtime before recording a reply target.
    const sender = ((): SenderIdentity | undefined => {
      const candidate: unknown = payload.sender
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const record = candidate as Record<string, unknown>
      if (typeof record.instanceId !== 'string' || typeof record.sessionId !== 'string') return undefined
      return { instanceId: record.instanceId, sessionId: record.sessionId }
    })()
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
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(mode)
    }
    // Record the reply target only after the message committed: a delivery that
    // threw leaves no sender behind, so a later reply cannot target a session
    // whose handoff never landed. A message that carries NO sender (an old peer,
    // or an anonymous relay) clears any earlier mapping, so a reply cannot go
    // back to a stale sender from a previous handoff.
    if (sender !== undefined) {
      this.senders.set(payload.sessionId, sender)
    } else {
      this.senders.delete(payload.sessionId)
    }
    return { delivered: true, instance: this.instanceId, delivery: mode }
  }

  private async resolveToken(): Promise<string | undefined> {
    const credential = await this.ctx.credentials.resolve(credentialRef(INTERCONNECT_TOKEN_REF))
    return credential === undefined || credential.value.length === 0 ? undefined : credential.value
  }

  /**
   * Answer one refused upgrade and close its socket. `socket.end()` alone only
   * half-closes the connection: a client that keeps its own writing side open
   * (a socket created with `allowHalfOpen`) leaves the connection live, and a
   * refused socket never enters the link pool, so nothing else would reap it.
   * @param socket - the refused upgrade socket.
   * @param response - the complete HTTP response sent to the client.
   */
  private refuseUpgrade(socket: Duplex, response: string): void {
    socket.end(response, () => { socket.destroy() })
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
      this.refuseUpgrade(socket, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden')
      return
    }
    if (token === undefined) {
      this.refuseUpgrade(socket, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden')
      return
    }
    // The token read is an await, so the service can be torn down (or the
    // webserver route withdrawn) before it settles. Accepting here would add a
    // socket to a pool the teardown already cleared, with no owner left to
    // close it or answer its heartbeat.
    if (this.disposed) {
      this.refuseUpgrade(socket, 'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 11\r\n\r\nunavailable')
      return
    }
    const expected = `Bearer ${token}`
    const header = req.headers.authorization
    if (header === undefined || !timingSafeEqual(header, expected)) {
      this.refuseUpgrade(socket, 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nunauthorized')
      return
    }
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      this.attachSocket(websocket)
    })
  }

  /**
   * Install frame + liveness handling on one socket and add it to the live
   * pool. Used by both the server half (accepted upgrade) and the client half
   * (outbound dial), so a single socket carries events both directions. Not a
   * model-facing entry point; the outbound dial reaches it through a private
   * closure.
   * @param websocket - the accepted or dialed socket to install handlers on.
   */
  private attachSocket(websocket: WebSocket): void {
    this.sockets.add(websocket)
    ;(websocket as WebSocket & { isAlive: boolean }).isAlive = true
    websocket.on('pong', () => {
      ;(websocket as WebSocket & { isAlive: boolean }).isAlive = true
    })
    websocket.on('message', (data: RawData, isBinary: boolean) => {
      // ws flags the frame opcode: binary frames are a protocol violation (the
      // link vocabulary is JSON text), so drop them before parsing.
      if (isBinary) return
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
  private handleFrame(socket: WebSocket, data: RawData | string): void {
    // Cap inbound frames well below ws's 100 MiB default: a link frame is at
    // most one small message plus metadata, so a larger frame is a hostile or
    // broken peer, not a legitimate handoff.
    const byteLength = typeof data === 'string'
      ? Buffer.byteLength(data)
      : Array.isArray(data)
        ? data.reduce((total, part) => total + part.byteLength, 0)
        : data.byteLength
    if (byteLength > MAX_LINK_FRAME_BYTES) {
      this.ctx.logger.warn('interconnect: dropping oversized link frame')
      return
    }
    // Text frames arrive as Buffers over real sockets (ws flags the opcode
    // separately); the other RawData arms cover alternate binaryType
    // deliveries and the string arm the direct test seams.
    const text = typeof data === 'string'
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8')
    let parsed: unknown
    try {
      parsed = withoutNullFields(z.resolve(JSON.parse(text), linkFrameSchema, {})[0])
    } catch {
      this.ctx.logger.warn('interconnect: dropping malformed link frame')
      return
    }
    // schemastery passes a JSON `null` through a union untouched; reject it
    // like any other malformed frame instead of dereferencing null below.
    if (parsed === null || typeof parsed !== 'object') {
      this.ctx.logger.warn('interconnect: dropping malformed link frame')
      return
    }
    const frame = parsed as LinkFrame
    if (frame.type === 'hello') {
      this.peerOf.set(socket, frame.sender)
      return
    }
    if (frame.type === 'event') {
      const sender = this.peerOf.get(socket) ?? 'unknown-peer'
      const kind = frame.notification.kind // validated above; do not re-read the frame inside the catch
      try {
        this.receiveEvent({ sender, notification: frame.notification })
      } catch (error) {
        // `receiveEvent` emits `interconnect/event`, and Cordis propagates a
        // listener throw back to the emitter. This runs inside the socket's
        // synchronous `message` handler, so an escaping throw becomes an
        // uncaughtException — letting any remote peer kill this process by sending
        // an event a local listener happens to mishandle.
        this.ctx.logger.warn(
          `interconnect: listener for a ${kind} event from ${sender} threw: `
            + (error instanceof Error ? error.message : String(error)),
        )
      }
      return
    }
    if (frame.type === 'msg-result') {
      const pending = this.pendingMessages.get(frame.reqId)
      // A `msg-result` settles only a `msg` request: a query awaiting its
      // `query-result` must never be resolved by a mis-typed frame. The
      // result shape is already enforced by the frame schema; msg requests
      // carry no per-kind accept gate.
      if (pending !== undefined && pending.kind === 'msg') {
        ;pending.resolve?.(projectMsgResult(frame.result))
      }
      return
    }
    if (frame.type === 'query-result') {
      const pending = this.pendingMessages.get(frame.reqId)
      // Only a result that satisfies the pending request's own shape settles
      // it, and the projecting accept returns what settles: anything else is
      // dropped and the request times out as unreachable.
      if (pending !== undefined && pending.kind === 'query') {
        const answer = pending.accept(frame.result)
        if (answer !== undefined) pending.resolve?.(answer)
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
    void Promise.resolve().then(() => {
      this.handleQueryFrame(socket, frame.reqId, frame.query)
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
 * One in-flight request awaiting its `*-result` frame. `waitForResult`
 * installs the timer and settle callbacks; `handleFrame` settles the matching
 * entry when the result arrives.
 */
interface PendingMessage {
  readonly timer: ReturnType<typeof setTimeout>
}
/** A pending that awaits a `msg-result` frame. */
interface PendingMsg extends PendingMessage {
  kind: 'msg'
  resolve?: (result: unknown) => void
}
/** A pending that awaits a `query-result` frame, gated by its request kind's projector. */
interface PendingQuery extends PendingMessage {
  kind: 'query'
  resolve?: (result: unknown) => void
  /** Kind gate and projector: returns the answer to settle with, or undefined to drop the frame. */
  accept: (result: unknown) => unknown
}
/** One pending request: a `msg` outcome is projected at its settle site, a `query` outcome by its own projector. */
type MutablePendingMessage = PendingMsg | PendingQuery

/**
 * One outbound WebSocket peer link: dials, re-dials with backoff after an
 * unexpected drop, and joins the service's live socket pool once open, so
 * local events fan out over the link and the peer's pushes come back in.
 */
class LinkState implements WebSocketLinkHandle {
  private socket: WebSocket | undefined
  private dialEpoch = 0
  private closed = false
  private retry = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private warnedNoToken = false
  /** Dial-registered handlers, removed by reference on close/reroute so the pool-cleanup handlers attachSocket added stay alive. */
  private dialListeners: { open: () => void; close: () => void; error: () => void } | undefined

  // `peer` is mutable so `reroute` can point the link at a new origin.
  peer: string
  readonly instanceId: string

  constructor(
    private readonly attachSocket: (socket: WebSocket) => void,
    private readonly logger: LoggerService,
    private readonly resolveToken: () => Promise<string | undefined>,
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
    // Cancel any in-flight dial: an epoch bump makes a pending token
    // resolution discard itself, and a pending reconnect timer is cleared.
    this.dialEpoch += 1
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const socket = this.socket
    if (socket !== undefined) {
      // Remove only the dial handlers: the attachSocket pool-cleanup
      // handlers must stay, or the terminated socket lingers in the live
      // pool and the heartbeat calls ping() on a non-OPEN socket.
      this.removeDialListeners(socket)
      // A CONNECTING socket emits 'error' asynchronously on terminate; keep a
      // listener so the event cannot escape as an uncaughtException.
      /* v8 ignore next 1 -- a CONNECTING terminate error is timing-dependent and does not fire in tests. */
      socket.on('error', () => {})
      socket.terminate()
      this.socket = undefined
    }
    this.dial()
  }

  /** Open the socket; reconnect is scheduled by the close handler. */
  dial(): void {
    /* v8 ignore next 1 -- close() removes the link state from the map before any later dial can observe it. */
    if (this.closed) return
    const epoch = this.dialEpoch
    let url: URL
    try {
      url = linkUrl(this.peer)
    } catch {
      // The constructor pre-validates configured origins; a runtime `link`/`reroute`
      // with a malformed origin must degrade to a down link, not a thrown dial.
      this.logger.warn(`interconnect: invalid peer origin ${this.peer}; link to ${this.instanceId} stays down`)
      return
    }
    void this.resolveToken().then((token) => {
      if (token === undefined) {
        // Warn once, then keep retrying on the reconnect backoff: a credential
        // injected after this service activated must bring the link up without
        // a restart. The dial re-resolves the token on every retry.
        if (!this.warnedNoToken) {
          this.warnedNoToken = true
          this.logger.warn(`interconnect: no shared token configured; peer ${this.instanceId} link stays down, retrying until one is set`)
        }
        if (this.closed || epoch !== this.dialEpoch) return
        this.scheduleReconnect()
        return
      }
      if (this.closed || epoch !== this.dialEpoch) return
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
        maxPayload: MAX_LINK_FRAME_BYTES,
        // A peer that accepts TCP but never completes the upgrade would leave
        // the socket in CONNECTING forever: no open (so no heartbeat) and no
        // close (so no reconnect). ws aborts the connection past the handshake
        // window, so its own error+close fire and the close handler schedules
        // a reconnect — and ws owns the timer, so nothing leaks on teardown.
        handshakeTimeout: LINK_HANDSHAKE_TIMEOUT_MS,
      })
      this.socket = socket
      const onOpen = (): void => {
        this.retry = 0
        // Same handler as the server half: adds to the live pool and announces
        // this instance's identity over the now-open link.
        this.attachSocket(socket)
      }
      const onClose = (): void => {
        /* v8 ignore next 1 -- close() strips this listener before terminating, so the guard is only reachable on real drops. */
        if (this.closed) return
        this.scheduleReconnect()
      }
      const onError = (): void => {
        // close follows; reconnect is scheduled there.
      }
      this.dialListeners = { open: onOpen, close: onClose, error: onError }
      socket.once('open', onOpen)
      socket.once('close', onClose)
      socket.on('error', onError)
    }).catch(() => {
      // A rejecting token read must not become an unhandled rejection, and must
      // not silently end the dial loop either: without this the link would stay
      // down until the process restarted, since no socket was ever created and
      // so no `close` will arrive to schedule the retry. A failure from a
      // SUPERSEDED dial epoch (a reroute happened while the token read was in
      // flight) schedules nothing: the reroute already dialed.
      if (this.closed || epoch !== this.dialEpoch) return
      this.scheduleReconnect()
    })
  }

  /** Whether this link has been closed; a closed state is never reused by `link()`. */
  isClosed(): boolean {
    return this.closed
  }

  /** Whether this link currently holds an open socket that can carry frames. */
  writable(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN
  }

  /** Write one frame over this link's outbound socket; false when not open. */
  sendFrame(frame: LinkFrame): boolean {
    const socket = this.socket
    /* v8 ignore next 1 -- callers gate on writable(), which reads the same readyState synchronously; this guard is unreachable. */
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    const socket = this.socket
    if (socket !== undefined) {
      // Remove only the dial handlers (see reroute): the attachSocket
      // pool-cleanup handlers must stay so the pool does not retain the
      // terminated socket.
      this.removeDialListeners(socket)
      // A CONNECTING socket emits 'error' asynchronously on terminate; keep a
      // listener so the event cannot escape as an uncaughtException. Callers
      // delete this link's state from the map themselves.
      /* v8 ignore next 1 -- a CONNECTING terminate error is timing-dependent and does not fire in tests. */
      socket.on('error', () => {})
      socket.terminate()
    }
  }

  /** Detach the dial-registered handlers from a socket before terminating it. */
  private removeDialListeners(socket: WebSocket): void {
    const listeners = this.dialListeners
    if (listeners === undefined) return
    socket.removeListener('open', listeners.open)
    socket.removeListener('close', listeners.close)
    socket.removeListener('error', listeners.error)
    this.dialListeners = undefined
  }

  private scheduleReconnect(): void {
    /* v8 ignore next 1 -- the 30s cap binds only after five consecutive reconnect failures (~31s of wall time). */
    const delay = Math.min(30000, 1000 * 2 ** this.retry)
    this.retry += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.dial()
    }, delay)
  }
}

/**
 * Constant-time comparison of two strings. Each side is digest-normalized
 * first, so the buffers passed to `timingSafeEqual` always match in length:
 * a malformed multi-byte Authorization header cannot reach the crypto layer
 * with a mismatched length, and the comparison leaks no length information.
 */
function timingSafeEqual(a: string, b: string): boolean {
  return constantTimeEqual(createHash('sha256').update(a, 'utf8').digest(), createHash('sha256').update(b, 'utf8').digest())
}

/**
 * Map one HTTP(S) peer origin to the WebSocket URL of its link route. Only
 * the plain-HTTP schemes are rewritten to their WebSocket equivalents; an
 * explicit `wss:` (or `ws:`) origin keeps its scheme, so a TLS peer link is
 * never downgraded to plaintext. Any other scheme (ftp:, file:, ...) is
 * rejected so a misconfigured origin fails loudly instead of feeding
 * `new WebSocket` a URL it cannot dial.
 * @param origin - peer origin as configured, e.g. `http://127.0.0.1:13080`.
 * @returns the link URL, e.g. `ws://127.0.0.1:13080/interconnect/link`.
 * @throws TypeError when the origin is not a valid absolute URL or maps to a
 *   non-WebSocket protocol.
 */
export function linkUrl(origin: string): URL {
  const url = new URL('/interconnect/link', origin)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError(`interconnect: unsupported peer origin protocol ${url.protocol}`)
  }
  return url
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export default InterconnectService
