# Git support

**Desktop app only.** Git support runs your own `git` binary, so it can use your real
`~/.gitconfig`, your credential helper, and your SSH agent — exactly as a terminal `git` command
would. (SaiLoR's discontinued web build could never have offered this either — a web page can't spawn
a process or read your git config — but that's moot now: the web build no longer opens projects at
all, see the main [README](README.md).)

If `git` isn't on your `PATH` in the desktop app, the same controls appear greyed out with git's own
error explaining why.

## Cloning a repository

**Import from remote git…**, on the start screen and in the toolbar's *Open ▾* menu: paste a repository URL,
pick a destination folder, confirm. A clone of a repository full of PDFs can take a while, so you get
a spinner and an elapsed-seconds line rather than a frozen-looking window. On success you pick which
project JSON to open, and the picker already starts inside the folder that was just cloned.

## The Git panel

The toolbar's **Git** button appears whenever the open project's folder sits inside a git repository —
disabled, with a reason on hover, when it doesn't (no project open, or the project isn't in a
repository).

Next to it, the toolbar tells you what's waiting:

- **↓ N to pull** — someone has pushed commits you haven't pulled yet. SaiLoR fetches in the
  background to keep this current: when the project opens, whenever you open the Git panel, and every
  two minutes. That fetch only updates git's knowledge of the remote; it never touches your files.
