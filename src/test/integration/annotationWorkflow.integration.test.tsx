import '@testing-library/jest-dom/vitest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitPlatform, GitRun, GitStatus } from '../../git/types'
import type { SaveHandle } from '../../platform/adapter'

/**
 * One coherent walk through the actual use case: author a small annotation
 * schema with every field type, use it to annotate a real PDF (a highlight,
 * a sticky note, a comment, a field value), then commit the result with a
 * real `git` binary against a real scratch repository — all driven through
 * the real React components (real clicks, real typing, real DOM events),
 * not direct store calls. See the plan this implements for the full design
 * rationale (jsdom has no layout engine, so PDF selection geometry and
 * `react-pdf` itself are mocked at the two points noted below; everything
 * else is the genuine app).
 */

// ---------------------------------------------------------------------------
// jsdom performs no real layout — every element's rect is {0,0,0,0} by
// default, which would make PdfViewer's own `width > 1 && height > 1` filter
// (see PdfViewer.tsx's `rectsForPageRange`) drop every selection rect. Fixed,
// non-zero geometry for every element/range is enough for the real selection
// → highlight code path to run and produce a real mark.
Element.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, x: 0, y: 0, toJSON() {} }
}
Range.prototype.getClientRects = function () {
  return [
    { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20, x: 10, y: 10, toJSON() {} },
  ] as unknown as DOMRectList
}
Range.prototype.getBoundingClientRect = function () {
  return this.getClientRects()[0] as DOMRect
}
// jsdom implements neither — PdfViewer uses ResizeObserver to fit the PDF to
// its container's width, and highlightRegistry/CSS Custom Highlight API for
// in-PDF search; both are unused by anything this test exercises.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver

// react-pdf does real PDF.js parsing and canvas rendering, neither of which
// jsdom supports (no canvas, no real layout). Mocked to skip straight to the
// DOM shape PdfViewer's own selection code queries for
// (`.react-pdf__Page` / `.react-pdf__Page__textContent`) — everything above
// that (selection capture, mark creation, mark rendering, the comment
// popover) is the real component code running against it.
const PDF_SAMPLE_TEXT = 'Sample abstract sentence for selection testing in this fixture paper.'
vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: {} as Record<string, unknown> },
  Document: (props: { onLoadSuccess?: (doc: { numPages: number }) => void; children?: React.ReactNode }) => {
    useEffect(() => props.onLoadSuccess?.({ numPages: 1 }), [])
    return <>{props.children}</>
  },
  Page: (props: {
    inputRef?: (el: HTMLDivElement | null) => void
    onRenderTextLayerSuccess?: () => void
    children?: React.ReactNode
  }) => {
    useEffect(() => props.onRenderTextLayerSuccess?.(), [])
    return (
      <div className="react-pdf__Page" ref={props.inputRef} style={{ position: 'relative' }}>
        <div className="react-pdf__Page__textContent">
          <span>{PDF_SAMPLE_TEXT}</span>
        </div>
        {props.children}
      </div>
    )
  },
}))

// ---------------------------------------------------------------------------
// Scratch git repo: a real `git` binary against a real temp directory, wired
// in as the platform's `getGit()`. `headContent`/`workingContent` are left
// returning `null` on purpose — that's what makes `gitStore.ts`'s
// `refreshFieldReview` bail out and take the plain whole-file commit path
// (`git.commit`) rather than the field-level `commitPartial` path, which is
// the simpler, still fully real, path this test exercises.
let repoDir: string
let projectJsonPath: string

function git(args: string[]) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
}

