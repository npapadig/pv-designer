"""The name and the mascot of the app (Solly) for the PDF documents: a small head with "Solly · Your Bright Friend", and the engineer for the cover."""
from __future__ import annotations

from pathlib import Path

from reportlab.lib.units import mm

NAME = "Solly"
TAGLINE = "Your Bright Friend"
FULL = f"{NAME} · {TAGLINE}"
IMG = Path(__file__).resolve().parent.parent / "frontend" / "img"
HEAD = IMG / "solly-head-day.png"
MASCOT = IMG / "solly-day.png"


def mark(c, x: float, y: float, h: float = 6 * mm, right: bool = False, font: str = "DejaVu-Bold", size: float = 7.5, color=None) -> float:
    """The head and the name, the head's lower left corner at (x, y); with right=True (x, y) is the lower RIGHT corner of the whole mark.
    Returns the width. Nothing is drawn (and 0 returned) when the picture is missing."""
    if not HEAD.exists():
        return 0.0
    c.saveState()
    c.setFont(font, size)
    text_w = c.stringWidth(FULL, font, size)
    width = h + 2 * mm + text_w
    x0 = x - width if right else x
    c.drawImage(str(HEAD), x0, y, h, h, mask="auto", preserveAspectRatio=True)
    if color is not None:
        c.setFillColor(color)
    c.drawString(x0 + h + 2 * mm, y + h / 2 - size * 0.35, FULL)
    c.restoreState()
    return width


def mascot(c, x: float, y: float, size: float) -> None:
    """The engineer, lower left corner at (x, y), size x size."""
    if MASCOT.exists():
        c.drawImage(str(MASCOT), x, y, size, size, mask="auto", preserveAspectRatio=True)


def footer(c, doc) -> None:
    """Page callback (PageTemplate onPage): the mark centred at the bottom edge of the page."""
    w, _ = doc.pagesize
    text_w = c.stringWidth(FULL, "DejaVu-Bold", 7)
    mark(c, (w - (5 * mm + 2 * mm + text_w)) / 2, 4 * mm, h=5 * mm, size=7)
