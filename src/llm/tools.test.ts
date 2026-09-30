import { describe, it, expect, vi } from 'vitest'
import { executeTool, parseSubmitArgs, splitPages, type ToolDeps } from './tools'
import type { WebFetchResult } from './types'

const PAPER_TEXT = [
  '[page 1]',
  'This study used a sample size of 24 participants in a controlled experiment.',
  '',
  '[page 2]',
  'The metric was measured across three trials for each participant.',
].join('\n')

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    paperText: PAPER_TEXT,
    textAvailable: true,
    fetchWeb: vi.fn(),
    ...over,
  }
}

function ok(body: string, contentType = 'application/json'): WebFetchResult {
  return { ok: true, status: 200, url: 'https://example.test/x', contentType, body, truncated: false }
}

describe('splitPages / search_paper / read_pages', () => {
  it('splits pdfText.ts blocks back into per-page text', () => {
    expect(splitPages(PAPER_TEXT)).toEqual([
      { page: 1, text: 'This study used a sample size of 24 participants in a controlled experiment.' },
      { page: 2, text: 'The metric was measured across three trials for each participant.' },
    ])
  })

  it('search_paper finds a term and reports its page number', async () => {
    const out = await executeTool('search_paper', { query: 'sample size' }, deps())
    expect(out).toContain('[page 1]')
    expect(out).toContain('sample size')
  })

  it('search_paper is case-insensitive and reports no matches cleanly', async () => {
    const hit = await executeTool('search_paper', { query: 'SAMPLE SIZE' }, deps())
    expect(hit).toContain('[page 1]')
    const miss = await executeTool('search_paper', { query: 'nonexistent term' }, deps())
    expect(miss).toContain('No matches')
  })

  it('search_paper reports unavailability for a scanned paper', async () => {
    const out = await executeTool('search_paper', { query: 'x' }, deps({ textAvailable: false }))
    expect(out).toContain('unavailable')
  })

  it('read_pages returns only the requested range', async () => {
    const out = await executeTool('read_pages', { from: 2, to: 2 }, deps())
    expect(out).toContain('[page 2]')
    expect(out).not.toContain('[page 1]')
  })

  it('read_pages caps total output and says so', async () => {
    const bigText = Array.from({ length: 20 }, (_, i) => `[page ${i + 1}]\n${'x'.repeat(2000)}`).join('\n\n')
    const out = await executeTool('read_pages', { from: 1, to: 20 }, deps({ paperText: bigText }))
    expect(out).toContain('truncated')
    expect(out.length).toBeLessThan(bigText.length)
  })

  it('rejects malformed args defensively instead of throwing', async () => {
    expect(await executeTool('search_paper', { query: '' }, deps())).toContain('Error')
    expect(await executeTool('search_paper', {}, deps())).toContain('Error')
    expect(await executeTool('read_pages', { from: 'a', to: 2 }, deps())).toContain('Error')
    expect(await executeTool('read_pages', { from: 5, to: 1 }, deps())).toContain('Error')
    expect(await executeTool('read_pages', null, deps())).toContain('Error')
  })
})

describe('scholarly_search (OpenAlex)', () => {
  it('reconstructs the abstract from the inverted index and lists compact fields', async () => {
    const work = {
      title: 'A Great Paper',
      doi: 'https://doi.org/10.1/x',
      publication_year: 2021,
      type: 'article',
      cited_by_count: 42,
      primary_location: { source: { display_name: 'ICSE' } },
      authorships: [
        { author: { display_name: 'A. One' } },
        { author: { display_name: 'B. Two' } },
      ],
      abstract_inverted_index: { This: [0], is: [1], great: [2] },
    }
    const fetchWeb = vi.fn().mockResolvedValue(ok(JSON.stringify({ results: [work] })))
    const out = await executeTool('scholarly_search', { query: 'great paper' }, deps({ fetchWeb }))
    expect(fetchWeb).toHaveBeenCalledWith(expect.stringContaining('api.openalex.org/works?search='), undefined)
    expect(out).toContain('A Great Paper')
    expect(out).toContain('ICSE')
    expect(out).toContain('A. One, B. Two')
    expect(out).toContain('This is great')
  })

  it('reports no results and fetch failures without throwing', async () => {
    const empty = vi.fn().mockResolvedValue(ok(JSON.stringify({ results: [] })))
    expect(await executeTool('scholarly_search', { query: 'x' }, deps({ fetchWeb: empty }))).toContain('No results')

    const failed = vi.fn().mockResolvedValue({ ok: false, status: 503, url: '', contentType: '', body: '', truncated: false, error: 'down' })
    expect(await executeTool('scholarly_search', { query: 'x' }, deps({ fetchWeb: failed }))).toContain('Error')

    expect(await executeTool('scholarly_search', {}, deps())).toContain('Error')
  })
})

