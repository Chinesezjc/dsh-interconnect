/**
 * Wire contracts for `@deepseek-ai/dsh-interconnect`.
 * The transport reuses the Connection RPC envelope (`ClientRequest` /
 * `ServerResponse` from `@deepseek-ai/dsh-host-apiproxy/api`); this module
 * defines only the business payloads that ride inside that envelope.
 * @module @deepseek-ai/dsh-interconnect
 */

/**
 * Logical HTTP route prefix this service owns. Requests reach endpoints as
 * `<baseURL>/interconnect/<endpoint>`.
 */
export const INTERCONNECT_CHANNEL = '/interconnect'

/**
 * Credential reference holding the shared auth token. Both halves of a link
 * must resolve the same value: inbound requests are rejected unless their
 * `Authorization: Bearer <token>` matches this secret, and outbound requests
 * send it. An unconfigured token fails closed on the inbound side.
 */
export const INTERCONNECT_TOKEN_REF = 'DSH_INTERCONNECT_TOKEN'

/**
 * How one inbound message reaches the target agent's inbox. Each value names an
 * existing `Agent` method, which is exactly the pair `(inbox target, wakeup)`:
 * - `followup` — `next-turn` + wake: the message becomes its own turn, queued
 *   behind whatever the agent is currently doing.
 * - `steer` — `next-step` + wake: the message cuts into the nearest step
 *   boundary of a running turn instead of waiting for that turn to finish; an
 *   idle agent starts a turn.
 * - `inject` — `next-step`, no wake: seeds model-facing context without waking
 *   an idle agent, so it can sit unread until something else wakes it.
 */
export type DeliveryMode = 'followup' | 'steer' | 'inject'

/**
 * Self-reported identity of the peer that sent a message, carried for reply
 * attribution and echoed `sessionId` of the sending instance. Address-free on
 * purpose: every delivery goes over an already-established WebSocket link, so
 * the receiver addresses a `reply` by recalling the sender's `instanceId` and
 * using its OWN outbound link to that instance — no origin crosses the wire.
 * Both fields are sender-supplied and self-reported; the receiver stores them
 * only to address a `reply`, never as an auth or routing authority (the shared
 * secret still authenticates the connection itself).
 */
export interface SenderIdentity {
  /** The sender's self-reported instance id (diagnostic, as in `ping`). */
  readonly instanceId: string
  /** Session id on the sender's instance to which a `reply` is addressed. */
  readonly sessionId: string
}

/**
 * Business payload for the `send` endpoint: deliver one text message to one
 * live session of the receiving instance.
 */
export interface SendPayload {
  /** Target session id on the receiving instance. */
  readonly sessionId: string
  /** Message text delivered to the peer session's inbox. */
  readonly text: string
  /**
   * The sender's identity, so the receiver can attribute the message and
   * address a reply back. Optional for backward compatibility: a peer running
   * an older version omits it, and the receiver simply has nothing to reply to.
   */
  readonly sender?: SenderIdentity
  /**
   * Per-message override of the receiver's configured delivery mode. Urgency is
   * a property of one message, not of the link, so a sender may ask to cut into
   * a running turn. Absent leaves the receiver's configured default in force.
   */
  readonly delivery?: DeliveryMode
  /**
   * Ask the receiver to wake a persisted session that has no running agent.
   *
   * Opt-in, and deliberately not the default: delivery to a woken session runs
   * a real agent turn — a billed model call whose assembly carries that
   * session's full toolset — inside a conversation its owner is not watching
   * and cannot interrupt. That is categorically more than nudging an already
   * open session, so the sender must ask for it explicitly. The receiver can
   * still refuse via `Config.allowResume`, because the cost lands on its
   * machine.
   */
  readonly resume?: boolean
}

/**
 * Why a `send` did not deliver. `delivered: false` alone cannot be acted on,
 * because the causes need different responses:
 * - `session-not-live` — the receiver answered; that session has no running
 *   agent. Retrying the same id is futile until it is opened, so the caller
 *   should list live sessions and pick another target.
 * - `unreachable` — no usable answer from the receiver (transport failure, or
 *   auth rejected). The target may well be fine, so retrying can succeed.
 * - `resume-refused` — the sender asked to wake a persisted session and this
 *   receiver does not allow it. Retrying with `resume` set changes nothing.
 * - `resume-failed` — waking was allowed and attempted but did not yield a live
 *   agent (no persisted session under that id, or another owner holds it).
 * - `session-owned-by-subagent` — the session is reserved to subagent routing,
 *   so its parent agent owns delivery. Injecting here would race that parent;
 *   the sender must reach the child through its parent instead.
 * - `no-sender-known` — a `reply` was addressed to a local session that never
 *   recorded a sender, either because that session did not receive a message
 *   through this service or the incoming message carried no `sender` identity
 *   (an older peer omitted it).
 */
