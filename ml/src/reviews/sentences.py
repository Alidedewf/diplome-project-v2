"""Разбивка отзыва на предложения (E6; та же — для эталона и для всех ~60 млн предложений шага 6).

Основа — правило перевода (data.translate._SENT: знак + пробел + заглавная, склейка «book.Loved»), плюс:
- перенос строки — граница, если дальше начинается новая фраза (списки и заголовки без точки), но не перенос по
  ширине посреди предложения (см. paragraphs);
- не рвём после инициалов («J. Scott Savage», «A. S. Byatt», «W. Wilson», «U.S.») и сокращений (Mr., mr., Dr., St.,
  vol., pp., e.g., i.e., vs., No. перед числом…) — кусок, который ими кончается, склеивается со следующим.
Сплиттер перевода не меняется: на нём держится кэш переводов.
"""

import re

from data.translate import MAX_WORDS, _SENT

_NO_BREAK = re.compile(
    r"(?:(?<![\w.])[A-Z]|(?<![\w])(?:[A-Z]\.)+[A-Z]|"
    r"\b(?i:mr|mrs|ms|messrs|dr|st|jr|sr|prof|rev|gen|col|capt|lt|sgt|vs|vol|vols|pp|p|ch|chap|fig|ed|eds|approx|"
    r"cf|al|e\.g|i\.e|ca))\.$")
_NUM_ABBR = re.compile(r"\b(?i:no|nos|nr)\.$")


def _chunks(s: str) -> list[str]:
    """Очень длинное «предложение» (склеенные без точек абзацы) — по знакам «;:», затем по словам (как в переводе)."""
    words = s.split()
    if len(words) <= MAX_WORDS:
        return [s]
    parts, cur = [], []
    for w in words:
        cur.append(w)
        if len(cur) >= MAX_WORDS or (len(cur) >= 20 and w[-1] in ";:"):
            parts.append(" ".join(cur))
            cur = []
    if cur:
        parts.append(" ".join(cur))
    return parts


_LINE_START = re.compile(r"[A-Z0-9#\"“‘(•*\-]")


def paragraphs(text: str) -> list[str]:
    """Перенос строки — граница, только если следующая строка начинается как новая фраза (заглавная, цифра, маркер
    списка) и в предыдущей хотя бы два слова. Иначе это перенос по ширине («…is\\nit derogatory») или внутри фразы
    («And\\nMore importantly») — склеиваем пробелом."""
    out = []
    for line in re.split(r"\s*\n+\s*", text or ""):
        if not line:
            continue
        if out and (not _LINE_START.match(line) or len(out[-1].split()) < 2):
            out[-1] = out[-1] + " " + line
        else:
            out.append(line)
    return out


def split(text: str) -> list[str]:
    out = []
    for para in paragraphs(text):
        pieces = [p.strip() for p in _SENT.split(para) if p and p.strip()]
        merged = []
        for p in pieces:
            if merged and (_NO_BREAK.search(merged[-1]) or (_NUM_ABBR.search(merged[-1]) and p[:1].isdigit())):
                merged[-1] = merged[-1] + " " + p
            else:
                merged.append(p)
        for m in merged:
            out.extend(_chunks(" ".join(m.split())))
    return out