const fakeGit: GitPlatform = {
  probe: async () => ({ available: true, version: git(['--version']).trim(), error: '' }),
  pickCloneDir: async () => null,
  clone: async () => ({ ok: false, error: 'not supported in this test' }),
  pickProjectIn: async () => null,
  // `projectPath` is the project *file's* path — real `git.info` derives the
  // repo root from its directory (`git rev-parse --show-toplevel`); this test
  // already knows both, since it created the scratch repo itself.
  info: async () => ({
    root: repoDir,
    relPath: 'project.json',
    branch: git(['branch', '--show-current']).trim() || null,
    upstream: null,
    hasHead: true,
  }),
  status: async (root): Promise<GitStatus> => {
    const { parsePorcelain, capDiff } = await import('../../git/output')
    const porcelain = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8' })
    const diffRaw = execFileSync('git', ['diff', 'HEAD', '--'], { cwd: root, encoding: 'utf8' })
    const { text, truncated } = capDiff(diffRaw)
    return { changes: parsePorcelain(porcelain), diff: text, diffTruncated: truncated }
  },
  commit: async (root, paths, message, amend): Promise<GitRun> => {
    try {
      execFileSync('git', ['add', ...(paths.length > 0 ? paths : ['-A'])], { cwd: root })
      const stdout = execFileSync(
        'git',
        ['commit', ...(amend ? ['--amend'] : []), '-m', message],
        { cwd: root, encoding: 'utf8' },
      )
      return { ok: true, code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer; message: string }
      return {
        ok: false,
        code: e.status ?? null,
        stdout: e.stdout?.toString() ?? '',
        stderr: e.stderr?.toString() ?? e.message,
      }
    }
  },
  lastCommitMessage: async () => null,
  push: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  beginPull: async () => ({ kind: 'no-upstream', branch: null }),
  beginMerge: async () => ({ kind: 'up-to-date' }),
  logBegin: async () => ({ commits: [], truncated: false, error: null }),
  logDiff: async () => ({ kind: 'initial' }),
  finishPull: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  abortPull: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  headContent: async () => null,
  workingContent: async () => null,
  commitPartial: async () => ({ ok: false, code: null, stdout: '', stderr: 'not exercised — see headContent' }),
  writeWorking: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  branches: async () => [],
  createBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  deleteBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  checkoutBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  beginBranchSwitch: async () => ({ kind: 'error', message: 'not supported in this test' }),
  finishBranchSwitch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  abortBranchSwitch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  discardFile: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
}

const fakePlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (entries: unknown) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  // The only method that actually touches disk: writes the real serialized
  // project text to the real scratch repo, so `git status`/`git diff`/`git
  // commit` all see genuine, meaningful content — not a stub.
  saveProject: async (text: string, handle: SaveHandle) => {
    writeFileSync(handle.path!, text)
    return handle
  },
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: 'blob:fake-pdf-source' }),
  needsPdfFolderGrant: () => false,
  grantPdfFolderAccess: async () => {},
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  getGit: () => fakeGit,
}

vi.mock('../../platform', () => ({ getPlatform: () => fakePlatform }))

const { useEditorStore, toAnnotationDefs } = await import('../../state/editorStore')
const { useStore } = await import('../../state/store')
const { useGitStore } = await import('../../state/gitStore')
const { SchemaTreeEditor } = await import('../../components/SchemaTreeEditor')
const { PdfViewer } = await import('../../components/PdfViewer')
const { AnnotationPanel } = await import('../../components/AnnotationPanel')
const { GitDialog } = await import('../../components/GitDialog')

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'sailor-integration-'))
  projectJsonPath = join(repoDir, 'project.json')
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'SaiLoR Integration Test'])
  writeFileSync(projectJsonPath, '{}')
  copyFileSync(join(process.cwd(), 'samples/pdfs/multipage.pdf'), join(repoDir, 'sample.pdf'))
  git(['add', '-A'])
  git(['commit', '-m', 'Initial commit'])
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

