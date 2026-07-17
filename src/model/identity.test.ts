import { describe, it, expect } from 'vitest'
import {
  isSeatKey,
  seatLabel,
  normalizeEmail,
  sameIdentity,
  parseReviewerIdentities,
  serializeReviewerIdentities,
  toReviewerIdentity,
  seatHolder,
  checkSeat,
  describeIdentity,
  CONSOLIDATION_SEAT,
} from './identity'

describe('isSeatKey', () => {
  it('accepts a bare reviewer number and the consolidation seat', () => {
    expect(isSeatKey('1')).toBe(true)
    expect(isSeatKey('10')).toBe(true)
    expect(isSeatKey('consolidation')).toBe(true)
  })

  it('rejects anything else, including a case-mismatched consolidation', () => {
    expect(isSeatKey('0')).toBe(false)
    expect(isSeatKey('01')).toBe(false)
    expect(isSeatKey('-1')).toBe(false)
    expect(isSeatKey('1.5')).toBe(false)
    expect(isSeatKey('')).toBe(false)
    expect(isSeatKey('x')).toBe(false)
    expect(isSeatKey('Consolidation')).toBe(false)
  })
})

describe('seatLabel', () => {
  it('names a numbered reviewer and the consolidation seat', () => {
    expect(seatLabel('1')).toBe('Reviewer 1')
    expect(seatLabel('12')).toBe('Reviewer 12')
    expect(seatLabel(CONSOLIDATION_SEAT)).toBe('Consolidation')
  })
})

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail(' Alice@KIT.edu ')).toBe('alice@kit.edu')
  })

  it('reads blank/whitespace-only/absent as null', () => {
    expect(normalizeEmail(null)).toBeNull()
    expect(normalizeEmail(undefined)).toBeNull()
    expect(normalizeEmail('')).toBeNull()
    expect(normalizeEmail('   ')).toBeNull()
  })
})

describe('sameIdentity', () => {
  it('is case- and whitespace-insensitive on email', () => {
    expect(sameIdentity({ email: 'alice@kit.edu' }, { email: ' Alice@KIT.edu ' })).toBe(true)
  })

  it('ignores name entirely — a name-only difference is still the same identity', () => {
    // This is the merge false-alarm trap: `merge.ts` uses this as its
    // comparator specifically so a re-spelled display name never manufactures
    // a seat conflict.
    expect(sameIdentity({ email: 'alice@kit.edu', name: 'Alice' }, { email: 'alice@kit.edu', name: 'Dr. Alice Ng' })).toBe(
      true,
    )
  })

  it('both undefined counts as equal (no claim vs. no claim)', () => {
    expect(sameIdentity(undefined, undefined)).toBe(true)
  })

  it('one undefined, one not, is never equal', () => {
    expect(sameIdentity(undefined, { email: 'alice@kit.edu' })).toBe(false)
    expect(sameIdentity({ email: 'alice@kit.edu' }, undefined)).toBe(false)
  })

  it('a genuinely different email is not the same identity', () => {
    expect(sameIdentity({ email: 'alice@kit.edu' }, { email: 'bob@kit.edu' })).toBe(false)
  })
})

describe('parseReviewerIdentities', () => {
  it('drops a non-object/array/null input entirely', () => {
    expect(parseReviewerIdentities(undefined)).toEqual({})
    expect(parseReviewerIdentities(null)).toEqual({})
    expect(parseReviewerIdentities('nope')).toEqual({})
    expect(parseReviewerIdentities([])).toEqual({})
  })

  it('drops keys that are not a seat', () => {
    const raw = {
      '0': { email: 'a@b.com' },
      '-1': { email: 'a@b.com' },
      '1.5': { email: 'a@b.com' },
      '': { email: 'a@b.com' },
      '01': { email: 'a@b.com' },
      Consolidation: { email: 'a@b.com' }, // case-sensitive
    }
    expect(parseReviewerIdentities(raw)).toEqual({})
  })

  it('keeps well-formed numbered and consolidation seats', () => {
    const raw = {
      '1': { email: 'alice@kit.edu' },
      '10': { email: 'bob@kit.edu' },
      consolidation: { email: 'carol@kit.edu' },
    }
    expect(parseReviewerIdentities(raw)).toEqual({
      '1': { email: 'alice@kit.edu' },
      '10': { email: 'bob@kit.edu' },
      consolidation: { email: 'carol@kit.edu' },
    })
  })

  it('drops an entry with a missing, non-string, or blank email', () => {
    const raw = {
      '1': {},
      '2': { email: 42 },
      '3': { email: '   ' },
      '4': { email: 'ok@kit.edu' },
    }
    expect(parseReviewerIdentities(raw)).toEqual({ '4': { email: 'ok@kit.edu' } })
  })

  it('omits name entirely (never name: "") when it is non-string or blank', () => {
    const raw = {
      '1': { email: 'a@kit.edu', name: '' },
      '2': { email: 'b@kit.edu', name: '   ' },
      '3': { email: 'c@kit.edu', name: 42 },
      '4': { email: 'd@kit.edu', name: 'Dana' },
    }
    const parsed = parseReviewerIdentities(raw)
    expect('name' in parsed['1']).toBe(false)
    expect('name' in parsed['2']).toBe(false)
    expect('name' in parsed['3']).toBe(false)
    expect(parsed['4'].name).toBe('Dana')
  })

  it('trims email but preserves its case', () => {
    const parsed = parseReviewerIdentities({ '1': { email: '  Alice@KIT.edu  ' } })
    expect(parsed['1'].email).toBe('Alice@KIT.edu')
  })

  it('drops a non-object entry value', () => {
    expect(parseReviewerIdentities({ '1': 'nope', '2': null, '3': [1, 2] })).toEqual({})
  })
})

