/**
 * Pairing-code codec for `interconnect_pair`.
 *
 * A pairing code is a short-lived bearer token that carries one instance's
 * address and id. It is HMACed with the deployment's shared
 * `DSH_INTERCONNECT_TOKEN`, so two instances can only complete a pairing when
 * they already share that credential; the code does not establish trust, it
 * only exchanges reachable origins. Codes carry an expiry and an optional
 * `inReplyTo` nonce, which distinguishes a first offer from a response.
 * @module dsh-interconnect/pairing
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Prefix identifying a pairing code; versioned so a future format can reject old codes. */
export const PAIRING_CODE_PREFIX = 'dshpair1'

/** How long a pairing code stays valid, in milliseconds. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000

/** One decoded pairing code. `inReplyTo` is present only on the response code. */
export interface PairingPayload {
  /** Format version; only 1 is accepted. */
  readonly v: 1
  /** The issuing instance's id. */
  readonly instanceId: string
  /** The origin the peer should dial for the issuing instance. */
  readonly origin: string
  /** One-time challenge echoed by the response. */
  readonly nonce: string
  /** Epoch milliseconds after which the code is rejected. */
  readonly expiresAt: number
  /** Nonce of the offer this code answers; absent on the first offer. */
  readonly inReplyTo?: string
}

/** Encode and sign one pairing payload. */
export function encodePairingCode(payload: PairingPayload, token: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', token).update(body).digest('base64url')
  return `${PAIRING_CODE_PREFIX}.${body}.${mac}`
}

/**
 * Verify and decode one pairing code.
 * @param code - the code produced by {@link encodePairingCode}.
 * @param token - this instance's shared token; must equal the issuer's.
 * @param now - current epoch milliseconds, injectable for expiry tests.
 * @returns the verified payload.
 * @throws Error when the shape, signature, or expiry is invalid.
 */
export function decodePairingCode(code: string, token: string, now: number = Date.now()): PairingPayload {
  const parts = code.trim().split('.')
  if (parts.length !== 3 || parts[0] !== PAIRING_CODE_PREFIX) {
    throw new Error('pairing code has an unknown format')
  }
  const body = parts[1]!
  const supplied = Buffer.from(parts[2]!, 'base64url')
  const expected = createHmac('sha256', token).update(body).digest()
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('pairing code is invalid or was issued with a different DSH_INTERCONNECT_TOKEN')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new Error('pairing code payload is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('pairing code payload is not an object')
  const record = parsed as Record<string, unknown>
  if (record.v !== 1) throw new Error('pairing code version is not supported')
  if (typeof record.instanceId !== 'string' || record.instanceId.length === 0) {
    throw new Error('pairing code has no instanceId')
  }
  if (typeof record.origin !== 'string' || record.origin.length === 0) {
    throw new Error('pairing code has no origin')
  }
  if (typeof record.nonce !== 'string' || record.nonce.length === 0) {
    throw new Error('pairing code has no nonce')
  }
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) {
    throw new Error('pairing code has no expiry')
  }
  if (record.expiresAt <= now) throw new Error('pairing code has expired')
  if (record.inReplyTo !== undefined && (typeof record.inReplyTo !== 'string' || record.inReplyTo.length === 0)) {
    throw new Error('pairing code has an invalid inReplyTo')
  }
  return {
    v: 1,
    instanceId: record.instanceId,
    origin: record.origin,
    nonce: record.nonce,
    expiresAt: record.expiresAt,
    ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
  }
}
