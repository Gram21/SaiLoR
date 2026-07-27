# Things to know

Short, and worth reading once before you rely on this for real review data. Each of these is a real
way to lose or corrupt work — none of them are hypothetical.

## Hand-editing config in the JSON silently deletes your changes

⚠️ The project file's `config` section (`config.schema`, `config.screening`, `config.reviewers`, and a
few others) is **rebuilt from scratch every time SaiLoR saves**. Any key it doesn't specifically know
about gets thrown away in that rebuild — including one you typed in by hand five seconds earlier.

```jsonc
{
  "version": 1,
  "config": {
    "schema": [ /* … */ ],
    "myNotes": "please don't put things here"   // ← gone the next time anyone saves
  }
}
```

This is **not** a bug you can work around by being careful — it's how the file format works, and it
applies even if you added the key through some other tool, not just by typing JSON yourself. If you
want to record something SaiLoR doesn't have a field for, two places are actually safe:

- **The review protocol** (research questions, search strings, databases, search date, notes) has a
  real, dedicated home: the project editor's *Review protocol* section, saved as a top-level
  `protocol` key. See [Setting up a project](project-editor.md#the-review-protocol).
- **Any other top-level key** (not nested under `config`) survives untouched. `{"version": 1,
  "myLabNotes": "…", "config": {...}, "papers": [...]}` keeps `myLabNotes` forever, exactly as
  written, because top-level keys the app doesn't recognize are preserved verbatim — only `config`'s
  own contents are rebuilt.

If you're not sure whether something you're adding is top-level or nested under `config`, put it at
the top level.

## No file locking, so two people saving at once overwrite each other

⚠️ A project is a `project.json` file plus a sibling `annotations/` folder (one file per paper per
reviewer, so different reviewers' or different papers' answers live in different files — see
[Setting up a project](project-editor.md) for why). That split means two reviewers working on
*different* papers, or different reviewer slots of the same paper, no longer touch the same file at
all when saving. It does **not** give you file locking, though: if two people have the *same* file
open — including `project.json` itself, or the same reviewer's answers for the same paper — and both
save (over email, a shared drive, a synced folder), the second save wins completely; the first
person's changes are gone with no warning.

Two ways people actually handle this:

- **Take turns** on anything you might both touch at once. Whoever's turn it is has the folder; pass
  it along (email, shared drive, whatever) when you're done.
- **Use git.** Each person works on their own clone; SaiLoR's git support merges different reviewers'
  answers field by field instead of overwriting, and the file split above means far fewer of those
  merges even need a decision from you. See [Git support](git.md).

## PDF paths are relative to the JSON file

⚠️ Every paper's `pdf` path is stored relative to `project.json`'s own location, not as an
absolute path. This is deliberate — it's what lets you zip up the project and its `pdfs/` folder and
hand the whole thing to someone else and have it just work. But it means:

- **Moving `project.json` in Finder/Explorer, without using SaiLoR, breaks every PDF reference**
  unless you move the PDFs along with it in exactly the same relative arrangement — and it also
  strands your annotations, which live in the sibling `annotations/` folder next to `project.json`,
  not inside it. **Always move the whole project folder together** — `project.json`, `annotations/`,
  and `pdfs/` — never `project.json` on its own.
- **Use *Save as…*, or the project editor's *Change…* button, to relocate a project instead** — both
  re-derive every PDF path for the new location automatically, and move `annotations/` along with it.

## Two people must not pick the same reviewer seat

⚠️ Each reviewer's answers live in their own file (`annotations/<paper>/reviewer-1.json`,
`reviewer-2.json`, …). If two *different people* — on two different clones of the same project — both
pick "Reviewer 1", their answers will merge into one chimeric tree the next time the project is pulled
together via git, with **no warning**, unless the project already records who holds each seat.

When you're using git, SaiLoR records your git identity (name/email) the first time you claim a seat,
and warns you if you try to take a seat someone else already claimed. That protection only exists
when git is available and the seat has actually been claimed once with it on — agree out of band (a
message, a spreadsheet, whatever) who is Reviewer 1 and who is Reviewer 2 regardless. See
[Reviewer-seat identity](multi-reviewer.md#reviewer-seat-identity).

## Renaming or removing a schema field drops its answers

⚠️ Answers are stored keyed by the field's *name*. If you rename "Study Type" to "Design Type" in
the schema editor, every answer anyone recorded under "Study Type" is orphaned and dropped the next
time the file is saved — there's no automatic migration. Settle field names before people start
annotating, where you can; if you must rename one later, do it while nobody has annotated with it yet.

(Screening's exclusion reasons are the one place this *is* handled automatically: renaming a reason
that's already in use prompts SaiLoR to offer moving existing decisions to the new name. See
[Screening](screening.md#renaming-a-reason).)

## Discard in the git commit review is real the moment you press the button

⚠️ The field-level commit review lets you mark a local change **Discard** instead of committing or
ignoring it. Marking it is free — nothing happens until you actually press **Commit** (which discards
it as part of committing everything else) or **Discard all** (which discards it immediately, with
nothing committed). Once you press either of those, the discarded value is reverted on disk right
then. It isn't a soft "hide this from the diff" — it's a real revert, confirmed with a dialog telling
you how many changes are about to be thrown away. See
[Field-level commit review](git.md#field-level-commit-review).

## A smaller one: a Yes/No field can never be reported as missing

An unticked checkbox is a real answer ("no"), not an absence of one — SaiLoR has no way to tell
"deliberately unchecked" apart from "never looked at". That's why the schema editor doesn't offer a
*Required* option on Yes/No fields at all: it would look like a setting that does something, and it
never could. If you need a genuine third state ("not stated in the paper"), use a Text field with
fixed options instead of a checkbox — see [Setting up a project](project-editor.md#building-the-schema).
