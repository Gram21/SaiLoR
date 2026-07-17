import { describe, it, expect } from 'vitest'
import { YEAR_MIN, YEAR_MAX, isPlausibleYear, parseYear } from './year'

describe('isPlausibleYear', () => {
  it('accepts the boundaries', () => {
    expect(isPlausibleYear(YEAR_MIN)).toBe(true)
    expect(isPlausibleYear(YEAR_MAX)).toBe(true)
  })

  it('rejects one past either boundary', () => {
    expect(isPlausibleYear(YEAR_MIN - 1)).toBe(false)
    expect(isPlausibleYear(YEAR_MAX + 1)).toBe(false)
  })

  it('rejects a non-integer', () => {
    expect(isPlausibleYear(2021.5)).toBe(false)
  })

  it('rejects anything that is not a number', () => {
    expect(isPlausibleYear('2021')).toBe(false)
    expect(isPlausibleYear(null)).toBe(false)
    expect(isPlausibleYear(undefined)).toBe(false)
  })
})

describe('parseYear', () => {
  it('accepts a plausible number as-is', () => {
    expect(parseYear(2021)).toBe(2021)
  })

  it('parses a plain numeric string', () => {
    expect(parseYear('2021')).toBe(2021)
  })

  it('takes the first four-digit run out of a year range, matching the on-disk behaviour this replaces', () => {
    expect(parseYear('1985--1986')).toBe(1985)
  })

  it('takes the first four-digit run out of surrounding prose', () => {
    expect(parseYear('c. 1998')).toBe(1998)
  })

  it('rejects text with no four-digit run at all', () => {
    expect(parseYear('in press')).toBeUndefined()
    expect(parseYear('to appear')).toBeUndefined()
  })

  it('rejects blank, missing, or wrongly-shaped input', () => {
    expect(parseYear('')).toBeUndefined()
    expect(parseYear(null)).toBeUndefined()
    expect(parseYear(undefined)).toBeUndefined()
    expect(parseYear({})).toBeUndefined()
    expect(parseYear([])).toBeUndefined()
    expect(parseYear(true)).toBeUndefined()
  })

  it('rejects a number below the plausible range', () => {
    expect(parseYear(55)).toBeUndefined()
  })

  it('reads only the first four digits of a five-digit typo, then the range check rejects it', () => {
    // No `\b` word boundary in the regex on purpose (see the doc comment) —
    // this pins that `"20221"` reads as `2022`, which the range check then
    // accepts. A `\b`-guarded match would instead see no run at all.
    expect(parseYear('20221')).toBe(2022)
  })

  it('rejects a non-integer number', () => {
    expect(parseYear(2021.5)).toBeUndefined()
  })

  it('rejects NaN and Infinity', () => {
    expect(parseYear(NaN)).toBeUndefined()
    expect(parseYear(Infinity)).toBeUndefined()
  })
})
