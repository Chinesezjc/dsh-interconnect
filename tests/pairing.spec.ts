/** Pairing-code codec: signing, tampering, expiry, and response binding. */
import { describe, expect, it } from 'vitest'
import { decodePairingCode, encodePairingCode, PAIRING_CODE_TTL_MS } from '../src/interconnect/pairing.ts'

const payload = {
  v: 1 as const,
  instanceId: 'peer-a',
  origin: 'http://127.0.0.1:13080',
  nonce: 'nonce-1',
  expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
}

describe('pairing code codec', () => {
  it('round-trips an offer and a response', () => {
    const offer = encodePairingCode(payload, 'secret')
    expect(decodePairingCode(offer, 'secret')).toEqual(payload)
    const response = encodePairingCode({ ...payload, nonce: 'nonce-2', inReplyTo: 'nonce-1' }, 'secret')
    expect(decodePairingCode(response, 'secret')).toMatchObject({ nonce: 'nonce-2', inReplyTo: 'nonce-1' })
  })

  it('rejects a code signed with a different token', () => {
    const code = encodePairingCode(payload, 'secret')
    expect(() => decodePairingCode(code, 'other')).toThrow(/different DSH_INTERCONNECT_TOKEN/)
  })

  it('rejects a tampered payload', () => {
    const code = encodePairingCode(payload, 'secret')
    const parts = code.split('.')
    const tampered = `${parts[0]}.${parts[1]!.slice(0, -1)}A.${parts[2]!}`
    expect(() => decodePairingCode(tampered, 'secret')).toThrow(/invalid/)
  })

  it('rejects an expired code', () => {
    const code = encodePairingCode(payload, 'secret')
    expect(() => decodePairingCode(code, 'secret', payload.expiresAt + 1)).toThrow(/expired/)
  })

  it('rejects an unknown format', () => {
    expect(() => decodePairingCode('not-a-pairing-code', 'secret')).toThrow(/unknown format/)
  })
})
