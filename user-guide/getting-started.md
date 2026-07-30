# Getting started

## The three-pane layout

Once a project is open, the screen is three panes: your **papers** on the left, the **PDF** in the
middle, and the **annotation form** on the right, built from the project's schema.

<p align="center">
  <img src="screenshots/annotate-overview.png" alt="The annotation view: paper list on the left, PDF in the middle, annotation form on the right" width="900">
</p>

- **Pick a paper** from the left list to load its PDF and its form.
- **Read the PDF** in the middle; its text is selectable, and **Ctrl/Cmd+F** searches within it.
- **Fill in the form** on the right. Repeatable fields (like *Findings* above) show **+ Add** and a
  remove (**×**) control for each entry.
- **Save** via the *Save* menu, or **Ctrl/Cmd+S**. *Save as…* writes to a new location and
  re-derives every PDF reference so they keep resolving from there.

If the project is set up for **screening** instead of full annotation, this pane shows a title/abstract
record and an Include/Exclude choice instead — see [Screening](screening.md). If it's set up for
**multiple reviewers**, you'll be asked which seat you are before you can annotate anything — see
[Working with several reviewers](multi-reviewer.md).

## Finding a paper

The box above the paper list searches **title, authors, DOI, abstract, the PDF's file name, and the
paper's own id** by default (the **META** trigger on the right edge of the box). Click that trigger to
switch to **TAGS**, which searches the **annotation content** you've already recorded instead — useful
for "which papers did I mark as X".

<p align="center">
  <img src="screenshots/paper-search.png" alt="Searching the paper list for 'A1-37', a PDF's file name, and finding the one matching paper" width="900">
</p>

The search above matches `A1-37` — part of a PDF's *file name*, not its title or authors — and still
finds the right paper. Searching by the paper's own id works the same way; both are useful once a
project has more papers than you can recognize by title alone.

Annotation-content search looks at *your own* current seat's answers, so in a multi-reviewer project
it finds your work, not somebody else's.

## Grabbing text straight from the PDF

Select any text in the PDF, then click the **⧉** button next to a field to insert exactly that
selection into it. Numeric fields pull out the first number in the selection.

<p align="center">
  <img src="screenshots/grab-from-pdf-selection.png" alt="Text selected in the PDF, ready to be grabbed into an annotation field" width="900">
</p>

This is the fastest way to fill in most fields without retyping anything from the paper — select the
sentence that supports a claim, click ⧉ next to *Claim*, done.

## Highlighting and commenting in the PDF

Select text in the PDF and a small color toolbar appears — pick a color to highlight the selection
and open a note box for it right away. Click any existing highlight later to reopen that box: change
its color, edit or clear the note, or delete it. Press **Escape**, click elsewhere, or scroll the page
to close the box without deleting anything.

These highlights and notes are your own — in a multi-reviewer project, each reviewer (and
Consolidation) sees only their own marks, just like annotation answers. They're saved with the
project like everything else, but on their own file per paper per reviewer, so two people marking up
the same PDF never conflict in git.

**More annotation tools.** The 📝 button in the PDF header opens a row of annotation tools below it:

- A post-it button for dropping a sticky note anywhere on the page — click the button, then click
  the spot in the PDF, and the note's comment box opens right away.
- ‹ › buttons to step through every highlight and note on the paper, in reading order, jumping
  straight to each one's exact spot on the page (not just the top of the page it's on).
- A 📤 button (enabled once you have at least one highlight or note) that exports the PDF with your
  marks burned in as real PDF annotation objects any PDF reader can show — for sharing outside
  SaiLoR. Choose to save it as a new file (the default) or overwrite the paper's own PDF in place;
  the app warns before the second option, since that file is shared with every other reviewer and
  overwriting it is likely to cause a git conflict.

**Linking a highlight or note to a field.** Next to every annotation field is a small 🔗 button —
click it to record why you picked this value. It opens a box showing what's already linked (or "No
links yet"); click **+ Link a highlight or note** to fold out a scrollable list of the paper's other
highlights and notes, with a search box at the bottom if there are a lot of them. Clicking a
highlight/note's text — in either list — jumps to it in the PDF so you can see which one it is,
without closing the box or changing anything; click **Link** to actually attach it. The button shows
a count once you've linked one or more (`🔗 2`). A highlight or note can be linked to any number of
fields, and a field can have any number linked to it. To remove a link, click the × next to it —
either in the field's own box, or by opening the highlight/note itself in the PDF, where its box
lists every field it's linked to.

## The completeness dot

Each paper in the list carries a status dot on its left. In an ordinary (non-screening) project, it
fills in proportionally as fields are completed:

<p align="center">
  <img src="screenshots/completeness-dots.png" alt="Paper list showing a partially-filled completeness dot on the first paper, empty dots on the rest" width="280">
</p>

