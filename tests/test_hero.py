"""Start-screen 3D planet (three.js): the files exist, index.html loads them, three.js is vendored with its licence,
nothing is fetched from outside, and the scripts keep the behaviour we rely on (theme = time of day, reduced motion,
zoom by click / Esc, pausing, the focus hooks of the start screen)."""
import re
from pathlib import Path

FRONT = Path(__file__).resolve().parent.parent / "frontend"
HERO = ["hero.js", "hero-world.js", "hero-kit.js"]


def read(name: str) -> str:
    return (FRONT / name).read_text(encoding="utf-8")


def test_hero_files_are_loaded_by_index():
    html = read("index.html")
    assert 'href="hero.css?v=__VERSION__"' in html
    assert '<script type="module" src="hero.js?v=__VERSION__"></script>' in html
    for name in [*HERO, "hero.css"]:
        assert (FRONT / name).is_file(), name


def test_three_is_vendored_with_its_licence_and_imported_locally():
    three = FRONT / "vendor" / "three" / "three.module.min.js"
    assert three.is_file() and 'const t="168"' in three.read_text(encoding="utf-8")[:400]  # three.js r168
    assert "MIT License" in (FRONT / "vendor" / "three" / "LICENSE").read_text(encoding="utf-8")
    assert "three/three.module.min.js" in read("vendor/README.md")
    for name in HERO:
        for spec in re.findall(r'from "([^"]+)"', read(name)):
            assert spec.startswith("./"), (name, spec)  # only our own files, no CDN
    assert 'from "./vendor/three/three.module.min.js"' in read("hero.js")
    assert 'from "./hero-world.js"' in read("hero.js") and 'from "./hero-kit.js"' in read("hero-world.js")


def test_hero_follows_the_theme_and_respects_reduced_motion():
    js = read("hero.js")
    assert 'dataset.theme === "light"' in js and "prefers-reduced-motion" in js
    assert "pointermove" in js and "Escape" in js and "webglcontextlost" in js
    assert "visibilitychange" in js and "IntersectionObserver" in js and "home.hidden" in js  # pauses when not seen
    assert "Math.min(window.devicePixelRatio || 1, 2)" in js  # pixel ratio never above 2
    for name in HERO:
        src = read(name)
        assert "mouse" not in src.lower().replace("pointer", ""), name  # time of day never follows the pointer
        assert "http" not in src.replace("http://www.w3.org", ""), name  # no external files


def test_hero_has_no_greek_text():
    for name in HERO:
        assert not any("Ͱ" <= c <= "Ͽ" or "ἀ" <= c <= "῾" for c in read(name)), name  # texts would need English


def test_close_ups_stay_beside_or_below_the_cards():
    js = read("hero.js")
    assert "function freeArea()" in js and 'home.querySelector(".home-wrap")' in js  # measured from the cards
    assert "world.subject(name)" in js and "ResizeObserver" in js  # fitted again when the cards change
    assert "subject" in read("hero-world.js")
    css = read("hero.css")
    assert "@property --hero-rx" in css and "var(--hero-rx) var(--hero-ry)" in css  # the clear part shrinks close up


def test_start_screen_focuses_the_scene_on_the_choice():
    js = read("hero.js")
    assert "window.heroScene = { focus }" in js
    world = read("hero-world.js")
    for shot in ("overview:", "town:", "park:"):
        assert shot in world
    home = read("home.js")
    assert "window.heroScene" in home
    assert 'hero(name === "roof" ? "town" : "overview")' in home  # roof question = a building: show the town
    assert 'hero("park")' in home and '["homePark", "park"]' in home
