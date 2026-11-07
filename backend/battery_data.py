"""Reading the user's own measurements: the consumption of the building and the production of the PV system, hourly or every 15 minutes.

Files: CSV (any delimiter, Greek or Western encoding, decimal comma or point) and Excel .xlsx (read here with the standard library, so
no new package). The old .xls is not read: the user saves it as .xlsx or CSV.
What is understood (so the user does not have to prepare the file):
- time: one column with date and time, or a date column and a time column, or a date and a number of the interval (1..24, 1..96),
  or one row per day with the intervals as columns (wide); day first (dd/mm/yyyy) or ISO (yyyy-mm-dd); "24:00" and Excel dates;
  a time that marks the END of the interval (the first record of the file is 00:15 and the last one is 00:00) is moved to its start;
- values: kWh, Wh (energy of the interval) or kW, W (average power of the interval); the unit is read from the title of the column
  (and can be given); counters that only grow (total kWh meters) are turned into the energy of each interval;
- what a column is (from its title): consumption / taken from the grid (import), fed into the grid (export), production of the inverter.
  Reactive energy (kvarh) is ignored.
The answer of `parse` is plain numbers and texts; the series of every role (kWh per interval, local clock time) are in `series`.
Gaps are filled (short ones by a line, long ones by the typical value of that month and time of the day) and counted in `missing_pct`.
A file longer than a year keeps its last 365 days. Zeros at the start / end of the file (values that had not arrived yet) are cut; the file
may cover only part of the year (at least MIN_VALID_DAYS): `full_year` and `covered_months` tell, and battery_real completes the year.
Nothing is stored: the caller keeps the file and sends it again (a small memory cache avoids reading it twice).
"""
from __future__ import annotations

import csv
import hashlib
import io
import math
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from datetime import date, datetime, time, timedelta
from functools import lru_cache

import numpy as np
import pandas as pd

MIN_VALID_DAYS = 28               # less than this is refused
FULL_YEAR_DAYS = 330              # from this many days the file counts as a whole year (no completion needed)
EDGE_ZERO_DAYS = 2                # zeros of at least this many days at the start / end of the file are not measurements
LONG_ZERO_DAYS = 7                # zeros of at least this many days inside the file are a missing stretch
MAX_BYTES = 40 * 1024 * 1024
STEPS = (5, 10, 15, 30, 60)       # minutes between two records that are understood
SHORT_GAP_STEPS = 4               # a gap of up to this many records is filled by a straight line
UNITS = ("kwh", "wh", "kw", "w")
ROLES = ("import", "export", "production", "consumption")
KINDS = ("consumption", "meter", "production")

_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_BUILTIN_DATE_FORMATS = set(range(14, 23)) | set(range(45, 48))


