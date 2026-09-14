/**
 * Model-facing tools for cross-instance message handoff: `interconnect_send`
 * delivers one text message to a live session on a peer DSH instance,
 * `interconnect_ping` probes a peer's liveness and identity, `interconnect_list`
 * discovers a peer's live sessions, and `interconnect_reply` answers the sender
 * a local session last heard from.
 *
 * The tools consume the host-plane `interconnect` service and publish nothing
 * themselves; the profile layer that enables cross-instance handoff mounts the
 * service, these tools, and the companion skill together.
 * @module @deepseek-ai/dsh-experimental-tool-interconnect
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Activates the `Context.interconnect` merge declared by the interconnect service plugin.
import type {} from '../interconnect/index.ts'

/** Cordis plugin name. */
export const name = 'tool-interconnect'

/** Services required before the tools can register. */
export const inject = ['interconnect', 'tools']

/** Shared `delivered`/`instance`/`delivery`/`reason` outcome shape of send and reply. */
const deliveryOutcomeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    delivered: { type: 'boolean', required: true },
    instance: { type: 'string', required: true },
    delivery: { type: 'string' },
    reason: { type: 'string' },
  },
} as const

/** Settle a service promise against the executing agent's cancellation signal. */
const raceSignal = <T>(signal: AbortSignal, promise: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'aborted'))
    }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })

/** Project one send/reply service result into the tool's canonical outcome. */
const deliveryOutcome = (result: {
  delivered: boolean
  instance: string
  delivery?: string
  reason?: string
}): { delivered: boolean; instance: string; delivery?: string; reason?: string } => ({
  delivered: result.delivered,
  instance: result.instance,
  ...(result.delivery === undefined ? {} : { delivery: result.delivery }),
  ...(result.reason === undefined ? {} : { reason: result.reason }),
})

/**
 * Register the four tool surfaces. Registration is idempotent per fiber; the
 * tools unregister with the owning fiber.
 * @param ctx - connection context carrying the interconnect service and the tool registry.
 */