- **N stashed** — changes of this project are parked in a stash (see [Stashing changes](#stashing-changes)).
- **⚠ N unreadable** — annotation files that aren't valid JSON (typically left with git conflict
  markers in them) and were skipped when the project opened. Click it for the list. SaiLoR never
  deletes them, but it can't show what's in them, and annotating that paper in that seat writes a new
  file over it — fix them first.

### Repository setup

When a project in a repository opens, SaiLoR checks that the repository's `.gitattributes`
and `.gitignore` (next to the project file) hold the rules it relies on:

- JSON files get LF line endings on every platform, so a reviewer on Windows doesn't turn every save
  into a whole-file diff, and git's line-by-line merge is turned off for them — it can combine two
  reviewers' answers into valid JSON neither of them wrote. SaiLoR does its own
  [field-by-field merge](#pull) instead.
- Operating-system clutter (`.DS_Store`, `Thumbs.db`, `desktop.ini`, editor swap files) is ignored,
  because one of those sitting untracked in the `annotations/` folder would block every pull. PDFs are
  not ignored; whether to commit them is up to your team.

The rules go in a clearly marked block, and nothing outside it is changed. If neither file has rules of
its own, SaiLoR adds the block without asking; otherwise it asks first, and asks again later if you
said no. The change is committed right
away with SaiLoR as author and you as committer, and a small popup confirms it.

## Switching branches

The panel's header shows the current branch as a dropdown of every local branch — pick a different
one to switch:

- **Nothing uncommitted?** It switches right away.
- **Something uncommitted?** You're asked: **commit first** (closes this and switches nothing — you're
  already looking at the commit form), **carry the changes over** (switches, then merges your
  uncommitted work into the new branch field by field — the same engine [Pull](#pull) uses below), or
  **cancel**.

**+ New branch…**, near the end of the dropdown, creates a branch at your current commit and
switches to it right away, going through the exact same carry-over-or-not flow above. Since the new
branch starts as an identical copy of the one you're on, carrying uncommitted changes into it can
never itself produce a conflict — there's nothing for your changes to disagree with yet.

**- Delete branch…**, the last entry, opens a small dialog to pick a local branch (never the one
you're on) and delete it. Git refuses on its own — with its own message shown verbatim — when the
branch isn't fully merged into the one you're on; there's no force option here, so if you really mean
it, do that from a terminal. Only local branches are offered: deleting a remote one needs
`git push origin --delete`, a different, more consequential operation this dialog doesn't attempt.

### Field-level commit review

When your changes are to the open project's own file, SaiLoR breaks them down **field by field**
instead of offering only a whole-file checkbox — "Field: was *this*, now *that*":

<p align="center">
  <img src="screenshots/git-field-review.png" alt="The Git panel's field-level review: three changed fields, each with Use/Ignore/Discard, and a commit message" width="900">
</p>

Each row gets three choices:

- **Use** — commit this field's new value.
- **Ignore** — leave it as an uncommitted local change, offered again next time. Nothing about it is
  touched.
- **Discard** — revert it back to the committed value. This only actually happens once you press
  **Commit** or **Discard all**, never the moment you click it — see
  [Things to know](things-to-know.md#discard-in-the-git-commit-review-is-real-the-moment-you-press-the-button).

**Use all / Ignore all / Discard all**, above the field list, apply one disposition to everything at
once. If, after your choices, nothing is left marked *Use* — either because you ignored everything or
discarded everything — the **Commit** button relabels itself to **Discard all** and turns red,
because committing at that point would write nothing new; pressing it just performs the discards
directly, with no message needed.

Some changes have no row of their own because nobody typed them: reading notes, finished marks,
AI-usage records, and how Consolidation matched up entries. The review says how many papers they
changed for, and they are committed whatever you pick above.

Any change to a file *other* than the open project's own — a PDF you added, say — still shows as a
plain whole-file checkbox underneath, exactly as before field-level review existed. Each of those
rows also has a small **↺** button: for a file you've already committed before, it reverts that one
file back to the last commit; for a new, untracked file, it deletes it from disk. Either way you're
asked to confirm first, and it cannot be undone. A renamed file or one with an unresolved merge
conflict has no ↺ at all — reverting either correctly takes more than SaiLoR does here, so it's left
for you to sort out with git directly rather than have the button guess.

## Pull

**Pull** fetches, and either fast-forwards, reports "already up to date", or — on a genuine
divergence — merges the three revisions of the project JSON **field by field**, not as text. A field
only *you* changed keeps your value; a field only the *remote* changed takes theirs. Only a field
**both sides changed, to different things**, is a real conflict, and those are the only ones you're
ever asked about.

<p align="center">
  <img src="screenshots/git-merge-conflicts.png" alt="The merge-conflict dialog: conflicts grouped by paper in collapsible sections, with full untruncated values on both sides" width="900">
</p>

Conflicts are **grouped by paper**, one collapsible section per paper — a section collapses
automatically the instant every conflict inside it is decided, so a long list of conflicts across many
papers doesn't stay one undifferentiated wall of rows. Reopening a collapsed section to change a
decision never gets forced shut again on its own. Both sides of every conflict are shown in full,
wrapped rather than truncated, alongside an editable middle value you can type your own reconciled
answer into, or take one side wholesale with the ◀ / ▶ buttons.

**Use all mine / Use all remote** resolve every remaining conflict at once toward one side. Nothing is
committed until every conflict has been decided — the **Finish merge** button stays disabled until
then.

## Merging another branch

**Merge branch…**, a quieter text button in the panel's header, next to the close button — merging is
a deliberate, occasional action, so it deliberately doesn't sit in the commit/pull/push row you use
every session. It opens a small dialog: pick a branch from the dropdown (grouped into **Local**
branches and **Remote** ones like `origin/side` that a fetch has brought in), and the dialog spells out
the direction in plain language — "Merge *branch* into the current branch *your-branch*" — so it's
never ambiguous which way things merge. Press **OK** and it runs the ordinary `git merge`, with the
same field-by-field reconciliation Pull uses: "already up to date", a fast-forward, a merge commit
made straight away when the two sides don't disagree, or the same conflict dialog above when they do.
Cancel there and the merge is aborted; the repository ends up exactly where it started.

Picking a remote branch fetches first, so you get it as it is now, not as it was the last time
anything fetched. Merging never moves you off your branch — that's what
[Switching branches](#switching-branches) is for.

Both Merge and Pull work on the **file on disk**, so both are greyed out while you have unsaved
annotations, and both refuse outright while any tracked file in the repository has uncommitted
changes, or an untracked file sits in the project's `annotations/` folder — commit or
[stash](#stashing-changes) those first. Untracked files elsewhere (a PDF you haven't added yet, say) don't
block anything.

Pull, Merge, and Push wait for a background fetch that is still running rather than race it.

## Commit history

**History…**, next to Merge branch… in the panel's header, lists the commits that changed the open
project's own file — not the whole repository, just this project — newest first. Click a row to see
what it changed: the same field-by-field "Was/Now" view the commit review above uses, computed
against that commit's parent, but read-only — history is for looking back, not for redoing a
decision. A commit shows "Initial commit — nothing to compare" if it has no parent, and a note about
the schema/protocol/etc. having changed instead of a diff if that commit isn't one field-level diffing
can make sense of. The list is capped at the latest 250 commits; past that it says so rather than
cutting off silently.

### How the project's own settings are merged

Pull, Merge branch…, carrying changes into a branch switch, and combining a save with changes on disk
all merge the project's settings part by part, with the same rule as for answers: a part only one
side changed takes that change, and only a part both changed differently becomes a row in the
conflict dialog.

- **The schema is merged node by node.** Fields either side added are all kept, a field one side
  removed is removed, and a field one side renamed is renamed. Where both changed the *same* field,
  each property is its own row: its description, required flag, minimum and maximum entries, and
  fixed choices (one per line, so you can type a combined list) take mine, theirs, or your own
  value; its kind of answer and when it is shown are mine or theirs. A field one side removed and
  the other changed asks whether to keep or remove it. Answers under a field that ends up removed
  are not deleted: they stay in the files, hidden, and come back if the field does. A field renamed
  or moved on one side follows that rename on the other side too, so answers recorded there under the
  old name merge into it. If **both** sides renamed the same field differently, one row asks which
  name it keeps; both sides' answers are merged under it either way.
- **Reviewer count** takes mine, theirs, or a number you type; the **AI** and **finished checkbox**
  switches take either value.
- **The review protocol** is merged entry by entry — research questions, search strings, databases,
  search date, notes — each with mine, theirs, or your own text.
- **The screening setup** (reasons for exclusion), **where the papers were imported from**, and
  settings SaiLoR doesn't know are mine or theirs as a whole.

If the combined settings would make a project SaiLoR can't open — say, a group left with no fields —
**Finish** says why and writes nothing, so you can decide differently.

### What Pull, Merge, and carrying changes into a new branch refuse to guess at

A few kinds of disagreement can't be expressed as a conflict row, so instead of guessing, SaiLoR
aborts cleanly — nothing changes — and tells you what to reconcile first. This applies equally to
Pull, to Merge branch…, and to carrying uncommitted changes into a branch switch, since all three go
through the same merge:

- **A repeated entry shortened on one side and edited on the other** — SaiLoR can't tell which
  entry the edit belongs to.
- **The file format version** differs on both sides.
- **A conflict outside the project** (a PDF, a `.gitignore`, anything else git couldn't merge on
  its own) — resolve it with git directly, then try again.

None of these leave anything half-done: the git merge itself is aborted, so the repository ends up
exactly where it started.

## Stashing changes

**Stashed changes**, a collapsible section in the Git panel, parks this project's uncommitted changes
and gives you back a clean copy — for example to pull, or to switch branches without carrying your
work along. Only what's on disk is stashed, so save first. Add an optional note and press **Stash my
changes**; new annotation files are included, and other projects' files in the same folder are left
alone.

Each stash in the list offers:

- **Restore** — puts the changes back into your files and removes the stash. It's all or nothing: if
  the stash conflicts with what's there now, nothing is changed and you're told so.
- **Restore on a new branch** — puts the changes back on a new branch made at the commit where the
  stash was taken, which can never conflict. Use this when Restore refuses.
- **×** — deletes the stash after asking. Its changes are in no file or commit, so they're gone for
  good.

If a branch switch that was carrying your changes can't put them back, they stay in a stash rather
than being lost, and show up here as "Saved by SaiLoR while switching branches, and not put back
afterwards".

## What it won't do

- Merge a conflict outside the project (see above) — that's on you and plain git.
- Delete a paper the remote deleted, if you've annotated it since — it's kept, and you're told, rather
  than losing your work silently.
- Carry uncommitted changes across a branch switch if something *outside* the project is also
  uncommitted (a PDF you added, say) — SaiLoR refuses the whole switch up front rather than guess;
  commit or discard those first, then try again.
- Switch branches while you have **unsaved annotation edits** — a clean `git status` doesn't see
  those, only what's on disk, so the switch is refused with an error telling you to save first
  (**Ctrl/Cmd+S**) rather than silently reloading the project and losing them.
- Commit while no branch is checked out (a "detached HEAD", after checking out a commit in a
  terminal) — such a commit would belong to no branch and vanish from view at the next checkout.
  Check out a branch first.
- Show live clone progress with a cancel button — out of scope for this feature.

## Credentials

SaiLoR never asks for your password and never stores one. Every git operation runs through your own
credential helper and SSH agent, exactly as a terminal `git` command would.

The background fetch behind **↓ N to pull** never prompts: if it can't sign in without asking, it
fails quietly and tries again later, and your next Pull asks as usual. It is also skipped for a
repository whose own `.git/config` names a program for git to run during a fetch (an ssh command, a
credential helper, an included config file). A project folder that arrived by zip or shared drive
brings that config along, and SaiLoR runs those programs only on a Pull you pressed. Settings in your
own global git config don't count, so ordinary setups are unaffected.