# ---------------------------------------------------------------- reading the rows
def read_rows(content: bytes, filename: str = "") -> list[list]:
    """The cells of the file as rows: text, numbers, datetime / time (Excel dates) or None."""
    if len(content) > MAX_BYTES:
        raise ValueError("Το αρχείο είναι πολύ μεγάλο (πάνω από 40 MB).")
    name = filename.lower()
    if content[:4] == b"PK\x03\x04" or name.endswith((".xlsx", ".xlsm")):
        return _read_xlsx(content)
    if content[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" or name.endswith(".xls"):
        raise ValueError("Το παλιό Excel (.xls) δεν διαβάζεται. Άνοιξέ το στο Excel και κάνε «Αποθήκευση ως» "
                         "«Βιβλίο Excel (.xlsx)» ή «CSV».")
    return _read_csv(content)


def _decode(content: bytes) -> str:
    if content[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return content.decode("utf-16")
    for enc in ("utf-8-sig", "cp1253"):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    return content.decode("latin-1")


def _read_csv(content: bytes) -> list[list]:
    text = _decode(content)
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise ValueError("Το αρχείο είναι άδειο.")
    sample = lines[:40]
    best, best_n = ";", 0
    for d in (";", "\t", "|", ","):                 # the comma last: in Greek files it is often the decimal sign
        counts = sorted(ln.count(d) for ln in sample)
        n = counts[len(counts) // 2]
        if n > best_n:
            best, best_n = d, n
    return [[c.strip() for c in row] for row in csv.reader(lines, delimiter=best)]


def _col_index(ref: str) -> int:
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + ord(ch.upper()) - 64
    return n - 1


def _serial_to_datetime(serial: float) -> datetime:
    return datetime(1899, 12, 30) + timedelta(seconds=round(serial * 86400))


def _date_style_flags(z: zipfile.ZipFile) -> list[bool]:
    """For every cell style of the workbook: does it show a date or a time?"""
    if "xl/styles.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/styles.xml"))
    custom = {}
    for nf in root.iter(f"{_NS}numFmt"):
        custom[int(nf.get("numFmtId", "0"))] = nf.get("formatCode", "")
    flags = []
    xfs = root.find(f"{_NS}cellXfs")
    for xf in (xfs if xfs is not None else []):
        fid = int(xf.get("numFmtId", "0"))
        code = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", custom.get(fid, ""))
        flags.append(fid in _BUILTIN_DATE_FORMATS or bool(re.search(r"[ymdhs]", code, re.I)) and fid >= 164)
    return flags


def _read_xlsx(content: bytes) -> list[list]:
    try:
        z = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise ValueError("Το αρχείο Excel δεν διαβάζεται (είναι κατεστραμμένο ή δεν είναι .xlsx).")
    names = z.namelist()
    shared: list[str] = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{_NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{_NS}t")))
    date_flags = _date_style_flags(z)
    sheets = sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    if not sheets:
        raise ValueError("Δεν βρέθηκε φύλλο με δεδομένα στο Excel.")
    best: list[list] = []
    for sheet in sheets:
        rows: list[list] = []
        for _, el in ET.iterparse(io.BytesIO(z.read(sheet)), events=("end",)):
            if el.tag != f"{_NS}row":
                continue
            row: list = []
            for c in el.findall(f"{_NS}c"):
                idx = _col_index(c.get("r", "A1"))
                while len(row) <= idx:
                    row.append(None)
                t, s = c.get("t"), c.get("s")
                v = c.find(f"{_NS}v")
                val = None
                if t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(f"{_NS}t"))
                elif v is not None and v.text is not None:
                    if t == "s":
                        val = shared[int(v.text)] if int(v.text) < len(shared) else None
                    elif t in ("str", "e"):
                        val = v.text if t == "str" else None
                    elif t == "b":
                        val = None
                    else:
                        try:
                            num = float(v.text)
                        except ValueError:
                            num = None
                        if num is not None:
                            is_date = s is not None and int(s) < len(date_flags) and date_flags[int(s)]
                            if is_date and num < 1:
                                val = (datetime(1899, 12, 30) + timedelta(seconds=round(num * 86400))).time()
                            elif is_date:
                                val = _serial_to_datetime(num)
                            else:
                                val = num
                row[idx] = val
            rows.append(row)
            el.clear()
        if len(rows) > len(best):
            best = rows
    if not best:
        raise ValueError("Το φύλλο του Excel είναι άδειο.")
    return best


# ---------------------------------------------------------------- cell readers
_NUM_RE = re.compile(r"^[+-]?(\d[\d.,']*|[.,]\d+)([eE][+-]?\d+)?\s*[A-Za-zμ%/·]*$")
_DT_RE = re.compile(r"^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?"
                    r"\s*(?:[zZ]|[+-]\d{2}:?\d{2})?\s*([AaPp][Mm])?$")
_TOD_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\s*(?:[-–—]|$)")


def _decimal(t: str) -> float:
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".") if t.rfind(",") > t.rfind(".") else t.replace(",", "")
    elif "," in t:
        t = t.replace(",", "") if t.count(",") > 1 else t.replace(",", ".")
    elif t.count(".") > 1:
        t = t.replace(".", "")
    return float(t)


