#!/usr/bin/env python3
"""Count requirements and their trace links in docs/requirements/ for the technical report.

Run from the repository root: python3 technical-report/trace_stats.py
"""
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQ = ROOT / "docs" / "requirements"
EMPTY = {"", "—", "-"}


def cells(line):
    parts = re.split(r"(?<!\\)\|", line.strip())[1:-1]
    return [p.strip() for p in parts]


def paths(cell):
    found = set()
    for code in re.findall(r"`([^`]+)`", cell):
        p = code.split(":")[0].split(" ")[0]
        if "/" in p and "." in p.rsplit("/", 1)[-1]:
            found.add(p)
    return found


def main():
    ids, status, kinds = {}, Counter(), Counter()
    for f in sorted(REQ.glob("*.md")):
        current = None
        for line in f.read_text().splitlines():
            m = re.match(r"### (REQ-([A-Z]+)-\d+)", line)
            if m:
                current = m.group(1)
                ids[current] = m.group(2)
            elif current and line.startswith("- **Status:**"):
                status["implemented" if line.split("**Status:**")[1].strip().startswith("Implemented") else "other"] += 1
            elif current and line.startswith("- **Type:**"):
                kinds["functional" if line.split("**Type:**")[1].strip().startswith("Functional") else "non-functional"] += 1

    rows = {}
    for line in (REQ / "traceability.md").read_text().splitlines():
        if line.startswith("| REQ-"):
            c = cells(line)
            rows[c[0]] = c

    groups = {"DAT": "DAT/EDT", "EDT": "DAT/EDT", "ANN": "ANN/LST/PDF/UI", "LST": "ANN/LST/PDF/UI",
              "PDF": "ANN/LST/PDF/UI", "UI": "ANN/LST/PDF/UI"}
    per_group = Counter(groups.get(p, p) for p in ids.values())

    has = lambda col: sum(1 for c in rows.values() if c[col] not in EMPTY)
    tests, sources, missing = set(), set(), set()
    for c in rows.values():
        tests |= paths(c[4])
        sources |= paths(c[3])
    for p in tests | sources:
        if not (ROOT / p).exists():
            missing.add(p)
    security = sum(1 for c in rows.values() if "Security" in c[2])

    n = len(ids)
    pct = lambda k: f"{k} ({round(100 * k / n)}%)"
    print(f"requirements in files: {n}")
    for g, k in sorted(per_group.items()):
        print(f"  {g}: {k}")
    print(f"functional / non-functional: {kinds['functional']} / {kinds['non-functional']}")
    print(f"status implemented / other: {status['implemented']} / {status['other']}")
    print(f"matrix rows: {len(rows)}; ids only in files: {sorted(set(ids) - set(rows))}; only in matrix: {sorted(set(rows) - set(ids))}")
    print(f"with implementing source link: {pct(has(3))}")
    print(f"with verifying test: {pct(has(4))}")
    print(f"without automated check: {pct(n - has(4))}")
    print(f"with history commit: {pct(has(5))}")
    print(f"with docs link: {pct(has(6))}")
    print(f"security-related (ISO 25010 Security): {security}")
    print(f"distinct test files linked: {len(tests)}; distinct source files linked: {len(sources)}")
    print(f"linked files missing at this revision: {len(missing)}")
    for p in sorted(missing):
        print(f"  {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
