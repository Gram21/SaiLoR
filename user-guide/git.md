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
annotations, and both refuse outright if anything else in the repository is uncommitted — commit or
stash that first.

## Commit history

**History…**, next to Merge branch… in the panel's header, lists the commits that changed the open
project's own file — not the whole repository, just this project — newest first. Click a row to see
what it changed: the same field-by-field "Was/Now" view the commit review above uses, computed
against that commit's parent, but read-only — history is for looking back, not for redoing a
decision. A commit shows "Initial commit — nothing to compare" if it has no parent, and a note about
the schema/protocol/etc. having changed instead of a diff if that commit isn't one field-level diffing
can make sense of. The list is capped at the latest 250 commits; past that it says so rather than
cutting off silently.

### What Pull, Merge, and carrying changes into a new branch refuse to guess at

A few kinds of disagreement can't be expressed as a field-level conflict, so instead of guessing,
SaiLoR aborts cleanly — nothing changes — and tells you what to reconcile first. This applies equally
to Pull, to Merge branch…, and to carrying uncommitted changes into a branch switch, since all three
go through the same merge:

- The **annotation schema** was changed on both sides, differently — it decides the shape of every
  tree, so there's no per-field answer to offer.
- The **review protocol**, or **where the project was imported from**, was edited on both sides,
  differently — each is a single nested record, not something a conflict row can represent piece by
  piece.
- **A conflict outside the project** (a PDF, a `.gitignore`, anything else git couldn't merge on
  its own) — resolve it with git directly, then try again.
- **Two different people claiming the same reviewer seat**, with different git identities — see
  [Reviewer-seat identity](multi-reviewer.md#reviewer-seat-identity).

None of these leave anything half-done: the git merge itself is aborted, so the repository ends up
exactly where it started.

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
- Show live clone progress with a cancel button, or offer history browsing — out of scope for this
  feature.

## Credentials

SaiLoR never asks for your password and never stores one. Every git operation runs through your own
credential helper and SSH agent, exactly as a terminal `git` command would.
