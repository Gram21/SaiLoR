import { describe, it, expect } from 'vitest'
import { paperIdProblem, paperIdsCollide } from './paperId'

/**
 * `splitProjectFiles` writes a paper's id straight into a directory name, so
 * each case below is a real "works on my machine, breaks a teammate's repo"
 * hazard, not a theoretical one — see the module doc for the concrete stories.
 */

describe('paperIdProblem', () => {
  it('accepts ordinary ids, including the slugs paperIdFromName produces', () => {
    for (const id of ['p1', 'smith-2020', 'a_b.c', 'Smith 2020']) {
      expect(paperIdProblem(id), id).toBeNull()
    }
  })

  it('rejects the empty id', () => {
    expect(paperIdProblem('')?.reason).toBe('empty')
  })

  it('rejects control characters', () => {
    expect(paperIdProblem('a\nb')?.reason).toBe('control-char')
    expect(paperIdProblem('a\0b')?.reason).toBe('control-char')
  })

  it('rejects "." and ".." as not being a paper\'s own directory', () => {
    expect(paperIdProblem('.')?.reason).toBe('dot')
    expect(paperIdProblem('..')?.reason).toBe('dot')
  })

  it('rejects Windows-illegal characters and names them in the message', () => {
    // The motivating case: fine on macOS/Linux, unrepresentable on Windows.
    const issue = paperIdProblem('Smith 2020: A Study?')
    expect(issue?.reason).toBe('illegal-char')
    expect(issue?.detail).toContain('":"')
    expect(issue?.detail).toContain('"?"')
    for (const ch of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      expect(paperIdProblem(`a${ch}b`)?.reason, ch).toBe('illegal-char')
    }
  })

  it('rejects a trailing dot or space, which Windows silently strips', () => {
    // `Smith.` on screen becomes `Smith` on disk — a mismatch that would
    // otherwise stay invisible until a teammate's checkout can't find it.
    expect(paperIdProblem('Smith.')?.reason).toBe('trailing-dot-or-space')
    expect(paperIdProblem('Smith ')?.reason).toBe('trailing-dot-or-space')
  })

  it('rejects Windows reserved device names, case-insensitively', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
      expect(paperIdProblem(name)?.reason, name).toBe('reserved-name')
    }
  })

  it('rejects a reserved device name even with an extension', () => {
    // CON.json still opens the CON device — the extension doesn't save it.
    expect(paperIdProblem('CON.json')?.reason).toBe('reserved-name')
  })

  it('does not flag a reserved name as a mere prefix', () => {
    expect(paperIdProblem('CONference')).toBeNull()
  })
})

describe('paperIdsCollide', () => {
  it('flags ids differing only in case', () => {
    // Two folders on macOS/Linux, one on a case-insensitive checkout
    // (Windows, default macOS) — whichever reviewer wrote second wins,
    // silently, and the other's annotations are gone.
    expect(paperIdsCollide('P1', 'p1')).toBe(true)
  })

  it('flags ids differing only in Unicode normalisation', () => {
    const nfc = 'Muller'.replace('u', 'ü') // "Müller", precomposed (NFC)
    const nfd = 'Müller' // "Müller" spelled with a combining diaeresis (NFD)
    expect(nfc).not.toBe(nfd) // different code points, same rendered text
    expect(paperIdsCollide(nfc, nfd)).toBe(true)
  })

  it('does not flag genuinely different ids', () => {
    expect(paperIdsCollide('smith-2020', 'jones-2021')).toBe(false)
  })
})

describe('paperIdKey', () => {
  it('folds case and normalisation together, as a case-insensitive macOS checkout does', () => {
    // Differs in both at once — neither check alone would call these equal.
    expect(paperIdsCollide('Caf\u00e9', 'cafe\u0301')).toBe(true)
  })
})
