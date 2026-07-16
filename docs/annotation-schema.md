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
    "reviewers": 1
  },
  "papers": []
}
```

| Key       | Required? | What it is                                                                 |
| --------- | --------- | -------------------------------------------------------------------------- |
| `version` | optional  | A number. If you omit it, the app treats it as `1`.                        |
| `config`  | required  | The annotation schema (`schema`) and options such as `ai`.                 |
| `papers`  | required  | The list of papers to annotate.                                            |

`config.schema` must be an **array with at least one node**. An empty schema is rejected.

**`config.ai` — forbid AI-assisted annotation.** Optional, defaults to `true`. Set it to `false` and
the **✦ AI** button is disabled for anyone who opens the file. Use this when the papers must not be
sent to a third-party model — an embargoed corpus, or a review whose protocol forbids it. It only
affects this project file; it is written out only when `false`, so a normal file never carries the
key. The project editor exposes it as a checkbox (see §2 of the app's *New / Edit annotation JSON*
screen).

Note that `config.ai` can only ever *restrict* the feature, not guarantee it: `true` (or omitting
the key) does not by itself mean the button is available to whoever opens the file — the app may
have its own reasons for keeping AI-assisted annotation off that this setting does not override.
`false` always wins, in every build.

**`config.reviewers` — multiple independent reviewers.** Optional, defaults to `1`
(single-reviewer — the behavior described through the rest of this guide). Set it to a number from
2 to 10 to have that many reviewers annotate every paper **independently**, then reconcile their
answers into one final result via a built-in **Consolidation** role. See
[§9](#9-multiple-reviewers--consolidation) for the full picture. It is written out only when
greater than 1, so a normal single-reviewer file never carries the key. The project editor exposes
it as a checkbox + a reviewer-count field next to the AI opt-out.

**Extra keys are preserved.** Any additional top‑level key you add (say, `"reviewers"` or
`"notes"`) is kept verbatim when the app saves the file. The same applies to extra keys inside
a paper object. The app only manages the keys it knows about and leaves the rest untouched.

---

## 3. Defining the annotation schema

The schema lives at `config.schema` and is an array of **nodes**. Each node describes one
thing you want to record. A node is written as a JSON object (its technical name is
`AnnotationDef`) with these fields:

| Field         | Type                                   | Required | Default | Meaning                                                                                   |
| ------------- | -------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `name`        | string                                 | **yes**  | —       | The label shown in the form. **Sibling names must be unique** (see below).               |
| `type`        | `"string"` \| `"number"` \| `"boolean"`| no       | —       | Makes the node an editable field. **Omit it** to make a group (a name‑only branch).       |
| `children`    | array of nodes                         | no       | —       | A nested sub‑taxonomy. A node may have `type`, `children`, or **both**.                    |
| `min`         | number                                 | no       | `1`     | Minimum number of times this node may occur.                                              |
| `max`         | number or `null`                       | no       | `1`     | Maximum occurrences. A positive whole number, or `null` for **unbounded**.                |
| `options`     | array of strings                       | no       | —       | Turns a `string` field into an **enum dropdown** of allowed values (see §3.2).            |
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

### 3.1 Simple fields (string, number, boolean)

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
  "name": "Year",
  "type": "number"
}
```

The three types behave as you'd expect:

- `boolean` — a checkbox. Empty means `false`.
- `string` — free text. Empty means "not filled in".
- `number` — a numeric field. Empty means "not filled in".

Put together in a schema, these three might look like:

```json
{
  "config": {
    "schema": [
      { "name": "Relevant", "type": "boolean" },
      { "name": "Study Type", "type": "string" },
      { "name": "Year", "type": "number" }
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
| `pdf`         | string          | **yes**  | Path to the PDF file, **relative to the JSON file's location**.             |
| `annotations` | object          | yes*     | The single/consolidated result. Use `{}` for a paper you haven't annotated yet. |
| `reviews`     | object          | no       | Multi-reviewer only — each reviewer's own tree, keyed `"1"` .. `"N"`. See [§9](#9-multiple-reviewers--consolidation). Omit entirely in a single-reviewer file. |

<sub>* `authors` and `annotations` are effectively required in a hand‑written file — set them to
`[]` and `{}` respectively when there's nothing yet.</sub>

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

There are three ways to open a project; pick whichever fits how you're running SaiLoR.

- **In the app — Open ▾ menu.** Click **Open…** to load a local JSON file, or reopen one of the
  recent projects. (Recent projects and in‑place saving need the desktop app or a Chromium
  browser; other browsers offer only "Open file…" and download saves.)
- **Hosted browser build — `?project=<url>`.** Link straight to a project that lives on the same
  host by adding a `?project=` query parameter pointing at the JSON. The app fetches it and
  resolves its PDFs relative to that URL, for example:

  ```
  https://your.host/?project=/reviews/2026/project.json
  ```

- **Docker deployment — the mounted volume.** Point the volume in `docker-compose.yml` at your
  folder of JSON files and their `pdfs/` folders (it defaults to the bundled `./samples`). Whatever
  folder you mount is served read‑only under `/projects/`, so you open a review with, e.g.,
  `http://localhost:8080/?project=/projects/my-review.json`.

For full deployment and hosting details, see the [README](../README.md#deployment).

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
- **Wrong or missing `pdf` path.** Every paper needs a `pdf`, and the path is relative to the
  JSON file. If the PDF won't load, check the path and the recommended
  `project.json` + `pdfs/` layout.
- **Duplicate paper `id`.** Each paper's `id` must be unique across the whole `papers` list;
  repeated ids break navigation and are rejected.
- **Empty schema.** `config.schema` must contain at least one node.

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
  number as a string:

  ```json
  {
    "id": "paper-a",
    "title": "…",
    "pdf": "pdfs/paper-a.pdf",
    "annotations": { "Relevant": [{ "value": true }] },
    "reviews": {
      "1": { "Relevant": [{ "value": true }] },
      "2": { "Relevant": [{ "value": false }] }
    }
  }
  ```

  `reviews` is written only for a multi-reviewer project, and only once a reviewer has actually
  written something — a reviewer who hasn't started a given paper contributes no key at all. A
  single-reviewer file never has a `reviews` key on any paper, so it stays exactly as it always was.

### Setting it up

The project editor's *New / Edit annotation JSON…* screen has a **Multiple reviewers** checkbox
next to the AI opt-out; enabling it exposes a reviewer-count field (2–10) and writes
`config.reviewers` into the file. Hand-editing the JSON works the same way — add `"reviewers": 3`
under `config`.

### Validating

**Validate** checks the tree the active reviewer is responsible for: a numbered reviewer's own
answers, or — for Consolidation — the final consolidated result that will actually ship. It is
unavailable until a reviewer is picked, since there is no "the reviewer" to check otherwise.