export function apply(ctx: Context): void {
  const interconnect = ctx.interconnect

  ctx.tools.register(defineTool({
    name: 'interconnect_send',
    description: 'Deliver one text message to a live session on another DSH instance (same machine, '
      + 'another machine, or another session), over a shared-secret-authenticated channel. '
      + 'Returns whether the peer instance received it and which instance answered. '
      + 'Only a session with a running agent receives directly; a persisted one can be woken by '
      + 'setting resume, and when delivery fails the result reports the reason (for example '
      + '"session-not-live") and interconnect_list shows which sessions are live there. '
      + 'The sending instance and session ids are attached automatically, so the receiver can reply '
      + 'with interconnect_reply; do not pass a sender parameter.',
    parameters: {
      instanceId: {
        type: 'string',
        required: true,
        description: 'The peer instance id to deliver to, as configured under this instance\'s '
          + 'interconnect peers map. Deliveries go over the persistent link to that instance.',
      },
      sessionId: {
        type: 'string',
        required: true,
        description: 'Target session id on the receiving instance to deliver the message to.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Message text delivered to the peer session.',
      },
      delivery: {
        type: 'string',
        enum: ['followup', 'steer', 'inject'],
        description: 'How the message reaches the target agent. `followup` queues it as its own turn '
          + 'behind whatever that agent is doing now. `steer` cuts into the nearest step boundary of a '
          + 'running turn, so an urgent message does not wait for that turn to end. `inject` seeds '
          + 'context without waking an idle agent, so it may sit unread. Omit to use the receiver\'s '
          + 'configured default.',
      },
      resume: {
        type: 'boolean',
        description: 'Wake the target session if it is persisted but has no running agent. Off by '
          + 'default because delivery to a woken session starts a real agent turn — a billed model call '
          + 'with that session\'s full toolset — in a conversation nobody is watching. Prefer '
          + 'interconnect_list and an already-live target; set this only when that specific session must '
          + 'be reached. The receiver may refuse, answering reason "resume-refused".',
      },
    },
    output: {
      schema: deliveryOutcomeSchema,
      render: (_args, value) => {
        if (value.delivered) {
          return [{
            type: 'text',
            text: `delivered to ${value.instance}${value.delivery === undefined ? '' : ` via ${value.delivery}`}`,
          }]
        }
        // Each failure gets the response it actually needs: a not-live target
        // is the caller's to re-choose, while an unreachable peer is a delivery
        // outcome rather than a liveness claim.
        const text = ((): string => {
          switch (value.reason) {
            case 'unreachable':
              return `not delivered: ${value.instance} did not answer (unreachable or unauthorized)`
            case 'resume-refused':
              return `not delivered: ${value.instance} does not allow waking persisted sessions`
            case 'resume-failed':
              return `not delivered: could not wake "${_args.sessionId}" on ${value.instance}`
                + ' (no such persisted session, or another owner holds it)'
            case 'session-owned-by-subagent':
              return `not delivered: "${_args.sessionId}" is a subagent's session on ${value.instance}`
                + ' — its parent agent owns delivery, so reach it through that parent'
            default:
              // When the caller already asked to wake this session, the only
              // honest next step is choosing a live target, not re-requesting
              // resume.
              return `not delivered: no live session "${_args.sessionId}" on ${value.instance}`
                + (_args.resume === true
                  ? ' — use interconnect_list to see which sessions are live there'
                  : ' — use interconnect_list to see which sessions are live there, or set resume to wake this one')
          }
        })()
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      const self = interconnect.selfSender(sessionId === undefined ? '' : String(sessionId))
      const result = await raceSignal(exec.signal, interconnect.send({
        instanceId: args.instanceId,
        sessionId: args.sessionId,
        text: args.text,
        // Attribute this instance as the sender so the peer can reply back. The
        // calling session id comes from the executing agent (the session sending).
        sender: self,
        ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
        ...(args.resume === undefined ? {} : { resume: args.resume }),
      }))
      return deliveryOutcome(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interconnect_ping',
    description: 'Probe a peer DSH instance for liveness and identity over the shared-secret channel. '
      + 'Reports reachable with the peer instance id, or unreachable when the link is down or unauthorized.',
    parameters: {
      instanceId: {
        type: 'string',
        required: true,
        description: 'The peer instance id to probe, as configured under this instance\'s '
          + 'interconnect peers map.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reachable: { type: 'boolean', required: true },
          instance: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.reachable
          ? `reachable: ${value.instance ?? '(unknown instance)'}`
          : 'unreachable or unauthorized',
      }],
    },
    async execute(args, exec) {
      const result = await raceSignal(exec.signal, interconnect.ping(args.instanceId))
      if (result === undefined) return { reachable: false }
      return { reachable: true, instance: result.instance }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interconnect_list',
    description: 'List the live sessions on a peer DSH instance, so a message can be addressed without '
      + 'knowing a session id in advance. Every returned sessionId is a valid interconnect_send target at '
      + 'the time of the call. Only sessions with a running agent appear; reaching a persisted one that is '
      + 'not listed requires interconnect_send with resume set.',
    parameters: {
      instanceId: {
        type: 'string',
        required: true,
        description: 'The peer instance id to list, as configured under this instance\'s '
          + 'interconnect peers map.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reachable: { type: 'boolean', required: true },
          instance: { type: 'string' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.reachable) return [{ type: 'text', text: 'unreachable or unauthorized' }]
        const sessions = value.sessions ?? []
        if (sessions.length === 0) {
          return [{ type: 'text', text: `no live sessions on ${value.instance ?? '(unknown instance)'}` }]
        }
        const lines = sessions.map((session) => {
          const title = session.title === undefined ? '' : ` ${session.title}`
          const status = session.status === undefined ? '' : ` [${session.status}]`
          return `${session.sessionId}${title}${status}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const result = await raceSignal(exec.signal, interconnect.list(args.instanceId))
      if (result === undefined) return { reachable: false }
      return {
        reachable: true,
        instance: result.instance,
        // Rebuild each row so an optional key stays absent rather than
        // becoming an explicit undefined the wire schema would reject.
        sessions: result.sessions.map(session => ({
          sessionId: session.sessionId,
          ...(session.title === undefined ? {} : { title: session.title }),
          ...(session.status === undefined ? {} : { status: session.status }),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interconnect_reply',
    description: 'Deliver one text message back to the peer that this session last received an '
      + 'interconnect message from. Only the reply text is needed: the replying session is this '
      + 'agent\'s own, and the outbound target (the peer origin and its session id) is recalled '
      + 'from the message this session received, so you do not ask for an address twice. A session '
      + 'that never received a message through interconnect — or received one without a sender '
      + 'identity — reports reason "no-sender-known".',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'Message text delivered back to the recorded sender session.',
      },
      delivery: {
        type: 'string',
        enum: ['followup', 'steer', 'inject'],
        description: 'How the reply reaches the target agent, as in interconnect_send. Omit to use '
          + "the receiver's configured default.",
      },
      resume: {
        type: 'boolean',
        description: 'Wake the target session if it is persisted but has no running agent, as in '
          + 'interconnect_send. Off by default; the receiver may refuse.',
      },
    },
    output: {
      schema: deliveryOutcomeSchema,
      render: (_args, value) => {
        if (value.delivered) {
          return [{
            type: 'text',
            text: `replied to ${value.instance}${value.delivery === undefined ? '' : ` via ${value.delivery}`}`,
          }]
        }
        const text = ((): string => {
          if (value.reason === 'no-sender-known') {
            return 'not delivered: this session never received an interconnect message with a sender identity'
          }
          if (value.reason === 'session-owned-by-subagent') {
            return 'not delivered: the recorded sender\'s session belongs to a subagent and its parent agent owns delivery'
          }
          if (value.reason === 'unreachable') {
            return 'not delivered: the recorded sender did not answer (unreachable or unauthorized)'
          }
          if (value.reason === 'resume-refused') {
            return 'not delivered: the recorded sender does not allow waking persisted sessions'
          }
          if (value.reason === 'resume-failed') {
            return 'not delivered: could not wake the recorded sender\'s session'
          }
          return 'not delivered: the recorded sender\'s session is not live'
        })()
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        return { delivered: false, instance: 'unknown', reason: 'session-not-live' }
      }
      const result = await raceSignal(exec.signal, interconnect.reply({
        // The replying session is this executing agent's own session, never a
        // model-supplied id: the local sender map is keyed by session, so a
        // forged id could reply as another session.
        sessionId: String(exec.agent.session.id),
        text: args.text,
        ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
        ...(args.resume === undefined ? {} : { resume: args.resume }),
      }))
      return deliveryOutcome(result)
    },
  }))
}
