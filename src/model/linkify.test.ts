import { describe, it, expect } from 'vitest'
import { linkifyText } from './linkify'

describe('linkifyText', () => {
  it('returns the whole string as one segment when there is no URL', () => {
    expect(linkifyText('Is this paper relevant to the review?')).toEqual([
      { text: 'Is this paper relevant to the review?' },
    ])
  })

  it('recognizes a bare URL', () => {
    expect(linkifyText('https://example.com/guideline')).toEqual([
      { text: 'https://example.com/guideline', href: 'https://example.com/guideline' },
    ])
  })

  it('splits text around a URL in the middle of a sentence', () => {
    expect(linkifyText('See https://example.com/x for the full rubric.')).toEqual([
      { text: 'See ' },
      { text: 'https://example.com/x', href: 'https://example.com/x' },
      { text: ' for the full rubric.' },
    ])
  })

  it('strips trailing sentence punctuation out of the link', () => {
    // Otherwise "https://example.com." links to a URL with a literal trailing
    // dot, which is very rarely what the period-ending sentence meant.
    expect(linkifyText('Details: https://example.com.')).toEqual([
      { text: 'Details: ' },
      { text: 'https://example.com', href: 'https://example.com' },
      { text: '.' },
    ])
  })

  it('strips a trailing closing paren from a parenthetical', () => {
    expect(linkifyText('(see https://example.com/x)')).toEqual([
      { text: '(see ' },
      { text: 'https://example.com/x', href: 'https://example.com/x' },
      { text: ')' },
    ])
  })

  it('handles multiple URLs', () => {
    expect(linkifyText('http://a.example and https://b.example both apply.')).toEqual([
      { text: 'http://a.example', href: 'http://a.example' },
      { text: ' and ' },
      { text: 'https://b.example', href: 'https://b.example' },
      { text: ' both apply.' },
    ])
  })

  it('does not linkify a bare "www." with no scheme', () => {
    // Deliberately not supported — see the module comment.
    expect(linkifyText('see www.example.com')).toEqual([{ text: 'see www.example.com' }])
  })

  it('handles an empty string', () => {
    expect(linkifyText('')).toEqual([])
  })

  it('does not include surrounding angle brackets or quotes in the link', () => {
    expect(linkifyText('<https://example.com/x> and "https://example.com/y"')).toEqual([
      { text: '<' },
      { text: 'https://example.com/x', href: 'https://example.com/x' },
      { text: '> and "' },
      { text: 'https://example.com/y', href: 'https://example.com/y' },
      { text: '"' },
    ])
  })

  it('never produces a link with an empty href', () => {
    // A pathological match reduced to nothing but stripped punctuation must
    // fall back to plain text rather than emit an unusable href="".
    for (const seg of linkifyText('https://.,;:!?) more text')) {
      if (seg.href !== undefined) expect(seg.href.length).toBeGreaterThan(0)
    }
  })
})
