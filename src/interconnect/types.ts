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
 * Business payload for the `send` endpoint: deliver one text message to one
 * live session of the receiving instance.
 */
export interface SendPayload {
  /** Target session id on the receiving instance. */
  readonly sessionId: string
  /** Message text delivered to the peer session's inbox. */
  readonly text: string
}

/** Business result of a `send` endpoint call. */
export interface SendResult {
  /** True when the target session is live on the receiving instance and the message was delivered. */
  readonly delivered: boolean
  /** Echoed receiver instance id (diagnostic; never trusted for routing). */
  readonly instance: string
}

/** Business result of a `ping` endpoint call. */
export interface PingResult {
  /** Always true for an authenticated, live receiver. */
  readonly pong: true
  /** The receiving instance's self-reported id. */
  readonly instance: string
}

/** Outbound delivery request: receiver origin plus a `send` business payload. */
export interface SendRequest {
  /** Receiver origin, e.g. `http://127.0.0.1:3080`. */
  readonly baseUrl: string
  readonly sessionId: string
  readonly text: string
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
   * How an inbound `send` message reaches its target session.
   * - `followup` wakes the target agent into a new turn carrying the message.
   * - `inject` seeds model-facing context without waking the agent (it is
   *   claimed at the next step boundary, and may miss a step already claimed).
   */
  readonly delivery?: 'followup' | 'inject'
}
