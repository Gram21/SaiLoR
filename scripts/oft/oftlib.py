"""Shared parser for docs/requirements/*.md and symbol resolver for the OFT scripts."""
import re
from pathlib import Path

SKIP_FILES = {"index.md", "traceability.md"}
HEAD = re.compile(r"### REQ-([A-Z]+)-(\d+):\s*(.*)")
FIELD = re.compile(r"- \*\*(Description|Type|Evidence|Tests|Verified by|Status):\*\*\s*(.*)")
REF = re.compile(
    r"`([\w.\-/]+/[\w.\-]+\.\w+)(?::([\d,\- ]+))?`"
    r"(?:\s*\(((?:`[^`]*`|\"[^\"]*\"|[^()`\"])*)\))?"
)
TEST_FIELDS = ("Tests", "Verified by")
CODE_EXT = {".ts", ".tsx", ".rs", ".js", ".mjs", ".cjs"}
TAG_LINE = re.compile(r"^\s*//\s*\[\w+->req~[\w.\-]+~\d+\]\s*$")


def oft_id(area, num):
    return f"req~{area.lower()}-{num}~1"


def parse_file(path):
    """Yield ("text", line) and ("item", dict) chunks in file order."""
    item, field = None, None
    for line in path.read_text(encoding="utf-8").splitlines():
        m = HEAD.match(line)
        if m:
            if item:
                yield "item", item
            item = {"heading": line, "id": oft_id(m.group(1), m.group(2)),
                    "legacy": f"REQ-{m.group(1)}-{m.group(2)}", "fields": {}, "order": []}
            field = None
            continue
        if item:
            f = FIELD.match(line)
            if f:
                field = f.group(1)
                item["fields"][field] = f.group(2)
                item["order"].append(field)
                continue
            if field and line.startswith(" ") and line.strip():
                item["fields"][field] += "\n" + line.strip()
                continue
            if not line.strip() and field:
                field = None
                continue
            if line.strip():
                yield "item", item
                item, field = None, None
            else:
                continue
        yield "text", line
    if item:
        yield "item", item


def items(req_dir):
    for path in sorted(Path(req_dir).glob("*.md")):
        if path.name in SKIP_FILES:
            continue
        for kind, chunk in parse_file(path):
            if kind == "item":
                yield path, chunk


def split_symbols(paren):
    if paren is None:
        return []
    quoted = re.findall(r"`([^`]+)`|\"([^\"]+)\"", paren)
    if quoted:
        return [a or b for a, b in quoted]
    return [p.strip() for p in paren.split(",") if p.strip()]


def refs(item):
    """Return (field, path, first_line, symbols) for every file reference of an item."""
    out = []
    for field in ("Evidence",) + TEST_FIELDS:
        for m in REF.finditer(item["fields"].get(field, "")):
            line = int(re.match(r"\d+", m.group(2)).group()) if m.group(2) else None
            out.append((field, m.group(1), line, split_symbols(m.group(3))))
    return out


def is_test_path(p):
    return bool(re.search(r"\.(test|spec)\.\w+$", p)) or p.startswith(("e2e/", "tests/", "src/test/"))


# ---- symbol resolution on a file's lines (trace-tag lines removed) ----

def _ts_patterns(n):
    e = re.escape(n)
    decl = re.compile(rf"^\s*(export\s+)?(default\s+)?(declare\s+)?(async\s+)?"
                      rf"(function\*?\s+{e}\b|(const|let|var|class|interface|type|enum)\s+{e}\b)")
    member = re.compile(rf"^\s*(public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*"
                        rf"{e}\s*(\??:\s*|(?=\())")
    return decl, member


def _member_impl(line):
    return line.rstrip().endswith(("{", ",", "(", "=>", "["))


def _rust_decl(n):
    return re.compile(rf"^\s*(pub(\([^)]*\))?\s+)?((async|unsafe|const|extern\s+\"C\")\s+)*"
                      rf"(fn|struct|enum|trait|type|mod|const|static)\s+{re.escape(n)}\b")


def _calls(lines):
    """Return (index, it|test|describe, name) for each test call that starts on one line."""
    pat = re.compile(r"^\s*(it|test|describe)(\.\w+)*\(\s*(['\"`])((?:\\.|(?!\3).)*)\3")
    return [(i, m.group(1), re.sub(r"\\(.)", r"\1", m.group(4))) for i, l in enumerate(lines) if (m := pat.match(l))]


def _indent(line):
    return len(line) - len(line.lstrip())


def _in_type_block(lines, i):
    """True if line i is a member of an interface or object type, not of an implementation."""
    for j in range(i - 1, -1, -1):
        if lines[j].strip() and _indent(lines[j]) < _indent(lines[i]):
            return bool(re.match(r"^\s*(export\s+)?(declare\s+)?(interface\s|type\s+\w+.*=\s*\{?\s*$)", lines[j]))
    return False