describe('lookup_doi (Crossref)', () => {
  it('extracts compact metadata', async () => {
    const message = {
      title: ['A Great Paper'],
      author: [{ given: 'A', family: 'One' }],
      issued: { 'date-parts': [[2021]] },
      'container-title': ['ICSE'],
      publisher: 'ACM',
      type: 'proceedings-article',
      volume: '1',
      issue: '2',
      page: '3-4',
    }
    const fetchWeb = vi.fn().mockResolvedValue(ok(JSON.stringify({ message })))
    const out = await executeTool('lookup_doi', { doi: '10.1/x' }, deps({ fetchWeb }))
    expect(out).toContain('A Great Paper')
    expect(out).toContain('A One')
    expect(out).toContain('2021')
    expect(out).toContain('ICSE')
    expect(out).toContain('ACM')
  })

  it('rejects a missing doi', async () => {
    expect(await executeTool('lookup_doi', {}, deps())).toContain('Error')
  })
})

describe('fetch_url', () => {
  it('converts HTML to readable text, dropping script/style, and wraps it as untrusted', async () => {
    const html = '<html><body><script>evil()</script><style>.a{}</style><p>Hello world</p></body></html>'
    const fetchWeb = vi.fn().mockResolvedValue(ok(html, 'text/html'))
    const out = await executeTool('fetch_url', { url: 'https://example.test/page' }, deps({ fetchWeb }))
    expect(out).toContain('Hello world')
    expect(out).not.toContain('evil()')
    expect(out).toContain('untrusted')
    expect(out).toContain('BEGIN UNTRUSTED CONTENT')
  })

  it('rejects a non-http(s) url and a failed fetch', async () => {
    expect(await executeTool('fetch_url', { url: 'file:///etc/passwd' }, deps())).toContain('Error')
    const failed = vi.fn().mockResolvedValue({ ok: false, status: 404, url: '', contentType: '', body: '', truncated: false })
    expect(await executeTool('fetch_url', { url: 'https://example.test/404' }, deps({ fetchWeb: failed }))).toContain('Error')
  })
})

describe('parseSubmitArgs', () => {
  it('parses a well-formed submission', () => {
    const payload = parseSubmitArgs({
      fields: [{ path: 'Year', value: 2021, evidence: 'in 2021', source: 'paper', confidence: 0.9 }],
      skipped: [{ path: 'Summary', reason: 'not stated' }],
      notes: 'done',
    })
    expect(payload.fields).toEqual([
      { path: 'Year', value: 2021, evidence: 'in 2021', source: 'paper', confidence: 0.9 },
    ])
    expect(payload.skipped).toEqual([{ path: 'Summary', reason: 'not stated' }])
    expect(payload.notes).toBe('done')
  })

  it('drops malformed entries instead of throwing', () => {
    const payload = parseSubmitArgs({
      fields: [{ path: 'Year' }, 'garbage', { value: 5 }, { path: 'Ok', value: 1, evidence: 'e' }],
      skipped: [{ path: 'X' }, { path: 'Y', reason: 'r' }],
    })
    expect(payload.fields).toEqual([{ path: 'Ok', value: 1, evidence: 'e', source: undefined, confidence: undefined }])
    expect(payload.skipped).toEqual([{ path: 'Y', reason: 'r' }])
  })

  it('parses schema_remarks and drops malformed ones', () => {
    const payload = parseSubmitArgs({
      fields: [],
      skipped: [],
      schema_remarks: [{ path: 'Year', issue: 'vague', suggestion: 'say which' }, { path: 'X' }, 'junk'],
    })
    expect(payload.schemaRemarks).toEqual([{ path: 'Year', issue: 'vague', suggestion: 'say which' }])
  })

  it('never throws on completely malformed args', () => {
    expect(parseSubmitArgs(null)).toEqual({ fields: [], skipped: [], notes: undefined })
    expect(parseSubmitArgs('garbage')).toEqual({ fields: [], skipped: [], notes: undefined })
    expect(parseSubmitArgs(undefined)).toEqual({ fields: [], skipped: [], notes: undefined })
  })
})