def _num(v) -> float | None:
    """A number from a number or from text ("1.234,5", "0,25 kWh"); None when it is not one (dates and times are not)."""
    if v is None or isinstance(v, (bool, datetime, date, time)):
        return None
    if isinstance(v, (int, float)):
        return None if isinstance(v, float) and math.isnan(v) else float(v)
    s = str(v).strip().replace("\xa0", "").replace(" ", "")
    if not s or not _NUM_RE.match(s):
        return None
    m = re.match(r"[+-]?[\d.,']+(?:[eE][+-]?\d+)?", s)
    try:
        return _decimal(m.group(0).replace("'", ""))
    except ValueError:
        return None


def _dt(v, monthfirst: bool = False) -> datetime | None:
    """A date, with the time when there is one ("24:00" is the midnight of the next day); None when it is not a date."""
    if isinstance(v, datetime):
        return v
    if isinstance(v, date):
        return datetime(v.year, v.month, v.day)
    if not isinstance(v, str):
        return None
    m = _DT_RE.match(v.strip())
    if not m:
        return None
    a, b, c = m.group(1), m.group(2), m.group(3)
    if len(a) == 4:
        y, mo, d = int(a), int(b), int(c)
    else:
        y = int(c) + (2000 if len(c) <= 2 else 0)
        mo, d = (int(a), int(b)) if monthfirst else (int(b), int(a))
    h, mi, s = int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0)
    if m.group(7):
        h = h % 12 + (12 if m.group(7).lower() == "pm" else 0)
    try:
        return datetime(y, mo, d) + timedelta(hours=h, minutes=mi, seconds=s)
    except ValueError:
        return None


def _tod(v) -> int | None:
    """Minutes after midnight of a time of the day ("00:15", "0:15:00", an Excel time, "00:00-00:15" = its start); 24:00 = 1440."""
    if isinstance(v, datetime):
        return v.hour * 60 + v.minute if v.date() == date(1899, 12, 30) else None
    if isinstance(v, time):
        return v.hour * 60 + v.minute
    if not isinstance(v, str):
        return None
    m = _TOD_RE.match(v)
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if m.group(3):
        h = h % 12 + (12 if m.group(3).lower() == "pm" else 0)
    return h * 60 + mi if h <= 24 and mi < 60 else None


def _plain(text) -> str:
    """Lower case, without accents, for matching the titles of the columns."""
    s = unicodedata.normalize("NFD", str(text or "").lower())
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn").replace("ς", "σ")


_ROLE_WORDS = (
    ("ignore", ("kvar", "αεργ", "reactive", "tariff", "τιμολ", "cost", "κοστ", "τιμη", "price", "volt", "ampere", "temp",
                "θερμοκρ", "φορτιση μπαταριας", "soc", "frequency")),
    ("export", ("εγχυ", "export", "inject", "feed", "a-", "to grid", "προς δικτυο", "πωληση", "αποδοση")),
    ("production", ("παραγωγ", "production", "yield", "generation", "pv ", "pv_", "solar", "φωτοβολταικ", "inverter",
                    "etoday", "e-day", "output", "ac energy", "energy output")),
    ("import", ("εισαγωγ", "import", "ληψη", "λαμβαν", "a+", "from grid", "απορροφ", "withdraw", "purchase", "αγορα", "καταναλωθ")),
    ("consumption", ("καταναλωσ", "consumption", "load", "usage", "demand", "ζητηση", "ενεργεια", "energy")),
)


def _role_of(header: str) -> str | None:
    h = _plain(header) + " "
    for role, words in _ROLE_WORDS:
        if any(w in h for w in words):
            return role
    return None


