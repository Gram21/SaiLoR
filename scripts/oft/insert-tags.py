#!/usr/bin/env python3
"""Insert OFT trace tags into source files from the Evidence and Verified-by fields.

Run from the repository root: python3 scripts/oft/insert-tags.py [--root DIR] [--dry-run]
Each tag goes on its own `//` line above the named symbol. A path:line reference goes above
the closest declaration at or above that line; a bare path goes on the first line of the file.
References that cannot be placed go to scripts/oft/unresolved.txt. A tag that already sits
above its target is not inserted again.
"""
import argparse
from collections import defaultdict
from pathlib import Path

import oftlib


def plan(root):
    """Return ({path: {stripped_index: [tag, ...]}}, unresolved rows)."""
    inserts, unresolved = defaultdict(lambda: defaultdict(list)), []
    for _, item in oftlib.items(root / "docs" / "requirements"):
        for ref in oftlib.refs(item):
            for kind, path, idx, reason in oftlib.resolve(root, *ref):
                field, _, line_no, symbols = ref
                if idx is None:
                    where = f"{path}:{line_no}" if line_no else f"{path} ({', '.join(symbols)})" if symbols else path
                    unresolved.append(f"{item['legacy']}\t{item['id']}\t{kind}\t{field}\t{where}\t{reason}")
                    continue
                tag = f"[{kind}->{item['id']}]"
                if tag not in inserts[path][idx]:
                    inserts[path][idx].append(tag)
    return inserts, unresolved


def apply(root, path, targets, dry_run):
    p = root / path
    text = p.read_text(encoding="utf-8")
    lines, real = oftlib.strip_tags(text)
    all_lines = text.split("\n")
    ext = p.suffix
    added = []
    for idx in sorted(targets, reverse=True):
        top = real[oftlib.lift(lines, idx, ext)] if idx < len(lines) else len(all_lines)
        while top > 0 and oftlib.TAG_LINE.match(all_lines[top - 1]):
            top -= 1
        block = all_lines[top:real[idx]] if idx < len(real) else []
        indent = lines[idx][: len(lines[idx]) - len(lines[idx].lstrip())] if idx < len(lines) else ""
        new = [f"{indent}// {t}" for t in targets[idx] if not any(t in b for b in block)]
        all_lines[top:top] = new
        added += [(real[idx] + 1 if idx < len(real) else len(all_lines), t.strip()) for t in new]
    if added and not dry_run:
        p.write_text("\n".join(all_lines), encoding="utf-8")
    return added


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=Path.cwd(), help="repository root (default: current directory)")
    ap.add_argument("--dry-run", action="store_true", help="print the tags, change no source file")
    args = ap.parse_args()
    root = args.root.resolve()
    inserts, unresolved = plan(root)
    total = 0
    for path in sorted(inserts):
        for line, tag in sorted(apply(root, path, inserts[path], args.dry_run)):
            print(f"{path}:{line}: {tag}")
            total += 1
    out = root / "scripts" / "oft" / "unresolved.txt"
    out.write_text("".join(f"{row}\n" for row in sorted(unresolved)), encoding="utf-8")
    verb = "would insert" if args.dry_run else "inserted"
    print(f"{verb} {total} tags in {len(inserts)} files; {len(unresolved)} unresolved references in {out}")


if __name__ == "__main__":
    main()
