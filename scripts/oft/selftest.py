#!/usr/bin/env python3
"""Self-check for the OFT scripts: python3 scripts/oft/selftest.py (exits non-zero on failure)."""
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

REQS = """# Area

### REQ-ABC-10: Save file
- **Description:** The app saves the file.
  It keeps the old copy.
- **Type:** Non-functional (ISO 25010: Reliability / Maturity)
- **Evidence:** `src/a.ts` (`save`), `src/a.ts:9`, `docs/x.yml`
- **Verified by:** `src/a.test.ts` ("save keeps old copy")
- **Status:** Done

### REQ-ABC-20: Load file
- **Description:** The app loads the file.
- **Type:** Functional
- **Evidence:** `src/a.ts`; `src/a.ts` (`missing`)
- **Status:** Done
"""

SRC = """import x from "y";

/** Saves. */
export function save() {
  return 1;
}

export const load = () => {
  return 2;
};
"""

TEST = """describe("save", () => {
  it("keeps old copy", () => {});
});
"""


def run(script, root):
    return subprocess.run([sys.executable, str(HERE / script), "--root", str(root)],
                          check=True, capture_output=True, text=True).stdout


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    for rel, text in {"docs/requirements/abc.md": REQS, "docs/requirements/index.md": "skip",
                      "src/a.ts": SRC, "src/a.test.ts": TEST, "scripts/oft/.keep": ""}.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")

    run("convert-requirements.py", root)
    oft = (root / "docs/requirements-oft/abc.md").read_text(encoding="utf-8")
    assert not (root / "docs/requirements-oft/index.md").exists()
    assert "### REQ-ABC-10: Save file\n`req~abc-10~1`\n\nThe app saves the file.\nIt keeps the old copy." in oft, oft
    assert "Needs: impl, utest\n\nTags: NonFunctional, Reliability, Maturity" in oft, oft
    assert "Needs: impl\n\nTags: Functional" in oft, oft

    assert "inserted 4 tags" in run("insert-tags.py", root)
    src = (root / "src/a.ts").read_text(encoding="utf-8")
    assert src.startswith("// [impl->req~abc-20~1]\nimport x"), src
    assert "// [impl->req~abc-10~1]\n/** Saves. */\nexport function save" in src, src
    assert "// [impl->req~abc-10~1]\nexport const load" in src, src
    test = (root / "src/a.test.ts").read_text(encoding="utf-8")
    assert '  // [utest->req~abc-10~1]\n  it("keeps old copy"' in test, test
    unresolved = (root / "scripts/oft/unresolved.txt").read_text(encoding="utf-8")
    assert "unsupported file type .yml" in unresolved and "symbol 'missing' not found" in unresolved, unresolved

    assert "inserted 0 tags" in run("insert-tags.py", root)
    assert (root / "src/a.ts").read_text(encoding="utf-8") == src
    run("convert-requirements.py", root)
    assert (root / "docs/requirements-oft/abc.md").read_text(encoding="utf-8") == oft

print("selftest ok")
