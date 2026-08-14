/**
 * Package root: re-exports the interconnect service surface so `.` importers
 * get the same bindings `build.mjs` bundles into `lib/index.js` from
 * `src/interconnect/index.ts`.
 * @module dsh-interconnect
 */

export type * from './interconnect/types.ts'
export {
  INTERCONNECT_CHANNEL,
  INTERCONNECT_TOKEN_REF,
  InterconnectService,
  default,
} from './interconnect/index.ts'