def _unit_of(header: str, strict: bool = False) -> str | None:
    """The unit named in a column title (strict, for file names: not a lone W)."""
    h = str(header or "")
    words = r"kwh|kw\.?h|mwh|wh|kw" if strict else r"kwh|kw\.?h|mwh|wh|kw|mw|w"
    m = re.search(rf"(?<![A-Za-z])({words})(?![A-Za-z])", h, re.I)
    if not m:
        return None
    u = m.group(1).lower().replace(".", "")
    return {"kwh": "kwh", "wh": "wh", "kw": "kw", "w": "w", "mwh": "mwh", "mw": "mw"}[u]


# ---------------------------------------------------------------- finding the table
def _is_text(v) -> bool:
    return isinstance(v, str) and _num(v) is None and _dt(v) is None and _tod(v) is None


def _monthfirst(values) -> bool:
    first_over, second_over = False, False
    for v in values:
        if isinstance(v, str):
            m = re.match(r"^(\d{1,2})[/\-.](\d{1,2})[/\-.]\d{2,4}", v.strip())
            if m:
                first_over |= int(m.group(1)) > 12
                second_over |= int(m.group(2)) > 12
    return second_over and not first_over


def _wide_time_columns(header: list) -> dict[int, int]:
    """For a table with one row per day: {column: minutes of the interval's start} when the titles are times / interval numbers."""
    cols = {}
    for i, h in enumerate(header[1:], start=1):
        t = _tod(h)
        if t is not None:
            cols[i] = t
    if len(cols) >= 20:
        return cols
    nums = {i: _num(h) for i, h in enumerate(header[1:], start=1) if _num(h) is not None and float(_num(h)).is_integer()}
    if len(nums) >= 20 and max(nums.values()) in (23, 24, 25, 46, 48, 50, 92, 96, 100):
        top = max(nums.values())
        step = 15 if top >= 90 else 30 if top >= 46 else 60
        lo = min(nums.values())
        return {i: int((n - (0 if lo == 0 else 1)) * step) for i, n in nums.items()}
    return {}


def _find_table(rows: list[list]):
    """(header cells, data rows, time spec). time spec: ("dt", col) | ("date_tod", dcol, tcol) | ("date_slot", dcol, scol) | ("wide", {col: minute})."""
    width = max(len(r) for r in rows)
    rows = [list(r) + [None] * (width - len(r)) for r in rows]
    # a row of day + many interval columns
    for k, r in enumerate(rows[:40]):
        wide = _wide_time_columns(r)
        if wide and k + 1 < len(rows) and _dt(rows[k + 1][0]) is not None:
            return r, rows[k + 1:], ("wide", wide)
    first_data = None
    for k, r in enumerate(rows):
        if any(_dt(c) is not None for c in r) and any(_num(c) is not None for c in r):
            first_data = k
            break
    if first_data is None:
        raise ValueError("Δεν βρήκα στο αρχείο ημερομηνίες με τιμές. Χρειάζεται μια στήλη με ημερομηνία και ώρα και μία με "
                         "κατανάλωση (kWh ή kW).")
    header = rows[first_data - 1] if first_data > 0 else [""] * width
    body = rows[first_data:]
    n = len(body)
    sample = body[: min(n, 500)]
    dt_cols = [j for j in range(width) if sum(_dt(r[j]) is not None for r in sample) >= 0.9 * len(sample)]
    if not dt_cols:
        raise ValueError("Δεν βρήκα στήλη με ημερομηνίες σε όλες τις γραμμές.")
    dcol = dt_cols[0]
    # does the date column carry the time of the day?
    has_time = any(isinstance(r[dcol], datetime) and (r[dcol].hour or r[dcol].minute) or
                   (isinstance(r[dcol], str) and re.search(r"\d:\d\d", r[dcol])) for r in sample)
    if has_time:
        return header, body, ("dt", dcol)
    tcols = [j for j in range(width) if j != dcol and sum(_tod(r[j]) is not None for r in sample) >= 0.9 * len(sample)]
    if tcols:
        return header, body, ("date_tod", dcol, tcols[0])
    for j in range(width):
        if j == dcol:
            continue
        vals = [_num(r[j]) for r in sample]
        if all(v is not None and float(v).is_integer() for v in vals) and vals:
            top = max(vals)
            if top in (23, 24, 25, 46, 48, 50, 92, 96, 100) and (min(vals) in (0, 1)):
                return header, body, ("date_slot", dcol, j)
    return header, body, ("dt", dcol)       # only days: the step check below refuses it


