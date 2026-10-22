"""Greek texts of the app (frontend/*.js, index.html) that have no English in frontend/lang/en.js.

    python -m tests.i18n_missing          # list what is missing
    python -m tests.i18n_missing --all    # list every Greek text found, with its English

Texts in JavaScript are found as string literals; `...${x}...` templates are checked with a sample
value in place of each ${x}, so a rule in en.js must cover them.
"""
from __future__ import annotations

import ast
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
SKIP = {"i18n.js"}
GREEK = re.compile(r"[\u0370-\u03ff\u1f00-\u1fff]")
HOLE = "\x00"  # stands for ${...} in a template literal
ATTRS = ("title", "placeholder", "aria-label", "alt")


def load_dictionary(path: Path = FRONTEND / "lang" / "en.js") -> dict:
    """en.js is `window.I18N_EN = {...};` with JSON inside (plus whole-line // comments)."""
    src = "\n".join(l for l in path.read_text(encoding="utf-8").splitlines() if not l.strip().startswith("//"))
    return json.loads(src[src.index("{"):src.rindex("}") + 1])


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def js_strings(src: str) -> list[str]:
    """Every string literal of a JavaScript source; in templates each ${...} becomes HOLE."""
    out, i, n = [], 0, len(src)

    def template(i):  # src[i] is just after the opening backtick; returns (text, index after it)
        text = []
        while i < n:
            c = src[i]
            if c == "\\":
                text.append(src[i:i + 2]); i += 2
            elif c == "`":
                return "".join(text), i + 1
            elif src.startswith("${", i):
                depth, j = 1, i + 2
                while j < n and depth:
                    if src[j] in "\"'":
                        j = quoted(j)
                        continue
                    if src[j] == "`":
                        inner, j = template(j + 1)
                        out.append(inner)
                        continue
                    depth += {"{": 1, "}": -1}.get(src[j], 0)
                    j += 1
                text.append(HOLE); i = j
            else:
                text.append(c); i += 1
        return "".join(text), i

    def quoted(i):  # src[i] is the quote; returns index after the closing quote
        q, j = src[i], i + 1
        while j < n and src[j] != q and src[j] != "\n":
            j += 2 if src[j] == "\\" else 1
        out.append(src[i + 1:j])
        return j + 1

    while i < n:
        c = src[i]
        if src.startswith("//", i):
            i = src.find("\n", i)
            i = n if i < 0 else i
        elif src.startswith("/*", i):
            i = src.find("*/", i + 2)
            i = n if i < 0 else i + 2
        elif c in "\"'":
            i = quoted(i)
        elif c == "`":
            text, i = template(i + 1)
            out.append(text)
        else:
            i += 1
    return [s.replace("\\n", "\n").replace('\\"', '"').replace("\\'", "'") for s in out]


class _Html(HTMLParser):
    def __init__(self):
        super().__init__()
        self.texts, self._skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        for k, v in attrs:
            if k in ATTRS and v:
                self.texts.append(v)

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.texts.append(data)


def pieces(s: str) -> list[str]:
    """The texts the page shows for a string: HTML tags split it, like the DOM does."""
    if "<" in s and re.search(r"<[a-z/][^>]*>", s):
        p = _Html()
        p.feed(s.replace(HOLE, "\x01"))
        return [t.replace("\x01", HOLE) for t in p.texts]
    return [s]


def py_strings(path: Path, skip_functions=()) -> list[str]:
    """Strings and f-strings (each {...} becomes HOLE) of a Python file, without docstrings."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    skip, docs = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.Module, ast.AsyncFunctionDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docs.add(id(body[0].value))
            if getattr(node, "name", None) in skip_functions:
                skip.update(id(n) for n in ast.walk(node))
    out = []
    for node in ast.walk(tree):
        if id(node) in skip or id(node) in docs:
            continue
        if isinstance(node, ast.JoinedStr):
            out.append("".join(v.value if isinstance(v, ast.Constant) else HOLE for v in node.values))
            skip.update(id(v) for v in node.values)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.append(node.value)
    return out


# Server messages that the app shows (errors, warnings, checks, names). report.py, i18n.py and mapimage.py
# are for the PDF only (backend/i18n.py), and so are the report_block functions.
BACKEND = ["main.py", "layout.py", "energy.py", "simulation.py", "shading.py", "electrical.py", "equipment.py",
           "finance.py", "storage.py", "settings.py"]
PDF_ONLY = ("report_block", "_report_block")


def greek_texts() -> list[tuple[str, str]]:
    """(file, normalised text) for every Greek text of the frontend and of the server messages it shows."""
    found = []
    html = _Html()
    html.feed((FRONTEND / "index.html").read_text(encoding="utf-8"))
    found += [("index.html", t) for t in html.texts]
    for f in sorted(FRONTEND.glob("*.js")):
        if f.name not in SKIP:
            found += [(f.name, p) for s in js_strings(f.read_text(encoding="utf-8")) for p in pieces(s)]
    for name in BACKEND:
        if (ROOT / "backend" / name).exists():
            found += [(f"backend/{name}", s) for s in py_strings(ROOT / "backend" / name, PDF_ONLY)]
    seen, out = set(), []
    for name, t in found:
        t = norm(t)
        if GREEK.search(t) and (name, t) not in seen:
            seen.add((name, t))
            out.append((name, t))
    return out


def translate(text: str, d: dict) -> str | None:
    """English of a normalised text (HOLE filled with a sample value), or None. Same steps as english() in
    frontend/i18n.js: the whole text, then the rules, then the parts (only when no Greek is left)."""
    text = text.replace(HOLE, "12")
    if text in d["texts"]:
        return d["texts"][text]
    for pattern, repl in d["rules"]:
        if re.search(_py(pattern), text):
            return re.sub(_py(pattern), _py_repl(repl), text)
    out = text
    for pattern, repl in d.get("parts", []):
        out = re.sub(_py(pattern), _py_repl(repl), out)
    return out if out != text and not GREEK.search(out) else None


def _py(js_pattern: str) -> str:
    return js_pattern.replace("(?<", "(?P<") if "(?<" in js_pattern and "(?<=" not in js_pattern else js_pattern


def _py_repl(js_repl: str) -> str:
    return re.sub(r"\$(\d)", r"\\g<\1>", js_repl)


def missing(d: dict | None = None) -> list[tuple[str, str]]:
    d = d or load_dictionary()
    return [(f, t) for f, t in greek_texts() if translate(t, d) is None]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    d = load_dictionary() if (FRONTEND / "lang" / "en.js").exists() else {"texts": {}, "rules": []}
    rows = greek_texts()
    for f, t in rows:
        en = translate(t, d)
        if "--all" in sys.argv or en is None:
            print(f"{f}\t{t.replace(HOLE, '${…}')}" + (f"\t→ {en}" if en else ""))
    print(f"# {sum(translate(t, d) is None for _, t in rows)} χωρίς μετάφραση από {len(rows)}", file=sys.stderr)
