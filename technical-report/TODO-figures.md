# TODO: Capture the report screenshots

This list covers the five screenshots of the technical report.
Capture them on the 2.0.0 Tauri build.
Save each image as a PNG in `technical-report/figures/`, with the exact file name below.
Until a PNG exists, the report shows a red placeholder box with the file name.

## 1. Prepare the build

| Step | Action | Check |
|---|---|---|
| 1 | Check out `release/2.0.0` at commit `96c4ec3` or later. | `git log -1 --oneline` shows `96c4ec3` or a later commit. |
| 2 | Install the dependencies. Run `make install`. | The command ends without errors. |
| 3 | Copy the samples to a folder outside the repository. Run `mkdir -p ~/sailor-captures && cp -R samples ~/sailor-captures/`. | `~/sailor-captures/samples/project.example.json` exists. |
| 4 | Start the app. Run `make dev` from the repository root. | The SaiLoR window opens. |
| 5 | Set the window size to 1440 x 900 points. | The OS window tool shows 1440 x 900. |
| 6 | Set the light theme. Click the "Toggle theme" button until the background is white. | The window background is white. |

Caution: Do not capture from a 1.x build or from an old installer.
The 1.x app is built with Electron and looks different.

Alternative for step 4: Run `make build-debug`.
Start the `SaiLoR` binary from `src-tauri/target/debug/`.

Caution: Always open the copies in `~/sailor-captures/`.
The app writes annotation files next to the project file.
Do not open the sample files in the repository.

## 2. Figure list

| # | File name | Used in | Caption (short form) | Width in report |
|---|---|---|---|---|
| 1 | `figures/annotate-overview.png` | Section 4, Data Extraction, `fig:annotate` | Main view with paper list, PDF, and extraction form | 0.85 of text width (full width) |
| 2 | `figures/project-editor-schema.png` | Section 4, Planning, `fig:schema` | Schema editor with types, counts, options, and visibility | One column |
| 3 | `figures/screening-record.png` | Section 4, Import and Screening, `fig:screening` | Screening view with abstract, decision buttons, and progress | One column |
| 4 | `figures/consolidation-compare-popup.png` | Section 4, Consolidation, `fig:compare` | Comparison of two reviewers' answers | One column |
| 5 | `figures/git-merge-conflicts.png` | Section 4, Collaboration with Git, `fig:merge` | Field-level resolution of merge conflicts after a pull | One column |

The caption text lives in `sections/04-tool.tex`.
Do not change the captions to fit a screenshot.
Change the screenshot to match the caption.

## 3. Figure specifications

### 3.1 `figures/annotate-overview.png`

Must show:

- The paper list on the left, with all five papers.
- The PDF of "Deep Learning for Code Search: A Study" in the middle.
- The extraction form on the right, for seat Reviewer 1.
- At least one answered field and one Findings entry in the form.

Must not show:

- The screening markings. Do not tick "Show markings from screening".

Setup:

1. Click "Open file…" and choose `~/sailor-captures/samples/project.example.json`.
2. Select Reviewer 1 in the seat control of the toolbar.
3. Select the paper "Deep Learning for Code Search: A Study".
4. Enter a value for "Relevant", "Study Type", and "Year".
5. Enter one Findings entry with a claim.
6. Click "Save".

### 3.2 `figures/project-editor-schema.png`

Must show:

- Field names, types, and counts (min and max).
- Options of a field, for example "Evaluation Type".
- The field "Exclusion Reason" with its visibility condition "Relevant is No".

Caution: The sample project has no field "Exclusion Reason".
The report text refers to it.
Add the field only in the copy in `~/sailor-captures/`.

Setup:

1. Open `~/sailor-captures/samples/project.example.json` in a text editor.
2. Insert this entry in the `config.schema` list, directly after the entry named "Relevant". Add a comma after the inserted entry.

   ```json
   {"name": "Exclusion Reason", "type": "string", "visibleIf": {"mode": "all", "conditions": [{"field": "Relevant", "equals": [false]}]}}
   ```

3. Save the text file. Check that it is valid JSON.
4. Close the open project with the "Close project" button, if a project is open.
5. On the start screen, click "Edit annotation JSON…". Choose the edited copy.
6. Select the field "Exclusion Reason".
7. Check that the condition reads "Relevant" is "No".
   If the editor shows booleans as Yes and No, use the value that reads No.
   If the editor shows another wording, keep the wording of the editor.

### 3.3 `figures/screening-record.png`

Must show:

- The abstract of the selected paper.
- The decision buttons, with no decision yet.
- The progress line "0 of 8 screened".

Must not show:

- The PDF. Do not click "Show the PDF for this paper".

Setup:

1. Click "Open file…" and choose `~/sailor-captures/samples/screening.example.json`.
2. Select Reviewer 1 in the seat control of the toolbar.
3. Select "Deep Learning for Code Search: A Study".