def _timestamps(body, spec, monthfirst):
    """(list of start times as datetime, the rows they belong to) from the time spec."""
    stamps, keep = [], []
    if spec[0] == "wide":
        for i, r in enumerate(body):
            d = _dt(r[0], monthfirst)
            if d is None:
                continue
            for col, minute in spec[1].items():
                stamps.append(d + timedelta(minutes=minute))
                keep.append((i, col))
        return stamps, keep
    for i, r in enumerate(body):
        if spec[0] == "dt":
            d = _dt(r[spec[1]], monthfirst)
        elif spec[0] == "date_tod":
            d0, t = _dt(r[spec[1]], monthfirst), _tod(r[spec[2]])
            d = None if d0 is None or t is None else d0.replace(hour=0, minute=0) + timedelta(minutes=t)
        else:
            d0, s = _dt(r[spec[1]], monthfirst), _num(r[spec[2]])
            d = None
            if d0 is not None and s is not None:
                d = d0.replace(hour=0, minute=0)
                keep_slot = s
                d = (d, keep_slot)
        if d is None:
            continue
        stamps.append(d)
        keep.append(i)
    if spec[0] == "date_slot":
        top = max(s for _, s in stamps)
        lo = min(s for _, s in stamps)
        step = 15 if top >= 90 else 30 if top >= 46 else 60
        stamps = [d + timedelta(minutes=int((s - (0 if lo == 0 else 1)) * step)) for d, s in stamps]
    return stamps, keep


# ---------------------------------------------------------------- the series
def _snap_step(minutes: float) -> int:
    if minutes >= 1000:
        raise ValueError("Το αρχείο έχει μία τιμή την ημέρα (ή τον μήνα). Χρειάζεται κατανάλωση ανά ώρα ή ανά 15 λεπτά για όλο "
                         "το έτος. Τα ωριαία/15λεπτα δεδομένα τα ζητάς από τον ΔΕΔΔΗΕ (έξυπνος μετρητής).")
    nearest = min(STEPS, key=lambda s: abs(s - minutes))
    if abs(nearest - minutes) > 0.2 * nearest:
        raise ValueError(f"Δεν κατάλαβα κάθε πότε είναι οι μετρήσεις (περίπου {minutes:.0f} λεπτά). Χρειάζονται 5, 10, 15, 30 ή 60 λεπτά.")
    return nearest


def _to_kwh(values: np.ndarray, unit: str, dt_h: float) -> np.ndarray:
    return values * {"kwh": 1.0, "wh": 1e-3, "mwh": 1e3, "kw": dt_h, "w": 1e-3 * dt_h, "mw": 1e3 * dt_h}[unit]


def _is_counter(v: np.ndarray) -> bool:
    d = np.diff(v)
    return len(v) > 100 and float((d >= -1e-9).mean()) > 0.995 and float(d.sum()) > 0 and float(v[-1] - v[0]) > 20 * float(np.median(np.abs(d)) + 1e-9)