export type SendFailure = 'session-not-live' | 'unreachable' | 'resume-refused' | 'resume-failed' | 'session-owned-by-subagent' | 'no-sender-known'

/** Business result of a `send` endpoint call. */
export interface SendResult {
  /** True when the target session is live on the receiving instance and the message was delivered. */
  readonly delivered: boolean
  /** Echoed receiver instance id (diagnostic; never trusted for routing). */
  readonly instance: string
  /**
   * The mode actually used, so a sender can tell whether its requested override
   * took effect. Absent when nothing was delivered.
   */
  readonly delivery?: DeliveryMode
  /**
   * Why delivery failed. Present exactly when `delivered` is false, so a caller
   * can distinguish "wrong target" from "receiver unreachable" instead of
   * guessing from a bare boolean.
   */
  readonly reason?: SendFailure
}

/** Business result of a `ping` endpoint call. */
export interface PingResult {
  /** Always true for an authenticated, live receiver. */
  readonly pong: true
  /** The receiving instance's self-reported id. */
  readonly instance: string
}

/**
 * One live session on the receiving instance. Only live agents appear: `send`
 * can reach exactly these, so the listing is the set of valid `sessionId`
 * values rather than a directory of everything ever persisted.
 */
export interface SessionSummary {
  /** The session id to pass back as `SendPayload.sessionId`. */
  readonly sessionId: string
  /**
   * The session's title when a title projection is available. Absent rather
   * than empty when the projection is missing or the session has no title yet,
   * so a caller can tell "untitled" from "titles unavailable on this receiver".
   */
  readonly title?: string
  /** The agent's current status, so a sender can prefer an idle target. */
  readonly status?: string
}

/** Business result of a `list` endpoint call. */
export interface ListResult {
  /** Live sessions in registration order. */
  readonly sessions: readonly SessionSummary[]
  /** Echoed receiver instance id (diagnostic; never trusted for routing). */
  readonly instance: string
}

/** Outbound listing request: which peer instance to list. */
export interface ListRequest {
  /** Peers' `instanceId` as configured under {@link Config.peers}. */
  readonly instanceId: string
}

/** Outbound delivery request: which peer instance plus a `send` business payload. */
export interface SendRequest {
  /**
   * The peer instance to deliver to, as configured under {@link Config.peers}.
   * The origin used to reach it comes from that instance's own link.
   */
  readonly instanceId: string
  readonly sessionId: string
  readonly text: string
  /**
   * This sender's identity, forwarded so the receiver can attribute the
   * message and address a reply back.
   */
  readonly sender?: SenderIdentity
  /** Per-message delivery override forwarded to the receiver. */
  readonly delivery?: DeliveryMode
  /** Ask the receiver to wake a persisted session; see {@link SendPayload.resume}. */
  readonly resume?: boolean
}

/**
 * Business payload for the `reply` endpoint: deliver one text message back to
 * the peer that a given local session most recently received a message from.
 * `sessionId` names the LOCAL session; the outbound target is the sender this
 * session recorded, so the caller does not need to know the peer's origin or
 * session id again.
 */
export interface ReplyPayload {
  /** Local session id that received the message being replied to. */
  readonly sessionId: string
  /** Message text delivered back to the recorded sender's session. */
  readonly text: string
  /** Per-message delivery override forwarded to the recalled sender. */
  readonly delivery?: DeliveryMode
  /** Ask the recalled sender's receiver to wake a persisted session. */
  readonly resume?: boolean
}

/** Outbound reply request: which local session is replying, plus the text. */
export interface ReplyRequest {
  /** Local session id that received the message being replied to. */
  readonly sessionId: string
  readonly text: string
  /** Per-message delivery override forwarded to the recalled sender. */
  readonly delivery?: DeliveryMode
  /** Ask the recalled sender's receiver to wake a persisted session. */
  readonly resume?: boolean
}

/**
 * One serializable lifecycle fact pushed from an emitting instance to its
 * peers. `kind` discriminates the union; the remaining fields are the compact
 * facts extractable from the source event without serializing live objects.
 */
export type EventNotification =
  | { readonly kind: 'agent/created'; readonly sessionId: string }
  | { readonly kind: 'agent/disposed'; readonly sessionId: string }
  | { readonly kind: 'agent/status'; readonly sessionId: string; readonly status: 'idle' | 'running' }
  | { readonly kind: 'session/created'; readonly sessionId: string; readonly parentSessionId?: string }
  | { readonly kind: 'session/disposed'; readonly sessionId: string }
  | { readonly kind: 'subagent/end'; readonly provider: string; readonly childSessionId: string; readonly stopReason: string }