- If the schema marks any fields **required**, the dot's denominator is those required fields only.
- If nothing is marked required, it's a fraction of *all* fields instead — better than nothing rather
  than staying permanently empty.
- Hover a dot (or check its accessible label) for the actual numbers: "3 of 12 fields filled".

The **fill** is always progress; the **color** says whose move it is:

| Dot | State | Meaning |
| --- | --- | --- |
| empty | *Not started* | nothing filled in yet |
| amber slice | *In progress* | partly filled |
| solid amber | *Ready to finish* | every counted field is filled, but nobody has said it's done |
| solid green | *Finished* | you ticked **Annotation finished** and it still holds |
| red | *Finished, required fields missing* | ticked while a **required** field is empty — see below |

This dot means something different depending on your seat: for a numbered reviewer it's your own
progress and your own sign-off; for **Consolidation** it's a simple done/not-done marker instead
(whether every reviewer has recorded something for that paper yet); in a **screening** project it
becomes the tri-state include/exclude/undecided marker described in [Screening](screening.md).

## Marking a paper finished

A completely filled form is not the same as a finished paper, so SaiLoR does not decide that for
you. The **Annotation finished** checkbox sits at the top of the annotation panel, under the paper's
title, and is always there — tick it when you're done with the paper. Only then does its dot turn
green.

### When red appears

Red means one specific thing: **a field that had to be filled is empty on a paper you called
finished.** "Had to be filled" is the schema's own `required` flag — the same rule
[Validate](#validating) uses — so the red dot and the Validate dialog can never disagree.

- If your schema marks **nothing** required, no paper ever turns red. An unanswered question is
  often the right record of a paper that doesn't address it, and ticking the box says so.
- A **Yes/No** field is never a hole. Unticking it records *no*, which is an answer — it can't turn
  a finished paper red even if the field is marked required. (Same reason Validate never reports a
  Yes/No field as missing.)
- Ticking early — before a required field is filled — is allowed rather than blocked. Sometimes a
  paper genuinely can't be filled in further; the app marks the disagreement instead of hiding it.

The mark is re-evaluated from the current data, live, as you type: **it is not tied to saving.**
Empty a required field on a finished paper and it turns red at once; refill it and it goes green
again. Nothing is ever silently un-ticked — the declaration is yours to withdraw by unticking the
box.

The tick is yours alone: in a multi-reviewer project each reviewer — and Consolidation — has their
own checkbox and their own green dot, saved in their own file.

### Where a project opens

Opening a project puts you on the **first paper that isn't finished** — including one showing red —
rather than on paper 1, which on a review you've been working through is something you already
signed off. If every paper is finished, it opens on the first one as before. Screening projects, and
a multi-reviewer project where you haven't picked a seat yet, also open on the first paper: neither
has a per-seat "finished" to go by.

## Filtering by annotation state

The dropdown under the search box narrows the list to one of three buckets:

- **In progress** — every paper you have *not* ticked as finished, whatever its dot shows: untouched,
  part-filled, and filled-but-not-yet-signed-off alike. Undo some annotations, or untick the box on a
  paper you had finished, and it comes back here.
- **Finished** — ticked and still holding.
- **With issues** — ticked while a required field is empty (the red dots).

The five dot colors are unchanged; the filter is just coarser than they are, since "what still needs
work" is the question you actually ask a list.

The line under "Papers" counts whichever bucket is selected, across the whole project regardless of
the search box: `finished: 5/100`. With no filter set it counts *finished*, the headline number.
Screening projects keep their own include/exclude/undecided filter instead, and the Consolidation
seat has neither — its dot answers "has every reviewer annotated this paper" instead.

## Validating

**Validate** (in the toolbar) checks every annotated paper against the schema: required fields that
are still empty, values of the wrong type, and enum values outside a dropdown's allowed choices.

<p align="center">
  <img src="screenshots/validate-dialog.png" alt="The Validate dialog listing three problems on one paper, and four papers not yet annotated" width="900">
</p>

Click a problem to jump straight to that field. Papers with **no annotations at all** are listed
separately under *Not annotated yet* rather than reported field by field — an untouched paper would
otherwise fail every required field at once and bury the problems that are actually worth looking at.

Note the reminder at the top of the dialog: a *Yes/No* field is never reported as missing, even if
it's marked required — see [Things to know](things-to-know.md#a-smaller-one-a-yesno-field-can-never-be-reported-as-missing).

## Keyboard shortcuts

Press **F1** at any time for the full, current list for whichever screen you're on — it differs
between the start screen, annotating, screening, and the project editor. The most common ones while
annotating:

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+O | Open a project file |
| Ctrl/Cmd+S | Save |
| Ctrl/Cmd+Shift+S | Save as… |
| Ctrl/Cmd+Z / Shift+Z | Undo / redo an annotation change |
| Ctrl/Cmd+F | Search within the PDF |
| Alt+↓ / `]` | Next paper |
| Alt+↑ / `[` | Previous paper |
| F1 | Open help |