describe('serializeReviewerIdentities', () => {
  it('emits undefined for an empty map, so nothing is written', () => {
    expect(serializeReviewerIdentities({})).toBeUndefined()
  })

  it('emits keys in canonical order: numeric ascending, then consolidation', () => {
    const out = serializeReviewerIdentities({
      consolidation: { email: 'c@kit.edu' },
      '2': { email: 'b@kit.edu' },
      '1': { email: 'a@kit.edu' },
      '10': { email: 'j@kit.edu' },
    })
    expect(Object.keys(out!)).toEqual(['1', '2', '10', 'consolidation'])
  })
})

describe('toReviewerIdentity', () => {
  it('returns null for a blank or absent email', () => {
    expect(toReviewerIdentity(undefined)).toBeNull()
    expect(toReviewerIdentity(null)).toBeNull()
    expect(toReviewerIdentity('')).toBeNull()
    expect(toReviewerIdentity('   ')).toBeNull()
  })

  it('trims email, and omits name when blank/absent', () => {
    expect(toReviewerIdentity('  a@kit.edu  ')).toEqual({ email: 'a@kit.edu' })
    expect(toReviewerIdentity('a@kit.edu', '   ')).toEqual({ email: 'a@kit.edu' })
    expect(toReviewerIdentity('a@kit.edu', undefined)).toEqual({ email: 'a@kit.edu' })
  })

  it('trims a real name in too', () => {
    expect(toReviewerIdentity('a@kit.edu', ' Alice ')).toEqual({ email: 'a@kit.edu', name: 'Alice' })
  })
})

describe('seatHolder', () => {
  it('returns the identity at that seat, or undefined', () => {
    const identities = { '1': { email: 'a@kit.edu' } }
    expect(seatHolder(identities, '1')).toEqual({ email: 'a@kit.edu' })
    expect(seatHolder(identities, '2')).toBeUndefined()
  })
})

describe('checkSeat — the false-alarm truth table', () => {
  it('no claims recorded at all — silent, regardless of identity', () => {
    expect(checkSeat({}, '1', 'me@kit.edu')).toEqual({ kind: 'ok' })
    expect(checkSeat({}, '1', null)).toEqual({ kind: 'ok' })
  })

  it('seat free, my identity known — silent (nothing to claim yet at this layer)', () => {
    expect(checkSeat({ '2': { email: 'other@kit.edu' } }, '1', 'me@kit.edu')).toEqual({ kind: 'ok' })
  })

  it('seat held by me, any casing, any name — silent', () => {
    const identities = { '1': { email: 'Me@KIT.edu', name: 'Old Name' } }
    expect(checkSeat(identities, '1', 'me@kit.edu')).toEqual({ kind: 'ok' })
  })

  it('seat held by someone else, my identity unknown — silent (an unanswerable question), holder still visible via seatHolder', () => {
    const identities = { '1': { email: 'other@kit.edu' } }
    expect(checkSeat(identities, '1', null)).toEqual({ kind: 'ok' })
    expect(seatHolder(identities, '1')).toEqual({ email: 'other@kit.edu' })
  })

  it('seat held by someone else, my identity known and different — the one alarm', () => {
    const identities = { '1': { email: 'other@kit.edu' } }
    expect(checkSeat(identities, '1', 'me@kit.edu')).toEqual({
      kind: 'mismatch',
      holder: { email: 'other@kit.edu' },
    })
  })

  it('holder email differs only in case/whitespace from mine — silent, not a mismatch', () => {
    const identities = { '1': { email: ' Me@KIT.edu ' } }
    expect(checkSeat(identities, '1', 'me@kit.edu')).toEqual({ kind: 'ok' })
  })
})

describe('describeIdentity', () => {
  it('shows the name with the email when there is one', () => {
    expect(describeIdentity({ email: 'a@kit.edu', name: 'Alice' })).toBe('Alice (a@kit.edu)')
  })

  it('falls back to the bare email', () => {
    expect(describeIdentity({ email: 'a@kit.edu' })).toBe('a@kit.edu')
  })
})
