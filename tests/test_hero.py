"""Start-screen planet animation: the files exist, index.html loads them, and the script has the pieces we rely on."""
from pathlib import Path

FRONT = Path(__file__).resolve().parent.parent / "frontend"


def test_hero_files_are_loaded_by_index():
    html = (FRONT / "index.html").read_text(encoding="utf-8")
    assert 'href="hero.css?v=__VERSION__"' in html and 'src="hero.js?v=__VERSION__"' in html
    assert (FRONT / "hero.css").is_file() and (FRONT / "hero.js").is_file()


def test_hero_script_follows_the_theme_and_respects_reduced_motion():
    js = (FRONT / "hero.js").read_text(encoding="utf-8")
    assert 'dataset.theme === "light"' in js and "prefers-reduced-motion" in js
    assert "pointermove" in js and "Escape" in js and "zt" in js  # zoom by click / Esc
    assert "mouse" not in js.lower().replace("pointer", "")  # time of day never follows the mouse
    assert "http" not in js.replace("http://www.w3.org", "")  # no external files


def test_hero_has_no_greek_text():
    js = (FRONT / "hero.js").read_text(encoding="utf-8")
    assert not any("Ͱ" <= c <= "Ͽ" for c in js)  # texts there would need an English entry
