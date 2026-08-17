/**
 * Model-facing tools for cross-instance message handoff: `interconnect_send`
 * delivers one text message to a live session on a peer DSH instance, and
 * `interconnect_ping` probes a peer's liveness and identity.
 *
 * The tools consume the host-plane `interconnect` service and publish nothing
 * themselves, so this row sits as an ordinary tool plugin in a preset while
 * the service it reaches stays host-side (the same split `tool-goal` uses
 * against `goals`).
 * @module @deepseek-ai/dsh-tool-interconnect
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Activates the `Context.interconnect` merge declared by the interconnect service plugin.
import type {} from '../interconnect/index.ts'

/** Services required before the tools can register. */
export const inject = ['interconnect', 'tools']

/**
 * Register the two tool surfaces. Registration is idempotent per fiber; the
 * tools unregister with the owning fiber.
 * @param ctx - connection context carrying the interconnect service and the tool registry.
 */
export function apply(ctx: Context): void {
  const interconnect = ctx.interconnect

  ctx.tools.register(defineTool({
    name: 'interconnect_send',
    description: 'Deliver one text message to a live session on another DSH instance (same machine, '
      + 'another machine, or another session), over a shared-secret-authenticated channel. '
      + 'Returns whether the peer instance received it and which instance answered.',
    parameters: {
      baseUrl: {
        type: 'string',
        required: true,
        description: 'Receiver instance origin, e.g. http://127.0.0.1:3080 or http://peer-host:9001.',
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          instance: { type: 'string', required: true },
          delivery: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `delivered to ${value.instance}${value.delivery === undefined ? '' : ` via ${value.delivery}`}`
          : `not delivered (no live session on ${value.instance})`,
      }],
    },
    async execute(args) {
      const result = await interconnect.send({
        baseUrl: args.baseUrl,
        sessionId: args.sessionId,
        text: args.text,
        ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
      })
      return {
        delivered: result.delivered,
        instance: result.instance,
        ...(result.delivery === undefined ? {} : { delivery: result.delivery }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interconnect_ping',
    description: 'Probe a peer DSH instance for liveness and identity over the shared-secret channel. '
      + 'Returns the peer instance id when reachable, or null on transport/auth failure.',
    parameters: {
      baseUrl: {
        type: 'string',
        required: true,
        description: 'Peer instance origin, e.g. http://127.0.0.1:3080.',
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
    async execute(args) {
      const result = await interconnect.ping(args.baseUrl)
      if (result === undefined) return { reachable: false }
      return { reachable: true, instance: result.instance }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interconnect_list',
    description: 'List the live sessions on a peer DSH instance, so a message can be addressed without '
      + 'knowing a session id in advance. Every returned sessionId is a valid interconnect_send target at '
      + 'the time of the call. Only live sessions appear: a session that exists on the peer but has no '
      + 'running agent is not listed and cannot receive a message.',
    parameters: {
      baseUrl: {
        type: 'string',
        required: true,
        description: 'Peer instance origin, e.g. http://127.0.0.1:3080.',
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
    async execute(args) {
      const result = await interconnect.list(args.baseUrl)
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
}
