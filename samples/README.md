# Samples

Example material for trying SaiLoR, and for its tests.

| Path | What it is |
|---|---|
| `project.example.json` | An annotation project: two reviewers, a schema with nested and repeated fields, five papers. Its answers live in `project-annotations/`. |
| `screening.example.json` | A screening project over the same papers and more. Its decisions live in `screening-annotations/`. |
| `pdfs/` | The PDFs both projects point at. |
| `git-scenarios/` | Git situations built on demand into real repositories — see [its README](git-scenarios/README.md). |

## One annotations folder per project

Every project keeps its answers in a folder next to its JSON file, named by the
file's `annotationsDir` (`annotations/` when it names none). The two example
projects sit in the same folder, so each names its own:
`"annotationsDir": "project-annotations"` and `"annotationsDir": "screening-annotations"`.
Two projects must never use the same folder — SaiLoR refuses it in the project
editor and on Save As, and offers to split a folder it finds shared (see
*Things to know* in the user guide).

The annotation folders are not committed (`.gitignore`): what you record while
trying the examples stays on your machine. An `annotations/` folder left over from
before the examples had their own folders holds only answers for papers neither
project lists, and can be deleted.

The `.gitattributes` and `.gitignore` here carry SaiLoR's own git rules (the
marked blocks), the same ones SaiLoR adds to a repository it opens a project in.
