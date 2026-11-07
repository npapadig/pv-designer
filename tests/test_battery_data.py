"""Reading the user's consumption / production files (backend/battery_data.py): CSV and Excel, hourly and 15 minutes."""
import io
import zipfile

import numpy as np
import pandas as pd
import pytest

from backend import battery_data as bd

IDX15 = pd.date_range("2025-01-01", "2025-12-31 23:45", freq="15min")
_rng = np.random.default_rng(7)
KW = 0.4 + 0.3 * np.clip(np.sin((IDX15.hour.to_numpy() - 6) / 24 * 2 * np.pi), 0, None) + _rng.random(len(IDX15)) * 0.2
KWH = KW * 0.25


def _csv(lines, enc="utf-8"):
    return "\n".join(lines).encode(enc)


def _fmt(v, comma=True):
    s = f"{v:.3f}"
    return s.replace(".", ",") if comma else s


def test_greek_csv_decimal_comma_day_first_greek_encoding():
    lines = ["Ημερομηνία;Κατανάλωση (kWh)"] + [f"{t:%d/%m/%Y %H:%M};{_fmt(v)}" for t, v in zip(IDX15, KWH)]
    r = bd.parse(_csv(lines, "cp1253"), "x.csv")
    assert r["step_minutes"] == 15 and r["kind"] == "consumption" and r["days"] == 365
    assert abs(r["annual_kwh"] - KWH.sum()) < 1.0 and r["notes"] == []
    assert r["series"]["import"].index[0] == pd.Timestamp("2025-01-01 00:00")


def test_date_and_time_columns_kw_and_end_of_interval_labels():
    t2 = IDX15 + pd.Timedelta(minutes=15)                    # the time marks the END of the 15 minutes
    lines = ["Date,Time,Power (kW)"] + [f"{t:%Y-%m-%d},{t:%H:%M},{v:.3f}" for t, v in zip(t2, KW)]
    r = bd.parse(_csv(lines), "b.csv")
    assert "end_labeled" in r["notes"] and r["unit"] == "kw"
    assert r["series"]["import"].index[0] == pd.Timestamp("2025-01-01 00:00")
    assert abs(r["annual_kwh"] - KWH.sum()) < 1.0            # kW turned into kWh per 15 minutes


def test_meter_file_with_import_and_export_columns():
    h = pd.date_range("2025-01-01", "2025-12-31 23:00", freq="h")
    lines = ["Time;A+ (kWh);A- (kWh)"] + [f"{t:%d.%m.%Y %H:%M};1,20;0,10" for t in h]
    r = bd.parse(_csv(lines), "c.csv")
    assert r["kind"] == "meter" and r["step_minutes"] == 60
    assert abs(r["annual_kwh"] - 1.2 * 8760) < 1 and abs(r["export_annual_kwh"] - 876) < 1


def test_total_meter_readings_become_the_energy_of_each_interval():
    cum = np.cumsum(KWH) + 1000
    lines = ["Ημερομηνία;Ένδειξη (kWh)"] + [f"{t:%d/%m/%Y %H:%M};{v:.3f}" for t, v in zip(IDX15, cum)]
    r = bd.parse(_csv(lines), "d.csv")
    assert "counter" in r["notes"] and abs(r["annual_kwh"] - KWH.sum()) < 2.0


def test_wide_table_one_row_per_day():
    lines = ["Ημερομηνία;" + ";".join(f"{m // 60:02d}:{m % 60:02d}" for m in range(0, 1440, 15))]
    d = KWH.reshape(365, 96)
    for i, day in enumerate(pd.date_range("2025-01-01", periods=365)):
        lines.append(f"{day:%d/%m/%Y};" + ";".join(_fmt(x) for x in d[i]))
    r = bd.parse(_csv(lines), "w.csv")
    assert r["step_minutes"] == 15 and abs(r["annual_kwh"] - KWH.sum()) < 1.0


def test_gaps_are_filled_and_counted():
    keep = np.ones(len(IDX15), bool)
    keep[1000:1003] = False                                  # a short gap
    keep[20000:20400] = False                                # a long one (about 4 days)
    lines = ["Date;kWh"] + [f"{t:%Y-%m-%d %H:%M};{v:.3f}" for t, v, k in zip(IDX15, KWH, keep) if k]
    r = bd.parse(_csv(lines), "g.csv")
    assert 1.0 < r["missing_pct"] < 1.3 and len(r["series"]["import"]) == len(IDX15)
    assert abs(r["annual_kwh"] - KWH.sum()) / KWH.sum() < 0.01


