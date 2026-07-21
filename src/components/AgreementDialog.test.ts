import { describe, it, expect } from 'vitest'
import { perFieldTsv, METRICS } from './AgreementDialog'
import type { FieldAgreement } from '../consolidate/agreement'
import type { Ratings } from '../consolidate/metrics'

const COHEN = METRICS.filter((m) => m.key === 'cohen')

function field(key: string, label: string, units: Ratings[]): FieldAgreement {
  return { key, label, unitCount: units.length, input: { raters: ['1', '2'], units } }
}

describe('perFieldTsv', () => {
  it('has a header row naming Field, N, and each given metric', () => {
    const tsv = perFieldTsv([], COHEN)
    expect(tsv).toBe("Field\tN\tCohen's κ")
  })

  it('one row per field, in the given order', () => {
    const perField = [
      field('a', 'Study Type', [{ '1': 'rct', '2': 'rct' }]),
      field('b', 'Findings › Claim', [{ '1': 'x', '2': 'y' }]),
    ]
    const rows = perFieldTsv(perField, COHEN).split('\n')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatch(/^Study Type\t1\t/)
    expect(rows[2]).toMatch(/^Findings › Claim\t1\t/)
  })

  it('a perfectly agreeing field gets a real, formatted coefficient', () => {
    const perField = [
      field('a', 'Study Type', [
        { '1': 'rct', '2': 'rct' },
        { '1': 'survey', '2': 'survey' },
        { '1': 'rct', '2': 'survey' },
      ]),
    ]
    const [, row] = perFieldTsv(perField, COHEN).split('\n')
    const [, , value] = row.split('\t')
    expect(value).toMatch(/^-?\d\.\d{3}$/)
  })

  it('a value the metric cannot honestly compute leaves the cell blank, not a stray note', () => {
    // One unit, perfect agreement: po = pe = 1, so (po-pe)/(1-pe) is 0/0 —
    // `cohenKappa` returns `value: null` for this rather than NaN, and the
    // cell must read as empty, not print a note meant for on-screen use.
    const perField = [field('a', 'Study Type', [{ '1': 'rct', '2': 'rct' }])]
    const [, row] = perFieldTsv(perField, COHEN).split('\n')
    const [, , value] = row.split('\t')
    expect(value).toBe('')
  })

  it('no rows beyond the header when there are no fields', () => {
    expect(perFieldTsv([], COHEN)).toBe("Field\tN\tCohen's κ")
  })
})
