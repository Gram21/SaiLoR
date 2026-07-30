# Authoring a SaiLoR project file

This guide explains how to write the JSON "project" file that SaiLoR opens: how to
design the **annotation schema** (the taxonomy of fields you fill in for each paper) and how
to list the **papers** you want to annotate. It is written for researchers who are comfortable
editing JSON but are not necessarily programmers, and it is packed with copy‑paste‑ready
examples.

If you just want the short version, the [README](../README.md) has a one‑page format table.
This document is the in‑depth companion to it.

## Contents

1. [Overview](#1-overview)
2. [File structure at a glance](#2-file-structure-at-a-glance)
3. [Defining the annotation schema](#3-defining-the-annotation-schema)
4. [Defining the papers](#4-defining-the-papers)
5. [What the file looks like after annotating](#5-what-the-file-looks-like-after-annotating)
6. [A complete example](#6-a-complete-example)
7. [Opening a project](#7-opening-a-project)
8. [Validation & common mistakes](#8-validation--common-mistakes)
9. [Multiple reviewers & Consolidation](#9-multiple-reviewers--consolidation)
10. [Screening projects](#10-screening-projects)

---

## 1. Overview

A **project** is a single JSON file that holds two things together:

- a **schema** — the taxonomy of annotation fields you want to record for every paper, and
- a list of **papers** — the documents you will read and annotate.

As you annotate in the app and save, your answers are written back into the same file, under
each paper's `annotations`. So the one file is your schema, your paper list, and your data.

The file is **plain JSON**. That means a few rules you must follow, or the file will not open:

- **No comments.** JSON has no `//` or `/* */` comments. (This guide explains fields in prose
  and tables *around* the code blocks — never with comments *inside* them.)
- **No trailing commas.** The last item in a list or object must not be followed by a comma.
- **Double quotes only.** All keys and all string values use `"double quotes"`, never
  `'single quotes'`.

A good habit: after editing, paste the file into any JSON validator (or run it through your
editor's JSON linter) before opening it in SaiLoR.

---

## 2. File structure at a glance

The top‑level object has three keys:

```json
{
  "version": 1,
  "config": {
    "schema": [],
    "ai": true,
    "finishCheckbox": true,
    "reviewers": 1
  },
  "papers": []
}
```

| Key         | Required? | What it is                                                                 |
| ----------- | --------- | -------------------------------------------------------------------------- |
| `version`   | optional  | A number. If you omit it, the app treats it as `1`.                        |
| `title`     | optional  | A display name for the review; falls back to the file name when absent.    |
| `config`    | required  | The annotation schema (`schema`) and options such as `ai`, `screening`.    |
| `protocol`  | optional  | The review's protocol — research questions, search, criteria. See below.   |
| `provenance`| optional  | Set by *New from screening…* to record where the papers came from (§10).   |
| `papers`    | required  | The list of papers to annotate.                                            |

`config.schema` must be an **array with at least one node** — *unless* `config.screening` is
present, in which case `schema` is ignored entirely (see [§10](#10-screening-projects)) and may be
omitted from the file. Every other project still needs a non-empty `schema`; an empty (or missing)
one is rejected.

**`config.ai` — forbid AI-assisted annotation.** Optional, defaults to `true`. Set it to `false` and
the **✦ AI** button is disabled for anyone who opens the file. Use this when the papers must not be
sent to a third-party model — an embargoed corpus, or a review whose protocol forbids it. It only
affects this project file; it is written out only when `false`, so a normal file never carries the
key. The project editor exposes it as a checkbox (see §2 of the app's *New / Edit annotation JSON*
screen).

**`config.finishCheckbox` — how a paper counts as finished.** Optional, defaults to `true`.

With the default, reviewers sign each paper off by hand: an **Annotation finished** checkbox sits at
the top of the annotation panel, and only ticking it turns that paper's dot green in the paper list.
A full form is not a sign-off — the point is that "done" is a judgement a person made about the
extraction, not something inferred from the fields being non-empty. Tick it while a `required` field
is still empty (or empty such a field afterwards) and the paper shows red until the two agree again.

Set it to `false` and the sign-off step disappears: the checkbox is not shown, and a paper counts as
finished exactly when its schema is fulfilled — every `required` field filled, or every field if the
schema marks none required. Nothing can be red in this mode, since there is no declaration left for
the data to contradict, and the paper list's filter drops its *With issues* option accordingly.

Choose `false` when the schema itself already encodes what "complete" means and the extra click buys
nothing; keep the default when a reviewer's own judgement of "I am done with this paper" is part of
the protocol. Like `config.ai`, it is written out only when `false`, so a file that never sets it
stays exactly as it was. Ticks recorded while it was on are kept in the per-paper annotation files
untouched, so turning it back on restores them.

Note that `config.ai` can only ever *restrict* the feature, not guarantee it: `true` (or omitting
the key) does not by itself mean the button is available to whoever opens the file — the app may
have its own reasons for keeping AI-assisted annotation off that this setting does not override.
`false` always wins, in every build.

**`config.reviewers` — multiple independent reviewers.** Optional, defaults to `1`
(single-reviewer — the behavior described through the rest of this guide). Set it to a number from
2 to 10 to have that many reviewers annotate every paper **independently**, then reconcile their
answers into one final result via a built-in **Consolidation** role. See
[§9](#9-multiple-reviewers--consolidation) for the full picture, including what happens if you
*lower* it after reviewers have already written something. It is written out only when
greater than 1, so a normal single-reviewer file never carries the key. The project editor exposes
it as a checkbox + a reviewer-count field next to the AI opt-out.

**`protocol` — the review's own protocol.** Optional. A record of the research questions, the
search that ran, and the criteria behind the review — kept *inside* the project file so a
pre-registered protocol travels with the data it produced. Every part is optional:

```jsonc
"protocol": {
  "researchQuestions": ["RQ1: …", "RQ2: …"],
  "searchStrings":     ["(\"code search\" AND \"deep learning\")"],
  "databases":         ["Scopus", "IEEE Xplore"],
  "searchDate":        "2024-03",            // free text — a range is fine
  "notes":             "Inclusion/exclusion criteria and any other notes."
}
```

It is a **top-level** key, deliberately not under `config` — see the warning just below. Author it
in the project editor's collapsed *Review protocol* section; it is written out only when non-empty,
so a project without one stays byte-clean.

**Extra keys are preserved — but only at the top level.** Any additional *top‑level* key you add
(say, `"notes"`) is kept verbatim when the app saves the file, as are extra keys inside a paper
object. **Keys you add inside `config` are not**: `config` is rebuilt from its known fields on every
save, so a hand-added `config.protocol` or `config.researchQuestions` is *silently dropped* the
first time the file is saved. Put anything you want kept at the top level, not inside `config`.

---

## 3. Defining the annotation schema

The schema lives at `config.schema` and is an array of **nodes**. Each node describes one
thing you want to record. A node is written as a JSON object (its technical name is
`AnnotationDef`) with these fields:

| Field         | Type                                   | Required | Default | Meaning                                                                                   |
| ------------- | -------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `name`        | string                                 | **yes**  | —       | The label shown in the form. **Sibling names must be unique** (see below).               |
| `type`        | `"string"` \| `"number"` \| `"boolean"` \| `"year"`| no       | —       | Makes the node an editable field. **Omit it** to make a group (a name‑only branch).       |
| `children`    | array of nodes                         | no       | —       | A nested sub‑taxonomy. A node may have `type`, `children`, or **both**.                    |
| `min`         | number                                 | no       | `1`     | Minimum number of times this node may occur.                                              |
| `max`         | number or `null`                       | no       | `1`     | Maximum occurrences. A positive whole number, or `null` for **unbounded**.                |
| `options`     | array of strings                       | no       | —       | Turns a `string` field into an **enum dropdown** of allowed values (see §3.2).            |
| `required`    | boolean                                | no       | `false` | Marks a **field** the reviewer must fill in. Shows a `*` next to the name; an empty one is reported by validation. Only valid on a node with a `type` — **and never on a `boolean`**: an unticked checkbox is already a real answer (`false`), so a boolean is never "empty" and `required` on one can never fire. The editor doesn't offer it there, and a stray one in a hand-edited file is dropped on load (not an error). |
| `description` | string                                 | no       | —       | A help note. The name shows an ⓘ marker and reveals this text on hover.                    |

Two structural rules the app enforces:

- **Every node must have a `type`, or a non‑empty `children`, or both.** A node with neither is
  invalid (it would be a label pointing at nothing).
- **Sibling names must be unique.** Two nodes at the same level cannot share a `name`, because
  the name is the key under which the saved data is stored. Duplicates cause a load error.
  (Names in *different* branches may repeat — the rule is only about direct siblings.)

> **Note for maintainers.** This description of the format is mirrored in the LLM system prompt
> (`SCHEMA_FORMAT_DOC` in `src/llm/prompt.ts`), so that the *AI-assisted annotation* feature can
> hand a model a schema it has never seen and have it read the schema rather than pattern-match a
> familiar one. The two are kept in step **by hand**: if the format changes here, change it there
> too.

### 3.1 Simple fields (string, number, boolean, year)

The simplest node is a single field. Add a `type` and you get an editable value:

```json
{
  "name": "Relevant",
  "type": "boolean",
  "description": "Is this paper relevant to the review?"
}
```

```json
{
  "name": "Study Type",
  "type": "string"
}
```

```json
{
  "name": "Publication Year",
  "type": "year"
}
```

The four types behave as you'd expect:

- `boolean` — a checkbox. Empty means `false`.
- `string` — free text. Empty means "not filled in".
- `number` — a numeric field. Empty means "not filled in".
- `year` — a four-digit publication year (1000–2100), rejecting anything else (a typo like `20221`,
  a decimal, a bare `55`). Empty means "not filled in". Prefer this over a plain `number` for a
  publication year: it is the same on-disk shape (a JSON number) but with real range validation,
  where a bare `number` accepts anything.

> **Opening a `year` field in an older SaiLoR.** A file using `type: "year"` fails to load in a
> version of the app that predates this type (the same as any new type would) — the whole point of
> validating `type` against a fixed enum. If you need the file to stay readable by an older SaiLoR,
> use `type: "number"` instead and accept that it validates less.

Put together in a schema, these might look like:

```json
{
  "config": {
    "schema": [
      { "name": "Relevant", "type": "boolean" },
      { "name": "Study Type", "type": "string" },
      { "name": "Publication Year", "type": "year" }
    ]
  }
}
```

### 3.2 Enum fields: constraining a string to a set of options

When you want a field limited to a fixed set of choices, add an **`options`** array to a
`type: "string"` node. This turns the field into an **enum**: the app renders it as a
searchable **dropdown** (a combobox). Clicking the field opens the list of allowed options;
typing filters that list; the value you pick is stored as a plain string, exactly like any
other string field. Leaving it unselected stores `null`.

```json
{
  "name": "Evaluation Type",
  "type": "string",
  "options": ["Controlled experiment", "Case study", "Benchmark", "User study", "Survey", "Simulation", "Ablation study"],
  "description": "How the evidence was obtained"
}
```

Rules for `options`:

- It only applies to a `type: "string"` node. Using `options` **without** `type: "string"`
  (for example on a group, a number, or a boolean) is a schema error.
- It must be an **array of strings**.

You can still add a `description` alongside `options` for extra guidance in the tooltip, but the
dropdown itself is now the mechanism that keeps everyone using the same vocabulary — you no
longer need to spell the choices out in prose.

### 3.3 Groups and nested taxonomies

A node **without a `type`** but **with `children`** is a **group**: a branch that has no value
of its own but organizes fields underneath it. Groups let you build a taxonomy.

```json
{
  "name": "Threats to Validity",
  "children": [
    { "name": "Kind", "type": "string" },
    { "name": "Addressed", "type": "boolean" }
  ]
}
```

Here `Threats to Validity` records nothing itself; it groups a `Kind` string and an
`Addressed` boolean.

A node can also have **both** a `type` and `children` — a field that additionally owns a
sub‑tree:

```json
{
  "name": "Method",
  "type": "string",
  "description": "Primary method used",
  "children": [
    { "name": "Tool", "type": "string" },
    { "name": "Version", "type": "string" }
  ]
}
```

You can nest groups as deeply as you like.

### 3.4 Cardinality: `min` and `max`

By default every node occurs **exactly once** (`min` is `1`, `max` is `1`). You change how many
times a node may occur with `min` and `max`.

- `min` — the minimum number of instances. Defaults to `1`.
- `max` — the maximum number of instances: a positive whole number, or `null` for
  **unbounded**. Defaults to `1`.
- `max` must be **greater than or equal to** `min`.

A node is **repeatable** when its `max` is `null` or greater than `1`. In the form, repeatable
nodes show an **+ Add** button (up to `max`) and a remove (**×**) control (down to `min`).

Allow up to three of something:

```json
{
  "name": "Keyword",
  "type": "string",
  "min": 1,
  "max": 3
}
```

Allow **any number** (unbounded) by setting `max` to `null`:

```json
{
  "name": "Keyword",
  "type": "string",
  "min": 1,
  "max": null
}
```

> **A note on `min`.** The editor always shows at least one instance of every node, so in
> practice the effective minimum is 1. Setting `"min": 0` still shows one (possibly empty)
> instance; the difference is only that a `min: 0` instance left empty is pruned away when you
> save, whereas a `min: 1` instance is always kept.

### 3.5 Repeatable groups (multiple parallel sub‑trees)

Cardinality applies to **groups** too, not just fields. A repeatable group produces several
parallel copies of its whole sub‑tree — perfect for "list of findings", "list of
participants", and similar one‑to‑many structures.

```json
{
  "name": "Findings",
  "min": 1,
  "max": null,
  "description": "One or more key findings extracted from the paper.",
  "children": [
    { "name": "Claim", "type": "string" },
    { "name": "Evidence", "type": "string" },
    { "name": "Confidence", "type": "number", "description": "1 (low) to 5 (high)" }
  ]
}
```

Each `Findings` instance is a fresh `Claim` + `Evidence` + `Confidence` triple, and the
reviewer can add as many as the paper warrants.

You can bound a repeatable group as well. Between one and three threats:

```json
{
  "name": "Threats to Validity",
  "min": 1,
  "max": 3,
  "children": [
    { "name": "Kind", "type": "string" },
    { "name": "Addressed", "type": "boolean" }
  ]
}
```

---

## 4. Defining the papers

`papers` is an array of paper objects. Each paper has these fields:

| Field         | Type            | Required | Meaning                                                                     |
| ------------- | --------------- | -------- | --------------------------------------------------------------------------- |
| `id`          | string          | **yes**  | A unique identifier. Must not repeat across papers.                         |
| `title`       | string          | **yes**  | The paper's title, shown in the list and header.                            |
| `authors`     | array of strings| yes*     | Author names. May be an empty list `[]`.                                    |
| `doi`         | string          | no       | The DOI, if you have one.                                                   |
| `abstract`    | string          | no       | The abstract. Screening reads this when there is no PDF (see [§10](#10-screening-projects)); ordinary paper metadata otherwise. |
| `abstractFromPdf` | boolean     | no       | `true` when `abstract` was extracted from the PDF by a basic heuristic rather than authored — see [§10](#10-screening-projects). Meaningless (and dropped on load) without a non-empty `abstract`. |
| `pdf`         | string          | **yes**\*\* | Path to the PDF file, **relative to the JSON file's location**.          |
| `annotations` | object          | yes*     | The single/consolidated result. Use `{}` for a paper you haven't annotated yet. |
| `reviews`     | object          | no       | Multi-reviewer only — each reviewer's own tree, keyed `"1"` .. `"N"`. See [§9](#9-multiple-reviewers--consolidation). Omit entirely in a single-reviewer file. |

<sub>* `authors` and `annotations` are effectively required in a hand‑written file — set them to
`[]` and `{}` respectively when there's nothing yet.</sub>
<sub>\*\* `pdf` may be `""` **only** in a screening project ([§10](#10-screening-projects)) — screening
is normally done from `abstract` alone, often before any PDF has been attached. Every other project
still requires a non-empty `pdf`.</sub>

A minimal, not‑yet‑annotated paper:

```json
{
  "id": "paper-a",
  "title": "Deep Learning for Code Search: A Study",
  "authors": ["A. Author", "B. Writer"],
  "doi": "10.1000/xyz123",
  "pdf": "pdfs/paper-a.pdf",
  "annotations": {}
}
```

**Extra keys are preserved.** As with the top level, any additional key you add to a paper
(e.g. `"venue"` or `"tags"`) is kept verbatim when the app saves.

### How the `pdf` path resolves

The `pdf` value is resolved **relative to the location of the JSON file**, not relative to the
app or your home directory. If your project file is at `.../reviews/project.json` and a paper's
`pdf` is `"pdfs/paper-a.pdf"`, the app looks for `.../reviews/pdfs/paper-a.pdf`.

The recommended layout is to keep the project file next to a `pdfs/` folder:

```
my-review/
  project.json
  pdfs/
    paper-a.pdf
    paper-b.pdf
```

With that layout, each paper's `pdf` is simply `"pdfs/paper-a.pdf"`. This folder travels as a
unit — you can zip `my-review/` and hand it to a colleague, and every PDF path still resolves.

---

## 5. What the file looks like after annotating

When you first write a paper, its `annotations` is an empty object:

```json
{
  "id": "paper-a",
  "title": "Deep Learning for Code Search: A Study",
  "authors": ["A. Author", "B. Writer"],
  "pdf": "pdfs/paper-a.pdf",
  "annotations": {}
}
```

After you fill in the form and save, the app writes an **annotation value tree** into
`annotations`. Its shape mirrors the schema:

- At each level it is an object **keyed by node `name`**.
- Each key holds an **array of instances** (one entry per occurrence, bounded by `min`/`max`).
- Each instance is an object with a `value` (for field nodes) and/or `children` (a nested tree
  for group nodes).

Using the schema from [section 6](#6-a-complete-example) below, the same paper might save as:

```json
{
  "id": "paper-a",
  "title": "Deep Learning for Code Search: A Study",
  "authors": ["A. Author", "B. Writer"],
  "pdf": "pdfs/paper-a.pdf",
  "annotations": {
    "Relevant": [{ "value": true }],
    "Study Type": [{ "value": "Experiment" }],
    "Year": [{ "value": 2021 }],
    "Findings": [
      {
        "children": {
          "Claim": [{ "value": "Neural retrieval beats BM25 on their benchmark." }],
          "Evidence": [
            {
              "children": {
                "Metric": [{ "value": "MRR" }],
                "Evaluation Type": [{ "value": "Benchmark" }]
              }
            }
          ],
          "Confidence": [{ "value": 4 }]
        }
      },
      {
        "children": {
          "Claim": [{ "value": "Gains shrink on cross-language queries." }],
          "Evidence": [
            {
              "children": {
                "Metric": [{ "value": "MRR" }],
                "Evaluation Type": [{ "value": "Controlled experiment" }]
              }
            }
          ],
          "Confidence": [{ "value": 3 }]
        }
      }
    ]
  }
}
```

A few things worth knowing about how the app fills and tidies this tree:

- **Empty defaults.** A blank `boolean` saves as `false`; a blank `string` or `number` saves as
  `null`.
- **Minimums are honored.** Every node is filled to at least its `min` (and at least one)
  instance.
- **Trailing empties are pruned.** Optional instances you added but left completely empty are
  removed on save, so the file stays tidy. Required instances (up to `min`, at least one) are
  always kept even if empty.
- **`config` is never touched** by saving, and any unknown extra fields are preserved.

You normally don't hand‑write this tree — the app produces it. But understanding its shape helps
you read a saved file and spot problems.

### AI usage disclosure

If AI-assisted annotation is ever used on a paper, the app adds a top-level `aiUsage` array to
that paper — a permanent record of which provider and model produced values, and when:

```json
"aiUsage": [
  { "provider": "anthropic", "model": "claude-opus-4-8", "appliedAt": "2026-07-15T10:00:00.000Z" }
]
```

One entry is appended each time a reviewer accepts an AI-proposed run of values for this paper, in
the order they happened — array order (backed by `appliedAt`) is how "which use came first" is
read. A paper AI was never used on has no `aiUsage` key at all, so a normal, hand-annotated project
stays exactly as clean as before this feature existed. Unlike the annotation values themselves,
this record survives independently of any single field — it is not removed if the fields it
accompanied are later edited by hand, only if that entire AI-fill action is undone.

---

## 6. A complete example

Here is one realistic, fully‑valid SLR project: a schema mixing a boolean, strings (including
an `options` enum dropdown), a number, a repeatable **Findings** group with a nested
**Evidence** group, and a bounded **Threats to Validity** group — plus two papers. This block is
copy‑paste runnable: save it as `project.json`, put the two PDFs under `pdfs/`, and open it.

```json
{
  "version": 1,
  "config": {
    "schema": [
      {
        "name": "Relevant",
        "type": "boolean",
        "description": "Is this paper relevant to the review?"
      },
      {
        "name": "Study Type",
        "type": "string",
        "options": ["Case study", "Experiment", "Survey", "Literature review"],
        "description": "The empirical form of the study"
      },
      {
        "name": "Year",
        "type": "number"
      },
      {
        "name": "Findings",
        "min": 1,
        "max": null,
        "description": "One or more key findings extracted from the paper.",
        "children": [
          { "name": "Claim", "type": "string" },
          {
            "name": "Evidence",
            "children": [
              { "name": "Metric", "type": "string", "description": "e.g. MRR, F1, accuracy" },
              {
                "name": "Evaluation Type",
                "type": "string",
                "options": ["Controlled experiment", "Case study", "Benchmark", "User study", "Survey", "Simulation", "Ablation study"],
                "description": "How the evidence was obtained"
              }
            ]
          },
          { "name": "Confidence", "type": "number", "description": "1 (low) to 5 (high)" }
        ]
      },
      {
        "name": "Threats to Validity",
        "min": 1,
        "max": 3,
        "children": [
          {
            "name": "Kind",
            "type": "string",
            "description": "internal, external, construct, or conclusion"
          },
          { "name": "Addressed", "type": "boolean" }
        ]
      }
    ]
  },
  "papers": [
    {
      "id": "paper-a",
      "title": "Deep Learning for Code Search: A Study",
      "authors": ["A. Author", "B. Writer"],
      "doi": "10.1000/xyz123",
      "pdf": "pdfs/paper-a.pdf",
      "annotations": {}
    },
    {
      "id": "paper-b",
      "title": "A Survey of Program Repair Techniques",
      "authors": ["C. Coder", "D. Dev"],
      "doi": "10.1000/abc987",
      "pdf": "pdfs/paper-b.pdf",
      "annotations": {}
    }
  ]
}
```

---

## 7. Opening a project

**In the app — Open ▾ menu.** Click **Open…** to load a local JSON file, or reopen one of the
recent projects. SaiLoR is a desktop (Electron) app — see the [README](../README.md#deployment) for
building installers.

---

## 8. Validation & common mistakes

If a project won't open, it's almost always one of these:

- **Duplicate sibling names.** Two nodes at the same level share a `name`. Rename one — sibling
  names must be unique because they key the saved data.
- **`max` less than `min`.** The maximum must be greater than or equal to the minimum. Fix the
  numbers, or use `null` for `max` if you meant "unbounded".
- **A node with neither `type` nor `children`.** Every node needs a `type` (to be a field), a
  non‑empty `children` (to be a group), or both. A bare `{ "name": "X" }` is invalid.
- **`options` on a non‑string node.** The `options` enum list only applies to `type: "string"`
  nodes, and must be an array of strings. Using it anywhere else is rejected.
- **Comments or trailing commas.** JSON allows neither. Remove any `//` lines and any comma that
  sits before a closing `]` or `}`.
- **Wrong or missing `pdf` path.** Every paper needs a non-empty `pdf`, and the path is relative
  to the JSON file — *unless* this is a screening project ([§10](#10-screening-projects)), where
  `pdf: ""` is allowed. If the PDF won't load, check the path and the recommended
  `project.json` + `pdfs/` layout.
- **Duplicate paper `id`.** Each paper's `id` must be unique across the whole `papers` list;
  repeated ids break navigation and are rejected.
- **Empty schema.** `config.schema` must contain at least one node — unless `config.screening` is
  present, in which case `schema` is derived automatically and this check does not apply.

When a file fails to load, the app reports which check failed (and often the exact node or path),
so start from the message and work back to the offending line.

---

## 9. Multiple reviewers & Consolidation

Everything above describes the default, **single-reviewer** case: one `annotations` tree per
paper, one person filling it in. Set `config.reviewers` to a number from 2 to 10 to have that many
reviewers annotate **independently**, then reconcile disagreements into one final answer.

### What changes

- Each reviewer 1..N gets their **own** copy of every paper's fields — nobody sees anyone else's
  answers while annotating. In the app, a reviewer switch appears in the toolbar (hidden entirely
  for a single-reviewer project) so it is always obvious *whose* answers are on screen.
- In addition to the N reviewers, there is always one extra, built-in **Consolidation** role. It is
  not counted in `config.reviewers` and nobody explicitly assigns it — it is simply the seat for
  whoever reconciles the reviewers' answers. Consolidation sees every reviewer's value for each
  field side by side (a **compare** button next to the field) and picks the one that becomes final.
- `annotations` keeps doing exactly what it always did: it is the single, final result — what
  Consolidation writes, and what validation, and any future export, reads. In a single-reviewer
  project it is simply the only tree there is, unaffected by any of this.
- Each reviewer's own work is saved under a new per-paper `reviews` object, keyed by reviewer
  number as a string. Both `annotations` and every reviewer's tree are written **in full** — every
  field present, at its minimum count, holding `null`/`false` where nobody has answered yet — not
  as an empty `{}` and not as a missing key:

  ```json
  {
    "id": "paper-a",
    "title": "…",
    "pdf": "pdfs/paper-a.pdf",
    "annotations": { "Relevant": [{ "value": false }] },
    "reviews": {
      "1": { "Relevant": [{ "value": true }] },
      "2": { "Relevant": [{ "value": false }] }
    }
  }
  ```

  Reviewer 2 above hasn't necessarily answered — `{ "value": false }` is what an *untouched*
  boolean looks like too, the same as it does in an untouched `annotations` tree (§3.1: "boolean —
  a checkbox. Empty means `false`."). The point is that the key, and the field, are already there
  either way. This is deliberate, and it's for **git**: a reviewer's first real edit then changes a value on a line
  that already existed for every other paper and reviewer, instead of adding a brand-new key —
  which is what actually makes a `git diff` of one person's work readable on its own, and a
  `git merge` of two reviewers' independently-annotated copies of the same file survivable instead
  of a near-guaranteed conflict on top of whatever they actually disagree about.

  That still matters even though SaiLoR's own **Git → Pull** does not actually depend on it: a pull
  reads the three revisions of the project file and reconciles them field by field over the parsed
  data, not by asking git to merge the JSON's *lines* — so its correctness never rested on the
  file's shape to begin with. The skeleton keeps doing its other two jobs regardless: a legible
  `git diff`, and a plain `git merge` — run from the command line, or by any tool that isn't
  SaiLoR — staying tractable instead of a conflict on the shape of the JSON, on top of whatever the
  reviewers actually disagree about.

  `reviews` is written only for a multi-reviewer project — a single-reviewer file never has a
  `reviews` key on any paper, so it stays exactly as it always was. But for a multi-reviewer
  project, every reviewer `1..N` gets a key **from the moment the project is opened**, whether or
  not they have written anything; it is not created lazily on that reviewer's first write.

  **A file that predates this — `annotations: {}`, or a `reviews` object missing some
  reviewers — is fixed automatically the next time it is opened**, and saved back if there is
  somewhere to save it (not a browser download, and not a read-only server-hosted file). You don't
  need to do anything by hand; opening the project once is enough.

### Setting it up

The project editor's *New / Edit annotation JSON…* screen has a **Multiple reviewers** checkbox
next to the AI opt-out; enabling it exposes a reviewer-count field (2–10) and writes
`config.reviewers` into the file. Hand-editing the JSON works the same way — add `"reviewers": 3`
under `config`.

The editor itself doesn't write the full per-reviewer skeleton described above — it preserves
whatever a paper's `annotations` already were, verbatim, while the schema is being edited. That's
fine: the first time the saved file is *opened* (including "Save and annotate", which opens it
immediately), it gets normalized into the full shape automatically — see above.

### Lowering the reviewer count

Changing `config.reviewers` back down — say from 3 to 2, because the third reviewer left the
project — does **not** delete Reviewer 3's answers. Their `reviews["3"]` tree stays in the file
exactly as they left it; nothing on load or save touches a `reviews` key just because it no longer
falls in `1..config.reviewers`.

What changes is that it becomes **invisible and excluded** for as long as the count stays lowered:

- The reviewer switch only offers seats `1..N`, so nobody can select "Reviewer 3" to view, edit, or
  Validate their answers.
- Consolidation's compare/align tooling and the automatic "everyone already agreed" fill only
  consider reviewers `1..N` — Reviewer 3's answers take no part in either, even where they agree
  with the others.

Raise `config.reviewers` back to 3 (or higher) and Reviewer 3's tree — and their seat in the
switch — reappears exactly as it was left. Treat lowering the count as *hiding* a reviewer's work,
not discarding it; if you actually want it gone, that has to be done by hand.

### Validating

**Validate** checks the tree the active reviewer is responsible for: a numbered reviewer's own
answers, or — for Consolidation — the final consolidated result that will actually ship. It is
unavailable until a reviewer is picked, since there is no "the reviewer" to check otherwise.

---

## 10. Screening projects

A **screening project** is a project whose schema is *derived*, not authored. It records exactly
one thing per paper — an include/exclude decision, and (when excluded) why — instead of a
hand-designed taxonomy. This is the fast, high-volume pass an SLR usually runs before annotation:
deciding which of a few hundred candidate papers are worth reading in full.

### `config.screening`

```json
{
  "config": {
    "screening": {
      "reasons": ["Not peer-reviewed", "Wrong topic", "Duplicate"]
    }
  }
}
```

| Field     | Type            | Required | Meaning                                                              |
| --------- | --------------- | -------- | ---------------------------------------------------------------------|
| `reasons` | array of strings| **yes**  | The exclusion reasons a reviewer can pick from. Must list at least one; trimmed and deduped on load. Order is the order the summary reports counts in. |

**`config.screening`'s presence is what makes a project a screening project.** Nothing else in the
file needs to change: `config.schema` is simply not read for a screening project and may be
omitted from the file entirely.

### `config.schema` is derived, not authored

For a screening project, `config.schema` is **always ignored on load** and **always rewritten on
save** as a projection of `config.screening.reasons` — the exact two-node schema below. Hand-editing
`config.schema` in a screening project's file therefore does nothing; the way to change what
reviewers see is to edit `config.screening.reasons`.

```json
[
  {
    "name": "Decision",
    "type": "string",
    "options": ["Include", "Exclude"],
    "description": "Include this paper in the review, or exclude it. Left unset until you decide."
  },
  {
    "name": "Reason",
    "type": "string",
    "options": ["Not peer-reviewed", "Wrong topic", "Duplicate"],
    "description": "Why this paper is excluded. Only applies when the decision is Exclude."
  }
]
```

**Why an `Include`/`Exclude` dropdown and not a plain boolean.** The obvious design for "should this
paper be excluded" is a single checkbox. This app cannot represent that: an unticked box is read as
a deliberate, answered "no" everywhere else in the file format — booleans have no way to mean "not
answered yet" (see `isEmptyValue` in the codebase, or §3.1's "boolean — a checkbox. Empty means
`false`."). Screening is the one phase where that third state — **not screened yet** — is the whole
point: the progress count, the per-reason PRISMA totals, and which papers an import carries forward
all depend on being able to tell "decided" apart from "untouched". A two-option enum gets that state
for free (`null` until chosen), so `Decision` is spelled as an enum rather than a boolean.

`Reason` is only meaningful once `Decision` is `"Exclude"` — the app's screening UI disables it
otherwise and clears it if the decision changes away from `Exclude` — but a hand-edited file can
still hold either mismatch (an excluded paper with no reason, or a reason recorded on a paper that
isn't excluded). Both are reported as validation issues, not silently accepted.

### A screened paper on disk

```json
{
  "id": "paper-a",
  "title": "Deep Learning for Code Search: A Study",
  "authors": ["A. Author", "B. Writer"],
  "abstract": "We study neural retrieval for code search…",
  "pdf": "",
  "annotations": {
    "Decision": [{ "value": "Exclude" }],
    "Reason": [{ "value": "Wrong topic" }]
  }
}
```

Ordinary shape, ordinary rules: `annotations` is still the field that is written in full and
pruned the same way every other project's is. The only things specific to screening are the
derived schema above, `pdf: ""` being allowed (§4), and `abstract` usually being the paper's only
readable content until it reaches full-text review.

### A missing abstract can be extracted from the PDF

Screening is normally decided from `abstract` alone, but a paper picked up with only a PDF (rather
than through a reference-manager export) may have none. The app fills this gap two ways, both using
the same basic layout heuristic in `pdfMeta.ts` — find the "Abstract" heading and follow the column
it sits in down to that column's next section heading:

1. **While building the project.** Adding a PDF directly (not via a reference file) in the project
   editor tries the heuristic in the background, the same way it already pre-fills title/authors.
2. **While screening.** Selecting a paper that has a PDF but no abstract (`paper.pdf` set,
   `paper.abstract` unset) tries the same heuristic against that PDF, and the result appears in the
   abstract view — the reviewer never has to open the PDF to trigger it, which is the whole point,
   since the abstract is what the screening decision is made from. A hit is written into `abstract`
   immediately, with no confirmation step: screening is hundreds of papers at seconds each, and a
   per-paper dialog would defeat exactly the throughput the phase exists for.

Either way, a hit is marked with `abstractFromPdf: true` (§4) — a **permanent** disclosure, not a
session-only hint, so every reviewer who later opens the file sees the same "this is a guess, not a
fact" warning the extracting session did, not just whoever happened to trigger it. The app shows
that warning wherever the abstract is displayed and tells the reviewer to check the PDF directly if
in doubt. The flag (and the abstract it describes) is dropped on load if `abstract` is empty — a
flag with nothing to describe is meaningless, most likely a hand-edited or stale file.

A heuristic-extracted abstract is treated as **lower confidence than one actually recorded
somewhere** — unlike every other paper field, which is never overwritten once set, a later
reference-manager import (a `.bib`/`.ris`/CSL-JSON export, an editor feature — see the wiki's
architecture page) is allowed to replace an `abstractFromPdf`-flagged abstract with a real one,
clearing the flag in the same step.

### Interaction with multiple reviewers (§9)

A screening project can set `config.reviewers` exactly like any other — two reviewers screen
independently and Consolidation reconciles them, which is the standard SLR screening protocol
(screen in duplicate, resolve disagreements). Everything in §9 applies unchanged, with one
narrower exception: **inter-rater agreement is computed over `Decision` only.** `Reason` is a
different question, and one only defined on the subset of papers both reviewers excluded, so
folding it into the same κ would produce a number that answers neither question honestly.

The entry-matching machinery §9 describes for repeatable groups (matching "Reviewer 1's Finding
#2" to "Reviewer 2's Finding #3") has nothing to do here: `Decision` and `Reason` are both
single-instance fields, so there is nothing to match — every reviewer's answer already lines up at
the same, only, index.

### Starting the next phase: importing from a screening project

The project editor's **New from screening…** (start screen) and **Import from screening…** (Papers
section, when the current draft is *not* itself a screening project) both read a screening
project's results and carry papers into a new or existing annotation project.

- **What counts as "included".** A paper is carried over unless it is **explicitly**
  `Decision: "Exclude"`. That means both `"Include"` and *anything else* — no decision recorded, or
  an unrecognised value from a hand-edited file — are carried by default; only an explicit exclusion
  drops a paper. The import dialog states the three counts (included / excluded / not-screened-yet)
  before anything is written, and offers to leave the not-screened-yet papers out instead, but
  never drops them silently.
- **Which tree is read.** For a multi-reviewer screening project, "included" is read from the
  **consolidated** `annotations` tree — the one that ships — never an individual reviewer's own
  `reviews` entry. If reviewers agreed on a paper but Consolidation hasn't opened it yet (adoption
  only happens per-paper, as the consolidator reviews each one), that paper has no consolidated
  decision yet and is carried as not-screened-yet; the dialog says so and points at **Adopt all**
  (the consolidator's one-click way to adopt every such paper at once) as the fix.
- **What carries over.** `title`, `authors`, `doi`, `abstract` (with its `abstractFromPdf` flag, if
  set — the caution stays attached to the abstract, not to which project file it currently lives
  in), and `pdf` (re-derived to remain correct if the new project's location differs from the
  screening project's). `reviews`, `equal`, and `aiUsage` do **not** carry over — they are the
  screening phase's own record and have no meaning against the new project's different schema.
- **Where the new project is saved.** By default, **next to the screening project's JSON file** —
  a sibling location, so every carried paper's relative `pdf` keeps resolving without being
  rewritten at all. This is the default location, not a locked one; *Change…* still works
  afterward.
