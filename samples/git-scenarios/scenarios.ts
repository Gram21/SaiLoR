import { execFileSync } from 'node:child_process'
import { planRepoSetup } from '../../src/git/repoSetup'
import { BRANCH_SWITCH_STASH_MESSAGE, MANUAL_STASH_PREFIX, parseStashList, STASH_LIST_FORMAT } from '../../src/git/stash'
import { parseAnnotationAuthors } from '../../src/git/seatOwner'
import { backgroundFetchAllowed, FETCH_COMMAND_KEYS } from '../../src/git/fetchPolicy'
import { planSplit } from '../../src/model/annotationSplit'
import { annotationsDirOf, filesCollide, sharesPaper } from '../../src/model/annotationsDir'
import { ANNA, BEN, type Scenario, type Stage } from './builder'
import { answers, assert, PROJECT, pullOutcome, review, SCHEMA, start, V0, version } from './base'

/** Every git scenario, in the order the README lists them. */

const RENAMED = [{ name: 'Study design', type: 'string', options: ['RCT', 'Cohort', 'Case study'] }]
const withDesign = (design: object[]) => [...design, { name: 'Sample size', type: 'number' }, { name: 'Findings', min: 0, max: null, children: [{ name: 'Claim', type: 'string' }] }]

const merged = (stage: Stage, who = BEN) => {
  const outcome = pullOutcome(stage, who)
  assert(outcome.kind === 'merged', `the merge was refused: ${outcome.kind === 'refused' ? outcome.details.join(' ') : ''}`)
  return outcome
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'disjoint-reviewers',
    summary: 'Anna and Ben each answered a different paper; Ben has not pulled yet.',
    open: 'ben/review.json',
    check: [
      'Open as Reviewer 2. The toolbar shows "↓ 1 to pull" (after the background fetch).',
      'Open Git and press Pull: it merges without asking anything.',
      "Both answers are there: Anna's on smith2021 (Reviewer 1), Ben's on lee2022 (Reviewer 2).",
    ],
    build(s) {
      start(s)
      s.writeProject(ANNA, PROJECT, review({ answers: { smith2021: { r1: answers({ Design: 'RCT' }) } } }))
      s.commit(ANNA, 'Reviewer 1: smith2021')
      s.push(ANNA)
      s.writeProject(BEN, PROJECT, review({ answers: { lee2022: { r2: answers({ Design: 'Cohort' }) } } }))
      s.commit(BEN, 'Reviewer 2: lee2022')
    },
    verify(s) {
      const o = merged(s)
      assert(o.conflicts.length === 0, 'expected no conflicts')
      const paper = (id: string) => o.merged.papers.find((p) => p.id === id)!
      assert(paper('smith2021').reviews['1'].Design[0].value === 'RCT', "Anna's answer is merged")
      assert(paper('lee2022').reviews['2'].Design[0].value === 'Cohort', "Ben's answer is kept")
    },
  },
  {
    name: 'same-field-conflict',
    summary: "Both consolidated smith2021's Design differently.",
    open: 'ben/review.json',
    check: [
      'Open Git and press Pull: the conflict dialog opens with one row, grouped under smith2021.',
      'Pick a side (or type a value) and press Finish merge.',
    ],
    build(s) {
      start(s)
      s.writeProject(ANNA, PROJECT, review({ answers: { smith2021: { consolidated: answers({ Design: 'RCT' }) } } }))
      s.commit(ANNA, 'Consolidation: smith2021')
      s.push(ANNA)
      s.writeProject(BEN, PROJECT, review({ answers: { smith2021: { consolidated: answers({ Design: 'Case study' }) } } }))
      s.commit(BEN, 'Consolidation: smith2021')
    },
    verify(s) {
      const o = merged(s)
      assert(o.conflicts.length === 1 && o.conflicts[0].paperId === 'smith2021', 'expected one conflict on smith2021')
    },
  },
  {
    name: 'schema-both-extended',
    summary: 'Anna added the field "Venue type", Ben added "Funding", each as a new schema version.',
    open: 'ben/review.json',
    check: ['Press Pull: it merges without asking; the schema now has both new fields.'],
    build(s) {
      start(s)
      s.writeProject(ANNA, PROJECT, review({ schema: [...SCHEMA, { name: 'Venue type', type: 'string' }], schemaVersion: 'v1-anna', schemaHistory: [version(V0, []), version('v1-anna', [V0])] }))
      s.commit(ANNA, 'Schema: add Venue type')
      s.push(ANNA)
      s.writeProject(BEN, PROJECT, review({ schema: [...SCHEMA, { name: 'Funding', type: 'string' }], schemaVersion: 'v1-ben', schemaHistory: [version(V0, []), version('v1-ben', [V0])] }))
      s.commit(BEN, 'Schema: add Funding')
    },
    verify(s) {
      const o = merged(s)
      const names = o.merged.schema.map((d) => d.name)
      assert(names.includes('Venue type') && names.includes('Funding'), 'both new fields are in the merged schema')
      assert(o.conflicts.length === 0, 'expected no conflicts')
      assert(o.merged.schemaHistory.at(-1)!.parents.length === 2, 'the merge gets a version descending from both')
    },
  },
  {
    name: 'rename-vs-edit',
    summary: 'Anna renamed "Design" to "Study design"; Ben still answered under "Design".',
    open: 'ben/review.json',
    check: ["Press Pull: no conflict; Ben's answer on lee2022 shows under \"Study design\"."],
    build(s) {
      start(s, { base: { answers: { lee2022: { r2: answers({ Design: 'RCT' }) } } } })
      s.writeProject(ANNA, PROJECT, review({
        schema: withDesign(RENAMED),
        answers: { lee2022: { r2: answers({ 'Study design': 'RCT' }) } },
        schemaVersion: 'v1-rename',
        schemaHistory: [version(V0, []), version('v1-rename', [V0], [{ from: ['Design'], to: ['Study design'] }])],
      }))
      s.commit(ANNA, 'Schema: rename Design to Study design')
      s.push(ANNA)
      s.writeProject(BEN, PROJECT, review({ answers: { lee2022: { r2: answers({ Design: 'Case study' }) } } }))
      s.commit(BEN, 'Reviewer 2: lee2022 is a case study')
    },
    verify(s) {
      const o = merged(s)
      assert(o.conflicts.length === 0, 'expected no conflicts')
      const lee = o.merged.papers.find((p) => p.id === 'lee2022')!
      assert(lee.reviews['2']['Study design'][0].value === 'Case study', "Ben's edit lands in the renamed field")
    },
  },
  {
    name: 'conflicting-renames',
    summary: 'Anna renamed "Design" to "Study design", Ben renamed it to "Method".',
    open: 'ben/review.json',
    check: ['Press Pull: one row asks which name "Design" keeps; both answers follow the chosen name.'],
    build(s) {
      start(s, { base: { answers: { smith2021: { r1: answers({ Design: 'RCT' }) } } } })
      const renameTo = (name: string, id: string) =>
        review({
          schema: withDesign([{ ...RENAMED[0], name }]),
          answers: { smith2021: { r1: answers({ [name]: 'RCT' }) } },
          schemaVersion: id,
          schemaHistory: [version(V0, []), version(id, [V0], [{ from: ['Design'], to: [name] }])],
        })
      s.writeProject(ANNA, PROJECT, renameTo('Study design', 'v1-anna'))
      s.commit(ANNA, 'Schema: rename Design to Study design')
      s.push(ANNA)
      s.writeProject(BEN, PROJECT, renameTo('Method', 'v1-ben'))
      s.commit(BEN, 'Schema: rename Design to Method')
    },
    verify(s) {
      const o = merged(s)
      assert(o.conflicts.filter((c) => c.label.includes('renamed differently')).length === 1, 'expected one rename row')
    },
  },
  {
    name: 'settings-conflict',
    summary: 'Both changed the reviewer count and the first research question differently.',
    open: 'ben/review.json',
    check: ['Press Pull: rows for "Number of reviewers" and "Research questions"; each takes mine, theirs or your own value.'],
    build(s) {
      start(s, { base: { protocol: { researchQuestions: ['RQ1: How is code searched?'] } } })
      s.writeProject(ANNA, PROJECT, review({ reviewers: 3, protocol: { researchQuestions: ['RQ1: How is code searched?', 'RQ2 (Anna)'] } }))
      s.commit(ANNA, 'Three reviewers, second RQ')
      s.push(ANNA)
      s.writeProject(BEN, PROJECT, review({ reviewers: 4, protocol: { researchQuestions: ['RQ1: How is code searched?', 'RQ2 (Ben)'] } }))
      s.commit(BEN, 'Four reviewers, second RQ')
    },
    verify(s) {
      const rows = merged(s).conflicts.map((c) => c.canonical)
      assert(rows.includes('reviewers') && rows.includes('protocol.researchQuestions'), `expected settings rows, got ${rows.join(', ')}`)
    },
  },
  {
    name: 'seat-collision',
    summary: 'Ben already committed Reviewer 1 on garcia2023; Anna pulled and opens the same seat.',
    open: 'anna/review.json',
    check: ['Choose Reviewer 1 and open garcia2023: a notice names Ben Example as having committed that seat on this paper.'],
    build(s) {
      start(s)
      s.writeProject(BEN, PROJECT, review({ answers: { garcia2023: { r1: answers({ Design: 'Cohort' }) } } }))
      s.commit(BEN, 'Reviewer 1: garcia2023')
      s.push(BEN)
      s.pull(ANNA)
    },
    verify(s) {
      const log = s.git(ANNA, 'log', '--no-merges', '--format=%x00%an%x09%ae', '--name-only', '--', 'annotations')
      const owners = parseAnnotationAuthors(log, 'annotations')
      assert(owners['garcia2023/reviewer-1.json']?.email === BEN.email, 'Ben is the last author of that seat')
    },
  },
  {
    name: 'unpulled',
    summary: 'Ben pushed two commits Anna has not fetched.',
    open: 'anna/review.json',
    check: ['Within a few seconds of opening, the toolbar shows "↓ 2 to pull". Pull fast-forwards.'],
    build(s) {
      start(s)
      s.writeProject(BEN, PROJECT, review({ answers: { chen2024: { r2: answers({ Design: 'RCT' }) } } }))
      s.commit(BEN, 'Reviewer 2: chen2024')
      s.writeProject(BEN, PROJECT, review({ answers: { chen2024: { r2: answers({ Design: 'RCT', 'Sample size': 120 }) } } }))
      s.commit(BEN, 'Reviewer 2: chen2024 sample size')
      s.push(BEN)
    },
    verify(s) {
      s.git(ANNA, 'fetch', '-q', 'origin')
      assert(s.git(ANNA, 'rev-list', '--count', 'HEAD..origin/main').trim() === '2', 'Anna is two commits behind')
    },
  },
  {
    name: 'risky-local-config',
    summary: "Like `unpulled`, but Anna's repository config names an ssh command.",
    open: 'anna/review.json',
    check: [
      'The count stays at nothing to pull: SaiLoR refuses to fetch in the background for a repository whose own config names a program to run.',
      'Press Pull: it fetches (you asked for it) and fast-forwards.',
    ],
    build(s) {
      start(s)
      s.writeProject(BEN, PROJECT, review({ answers: { chen2024: { r2: answers({ Design: 'Cohort' }) } } }))
      s.commit(BEN, 'Reviewer 2: chen2024')
      s.push(BEN)
      s.git(ANNA, 'config', 'core.sshCommand', 'ssh -o BatchMode=yes')
    },
    verify(s) {
      let keys = ''
      try {
        keys = s.git(ANNA, 'config', '--local', '--name-only', '--get-regexp', FETCH_COMMAND_KEYS)
      } catch {
        // exit 1: no match
      }
      assert(!backgroundFetchAllowed(keys), 'the background fetch is refused')
    },
  },
  {
    name: 'stashes',
    summary: 'Anna has one stash made in SaiLoR and one left behind by a branch switch.',
    open: 'anna/review.json',
    check: [
      'The toolbar shows "2 stashed". In Git, "Stashed changes" lists both; the older one is marked as saved while switching branches.',
      'Restore one; restore the other on a new branch; delete neither or both as you like.',
    ],
    build(s) {
      start(s)
      s.writeProject(ANNA, PROJECT, review({ answers: { smith2021: { r1: answers({ Design: 'RCT' }) } } }))
      s.git(ANNA, 'stash', 'push', '-q', '-u', '-m', BRANCH_SWITCH_STASH_MESSAGE)
      s.writeProject(ANNA, PROJECT, review({ answers: { lee2022: { r1: answers({ Design: 'Cohort' }) } } }))
      s.git(ANNA, 'stash', 'push', '-q', '-u', '-m', `${MANUAL_STASH_PREFIX}Half-done lee2022`)
    },
    verify(s) {
      const entries = parseStashList(s.git(ANNA, 'stash', 'list', `--format=${STASH_LIST_FORMAT}`))
      assert(entries.map((e) => e.origin).join(',') === 'sailor,branch-switch', 'one SaiLoR stash and one carry-over stash')
    },
  },
  {
    name: 'repo-setup-fresh',
    summary: 'A repository with no .gitattributes or .gitignore at all.',
    open: 'anna/review.json',
    check: ['On opening, a small popup says SaiLoR configured the repository; `git log` shows a commit authored by SaiLoR.'],
    build(s) {
      start(s, { noRepoSetup: true })
    },
    verify(s) {
      const plan = planRepoSetup(null, null)
      assert(!plan.upToDate && !plan.needsConsent, 'the rules are added without asking')
      assert(!s.git(ANNA, 'ls-files').includes('.gitattributes'), 'no .gitattributes yet')
    },
  },
  {
    name: 'repo-setup-existing',
    summary: 'A repository whose .gitattributes has rules of the team\'s own.',
    open: 'anna/review.json',
    check: ['On opening, SaiLoR asks before adding its rules; "No" leaves the file alone, "Add" adds a marked block below the existing rule.'],
    build(s) {
      start(s, { ownAttributes: '*.pdf binary\n' })
    },
    verify(s) {
      const plan = planRepoSetup(s.read(ANNA, '.gitattributes'), null)
      assert(plan.needsConsent, 'SaiLoR asks first')
    },
  },
  {
    name: 'detached-head',
    summary: 'Anna checked out a commit instead of a branch and has an uncommitted answer.',
    open: 'anna/review.json',
    check: ['In Git, Commit is refused with a message to check out a branch first.'],
    build(s) {
      start(s)
      s.git(ANNA, 'checkout', '-q', '--detach')
      s.writeProject(ANNA, PROJECT, review({ answers: { smith2021: { r1: answers({ Design: 'RCT' }) } } }))
    },
    verify(s) {
      let attached = true
      try {
        s.git(ANNA, 'symbolic-ref', '-q', 'HEAD')
      } catch {
        attached = false
      }
      assert(!attached, 'HEAD is detached')
    },
  },
  {
    name: 'shared-annotations',
    summary: 'Two annotation projects in one folder share annotations/ and a paper.',
    open: 'anna/review.json',
    check: [
      'On opening, "Give each project its own annotations folder" lists review.json and review-copy.json.',
      'The files of the papers both list are marked for you to confirm. Split, then look at `git status` in anna/: renames.',
    ],
    build(s) {
      start(s, { base: { answers: { smith2021: { r1: answers({ Design: 'RCT' }) }, chen2024: { r2: answers({ Design: 'Cohort' }) } } } })
      s.write(ANNA, 'review-copy.json', s.read(ANNA, PROJECT).replace('Example review for git scenarios', 'A copy that shares the folder'))
      s.commit(ANNA, 'Add a second project next to the first')
      s.push(ANNA)
    },
    verify(s) {
      const projects = ['review.json', 'review-copy.json'].map((name) => ({ path: name, name, meta: JSON.parse(s.read(ANNA, name)) }))
      const files = s
        .git(ANNA, 'ls-files', 'annotations')
        .split('\n')
        .filter(Boolean)
        .map((p) => ({ relPath: p.slice('annotations/'.length), text: s.read(ANNA, p) }))
      assert(planSplit(projects, files).some((r) => r.ambiguous), 'some files could belong to either project')
    },
  },
  {
    name: 'screening-beside-annotation',
    summary: 'A screening project and an annotation project over the same papers share annotations/.',
    open: 'anna/review.json',
    check: [
      'Opening either project asks nothing: the two kinds write differently named files, highlights included.',
      'Open screening.json too and highlight something in smith2021 — it lands in screening-marks-1.json, next to the annotation project\'s files.',
    ],
    build(s) {
      start(s, { base: { answers: { smith2021: { r1: answers({ Design: 'RCT' }) } } } })
      s.writeProject(ANNA, 'screening.json', {
        version: 1,
        title: 'Title and abstract screening',
        config: { reviewers: 2, screening: { reasons: ['Off topic', 'Not peer reviewed'] } },
        papers: ['smith2021', 'lee2022', 'wong2020'].map((id) => ({
          id,
          title: `Candidate ${id}`,
          authors: [],
          pdf: `pdfs/${id}.pdf`,
          annotations: {},
          reviews: { 1: { Decision: [{ value: 'include' }] } },
        })),
      })
      s.commit(ANNA, 'Keep the screening next to the annotation project')
      s.push(ANNA)
    },
    verify(s) {
      const review = JSON.parse(s.read(ANNA, PROJECT))
      const screening = JSON.parse(s.read(ANNA, 'screening.json'))
      const ids = (raw: { papers: { id: string }[] }) => raw.papers.map((p) => p.id)
      assert(annotationsDirOf(review) === annotationsDirOf(screening), 'both use the same folder')
      assert(sharesPaper(ids(review), screening), 'they list some of the same papers')
      assert(!filesCollide(ids(review), false, screening), 'and still write no file in common')
    },
  },
  {
    name: 'schema-versions',
    summary: 'One file predates schema versions (answer under the old name "Kind"), one names a version the project does not know.',
    open: 'anna/review.json',
    check: [
      'As Reviewer 1, smith2021 shows its answer under "Design" (carried from "Kind").',
      'Validate lists lee2022 under "Unknown schema version".',
    ],
    build(s) {
      start(s, {
        base: {
          schemaVersion: 'v1-rename',
          schemaHistory: [version(V0, []), version('v1-rename', [V0], [{ from: ['Kind'], to: ['Design'] }])],
        },
      })
      s.write(ANNA, 'annotations/smith2021/reviewer-1.json', { annotations: { Kind: [{ value: 'RCT' }] } })
      s.write(ANNA, 'annotations/lee2022/reviewer-1.json', { schemaVersion: 'from-another-branch', annotations: { Design: [{ value: 'Cohort' }] } })
      s.commit(ANNA, 'Files from before and from elsewhere')
    },
    verify(s) {
      const p = s.project(ANNA, PROJECT)
      const smith = p.papers.find((x) => x.id === 'smith2021')!
      const lee = p.papers.find((x) => x.id === 'lee2022')!
      assert(smith.reviews['1'].Design[0].value === 'RCT', 'the old answer is carried to "Design"')
      assert(lee.unknownSchemaFiles?.includes('review-1'), 'the unknown version is reported')
    },
  },
  {
    name: 'conflict-markers',
    summary: "An annotation file left with git's conflict markers in it.",
    open: 'anna/review.json',
    check: ['The toolbar shows "⚠ 1 unreadable"; click it for the file. Saving never deletes that file.'],
    build(s) {
      start(s)
      s.write(
        ANNA,
        'annotations/smith2021/reviewer-2.json',
        '<<<<<<< HEAD\n{"annotations":{"Design":[{"value":"RCT"}]}}\n=======\n{"annotations":{"Design":[{"value":"Cohort"}]}}\n>>>>>>> origin/main\n',
      )
    },
    verify(s) {
      let parses = true
      try {
        JSON.parse(s.read(ANNA, 'annotations/smith2021/reviewer-2.json'))
      } catch {
        parses = false
      }
      assert(!parses, 'the file does not parse')
    },
  },
  {
    name: 'stale-save',
    summary: "A script changes one of Anna's files while she has the project open.",
    open: 'anna/review.json',
    check: [
      'Open as Reviewer 1, change lee2022\'s Design, and do not save yet.',
      'Run ./change-on-disk.sh in the scenario folder.',
      'Save: SaiLoR stops and offers Overwrite / Keep theirs / Combine for lee2022 — Reviewer 1.',
    ],
    build(s) {
      start(s, { base: { answers: { lee2022: { r1: answers({ Design: 'RCT' }) } } } })
      s.script('change-on-disk.sh', [
        `printf '%s\\n' '{"schemaVersion":"${V0}","annotations":{"Design":[{"value":"Case study"}],"Sample size":[{"value":42}]}}' > anna/annotations/lee2022/reviewer-1.json`,
        'echo "Changed anna/annotations/lee2022/reviewer-1.json on disk."',
      ])
    },
    verify(s) {
      const before = s.read(ANNA, 'annotations/lee2022/reviewer-1.json')
      execFileSync(`${s.dir}/change-on-disk.sh`, { stdio: 'ignore' })
      const after = s.read(ANNA, 'annotations/lee2022/reviewer-1.json')
      assert(before !== after && JSON.parse(after).annotations['Sample size'][0].value === 42, 'the script changes the file')
    },
  },
]

export function scenarioNamed(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name)
}

/** The scenario list as it appears in README.md, between its generated-block markers. */
export function scenariosMarkdown(): string {
  return SCENARIOS.map((s) =>
    [`### \`${s.name}\``, '', s.summary, '', `Open \`${s.open}\`.`, '', ...s.check.map((c) => `- ${c}`), ''].join('\n'),
  ).join('\n')
}
