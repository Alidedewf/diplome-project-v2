"""Кандидаты в «не-книги» в каталоге (решения.md 3.6): блокноты, планеры, календари, экслибрисы, записные книжки,
наклейки, игрушки, канцелярия… Из каталога ничего не удаляется — список для решения с автором. Для сводок отзывов
(summarize.py) отсеиваются только «явные» кандидаты.

Признаки (у книги может быть несколько; итоговая сила — максимальная):
- формат (format) — не книжный: Misc. Supplies, Toy, Stationery, Bookmark, Poster, Calendar…;
- раздел / подраздел Amazon (cat2 / путь categories) — служебный или канцелярский: ASINs for HQP, Moleskine,
  Planners & Datebooks, Notebooks…;
- название — ключевые слова: bookplates, address book, planner, calendar, notebook, blank/lined journal, stickers…
«спорно» — то, что бывает и настоящей книгой: дневник-с-заданиями (guided journal), раскраска, книга-игра, комплект.

    uv run python src/reviews/nonbook.py      → data/processed/nonbook_candidates.csv (+ nonbook_books.parquet)
"""

import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
BOOKS = ROOT / "data" / "processed" / "books_clean.parquet"

FORMATS = {
    "явно": ["Misc. Supplies", "Toy", "Stationery", "Bookmark", "Poster", "Wall Chart", "Calendar", "Diary", "Game",
             "Kitchen", "Apparel", "Accessory", "Electronics", "Office Product", "Baby Product", "Automotive",
             "Health and Beauty", "Luggage", "Notebook", "Journal", "Sports", "Home", "Tools & Hardware",
             "Personal Computers", "Wireless Phone Accessory", "Puzzle", "DVD", "Blu-ray", "Misc."],
    "спорно": ["Product Bundle", "Card Book"],
}
SECTIONS = {   # подстрока пути категорий
    "явно": ["Moleskine", "Planners & Datebooks", "Notebooks"],
    "спорно": ["ASINs for HQP", "Coloring Books for Grown-Ups", "Journal Writing", "Activities, Crafts & Games > Games",
               "Puzzles & Games > Board Games"],
}
# Название: «явно» — только однозначные формулировки; общие слова (notebook, planner, address book, guest book…)
# встречаются в названиях романов («The Notebook», «The Red Address Book», «The Death Planner») — они «спорно»
TITLES = {
    "явно": [r"\bbookplates\b", r"\bbook of addresses\b",
             r"\b(wedding|weekly|daily|monthly|academic|budget|meal|\d{4}(-\d{2,4})?) planner\b", r"\bplanner (&|and) organizer\b",
             r"\b(wall|desk|day-to-day|mini|engagement|\d{4}) calendar\b", r"\bcalendar \d{4}\b",
             r"\b(composition|spiral|ruled|lined|dot(ted)?[- ]grid|sketch|college|pocket) notebook\b",
             r"\bnotebook (set|journal)\b",
             r"\b(blank|lined|dot[- ]grid|ruled|graph paper) (journal|book|pages)\b", r"\bstickers\b",
             r"\blog ?book\b", r"\bpassword (book|keeper|log|organizer)\b", r"\bnote ?cards\b",
             r"\b\d+ (post ?cards|cards)\b", r"\bpostcard (book|set|collection)\b",
             r"\bflash ?cards\b", r"\bbookmarks?\b", r"\b(tarot|oracle) (deck|cards)\b", r"\bjigsaw puzzle\b"],
    "спорно": [r"\bjournal\b", r"\bcoloring book\b", r"\bcolouring book\b", r"\bactivity book\b", r"\bworkbook\b",
               r"\bsticker book\b", r"\bnotebook\b", r"\bplanner\b", r"\baddress(es)? book\b", r"\bguest book\b",
               r"\brecord book\b", r"\bgift (set|box)\b", r"\bboxed set\b", r"\bbox set\b", r"\bpost ?cards\b"],
}
# «Явное» правило по названию не срабатывает, если наклейки — бонус к книжке («Stickers Included!», «With 22 Stickers»)
TITLE_EXCEPT = {r"\bstickers\b": r"(?i)(stickers included|\b(with|includes?|plus|over) (\w+ ){0,3}\d* ?(art )?stickers)"}
RANK = {"": 0, "спорно": 1, "явно": 2}


def flags(b: pd.DataFrame) -> pd.DataFrame:
    """Длинная таблица (parent_asin, признак, значение, сила)."""
    path = b["categories"].map(lambda c: " > ".join(c) if c is not None else "")
    out = []
    for force, vals in FORMATS.items():
        m = b["format"].isin(vals)
        out.append(pd.DataFrame({"parent_asin": b.loc[m, "parent_asin"], "признак": "формат",
                                 "значение": b.loc[m, "format"], "сила": force}))
    for force, vals in SECTIONS.items():
        for v in vals:
            m = path.str.contains(v, regex=False)
            out.append(pd.DataFrame({"parent_asin": b.loc[m, "parent_asin"], "признак": "раздел",
                                     "значение": v, "сила": force}))
    for force, pats in TITLES.items():
        for pat in pats:
            t = b["title"].fillna("")
            m = t.str.contains(re.compile(pat, re.I), regex=True)
            if force == "явно" and pat in TITLE_EXCEPT:
                m &= ~t.str.contains(re.compile(TITLE_EXCEPT[pat]), regex=True)
            out.append(pd.DataFrame({"parent_asin": b.loc[m, "parent_asin"], "признак": "название",
                                     "значение": pat, "сила": force}))
    return pd.concat(out, ignore_index=True)


def nonbook(b: pd.DataFrame) -> pd.Series:
    """Сила признака «не-книга» для каждой книги: «явно» / «спорно» / ''."""
    f = flags(b)
    r = f.assign(r=f["сила"].map(RANK)).groupby("parent_asin")["r"].max()
    inv = {v: k for k, v in RANK.items()}
    return b["parent_asin"].map(r).fillna(0).astype(int).map(inv)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    b = pd.read_parquet(BOOKS, columns=["parent_asin", "title", "format", "categories", "n_ratings"])
    f = flags(b).merge(b[["parent_asin", "title", "n_ratings"]], on="parent_asin")
    agg = f.groupby(["признак", "значение", "сила"]).agg(
        книг=("parent_asin", "nunique"), оценок=("n_ratings", "sum"),
        примеры=("title", lambda t: " | ".join(t.dropna().astype(str).str[:60].head(3)))).reset_index()
    agg = agg.sort_values(["сила", "книг"], ascending=[False, False])
    agg.to_csv(ROOT / "data" / "processed" / "nonbook_candidates.csv", index=False, encoding="utf-8-sig")
    s = nonbook(b)
    pd.DataFrame({"parent_asin": b["parent_asin"], "nonbook": s}).query("nonbook != ''").to_parquet(
        ROOT / "data" / "processed" / "nonbook_books.parquet", index=False)
    for force in ["явно", "спорно"]:
        m = s == force
        print(f"{force}: книг {m.sum():,} ({m.mean():.2%} каталога), оценок {b.loc[m, 'n_ratings'].sum():,} "
              f"({b.loc[m, 'n_ratings'].sum() / b['n_ratings'].sum():.2%})")
    pd.set_option("display.width", 220)
    pd.set_option("display.max_colwidth", 70)
    print(agg.head(40).to_string(index=False))


if __name__ == "__main__":
    main()
