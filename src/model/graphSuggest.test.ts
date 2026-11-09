// [utest->req~ui-400~1]
import { describe, expect, it } from 'vitest'
import { cypherProps, suggest } from './graphSuggest'

const at = (text: string, fields: string[] = [], props: string[] = []) => suggest(text, text.length, fields, props)

describe('cypherProps', () => {
  it('lists the built-in properties first, then answer keys, quoting odd names', () => {
    expect(cypherProps(['Method', 'year', 'Study type', 'Method'])).toEqual([
      'id', 'type', 'label', 'field', 'doi', 'year', 'abstract', 'Method', '`Study type`',
    ])
  })
})

describe('suggest', () => {
  it('offers node labels after a colon in a node pattern', () => {
    expect(at('MATCH (p:Pa')?.items).toEqual(['Paper'])
    expect(at('MATCH (p:')?.items).toContain('Venue')
  })

  it('offers relationship types inside brackets, also after |', () => {
    expect(at('MATCH (p)-[:auth')?.items).toEqual(['authoredBy'])
    expect(at('MATCH (p)-[r:cites|ha')?.items).toEqual(['hasKeyword', 'hasAnswer'])
  })

  it('offers keywords, ignoring case, and nothing after a property dot or inside a string', () => {
    expect(at('MATCH (p) wh')?.items).toEqual(['WHERE'])
    expect(at('MATCH (p) WHERE p.', [], ['year'])?.items).toEqual(['year'])
    expect(at("MATCH (p) WHERE p.label = 'wh")).toBeNull()
  })

  it('offers properties after a dot and at a key position in braces', () => {
    const props = ['label', 'Method']
    expect(at('MATCH (p:Paper) WHERE p.la', [], props)?.items).toEqual(['label'])
    expect(at('MATCH (p:Paper {Me', [], props)?.items).toEqual(['Method'])
    expect(at("MATCH (p:Paper {label: 'x', M", [], props)?.items).toEqual(['Method'])
    expect(at('MATCH (p:Paper {label: ', [], props)).toBeNull()
  })

  it('replaces only the word before the caret', () => {
    expect(suggest('MATCH (p:Pa) RETURN p', 11, [])).toMatchObject({ from: 9, to: 11, items: ['Paper'] })
  })

  it('completes text query keys, types and schema fields', () => {
    expect(at('au')?.items).toEqual(['author:'])
    expect(at('type:ve')?.items).toEqual(['venue'])
    expect(at('field:Me', ['Method', 'Metric'])?.items).toEqual(['Method', 'Metric'])
    expect(at('Meth', ['Method'])?.items).toEqual(['Method='])
    expect(at('-au')?.items).toEqual(['author:'])
  })

  it('stays quiet on an empty word unless forced', () => {
    expect(at('')).toBeNull()
    expect(suggest('', 0, [], [], true)?.items).toContain('type:')
  })
})