### 3.4 `figures/consolidation-compare-popup.png`

Must show:

- The popup "Compare answers Study Type".
- Two rows: "Reviewer 1" with "Case study", and "Reviewer 2" with "Benchmark".
- The seat control set to "Consolidation".

Setup:

1. Click "Open file…" and choose `~/sailor-captures/samples/project.example.json`.
2. Select Reviewer 1 in the seat control. Select "Deep Learning for Code Search: A Study".
3. Enter "Case study" in "Study Type". Click "Save".
4. Select Reviewer 2 in the seat control. Select the same paper.
5. Enter "Benchmark" in "Study Type". Click "Save".
6. Select "Consolidation" in the seat control. Select the same paper.
7. Click the compare button next to the field "Study Type".

### 3.5 `figures/git-merge-conflicts.png`

Must show:

- The merge conflict dialog after a pull.
- One row for the paper "smith2021" and the field "Design".
- The two values side by side.
- The "Finish merge" button.

Must not show:

- A chosen side. Do not pick a value.

Setup:

1. Run `make install` once from the repository root.
2. Run `npm run scenario -- same-field-conflict --out ~/sailor-captures/conflict`.
   The command prints what you should see.
3. Click "Open file…" and choose `~/sailor-captures/conflict/ben/review.json`.
4. Select Reviewer 2 in the seat control, if the app asks for a seat.
5. Click "Git". Then click "Pull".
6. Wait until the conflict dialog opens. Do not choose a value.

## 4. Capture method per operating system

| OS | Steps | Notes |
|---|---|---|
| macOS | Press Cmd+Shift+4, then press Space. Hold Option and click the app window. | Option removes the window shadow. The file is saved to the Desktop. |
| Windows | Press Win+Shift+S. Choose the window mode if it is offered. Click the app window. Save the image. | Alternative: press Alt+Print Screen to copy the active window. Paste it into an image editor. |
| Linux (GNOME) | Run `sleep 3; gnome-screenshot -w -f technical-report/figures/<name>.png`. Click the app window within 3 seconds. | Replace `<name>` with the file name from section 2. |

## 5. Crop and export

1. Keep the whole app window, including the title bar.
2. Remove the desktop, the menu bar, and other windows from the image.
3. If the corners are transparent, place the image on a white background.
4. Resize the image to 1800 px width. Keep the aspect ratio. Do not enlarge a smaller image.
5. Save the image as PNG, in RGB mode.
6. Save the image as `technical-report/figures/<name>.png`, using the exact name from section 2.

Note: A full window is small at column width.
If the text is not readable in the report, crop to the panel named in the caption.
Keep the title bar if you crop.

## 6. Privacy and secrets

- Use only the sample projects in `~/sailor-captures/`.
- Do not open the LLM settings. If an AI dialog opens, close it before capture.
- Do not show a user name, an e-mail address, a home folder path, or an OS account name.
- Do not show a real API key.

## 7. Checklist before you commit

Check each item on the screen and on the saved PNG.

- [ ] The title bar reads "<project title> - SaiLoR". For example: "Example SLR: Code Search and Program Repair - SaiLoR".
- [ ] The title bar has no leading "● ". The project has no unsaved changes.
- [ ] The "Close project" button (X) is visible at the left of the toolbar.
- [ ] The toolbar does not show the project name.
- [ ] The seat control shows the seat named in section 3.
- [ ] Only the named view, dialog, or popup is open.
- [ ] No tooltip, toast, or update banner is visible.
- [ ] The image shows every item of "Must show" for its figure.
- [ ] The image shows no item of "Must not show" for its figure.
- [ ] The text is readable at 100 percent zoom.
- [ ] The file is PNG, 1800 px wide, with the exact file name.
- [ ] The image shows no personal data and no API key.

## 8. After you capture all five figures

1. Run `make report` from the repository root.
   The build ends with "Output written on SaiLoR-technical-report.pdf".
2. Run `pdftotext technical-report/SaiLoR-technical-report.pdf - | grep -c PLACEHOLDER`.
   The output is `0`.
3. Delete the sentence "Furthermore, all figures in this report show the user interface of version 1.x." from `technical-report/sections/07-discussion.tex`.
4. Run `make report` again.
5. Commit only the PNG files and the changed `.tex` files.
   Do not commit the PDF.
   Do not commit `WRITING_STYLE.md`.
   Do not add a `Co-Authored-By` line or any AI attribution.

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| The placeholder stays after you add a PNG. | Check the file name and the folder. Run `make report` again. |
| The PDF still shows an image after you delete a PNG. | Run `touch technical-report/figures.tex`, then run `make report`. |
| The app does not show the seat from section 3. | Check that the project has two reviewers. Check the `reviewers` value in the copy. |
