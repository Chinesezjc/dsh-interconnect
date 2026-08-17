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
 * Business payload for the `send` endpoint: deliver one text message to one
 * live session of the receiving instance.
 */
export interface SendPayload {
  /** Target session id on the receiving instance. */
  readonly sessionId: string
  /** Message text delivered to the peer session's inbox. */
  readonly text: string
  /**
   * Per-message override of the receiver's configured delivery mode. Urgency is
   * a property of one message, not of the link, so a sender may ask to cut into
   * a running turn. Absent leaves the receiver's configured default in force.
   */
  readonly delivery?: DeliveryMode
}

/**
 * Why a `send` did not deliver. `delivered: false` alone cannot be acted on,
 * because the two causes need opposite responses:
 * - `session-not-live` — the receiver answered; that session has no running
 *   agent. Retrying the same id is futile until it is opened, so the caller
 *   should list live sessions and pick another target.
 * - `unreachable` — no usable answer from the receiver (transport failure, or
 *   auth rejected). The target may well be fine, so retrying can succeed.
 */
export type SendFailure = 'session-not-live' | 'unreachable'

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

/** Outbound listing request: just the receiver origin. */
export interface ListRequest {
  /** Receiver origin, e.g. `http://127.0.0.1:3080`. */
  readonly baseUrl: string
}

/** Outbound delivery request: receiver origin plus a `send` business payload. */
export interface SendRequest {
  /** Receiver origin, e.g. `http://127.0.0.1:3080`. */
  readonly baseUrl: string
  readonly sessionId: string
  readonly text: string
  /** Per-message delivery override forwarded to the receiver. */
  readonly delivery?: DeliveryMode
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
 * notification in either direction. Native ws ping/pong carries the heartbeat,
 * so no application-level keepalive frame exists.
 */
export type LinkFrame =
  | { readonly type: 'hello'; readonly sender: string }
  | { readonly type: 'event'; readonly notification: EventNotification }

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
   * Peer instance origins to fan local events out to at startup. A runtime
   * `subscribe` can extend the set without restart; an unset list fans nothing
   * out until a peer subscribes.
   */
  readonly peers?: string[]
  /**
   * Default mode for inbound `send` messages that carry no per-message
   * override. See {@link DeliveryMode} for what each mode does.
   */
  readonly delivery?: DeliveryMode
}
