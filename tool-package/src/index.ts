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
// Activates the `Context.interconnect` merge declared by the interconnect package.
import type {} from '@deepseek-ai/dsh-interconnect'

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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          instance: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `delivered to ${value.instance}`
          : `not delivered (no live session on ${value.instance})`,
      }],
    },
    async execute(args) {
      const result = await interconnect.send({
        baseUrl: args.baseUrl,
        sessionId: args.sessionId,
        text: args.text,
      })
      return { delivered: result.delivered, instance: result.instance }
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
}