def test_less_than_a_year_and_daily_values_are_refused_in_plain_words():
    short = ["Date;kWh"] + [f"{t:%Y-%m-%d %H:%M};{v:.3f}" for t, v in zip(IDX15[:2000], KWH)]
    with pytest.raises(ValueError, match="έτος"):
        bd.parse(_csv(short), "s.csv")
    days = pd.date_range("2025-01-01", periods=365)
    daily = ["Date;kWh"] + [f"{t:%Y-%m-%d};{12.5}" for t in days]
    with pytest.raises(ValueError, match="ανά ώρα"):
        bd.parse(_csv(daily), "d.csv")


def test_longer_than_a_year_keeps_the_last_365_days():
    idx = pd.date_range("2024-07-01", "2025-12-31 23:00", freq="h")
    lines = ["Date;kWh"] + [f"{t:%Y-%m-%d %H:%M};1.0" for t in idx]
    r = bd.parse(_csv(lines), "l.csv")
    assert r["days"] == 365 and "trimmed_to_year" in r["notes"] and r["start"].startswith("2025-01-01")


def test_old_xls_is_refused_with_advice():
    with pytest.raises(ValueError, match="xlsx"):
        bd.read_rows(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"0" * 20, "old.xls")


def _xlsx(rows, date_col=True):
    """A minimal .xlsx (one sheet, shared strings, date style) written by hand."""
    sst, cells = [], []
    def s(t):
        sst.append(t)
        return len(sst) - 1
    body = []
    for r, (a, b) in enumerate(rows, start=1):
        if r == 1:
            body.append(f'<row r="1"><c r="A1" t="s"><v>{s(a)}</v></c><c r="B1" t="s"><v>{s(b)}</v></c></row>')
        else:
            serial = (a - pd.Timestamp("1899-12-30")).total_seconds() / 86400
            body.append(f'<row r="{r}"><c r="A{r}" s="1"><v>{serial!r}</v></c><c r="B{r}"><v>{b}</v></c></row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    files = {
        "xl/worksheets/sheet1.xml": f'<worksheet {ns}><sheetData>{"".join(body)}</sheetData></worksheet>',
        "xl/sharedStrings.xml": f'<sst {ns}>' + "".join(f"<si><t>{t}</t></si>" for t in sst) + "</sst>",
        "xl/styles.xml": f'<styleSheet {ns}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts>'
                         f'<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
        "[Content_Types].xml": "<Types/>",
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    return buf.getvalue()


def test_excel_xlsx_with_real_dates():
    idx = pd.date_range("2025-01-01", "2025-12-31 23:00", freq="h")
    rows = [("Ημερομηνία", "Κατανάλωση (kWh)")] + [(t, 0.5) for t in idx]
    r = bd.parse(_xlsx(rows), "k.xlsx")
    assert r["step_minutes"] == 60 and abs(r["annual_kwh"] - 0.5 * 8760) < 1 and r["days"] == 365


def test_cache_returns_the_same_answer_and_summary_has_no_series():
    lines = ["Date;kWh"] + [f"{t:%Y-%m-%d %H:%M};{v:.3f}" for t, v in zip(IDX15, KWH)]
    data = _csv(lines)
    a, b = bd.parse_cached(data, "c.csv"), bd.parse_cached(data, "c.csv")
    assert a is b
    s = bd.summary(a)
    assert "series" not in s and s["peak_kw"] > 0


def test_partial_year_with_zeros_at_the_end_like_a_real_deddie_download():
    idx = pd.date_range("2025-05-26 01:00", "2025-12-23 00:00", freq="h")          # the time marks the END of the hour
    v = np.where(idx <= pd.Timestamp("2025-11-03 12:00"), 20.0, 0.0)                  # then the values had not arrived: zeros
    lines = ["Ημερομηνία;Ενέργεια;Πιστοποιημένη"] + [f"{t:%d/%m/%Y %H:%M};{x:.3f};  Ναι".replace(".", ",") for t, x in zip(idx, v)]
    r = bd.parse(_csv(lines), "p.csv")
    assert {"zeros_trimmed", "end_labeled", "unit_assumed"} <= set(r["notes"])
    assert r["full_year"] is False and 160 < r["days"] < 163 and r["covered_months"] == [6, 7, 8, 9, 10]
    assert r["start"].startswith("2025-05-26T00:00") and r["end"].startswith("2025-11-03T12:00")
    assert abs(r["series"]["import"].sum() - 20.0 * 161.5 * 24) < 25


def test_a_long_run_of_zeros_inside_the_file_is_a_missing_stretch():
    h = pd.date_range("2025-01-01", "2025-12-31 23:00", freq="h")
    v = np.full(len(h), 1.0)
    v[(h >= "2025-06-01") & (h < "2025-06-20")] = 0.0
    lines = ["Date;kWh"] + [f"{t:%Y-%m-%d %H:%M};{x:.2f}" for t, x in zip(h, v)]
    r = bd.parse(_csv(lines), "z.csv")
    assert "long_zero_run" in r["notes"] and abs(r["series"]["import"].sum() - len(h)) < 5