def _member(lines, head, name):
    """Find member `name` inside the block that starts at line head (Type.member references)."""
    pat = re.compile(rf"^\s*(readonly\s+|pub\s+)?{re.escape(name)}\??\s*[:(]")
    found = []
    for i in range(head + 1, len(lines)):
        if lines[i].strip().startswith("}") and _indent(lines[i]) <= _indent(lines[head]):
            break
        if pat.match(lines[i]):
            found.append(i)
    return found


def locate(lines, symbol, ext):
    """Return (index or None, reason)."""
    symbol = symbol.removesuffix("()")
    parts = symbol.split(".")
    if len(parts) == 2 and all(re.fullmatch(r"[A-Za-z_$][\w$]*", p) for p in parts):
        head, reason = locate(lines, parts[0], ext)
        if head is None:
            return None, reason
        found = _member(lines, head, parts[1])
        if len(found) == 1:
            return found[0], "symbol"
        return None, f"member '{symbol}' {'ambiguous' if found else 'not found'}"
    if ext == ".rs":
        tiers = [[i for i, l in enumerate(lines) if _rust_decl(symbol).match(l)]]
    else:
        decl, member = _ts_patterns(symbol)
        calls = _calls(lines)
        describes = [d for _, k, d in calls if k == "describe"]
        tiers = [
            [i for i, l in enumerate(lines) if decl.match(l)],
            [i for i, l in enumerate(lines) if member.match(l) and _member_impl(l) and not _in_type_block(lines, i)],
            [i for i, _, name in calls if name == symbol],
            [i for i, k, name in calls if k != "describe" and any(symbol == f"{d} {name}" for d in describes)],
        ]
        if " " in symbol:
            tiers.append([i for i, _, name in calls if name.startswith(symbol)])
    for found in tiers:
        if len(found) == 1:
            return found[0], "symbol"
        if len(found) > 1:
            return None, f"ambiguous symbol '{symbol}' ({len(found)} matches)"
    return None, f"symbol '{symbol}' not found"


ENCLOSING_TS = re.compile(r"^\s*(export\s+)?(default\s+)?(async\s+)?(function\b|(const|let|class|interface|type|enum)\s+\w)"
                          r"|^\s*(it|test|describe)(\.\w+)*\(")
ENCLOSING_RS = re.compile(r"^\s*(pub(\([^)]*\))?\s+)?((async|unsafe|const)\s+)*(fn|struct|enum|trait|mod|impl|const|static)\b")


def enclosing(lines, line_no, ext):
    if not 1 <= line_no <= len(lines):
        return None, f"line {line_no} beyond end of file ({len(lines)} lines)"
    pat = ENCLOSING_RS if ext == ".rs" else ENCLOSING_TS
    for i in range(line_no - 1, -1, -1):
        if pat.match(lines[i]):
            return i, "line"
    return 0, "file (no declaration at or above the line)"


def lift(lines, i, ext):
    """Move a target above attributes and doc comments that belong to the declaration."""
    while i > 0:
        prev = lines[i - 1].strip()
        if ext == ".rs" and (prev.startswith("#[") or prev.startswith("///")):
            i -= 1
        elif prev.endswith("*/") and ext != ".rs":
            j = i - 1
            while j >= 0 and "/**" not in lines[j]:
                j -= 1
            if j < 0:
                break
            i = j
        else:
            break
    return i


def is_rust_test(lines, i):
    """True if line i is a #[test] item or sits at or below `mod tests` (tests go last by convention)."""
    if any(re.match(r"^\s*(pub\s+)?mod tests\b", l) for l in lines[: i + 1]):
        return True
    j = i - 1
    while j >= 0 and lines[j].strip().startswith(("#[", "///")):
        if re.match(r"#\[(\w+::)?test\b", lines[j].strip()):
            return True
        j -= 1
    return False


def strip_tags(text):
    """Return (lines without trace-tag lines, map from stripped index to real index)."""
    real = text.split("\n")
    keep = [i for i, l in enumerate(real) if not TAG_LINE.match(l)]
    return [real[i] for i in keep], keep


def resolve(root, field, path, line_no, symbols):
    """Resolve one reference. Return list of (kind, path, stripped_index or None, reason)."""
    p = Path(root) / path
    ext = p.suffix
    base_kind = "utest" if field in TEST_FIELDS or is_test_path(path) else "impl"
    if ext not in CODE_EXT:
        return [(base_kind, path, None, f"unsupported file type {ext}")]
    if not p.is_file():
        return [(base_kind, path, None, "file not found")]
    lines, _ = strip_tags(p.read_text(encoding="utf-8"))
    out, targets = [], []
    if symbols:
        for s in symbols:
            targets.append(locate(lines, s, ext) + (s,))
    elif line_no is not None:
        targets.append(enclosing(lines, line_no, ext) + (None,))
    else:
        targets.append((0, "file", None))
    for idx, reason, _ in targets:
        if idx == 0 and lines and lines[0].startswith("#!"):
            idx = 1
        kind = base_kind
        if idx is not None and ext == ".rs" and is_rust_test(lines, idx):
            kind = "utest"
        out.append((kind, path, idx, reason))
    return out
