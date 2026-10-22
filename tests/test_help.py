"""Help bubbles (stream voitheia): every entry of frontend/helptexts.js is complete and points at real elements."""
import json
import re
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
PARTS = ("short", "what", "why", "example")  # bubble, «Τι κάνει», «Γιατί είναι χρήσιμο», «Παράδειγμα»
OPTIONAL = ("sel", "name", "place", "text")
PLACES = ("top", "bottom", "left", "right")
GREEK = re.compile("[Ͱ-Ͽ]")


def _no_duplicates(pairs):
    keys = [k for k, _ in pairs]
    dup = {k for k in keys if keys.count(k) > 1}
    assert not dup, f"διπλό κλειδί στο helptexts.js: {dup}"
    return dict(pairs)


def load_help_texts():
    """helptexts.js is a JS object literal kept close to JSON (see the comment at its top)."""
    src = (FRONTEND / "helptexts.js").read_text(encoding="utf-8")
    body = src[src.index("window.HELP_TEXTS = ") + len("window.HELP_TEXTS = "):src.rindex("};") + 1]
    body = re.sub(r"(?m)^\s*//.*$", "", body)  # comments on their own lines
    body = re.sub(r'"\s*\+\s*\n\s*"', "", body)  # "…" + "…" on the next line
    body = re.sub(r"(?m)^(\s*)([A-Za-z_]\w*)\s*:", r'\1"\2":', body)  # bare keys
    body = re.sub(r",(\s*[}\]])", r"\1", body)  # trailing commas
    return json.loads(body, object_pairs_hook=_no_duplicates)


TEXTS = load_help_texts()


def test_help_texts_load():
    assert len(TEXTS) > 100


@pytest.mark.parametrize("key", sorted(TEXTS))
def test_entry_has_all_four_parts(key):
    e = TEXTS[key]
    for part in PARTS:
        assert isinstance(e.get(part), str) and e[part].strip(), f"«{key}»: λείπει το {part}"
        assert GREEK.search(e[part]), f"«{key}»: το {part} δεν είναι στα ελληνικά"
    assert len(e["short"]) <= 140, f"«{key}»: το συννεφάκι θέλει 1-2 γραμμές (έως 140 χαρακτήρες)"
    unknown = set(e) - set(PARTS) - set(OPTIONAL)
    assert not unknown, f"«{key}»: άγνωστα πεδία {unknown}"
    if "place" in e:
        assert e["place"] in PLACES, f"«{key}»: place πρέπει να είναι ένα από {PLACES}"
    if "sel" not in e:
        # Found by data-help="<key>": keep the key usable inside that selector.
        assert re.fullmatch(r"[a-z][a-z0-9-]*", key), f"«{key}»: χωρίς sel, το κλειδί γίνεται data-help id"


def test_id_selectors_exist_in_index_html():
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    ids = set(re.findall(r'\bid="([^"]+)"', html))
    missing = {}
    for key, e in TEXTS.items():
        for el_id in re.findall(r"#([A-Za-z_][\w-]*)", e.get("sel", "")):
            if el_id not in ids:
                missing.setdefault(key, []).append(el_id)
    assert not missing, f"επιλογείς #id που δεν υπάρχουν στο index.html: {missing}"


def test_help_files_are_loaded_in_order():
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert 'href="help.css' in html
    assert html.index('src="helptexts.js') < html.index('src="help.js')
