import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProject } from '../model/project'
import { projectSchema } from '../model/schema'
import { DEMO_MODE } from './mode'
import { demoPdfUrl, demoProjectText } from './project'

const project = loadProject(demoProjectText())
// The parser fills an unannotated seat with blank defaults, so "not screened"
// shows as an empty Study Type rather than as a missing Relevant.
const relevantOf = (paperId: string, seat: string) => {
  const tree = project.papers.find((p) => p.id === paperId)?.reviews[seat]
  if (tree?.['Study Type']?.[0]?.value == null) return 'unset'
  return tree.Relevant[0].value
}

// [utest->req~plt-449~1]
describe('demo build mode', () => {
  it('is off in the test run, so the normal build keeps its behaviour', () => {
    expect(DEMO_MODE).toBe(false)
  })
})

// [utest->req~plt-445~1]
describe('demo project data', () => {
  it('passes the app schema and loads through the app parser', () => {
    const raw: unknown = JSON.parse(demoProjectText())
    expect(projectSchema.safeParse(raw).success).toBe(true)
    expect(project.reviewers).toBe(2)
    expect(project.papers).toHaveLength(7)
  })

  it('gives every paper a title, authors, a year, an abstract and a DOI', () => {
    for (const paper of project.papers) {
      expect(paper.title).not.toBe('')
      expect(paper.authors.length).toBeGreaterThan(0)
      expect(paper.year).toEqual(expect.any(Number))
      expect(paper.abstract?.length ?? 0).toBeGreaterThan(100)
      expect(paper.doi).toMatch(/^10\./)
    }
  })

  it('shows included, excluded, undecided and disagreeing papers', () => {
    expect(relevantOf('Schmid2025_ArchLLMs', '1')).toBe(true)
    expect(relevantOf('Schmid2025_ArchLLMs', '2')).toBe(true)
    expect(relevantOf('Amalfitano2025_GenAIRoadmap', '1')).toBe(false)
    expect(relevantOf('Amalfitano2025_GenAIRoadmap', '2')).toBe(false)
    expect(relevantOf('Keim2026_ARDoCoTools', '1')).toBe('unset')
    expect(relevantOf('Keim2026_ARDoCoTools', '2')).toBe('unset')
    expect(relevantOf('Scotti2025_TamedInteractions', '1')).toBe(false)
    expect(relevantOf('Scotti2025_TamedInteractions', '2')).toBe(true)
    expect(relevantOf('Corallo2026_EVerestDataset', '1')).toBe('unset')
    expect(relevantOf('Corallo2026_EVerestDataset', '2')).toBe(false)
  })

  it('records the evidence quotes from the bundled PDF', () => {
    const paper = project.papers.find((p) => p.id === 'KeimKaplan2026_ICSEBoF')
    const notes = paper?.reviews['1']?.Notes?.[0]?.value
    expect(notes).toContain('"where we will empirically evaluate each step to ensure effectiveness and practicality"')
    expect(notes).toContain('"The expected outcome is a prototype system that democratizes access to architectural knowledge across development teams."')
  })
})

// [utest->req~plt-454~1]
describe('demo PDFs', () => {
  it('bundles a PDF file for every paper', () => {
    for (const paper of project.papers) {
      expect(demoPdfUrl(paper.pdf), paper.id).not.toBeNull()
      const file = paper.pdf.replace(/^pdfs\//, '')
      expect(existsSync(join(process.cwd(), 'samples', 'pdfs', file)), paper.id).toBe(true)
    }
  })
})
