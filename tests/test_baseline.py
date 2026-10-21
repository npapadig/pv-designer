"""Every output of the baseline projects must stay identical (floats within 1e-6 relative)."""
import json
import math

from tests.baseline.run import EXPECTED, run_all


def _diff(path, got, exp, out):
    if isinstance(exp, dict):
        if not isinstance(got, dict) or set(got) != set(exp):
            out.append(f"{path}: keys {sorted(got) if isinstance(got, dict) else got!r} != {sorted(exp)}")
            return
        for k in exp:
            _diff(f"{path}.{k}", got[k], exp[k], out)
    elif isinstance(exp, list):
        if not isinstance(got, list) or len(got) != len(exp):
            out.append(f"{path}: list length differs")
            return
        for i, (g, e) in enumerate(zip(got, exp)):
            _diff(f"{path}[{i}]", g, e, out)
    elif isinstance(exp, float) or isinstance(got, float):
        if not (isinstance(got, (int, float)) and math.isclose(got, exp, rel_tol=1e-6, abs_tol=1e-9)):
            out.append(f"{path}: {got!r} != {exp!r}")
    elif got != exp:
        out.append(f"{path}: {got!r} != {exp!r}")


def test_baseline_outputs_unchanged():
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    diffs = []
    _diff("", json.loads(json.dumps(run_all())), expected, diffs)
    assert not diffs, "Baseline changed:\n" + "\n".join(diffs[:40])
