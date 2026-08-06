import { describe, it, expect } from 'vitest'
import { findSingleLink } from './NodeName'
import { linkifyText } from '../model/linkify'

describe('findSingleLink (Ctrl/Cmd-click shortcut target)', () => {
  it('is undefined for plain text with no link', () => {
    expect(findSingleLink(linkifyText('just some text'))).toBeUndefined()
  })

  it('returns the href when there is exactly one link', () => {
    expect(findSingleLink(linkifyText('see https://example.com for details'))).toBe('https://example.com')
  })

  it('is undefined when there are two or more links — no way to guess which one', () => {
    expect(findSingleLink(linkifyText('see https://a.com and https://b.com'))).toBeUndefined()
  })
})