describe('annotation workflow: schema, PDF annotation, git commit', () => {
  it('authors a schema, annotates a PDF, and commits the result with real git', async () => {
    const user = userEvent.setup()

    // ---- Phase A: author a schema covering every field type ----------------
    render(<SchemaTreeEditor />)

    async function addField(name: string, kind?: 'number' | 'boolean' | 'year' | 'group') {
      await user.click(screen.getByRole('button', { name: '+ Add field' }))
      const nameInput = screen.getAllByPlaceholderText('Field name').at(-1)!
      await user.type(nameInput, name)
      if (kind) {
        const kindSelect = screen.getAllByTitle('What kind of value this field holds').at(-1)!
        await user.selectOptions(kindSelect, kind)
      }
    }

    await addField('Study Type') // defaults to 'string'
    await addField('Sample Size', 'number')
    await addField('Randomized', 'boolean')
    await addField('Publication Year', 'year')
    await addField('Findings', 'group')
    await user.click(screen.getAllByTitle('Add a nested field under this one').at(-1)!)
    const claimInput = screen.getAllByPlaceholderText('Field name').at(-1)!
    await user.type(claimInput, 'Claim') // defaults to 'string'

    const schemaDefs = toAnnotationDefs(useEditorStore.getState().nodes)
    expect(schemaDefs.map((d) => d.type)).toEqual(
      expect.arrayContaining(['string', 'number', 'boolean', 'year', undefined]),
    )
    const findings = schemaDefs.find((d) => d.name === 'Findings')
    expect(findings?.children?.[0]?.name).toBe('Claim')

    cleanup()

    // ---- Phase B: seed a project with that schema, annotate the PDF --------
    const projectJson = JSON.stringify({
      version: 1,
      config: { schema: schemaDefs },
      papers: [{ id: 'p1', title: 'Fixture Paper', authors: ['A. Author'], pdf: 'sample.pdf', annotations: {} }],
    })
    useStore.getState().loadFromText(projectJson, { kind: 'electron', path: projectJsonPath }, 'project.json')
    useStore.getState().selectPaper('p1')

    render(
      <>
        <PdfViewer />
        <AnnotationPanel />
      </>,
    )

    const textSpan = await screen.findByText(PDF_SAMPLE_TEXT)

    // Mark text: select the sample sentence and confirm the highlight offer,
    // exactly as a real click-drag-then-swatch-click would.
    const range = document.createRange()
    range.selectNodeContents(textSpan)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(textSpan)

    const highlightSwatch = (await screen.findAllByRole('button', { name: /^Highlight in/ }))[0]
    await user.click(highlightSwatch)

    expect(document.querySelector('.pdf-mark-rect')).toBeInTheDocument()
    expect(useStore.getState().currentPdfMarks()).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'highlight' })]),
    )

    // The highlight's comment popover opens automatically right after — type
    // a note into it.
    const highlightComment = await screen.findByPlaceholderText('Add a comment…')
    await user.type(highlightComment, 'Worth citing in the review.')
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(useStore.getState().currentPdfMarks()).toEqual(
      expect.arrayContaining([expect.objectContaining({ comment: 'Worth citing in the review.' })]),
    )

    // Add a sticky note via the annotation toolbar.
    await user.click(screen.getByRole('button', { name: 'Annotation tools' }))
    await user.click(screen.getByRole('button', { name: 'Add sticky note' }))
    const pageEl = document.querySelector('.react-pdf__Page')!
    fireEvent.click(pageEl, { clientX: 50, clientY: 50 })

    expect(document.querySelector('.pdf-mark-note')).toBeInTheDocument()
    expect(useStore.getState().currentPdfMarks()).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'note' })]),
    )
    await user.click(screen.getByRole('button', { name: 'Done' }))

    // Fill in one schema field value through the real annotation form.
    const studyTypeInput = screen.getByRole('textbox', { name: 'Study Type' })
    await user.type(studyTypeInput, 'RCT')
    expect(studyTypeInput).toHaveValue('RCT')

    cleanup()

    // ---- Phase C: save, then commit via the real Git panel -----------------
    expect(useStore.getState().dirty).toBe(true)
    const saved = await useStore.getState().save()
    expect(saved).toBe(true)
    expect(useStore.getState().dirty).toBe(false)

    await useGitStore.getState().refreshRepo({ kind: 'electron', path: projectJsonPath })
    await useGitStore.getState().openPanel()

    render(<GitDialog />)

    const commitMessage = 'Annotate fixture paper: schema, marks, and Study Type'
    await user.type(screen.getByLabelText('Commit message'), commitMessage)
    await user.click(screen.getByRole('button', { name: 'Commit' }))

    await screen.findByText('Committed.')

    // Verify independently of the app: a real commit landed in the real repo,
    // with the message the user typed and the annotated content inside it.
    const log = git(['log', '-1', '--format=%s'])
    expect(log.trim()).toBe(commitMessage)
    const committed = git(['show', 'HEAD:project.json'])
    expect(committed).toContain('Study Type')
    expect(committed).toContain('RCT')
    expect(committed).toContain('Worth citing in the review.')
  })
})
