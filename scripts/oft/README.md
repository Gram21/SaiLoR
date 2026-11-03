# OpenFastTrace migration scripts

These scripts move the requirement trace links from `docs/requirements/` to OpenFastTrace (OFT).
OFT checks that each requirement has an implementation and a test.
The scripts use Python 3 with the standard library only.
The trace target uses OFT 4.11.0 and needs Java 17 or later.

## Files

| File | Purpose |
| --- | --- |
| `convert-requirements.py` | Writes OFT spec items to `docs/requirements-oft/`. |
| `insert-tags.py` | Writes OFT coverage tags into the source files. |
| `oftlib.py` | Parses the requirement files and finds the symbols in the source files. |
| `selftest.py` | Runs the scripts on a small sample and checks the output. |
| `unresolved.txt` | Lists the references that `insert-tags.py` cannot place. Git ignores this file. |

## Conversion rules

- The ID `REQ-ABC-10` becomes `req~abc-10~1`.
- The title and the description stay the same.
- The fields Type, Evidence, Tests, Verified by and Status go into `Comment:`.
- The converter writes `Needs: impl, utest` if the item has one or more test references.
- A test reference is a reference in Tests or Verified by.
- A test reference is also a test file in Evidence (`*.test.*`, `*.spec.*`, `e2e/`, `src/test/`).
- A test reference is also a Rust function below `mod tests` or below a `#[test]` attribute.
- If the item has no test reference, the converter writes `Needs: impl`.
- `Tags:` gets `Functional` or `NonFunctional` and the ISO 25010 characteristics.
- The converter skips `index.md` and `traceability.md`.
- The output is the same on each run for the same input.

## Tag rules

- Each tag is one `//` line, for example `// [impl->req~abc-10~1]`.
- Evidence references give `impl` tags. Test references give `utest` tags.
- If the reference names a symbol, the tag goes above that symbol.
- The tag also goes above the doc comment and the Rust attributes of that symbol.
- If the reference gives a line, the tag goes above the nearest declaration at or above that line.
- If no declaration is at or above the line, the tag goes on the first line of the file.
- If the reference gives only a path, the tag goes on the first line of the file.
- A quoted test name matches an `it(...)`, `test(...)` or `describe(...)` call.
- A quoted test name also matches `describe name` + `it name` and a unique name prefix.
- The script does not add a tag that is already above its target.
- If the script cannot find the file or the symbol, it writes the reference to `unresolved.txt`.
- If the script finds two or more matches, it writes the reference to `unresolved.txt`.
- The script does not tag `.json`, `.md`, `.yml` or `.sh` files.

## Procedure

1. Make sure that the working tree has no changes.
2. Run `python3 -B scripts/oft/selftest.py`. Make sure that the output is `selftest ok`.
3. Run `python3 -B scripts/oft/convert-requirements.py`.
4. Run `python3 -B scripts/oft/insert-tags.py --dry-run`.
5. Read the tag list. Make sure that each tag is above the correct code.
6. Run `python3 -B scripts/oft/insert-tags.py`.
7. Read `scripts/oft/unresolved.txt`.
8. For each line in `unresolved.txt`, fix the reference in `docs/requirements/` or add the tag manually.
9. Run steps 3, 6 and 7 again until the list has only expected entries.
10. Run `npm run typecheck`, `make lint` and `make test`.
11. Run `make trace`.
12. Read the report in `.cache/oft/trace.html` or `.cache/oft/trace.txt`.
13. Commit `docs/requirements-oft/` and the tagged source files in one commit.

Caution: Do step 6 only on a clean working tree. Then you can use `git diff` to examine each tag.

Caution: Line references in `docs/requirements/` can be out of date.
If a line reference is out of date, the tag goes above the wrong declaration.
Examine each tag from a line reference.

## The `make trace` target

- The target downloads the OFT jar one time to `.cache/oft/`.
- The target checks the SHA-256 of the jar before it uses the jar.
- The target reads `docs/requirements-oft/`, `src/`, `src-tauri/src/`, `samples/git-scenarios/` and `e2e/`.
- The target writes `.cache/oft/trace.html` and `.cache/oft/trace.txt`.
- The exit code is 0 if OFT finds no defects. The exit code is 1 if OFT finds defects.
- The CI job `trace` runs the self-check, the converter and `make trace`.
- The CI job `trace` can fail and does not block a merge.

Note: The OFT command line does not read `.tsx` files.
The target links each `.tsx` file as `.tsx.ts` in `.cache/oft/tsx/`.
OFT then reads the tags in the `.tsx` files through these links.

Note: The OFT color option is `-c BLACK_AND_WHITE`. The value `black-and-white` from the user guide fails.

## Proposed text for AGENTS.md

The user approved an exception to the "no inline comments" rule for trace tags.
Add this text to `AGENTS.md` after the migration:

```markdown
## Trace tags

Trace tags are allowed comments. A trace tag is one `//` line with an OpenFastTrace coverage tag,
for example `// [impl->req~abc-10~1]` or `// [utest->req~abc-10~1]`.

- Put the tag on its own line above the symbol that implements or tests the requirement.
- Put `impl` tags on implementation code. Put `utest` tags on tests.
- When you add or change a requirement in `docs/requirements/`, add or update its trace tags.
- When you move, rename or delete a tagged symbol, keep its tags with the code.
- Do not remove a trace tag unless the code no longer covers the requirement.
- Run `make trace` to check the trace links.
```
