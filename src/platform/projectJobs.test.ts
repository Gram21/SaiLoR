// [utest->req~plt-459~1]
import { describe, it, expect } from 'vitest'
import { offMain } from './offMain'

const head = JSON.stringify({
  version: 1,
  config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
  papers: [
    { id: 'a', title: 'A', authors: [], pdf: 'a.pdf' },
    { id: 'b', title: 'B', authors: [], pdf: 'b.pdf' },
  ],
})

describe('loading jobs', () => {
  it('opens a head, reads a batch of papers and parses it', async () => {
    const open = await offMain<'open'>({ kind: 'open', session: 1, text: head })
    expect(open.ids).toEqual(['a', 'b'])
    const files = [{ relPath: 'b/consolidated.json', text: JSON.stringify({ Relevant: [{ value: true }] }) }, { relPath: 'b/reviewer-1.json', text: '{bad' }]
    const batch = await offMain<'read'>({ kind: 'read', session: 1, files, ids: ['b'] })
    expect(batch.corrupt).toEqual(['b/reviewer-1.json'])
    const { papers } = await offMain<'parse'>({ kind: 'parse', text: batch.text })
    expect(papers.map((p) => p.id)).toEqual(['b'])
  })

  it('parses a head and gives null for an invalid one', async () => {
    expect((await offMain<'head'>({ kind: 'head', text: head }))?.project.papers).toHaveLength(2)
    expect(await offMain<'head'>({ kind: 'head', text: 'nope' })).toBeNull()
  })

  it('rejects a batch for a session that is gone', async () => {
    await expect(offMain<'read'>({ kind: 'read', session: 99, files: [] })).rejects.toThrow('no longer open')
  })
})
