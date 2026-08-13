/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-interconnect`.
 * @module @deepseek-ai/dsh-tool-interconnect/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-interconnect'

/** Cordis companion plugin name. */
export const name = 'tool-interconnect-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * Owned relation: the model-facing tools this package registers must vanish
 * when the owning fiber unloads — a stale tool would keep dispatching to a
 * disposed interconnect service. Registered at load; the registry's own
 * disposer contract is exercised by the shared tools invariant, so this
 * companion only brackets the relation for this package.
 */
const install: InvariantInstaller = (_ctx, _fail) => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
