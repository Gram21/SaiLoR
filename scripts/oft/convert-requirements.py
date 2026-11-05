#!/usr/bin/env python3
"""Convert docs/requirements/*.md into OpenFastTrace Markdown files in docs/requirements-oft/.

Run from the repository root: python3 scripts/oft/convert-requirements.py [--root DIR]
The output is the same on every run for the same input.
"""
import argparse
import re
from pathlib import Path

import oftlib


def needs(root, item):
    kinds = {kind for ref in oftlib.refs(item) for kind, _, _, reason in oftlib.resolve(root, *ref)
             if not (reason or "").startswith("unsupported file type")}
    return ", ".join(k for k in ("impl", "utest") if k in kinds)


def tags(item):
    t = item["fields"].get("Type", "")
    out = ["NonFunctional" if t.lower().startswith("non") else "Functional"]
    iso = re.search(r"ISO 25010:\s*([^)]*)\)", t)
    if iso:
        out += [re.sub(r"\W+", "_", q.strip()).strip("_") for q in re.split(r"[,/]", iso.group(1)) if q.strip()]
    return out


def render(root, item):
    f = item["fields"]
    lines = [item["heading"], f"`{item['id']}`", "", f.get("Description", "").strip(), "", "Comment:"]
    lines += [f"- **{k}:** {f[k]}".replace("\n", "\n  ") for k in item["order"] if k != "Description"]
    n = needs(root, item)
    lines += [""] + ([f"Needs: {n}", ""] if n else []) + [f"Tags: {', '.join(tags(item))}", ""]
    return lines


def fix_links(line, converted):
    def repl(m):
        target = m.group(1)
        if "/" in target or target.split("#")[0] in converted:
            return m.group(0)
        return f"](../requirements/{target})"
    return re.sub(r"\]\(([^)#:]+\.md(?:#[^)]*)?)\)", repl, line)


def convert(root):
    src, dst = root / "docs" / "requirements", root / "docs" / "requirements-oft"
    dst.mkdir(parents=True, exist_ok=True)
    files = [p for p in sorted(src.glob("*.md")) if p.name not in oftlib.SKIP_FILES]
    names = {p.name for p in files}
    count = 0
    for path in files:
        out = []
        for kind, chunk in oftlib.parse_file(path):
            if kind == "item":
                out += render(root, chunk)
                count += 1
            else:
                out.append(fix_links(chunk, names))
        text = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).rstrip("\n") + "\n"
        (dst / path.name).write_text(text, encoding="utf-8")
    print(f"{count} items in {len(files)} files written to {dst}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=Path.cwd(), help="repository root (default: current directory)")
    convert(ap.parse_args().root.resolve())