def _regular(stamps: list[datetime], vals: np.ndarray, label: str | None) -> tuple[pd.Series, dict]:
    """The values on a regular time grid (kWh per step not yet), the step in minutes and what was repaired."""
    s = pd.Series(vals, index=pd.DatetimeIndex(stamps)).sort_index()
    dup = int(s.index.duplicated().sum())
    s = s[~s.index.duplicated(keep="first")]
    if len(s) < 48:
        raise ValueError("Το αρχείο έχει πολύ λίγες μετρήσεις.")
    diffs = s.index.to_series().diff().dropna().dt.total_seconds() / 60.0
    step = _snap_step(float(diffs.median()))
    end_labeled = label == "end" or (label is None and s.index[0].hour * 60 + s.index[0].minute == step and
                                     s.index[-1].hour * 60 + s.index[-1].minute == 0 and step < 1440)
    if end_labeled:
        s.index = s.index - pd.Timedelta(minutes=step)
    grid = pd.date_range(s.index[0].floor(f"{step}min"), s.index[-1], freq=f"{step}min")
    s = s[~s.index.duplicated(keep="first")].reindex(grid)
    return s, {"step_minutes": step, "duplicates": dup, "end_labeled": bool(end_labeled)}


def _fill_gaps(s: pd.Series, step: int) -> tuple[pd.Series, float]:
    """Fill the missing records: short gaps by a straight line, long ones by the typical value of that month and time of the day."""
    miss = s.isna()
    pct = 100.0 * float(miss.mean())
    if not miss.any():
        return s, 0.0
    if miss.all():
        raise ValueError("Δεν υπάρχουν έγκυρες τιμές στο αρχείο.")
    out = s.interpolate(limit=SHORT_GAP_STEPS, limit_area="inside")
    still = out.isna()
    if still.any():
        key = list(zip(out.index.month, out.index.hour * 60 + out.index.minute))
        typical = out.groupby([out.index.month, out.index.hour * 60 + out.index.minute]).median()
        fill = pd.Series([typical.get(k, np.nan) for k in key], index=out.index)
        out = out.fillna(fill).fillna(float(out.mean()))
    return out, pct


def _column_values(body, keep, spec, col) -> np.ndarray:
    if spec[0] == "wide":
        return np.array([_num(body[i][c]) if _num(body[i][c]) is not None else np.nan for i, c in keep], float)
    return np.array([np.nan if _num(body[i][col]) is None else _num(body[i][col]) for i in keep], float)


def _nonzero_span(s: pd.Series, step: int) -> tuple[int, int, float]:
    """(first, last) positions of the real measurements: leading / trailing runs of zeros of at least EDGE_ZERO_DAYS are cut."""
    v = s.fillna(0.0).to_numpy(float)
    nz = np.flatnonzero(v != 0.0)
    if len(nz) == 0:
        raise ValueError("Το αρχείο έχει μόνο μηδενικά.")
    per_day = 1440.0 / step
    lo, hi = int(nz[0]), int(nz[-1])
    if lo < EDGE_ZERO_DAYS * per_day:
        lo = 0
    if len(v) - 1 - hi < EDGE_ZERO_DAYS * per_day:
        hi = len(v) - 1
    return lo, hi, ((lo) + (len(v) - 1 - hi)) / per_day


def _long_zero_runs_to_gaps(s: pd.Series, step: int) -> tuple[pd.Series, bool]:
    """Inside the file, a run of exact zeros of at least LONG_ZERO_DAYS is a missing stretch (no meter reading), not a real zero."""
    v = s.to_numpy(float)
    zero = np.nan_to_num(v, nan=1.0) == 0.0
    if not zero.any():
        return s, False
    edges = np.flatnonzero(np.diff(np.concatenate(([0], zero.astype(int), [0]))))
    need = LONG_ZERO_DAYS * 1440.0 / step
    out, hit = s.copy(), False
    for a, b in zip(edges[::2], edges[1::2]):
        if b - a >= need:
            out.iloc[a:b] = np.nan
            hit = True
    return out, hit


