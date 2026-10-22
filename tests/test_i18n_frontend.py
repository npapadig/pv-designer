"""Greek / English in the app: the dictionary frontend/lang/en.js and how index.html loads it.
(Which Greek texts have no English yet: python -m tests.i18n_missing)"""
import re

from tests import i18n_missing as m

d = m.load_dictionary()


def test_dictionary_is_well_formed():
    assert set(d) == {"texts", "rules", "parts"}
    for greek, english in d["texts"].items():
        assert greek == m.norm(greek), f"κενά στο κλειδί: {greek!r}"
        assert english and not m.GREEK.search(english), greek
    for pattern, repl in d["rules"] + d["parts"]:
        groups = re.compile(m._py(pattern)).groups
        assert all(int(n) <= groups for n in re.findall(r"\$(\d)", repl)), pattern
        assert not m.GREEK.search(repl), pattern
    for pattern, _ in d["rules"]:
        assert pattern.startswith("^") and pattern.endswith("$"), pattern


def test_sample_translations():
    tr = lambda t: m.translate(m.norm(t), d)
    assert tr("Νέο έργο") == "New project"
    assert tr("Βήμα 2 από 7") == "Step 2 of 7"
    assert tr("Να διαγραφεί το έργο «Σπίτι»;") == "Delete the project “Σπίτι”?"
    assert tr("Λόγος DC/AC 1.20, μέσα στο συνιστώμενο εύρος 1.00–1.35.") == \
        "DC/AC ratio 1.20, within the recommended range 1.00–1.35."
    # Put together in the code from pieces: translated only when no Greek is left.
    assert tr("Κόστος συστήματος 8,000 €, μετά την επιδότηση 7,000 €. Όφελος 1ου έτους 900 € (καθαρό 800 € "
              "μετά τη συντήρηση). Συνολικό καθαρό κέρδος σε 25 χρόνια 20,000 € (ROI 180%).") == \
        "System cost 8,000 €, after the subsidy 7,000 €. First-year benefit 900 € (net 800 € after " \
        "maintenance). Total net profit over 25 years 20,000 € (ROI 180%)."
    assert tr("Σπίτι και αποθήκη") is None  # a name the user wrote stays as it is


def test_index_loads_the_translator_before_the_other_scripts():
    html = (m.FRONTEND / "index.html").read_text(encoding="utf-8")
    scripts = re.findall(r'<script src="([^"?]+)', html)
    assert scripts[:2] == ["lang/en.js", "i18n.js"]
    assert html.index('src="i18n.js') < html.index("</head>")
