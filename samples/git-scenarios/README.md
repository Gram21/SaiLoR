# Git scenarios

Ready-made situations for trying SaiLoR's git support by hand — two reviewers,
Anna and Ben, a shared `origin`, and one situation each: a clean pull, a conflict,
a renamed field, a stash left behind, and so on.

A git repository cannot be committed inside another one, so the scenarios are
kept here as definitions (`scenarios.ts`, starting from the small review in
`base.ts`) and **built on demand** into real repositories:

```bash
npm run scenario -- list                       # what there is
npm run scenario -- rename-vs-edit             # build one into a temporary folder
npm run scenario -- rename-vs-edit --out ~/sailor-scenarios/rename
npm run scenario -- all --out ~/sailor-scenarios
```

Each build prints the project file to open in SaiLoR and what you should see.
A built scenario folder holds `origin.git` (the shared remote) and one clone per
person (`anna/`, `ben/`); open a clone's `review.json`, and pull, push or commit
as that person — each clone is configured with its person's name and e-mail.

- **Deterministic.** Fixed names, e-mail addresses and commit dates, branch
  `main`, and none of your own git configuration: the same scenario gives the
  same commits everywhere, so a bug report can name exact hashes.
- **Never inside a repository.** The builder refuses an `--out` folder inside a
  git working tree (including this one), so a scenario's `.git` folders can't be
  committed by accident. The default is a new temporary folder.
- **Checked.** `npm run test:integration` builds every scenario and checks it sets
  up what its entry below says (`src/test/integration/gitScenarios.integration.test.tsx`);
  `npm run test:e2e` opens two of them in the real app. The list below is
  generated — after changing a scenario, run `npm run scenario -- readme` and
  paste the output between the markers; the integration test fails while they
  differ.

Only `smith2021` has a PDF (copied from `samples/pdfs/`); the other papers open
without one.

## Scenarios

<!-- scenarios:begin -->
### `disjoint-reviewers`

Anna and Ben each answered a different paper; Ben has not pulled yet.

Open `ben/review.json`.

- Open as Reviewer 2. The toolbar shows "↓ 1 to pull" (after the background fetch).
- Open Git and press Pull: it merges without asking anything.
- Both answers are there: Anna's on smith2021 (Reviewer 1), Ben's on lee2022 (Reviewer 2).

### `same-field-conflict`

Both consolidated smith2021's Design differently.

Open `ben/review.json`.

- Open Git and press Pull: the conflict dialog opens with one row, grouped under smith2021.
- Pick a side (or type a value) and press Finish merge.

### `schema-both-extended`

Anna added the field "Venue type", Ben added "Funding", each as a new schema version.

Open `ben/review.json`.

- Press Pull: it merges without asking; the schema now has both new fields.

### `rename-vs-edit`

Anna renamed "Design" to "Study design"; Ben still answered under "Design".

Open `ben/review.json`.

- Press Pull: no conflict; Ben's answer on lee2022 shows under "Study design".

### `conflicting-renames`

Anna renamed "Design" to "Study design", Ben renamed it to "Method".

Open `ben/review.json`.

- Press Pull: one row asks which name "Design" keeps; both answers follow the chosen name.

### `settings-conflict`

Both changed the reviewer count and the first research question differently.

Open `ben/review.json`.

- Press Pull: rows for "Number of reviewers" and "Research questions"; each takes mine, theirs or your own value.

### `seat-collision`

Ben already committed Reviewer 1 on garcia2023; Anna pulled and opens the same seat.

Open `anna/review.json`.

- Choose Reviewer 1 and open garcia2023: a notice names Ben Example as having committed that seat on this paper.

### `unpulled`

Ben pushed two commits Anna has not fetched.

Open `anna/review.json`.

- Within a few seconds of opening, the toolbar shows "↓ 2 to pull". Pull fast-forwards.

### `risky-local-config`

Like `unpulled`, but Anna's repository config names an ssh command.

Open `anna/review.json`.

- The count stays at nothing to pull: SaiLoR refuses to fetch in the background for a repository whose own config names a program to run.
- Press Pull: it fetches (you asked for it) and fast-forwards.

### `stashes`

Anna has one stash made in SaiLoR and one left behind by a branch switch.

Open `anna/review.json`.

- The toolbar shows "2 stashed". In Git, "Stashed changes" lists both; the older one is marked as saved while switching branches.
- Restore one; restore the other on a new branch; delete neither or both as you like.

### `repo-setup-fresh`

A repository with no .gitattributes or .gitignore at all.

Open `anna/review.json`.

- On opening, a small popup says SaiLoR configured the repository; `git log` shows a commit authored by SaiLoR.

### `repo-setup-existing`

A repository whose .gitattributes has rules of the team's own.

Open `anna/review.json`.

- On opening, SaiLoR asks before adding its rules; "No" leaves the file alone, "Add" adds a marked block below the existing rule.

### `detached-head`

Anna checked out a commit instead of a branch and has an uncommitted answer.

Open `anna/review.json`.

- In Git, Commit is refused with a message to check out a branch first.

### `shared-annotations`

Two annotation projects in one folder share annotations/ and a paper.

Open `anna/review.json`.

- On opening, "Give each project its own annotations folder" lists review.json and review-copy.json.
- The files of the papers both list are marked for you to confirm. Split, then look at `git status` in anna/: renames.

### `schema-versions`

One file predates schema versions (answer under the old name "Kind"), one names a version the project does not know.

Open `anna/review.json`.

- As Reviewer 1, smith2021 shows its answer under "Design" (carried from "Kind").
- Validate lists lee2022 under "Unknown schema version".

### `conflict-markers`

An annotation file left with git's conflict markers in it.

Open `anna/review.json`.

- The toolbar shows "⚠ 1 unreadable"; click it for the file. Saving never deletes that file.

### `stale-save`

A script changes one of Anna's files while she has the project open.

Open `anna/review.json`.

- Open as Reviewer 1, change lee2022's Design, and do not save yet.
- Run ./change-on-disk.sh in the scenario folder.
- Save: SaiLoR stops and offers Overwrite / Keep theirs / Combine for lee2022 — Reviewer 1.
<!-- scenarios:end -->
