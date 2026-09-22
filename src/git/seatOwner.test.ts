import { describe, it, expect } from 'vitest'
import { seatPathspec, parseSeatAuthor, sameIdentity, ownerLabel } from './seatOwner'

describe('seatPathspec', () => {
  it('matches one seat across every paper, and nothing else', () => {
    expect(seatPathspec('annotations', '2', false)).toBe(':(glob)annotations/*/reviewer-2.json')
    expect(seatPathspec('annotations', 'consolidation', false)).toBe(':(glob)annotations/*/consolidated.json')
  })

  it('uses the screening family for a screening project', () => {
    expect(seatPathspec('annotations', '1', true)).toBe(':(glob)annotations/*/screening-1.json')
    expect(seatPathspec('annotations', 'consolidation', true)).toBe(
      ':(glob)annotations/*/screening-consolidated.json',
    )
  })
})

describe('parseSeatAuthor', () => {
  it('reads the name and email git printed', () => {
    expect(parseSeatAuthor('Anna Schmidt\0anna@example.org\n')).toEqual({
      name: 'Anna Schmidt',
      email: 'anna@example.org',
    })
  })

  it('treats no output as an unclaimed seat rather than an error', () => {
    expect(parseSeatAuthor('')).toBeNull()
    expect(parseSeatAuthor('  \n')).toBeNull()
  })
})

describe('sameIdentity', () => {
  it('matches on email regardless of how the name is spelled', () => {
    expect(
      sameIdentity({ name: 'Anna Schmidt', email: 'Anna@Example.org' }, { name: 'anna', email: 'anna@example.org' }),
    ).toBe(true)
  })

  it('separates two people sharing a display name', () => {
    expect(
      sameIdentity({ name: 'A. Schmidt', email: 'anna@example.org' }, { name: 'A. Schmidt', email: 'axel@example.org' }),
    ).toBe(false)
  })

  it('falls back to the name when neither side has an email', () => {
    expect(sameIdentity({ name: 'Anna', email: '' }, { name: 'Anna', email: '' })).toBe(true)
    expect(sameIdentity({ name: 'Anna', email: '' }, { name: 'Axel', email: '' })).toBe(false)
  })

  it('is false for an unclaimed seat — nobody is not everybody', () => {
    expect(sameIdentity(null, { name: 'Anna', email: 'anna@example.org' })).toBe(false)
    expect(sameIdentity({ name: '', email: '' }, { name: '', email: '' })).toBe(false)
  })
})

describe('ownerLabel', () => {
  it('prefers the name, falls back to the email', () => {
    expect(ownerLabel({ name: 'Anna Schmidt', email: 'anna@example.org' })).toBe('Anna Schmidt')
    expect(ownerLabel({ name: '  ', email: 'anna@example.org' })).toBe('anna@example.org')
  })
})
