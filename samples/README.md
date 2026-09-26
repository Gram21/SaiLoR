# Samples

Example material for trying SaiLoR, and for its tests.

| Path | What it is |
|---|---|
| `project.example.json` | An annotation project: two reviewers, a schema with nested and repeated fields, five papers. It records that it was started from the screening example. |
| `screening.example.json` | A screening project over the same papers and more. |
| `pdfs/` | The PDFs both projects point at. |
| `git-scenarios/` | Git situations built on demand into real repositories — see [its README](git-scenarios/README.md). |

## One annotations folder, two projects

Both examples keep their answers in the same `annotations/` folder, although
they list some of the same papers. That is safe because a screening project and
an annotation project never write a file of the same name: decisions are
`screening-*.json` against `reviewer-*.json`/`consolidated.json`, and PDF
highlights `screening-marks-*.json` against `marks-*.json`. It is how a
screening and the annotation project built from it are meant to sit together.

Two projects of the *same* kind that list the same paper would write the same
files, so SaiLoR keeps those apart: each project file can name its own folder
(`"annotationsDir": "…"`, set in the project editor), and SaiLoR refuses a
shared one in the editor and on Save As, and offers to split it when it finds
one (see *Things to know* in the user guide).

The `annotations/` folder is not committed (`.gitignore`): what you record while
trying the examples stays on your machine. The one exception is the screening
example's PDF highlights (`annotations/*/screening-marks-*.json`): they ship, so
opening `project.example.json` shows **Show markings from screening** on
*Deep Learning for Code Search* (a highlight and a note) and on *From Scattered
to Structured* (a note).

The `.gitattributes` and `.gitignore` here carry SaiLoR's own git rules (the
marked blocks), the same ones SaiLoR adds to a repository it opens a project in.
