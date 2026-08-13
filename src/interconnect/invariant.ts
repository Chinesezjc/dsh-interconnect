/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-interconnect`.
 * @module @deepseek-ai/dsh-interconnect/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-interconnect'

/** Cordis companion plugin name. */
export const name = 'interconnect-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * Owned relation: the interconnect HTTP route must vanish when its owning
 * fiber unloads, or a stale route keeps serving disposed-plugin handlers.
 * Mirrors the webserver invariant: register/dispose a probe route and assert
 * the disposer really removed it.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/plugin', () => {
    const server = ctx.get('webServer') as
      | { register(route: { kind: 'exact'; path: string; handler: () => void }): () => void }
      | undefined
    if (server === undefined) return
    const probe = { kind: 'exact' as const, path: '/__dsh_interconnect_invariant_probe__', handler: () => {} }
    try {
      server.register(probe)()
      server.register(probe)()
    } catch {
      fail('interconnect route disposer left a route registered — route table and fiber lifecycle diverged')
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