def parse(content: bytes, filename: str = "", unit: str | None = None, kind: str | None = None, label: str | None = None,
          value_col: int | None = None, export_col: int | None = None) -> dict:
    """Read a file. unit: "kwh"|"wh"|"kw"|"w" to override the one found in the title; kind: what the file shows
    ("consumption" of the building, "meter" = taken from / fed into the grid, "production" of the PV); label: "start"|"end"
    when the time marks the start / the end of the interval. value_col / export_col: column numbers (from `columns`) to override."""
    rows = read_rows(content, filename)
    header, body, spec = _find_table(rows)
    monthfirst = _monthfirst([r[spec[1] if spec[0] != "wide" else 0] for r in body[:2000]])
    stamps, keep = _timestamps(body, spec, monthfirst)
    if not stamps:
        raise ValueError("Δεν διάβασα καμία ημερομηνία από το αρχείο.")
    notes: list[str] = []
    width = len(header)
    cols: list[dict] = []
    if spec[0] == "wide":
        name = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", str(filename or ""))
        cols.append({"index": 0, "header": name, "role": _role_of(name), "unit": _unit_of(name, strict=True), "numeric": True})
        value_cols = {"value": 0}
    else:
        used = {spec[1]} | ({spec[2]} if spec[0] in ("date_tod", "date_slot") else set())
        sample = body[: min(len(body), 500)]
        for j in range(width):
            if j in used:
                continue
            ok = sum(_num(r[j]) is not None for r in sample) >= 0.8 * len(sample)
            if not ok:
                continue
            title = str(header[j] or "")
            cols.append({"index": j, "header": title, "role": _role_of(title), "unit": _unit_of(title), "numeric": True})
        cols = [c for c in cols if c["role"] != "ignore"]
        if not cols:
            raise ValueError("Δεν βρήκα στήλη με αριθμούς (kWh ή kW) στο αρχείο.")
        value_cols = {}
        by_role = {}
        for c in cols:
            by_role.setdefault(c["role"] or "unknown", []).append(c["index"])
        if value_col is not None:
            value_cols["value"] = value_col
        else:
            pick = (by_role.get("import") or by_role.get("consumption") or by_role.get("production") or by_role.get("unknown")
                    or [cols[0]["index"]])
            value_cols["value"] = pick[0]
        if export_col is not None:
            value_cols["export"] = export_col
        elif "export" in by_role and value_col is None:
            value_cols["export"] = by_role["export"][0]
    # what the file shows
    roles = {c["index"]: c["role"] for c in cols}
    main_role = roles.get(value_cols["value"])
    if kind is None:
        if "export" in value_cols or main_role == "import":
            kind = "meter"
        elif main_role == "production":
            kind = "production"
        else:
            kind = "consumption"
    elif kind not in KINDS:
        raise ValueError("Άγνωστο είδος αρχείου.")
    series: dict[str, pd.Series] = {}
    info: dict = {}
    regs = {}
    for name, col in value_cols.items():
        regs[name] = _regular(stamps, _column_values(body, keep, spec, col), label)
    # a file often runs on past the last real measurement with zeros (the values had not arrived yet): cut those edges, on all columns
    main = regs["value"][0]
    step = regs["value"][1]["step_minutes"]
    lo, hi, cut_days = _nonzero_span(main, step)
    if cut_days:
        notes.append("zeros_trimmed")
    for name, col in value_cols.items():
        s, rep = regs[name]
        s = s.iloc[lo:hi + 1]
        u = unit or next((c["unit"] for c in cols if c["index"] == col), None)
        if u is None:
            u = "kwh"
            notes.append("unit_assumed")
        counter = False
        raw = s.to_numpy(float)
        if u in ("kwh", "wh", "mwh") and _is_counter(raw[~np.isnan(raw)]):
            counter = True
            s = s.interpolate(limit_area="inside").diff().clip(lower=0)
            s.iloc[0] = np.nan
            s = s.bfill()
        else:
            s, long_zero = _long_zero_runs_to_gaps(s, step)
            if long_zero:
                notes.append("long_zero_run")
        s, miss = _fill_gaps(s, step)
        s = pd.Series(_to_kwh(s.to_numpy(float), u, step / 60.0), index=s.index).clip(lower=0)
        series["import" if name == "value" else "export"] = s
        info[name] = {"unit": u, "counter": counter, "missing_pct": round(miss, 2), **rep}
    step_min = info["value"]["step_minutes"]
    span_days = len(series["import"]) * step_min / 1440.0
    if span_days < MIN_VALID_DAYS:
        raise ValueError(f"Το αρχείο έχει μόνο {span_days:.0f} ημέρες με μετρήσεις (τα μηδενικά στο τέλος δεν μετριούνται). "
                         f"Χρειάζονται τουλάχιστον {MIN_VALID_DAYS} ημέρες, κατά προτίμηση ολόκληρο έτος.")
    first = series["import"]
    n_keep = int(365 * 24 * 60 / step_min)
    if len(first) > n_keep + step_min // 5:         # more than a year: the last 365 days
        for k in series:
            series[k] = series[k].iloc[-n_keep:]
        notes.append("trimmed_to_year")
    first = series["import"]
    for k, v in info.items():
        if k in ("value", "export"):
            if v.get("counter"):
                notes.append("counter")
            if v.get("end_labeled"):
                notes.append("end_labeled")
            if v.get("duplicates"):
                notes.append("duplicates")
    days = len(first) * step_min / 1440.0
    return {
        "kind": kind, "filename": filename, "step_minutes": step_min, "days": round(days, 1), "full_year": days >= FULL_YEAR_DAYS,
        "covered_months": _covered_months(first),
        "start": first.index[0].isoformat(), "end": (first.index[-1] + pd.Timedelta(minutes=step_min)).isoformat(),
        "annual_kwh": round(float(first.sum()) * 365.0 / days, 1) if days > 0 else 0.0,
        "export_annual_kwh": round(float(series["export"].sum()) * 365.0 / days, 1) if "export" in series and days > 0 else None,
        "missing_pct": max(v["missing_pct"] for v in info.values()), "notes": sorted(set(notes)),
        "columns": cols, "value_col": value_cols["value"], "export_col": value_cols.get("export"),
        "unit": info["value"]["unit"], "series": series,
    }


