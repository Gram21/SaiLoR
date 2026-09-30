import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { feedbackContentProblem, feedbackFileNameProblem, feedbackTarget } from './feedback'

describe('feedbackFileNameProblem', () => {
  it('accepts plain json names', () => {
    for (const n of ['run-1.json', '2026-01-02T03_04.abc.json', 'a.json']) expect(feedbackFileNameProblem(n), n).toBeNull()
  })
  it('rejects separators, dot starts, wrong extension, length, non-strings', () => {
    for (const n of ['../x.json', 'a/b.json', 'a\\b.json', '.hidden.json', 'x.txt', 'x', '.json', `${'a'.repeat(120)}.json`, 'a b.json', 'é.json'])
      expect(feedbackFileNameProblem(n), n).not.toBeNull()
    expect(feedbackFileNameProblem(5)).not.toBeNull()
  })
})

describe('feedbackContentProblem', () => {
  it('accepts a JSON object', () => expect(feedbackContentProblem('{"a":1}')).toBeNull())
  it('rejects non-objects, bad JSON, non-strings, oversize', () => {
    for (const c of ['[]', '1', 'null', '"x"', '{oops', 7, `{"a":"${'x'.repeat(1024 * 1024)}"}`])
      expect(feedbackContentProblem(c), String(c).slice(0, 10)).not.toBeNull()
  })
})

describe('feedbackTarget', () => {
  it('resolves under <annotationsDir>/feedback', () => {
    expect(feedbackTarget('/p/annotations', 'r.json')).toBe(path.join('/p/annotations', 'feedback', 'r.json'))
  })
  it('throws on a traversal name', () => {
    expect(() => feedbackTarget('/p/annotations', '../r.json')).toThrow()
  })
})