/**
 * Wire payload for the `event` endpoint: the pushed fact plus the emitting
 * instance's self-reported id, so a many-upstream receiver can attribute it.
 */
export interface EventPayload {
  /** Emitting instance's self-reported id. */
  readonly sender: string
  /** The serialized lifecycle fact. */
  readonly notification: EventNotification
}

/**
 * One text frame exchanged over a persistent WebSocket peer link. `hello`
 * opens a link with the dialing side's identity; `event` pushes one
 * notification in either direction; `msg`/`msg-result` carry a
 * request/response message delivery over the same long-lived link (correlated
 * by `reqId`). Native ws ping/pong carries the heartbeat, so no application
 * keepalive frame exists.
 */
export type LinkFrame =
  | { readonly type: 'hello'; readonly sender: string }
  | { readonly type: 'event'; readonly notification: EventNotification }
  | { readonly type: 'msg'; readonly reqId: string; readonly message: LinkMessage }
  | { readonly type: 'msg-result'; readonly reqId: string; readonly result: SendResult }
  | { readonly type: 'query'; readonly reqId: string; readonly query: QueryMessage }
  | { readonly type: 'query-result'; readonly reqId: string; readonly result: unknown }

/**
 * A request/response query carried by `query`/`query-result` frames, used for
 * the discovery endpoints (`ping`, `list`) over the persistent link. `ping`
 * answers the peer's identity; `list` answers the peer's live session rows.
 */
export type QueryMessage =
  | { readonly kind: 'ping' }
  | { readonly kind: 'list' }
  | { readonly kind: 'event'; readonly notification: EventNotification }

/**
 * The message-shaped business payload carried by a `msg` link frame. `kind`
 * picks the delivery semantics: `send` targets the named remote session,
 * `reply` targets the sender a local session recorded. One tagged union keeps
 * the frame count down while the receiver dispatches on `kind`.
 */
export type LinkMessage =
  | {
    readonly kind: 'send'
    readonly sessionId: string
    readonly text: string
    /** Delivered and attributed upstream exactly as in `SendPayload`. */
    readonly sender?: SenderIdentity
    readonly delivery?: DeliveryMode
    readonly resume?: boolean
  }
  | {
    readonly kind: 'reply'
    /** LOCAL session id that received the message being replied to. */
    readonly sessionId: string
    readonly text: string
    /** Attribution for the replying instance, so the peer can reply back. */
    readonly sender?: SenderIdentity
    readonly delivery?: DeliveryMode
    readonly resume?: boolean
  }

/**
 * Handle to one established outbound WebSocket peer link. `close` tears the
 * socket down and cancels reconnection; `peer` records the dialed receiver.
 */
export interface WebSocketLinkHandle {
  /** The dialed peer origin. */
  readonly peer: string
  /** Terminate the socket and stop reconnect attempts. */
  close(): void
}

/** Service config bound by the Composition loader. */
export interface Config {
  /** Self-reported id of this instance, echoed in ping/send results for diagnostics. */
  readonly instanceId: string
  /** Request timeout for outbound deliveries, in milliseconds. */
  readonly requestTimeoutMs: number
  /**
   * Peer instance routes, keyed by the peer's `instanceId`, valued by the
   * origin this instance dials to reach that peer (e.g. a tunnel endpoint
   * `http://127.0.0.1:13080`). At activation each peer is linked over a
   * persistent WebSocket (heartbeat + reconnect), and every outbound
   * `send`/`reply`/`ping`/`list` is addressed by `instanceId` through that
   * instance's own link. An origin is the ONLY routing authority — `instanceId`
   * is never used to derive an address.
   *
   * Fan-out of local lifecycle events also goes to every peer in this map.
   * A runtime `subscribe(instanceId, origin)` can extend the map without
   * restart; retuning the origin of an existing peer re-routes it.
   */
  readonly peers?: Record<string, string>
  /**
   * Default mode for inbound `send` messages that carry no per-message
   * override. See {@link DeliveryMode} for what each mode does.
   */
  readonly delivery?: DeliveryMode
  /**
   * Whether this instance honours a sender's `resume` request. Defaults to
   * true: the sender must opt in per message anyway, and this switch exists so
   * the side that pays — waking a session runs a billed model turn with that
   * session's tools on THIS machine — can refuse outright.
   */
  readonly allowResume?: boolean
}