def _covered_months(s: pd.Series) -> list[int]:
    """The months (1..12) of which at least half is in the series."""
    per_day = 1440.0 / ((s.index[1] - s.index[0]).total_seconds() / 60.0)
    days = np.bincount(s.index.month.to_numpy() - 1, minlength=12) / per_day
    full = np.array([31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
    return [i + 1 for i in range(12) if days[i] >= 0.5 * full[i]]


def _hash(content: bytes) -> str:
    return hashlib.sha1(content).hexdigest()


@lru_cache(maxsize=6)
def _parse_cached(digest: str, filename: str, unit, kind, label, value_col, export_col, content: bytes) -> dict:
    return parse(content, filename, unit, kind, label, value_col, export_col)


def parse_cached(content: bytes, filename: str = "", unit=None, kind=None, label=None, value_col=None, export_col=None) -> dict:
    """The same as `parse`, but the last few files are kept in memory (not on disk), so changing a price does not read the file again."""
    return _parse_cached(_hash(content), filename, unit, kind, label, value_col, export_col, content)


def summary(parsed: dict) -> dict:
    """The parts of the answer that are plain numbers and texts (no series): what the page shows after the upload."""
    out = {k: v for k, v in parsed.items() if k != "series"}
    s = parsed["series"]["import"]
    out["peak_kwh_step"] = round(float(s.max()), 3)
    out["peak_kw"] = round(float(s.max()) * 60.0 / parsed["step_minutes"], 2)
    out["base_kw"] = round(float(s.quantile(0.05)) * 60.0 / parsed["step_minutes"], 3)
    return out
