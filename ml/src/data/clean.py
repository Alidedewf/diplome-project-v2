"""Очистка данных: не-книги, язык, склейка изданий, повторный 5-core, новые поля книг.

Правила и их обоснование — решения.md, раздел 1.3; разведка — notebooks/01_data_issues.ipynb.

Запуск из папки ml/:
    uv run python src/data/clean.py
"""

import json
import re
import unicodedata
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
PROCESSED = ROOT / "data" / "processed"

BOOKS_IN = PROCESSED / "books_meta.parquet"
RATINGS_IN = PROCESSED / "ratings_5core.parquet"
BOOKS_OUT = PROCESSED / "books_clean.parquet"
RATINGS_OUT = PROCESSED / "ratings_clean.parquet"
FUNNEL_OUT = PROCESSED / "cleaning_funnel.csv"

MIN_RATINGS = 5
TEXT_MAX_CHARS = 2000  # ~512 токенов — предел типичной модели эмбеддингов
MIN_SECTION_BOOKS = 100  # меньше — промо-подборки Amazon («Best Books of 2013»), а не темы
YEAR_MIN, YEAR_MAX = 1900, 2023

# Разделы уровня 2, которые не являются темами книг
SERVICE_SECTIONS = {
    "New, Used & Rental Textbooks", "Boxed Sets", "Large Print", "Books on CD", "ASINs for HQP",
    "Textbook Rental ASINs", "Deals in Books", "Calendars",
}
NON_BOOK_FORMATS = {"Calendar", "Cards", "Map", "Diary"}
# Формат, если в subtitle его нет: ключ в details, который называет переплёт
FORMAT_KEYS = ["Paperback", "Hardcover", "Mass Market Paperback", "Board book", "Spiral-bound", "Audio CD",
               "Perfect Paperback", "Flexibound", "Library Binding", "Leather Bound", "Imitation Leather"]

# --- Нормализация названий (из 01_data_issues.ipynb) -------------------------------------------

EDITION_RE = re.compile(
    r"\b(\d+(st|nd|rd|th)\s+)?(\d+(st|nd|rd|th)|first|second|third|fourth|fifth|revised|updated|expanded|"
    r"anniversary|deluxe|collector'?s|special|illustrated|annotated|unabridged|abridged|large print|"
    r"new|international|student|library|mass market|reprint|definitive|complete)\s+(edition|ed\.)",
    re.I,
)
PARENS_RE = re.compile(r"\([^)]*\)|\[[^\]]*\]")
VOL_RE = re.compile(r"\b(book|vol\.?|volume|part|no\.?|#|tome|bk\.?)\s*(\d+)", re.I)
YEAR_RE = r"(1[4-9]\d\d|20[0-2]\d)"
HTML_RE = re.compile(r"<[^>]+>")
# Родовой подзаголовок после последнего двоеточия (уже нормализованный): «a novel», «a memoir»,
# «a novel of suspense», серийные «a jack reacher novel», «stories». Одно издание пишет его, другое нет.
# Не трогаем «a graphic novel» (это адаптация, другая книга) и «and other stories» (сборник).
GENERIC_TAIL_RE = re.compile(
    r"^(?:(?:a|an) (?:[a-z0-9 ]{1,40} )?"
    r"(?:novel|novella|thriller|mystery|memoir|romance|love story|ghost story|true story|short story|"
    r"cookbook|biography|autobiography)(?: of [a-z ]{1,40})?|stories|poems|essays)$"
)


def norm_text(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"&", " and ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def generic_tail(t: str) -> str | None:
    """Родовой подзаголовок названия (нормализованный) или None."""
    head, sep, tail = PARENS_RE.sub(" ", t).rpartition(":")
    tail = norm_text(tail)
    if sep and norm_text(head) and GENERIC_TAIL_RE.match(tail) and "graphic" not in tail:
        return tail
    return None


def title_key(t: str) -> str:
    """Название без скобок, пометок изданий и родового подзаголовка:
    «Gone Girl: A Novel (Deluxe Edition)» -> «gone girl»."""
    t = PARENS_RE.sub(" ", t)
    if generic_tail(t):
        t = t.rpartition(":")[0]
    return norm_text(EDITION_RE.sub(" ", t))


def volumes(t: str | None) -> frozenset:
    return frozenset(n for _, n in VOL_RE.findall(t or ""))


# --- Новые поля -----------------------------------------------------------------------------------

def extract_year(details: dict, subtitle: str | None) -> float | None:
    """Publication date -> Publisher «(January 1, 1988)» -> subtitle «Paperback – October 26, 2010»."""
    candidates = [
        re.search(rf"\b{YEAR_RE}\b", details.get("Publication date") or ""),
        re.search(rf"\b{YEAR_RE}\)\s*$", details.get("Publisher") or ""),
        re.search(rf"–.*\b{YEAR_RE}\s*$", subtitle or ""),
    ]
    for m in candidates:
        if m:
            year = int(m.group(1))
            return year if YEAR_MIN <= year <= YEAR_MAX else None
    return None


def extract_format(details: dict, subtitle: str | None) -> str | None:
    fmt = (subtitle or "").split(" – ")[0].strip()
    if fmt:
        return fmt
    for key in FORMAT_KEYS:
        if key in details:
            return key
    return "Kindle Edition" if "File size" in details else None


def isbn10_to_13(isbn10: str) -> str | None:
    if not re.fullmatch(r"\d{9}[\dX]", isbn10):
        return None
    core = "978" + isbn10[:9]
    check = (10 - sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(core)) % 10) % 10
    return core + str(check)


def extract_isbn13(details: dict) -> str | None:
    isbn13 = re.sub(r"[^\dX]", "", details.get("ISBN 13") or "")
    if len(isbn13) == 13:
        return isbn13
    return isbn10_to_13(re.sub(r"[^\dX]", "", details.get("ISBN 10") or ""))


def build_text(title: str | None, categories, features) -> str:
    """Текст для эмбеддингов: название + категории + features (аннотация). description не берём — там рецензии."""
    cats = " > ".join(c for c in categories if c not in ("Books", "Audible Books & Originals"))
    annotation = HTML_RE.sub(" ", " ".join(features))
    text = re.sub(r"\s+", " ", ". ".join(p for p in [title or "", cats, annotation] if p)).strip()
    if len(text) > TEXT_MAX_CHARS:
        text = text[:TEXT_MAX_CHARS].rsplit(" ", 1)[0]
    return text


# --- Шаги очистки ---------------------------------------------------------------------------------

def non_book_mask(books: pd.DataFrame) -> pd.DataFrame:
    title = books["title"].fillna("")
    cat_str = books["categories"].map(" > ".join)
    rules = pd.DataFrame({
        "категория Calendars": cat_str.str.contains(r"\bCalendars\b"),
        "категория Stationery": cat_str.str.contains("Stationery, Journals & Notebooks", regex=False),
        "формат Calendar/Cards/Map/Diary": books["format"].isin(NON_BOOK_FORMATS),
        "calendar + год/wall/desk": title.str.contains(r"\bcalendars?\b", case=False)
            & title.str.contains(r"\b(?:19|20)\d\d\b|wall|page-a-day|day-to-day|engagement|desk", case=False),
        "раскраски": title.str.contains(r"\bcolou?ring\s+books?\b", case=False),
    })
    return rules


def is_thematic(root: str | None, cat2: str | None, thematic_sections: set) -> bool:
    return root == "Books" and cat2 in thematic_sections


def merge_editions(books: pd.DataFrame, ratings: pd.DataFrame, thematic_sections: set):
    """Склейка изданий по строгому ключу.

    Возвращает (главные карточки, оценки на главных карточках, приклеенные книги без автора).
    """
    n_ratings = ratings["parent_asin"].value_counts()
    books = books.assign(n_src=books["parent_asin"].map(n_ratings).fillna(0).astype(int))

    has_author = books["author"].notna()
    tkey = books["title"].fillna("").map(title_key)
    key = books["author"].fillna("").map(norm_text) + " | " + tkey
    key = key.where(has_author, "noauthor | " + books["parent_asin"])

    # Группы с разными номерами томов не склеиваем
    vols = books["title"].map(volumes)
    conflict = vols.groupby(key).agg(lambda v: len({x for x in v if x}) > 1)
    key = key.where(~key.map(conflict), "volume | " + books["parent_asin"])

    # Книгу без автора приклеиваем, если с таким же названием ровно одна группа с автором
    # (и номер тома не противоречит группе). Несколько групп или ни одной — не трогаем.
    authored = has_author & ~key.str.startswith("volume | ")
    groups_by_title = pd.DataFrame({"t": tkey[authored], "g": key[authored]}).drop_duplicates().groupby("t")["g"].agg(list)
    group_vols = vols[authored].groupby(key[authored]).agg(lambda v: frozenset().union(*v))
    candidates = tkey[~has_author].map(groups_by_title)
    attach = {}
    for idx, gs in candidates.dropna().items():
        if len(gs) == 1 and tkey[idx] and (not vols[idx] or vols[idx] == group_vols[gs[0]]):
            attach[idx] = gs[0]
    key.update(pd.Series(attach, dtype=object))
    attached = books.loc[list(attach), ["parent_asin", "title"]].assign(group=pd.Series(attach))
    books["group"] = key

    # Главная карточка — больше всего оценок 5-core (при равенстве — меньший asin, для воспроизводимости)
    books = books.sort_values(["group", "n_src", "parent_asin"], ascending=[True, False, True])
    main_asin = books.groupby("group")["parent_asin"].transform("first")
    asin_map = dict(zip(books["parent_asin"], main_asin))
    books["n_editions"] = books.groupby("group")["parent_asin"].transform("size").astype("int16")

    # Пустые поля главной карточки заполняем из других изданий (по убыванию числа оценок)
    fill_cols = ["features", "description", "image", "isbn13", "year", "language", "author"]
    tmp = books[["group"] + fill_cols].copy()
    for col in ("features", "description"):
        tmp[col] = tmp[col].map(lambda x: x if len(x) else None)
    filled = tmp.groupby("group")[fill_cols].first()

    # Категории — голосование тематических изданий группы с весом по числу оценок, по уровням:
    # сначала самый «тяжёлый» cat2, затем внутри него самый тяжёлый cat3 (иначе Pride and Prejudice
    # уходит в Family Relationships: 175 оценок против 155 у Classics, хотя Literature & Fiction в сумме — 270).
    # Путь берём у самого оценённого издания с выбранной парой. Нет тематических — первого с любыми категориями.
    books["thematic"] = [is_thematic(r, c, thematic_sections) for r, c in zip(books["root"], books["cat2"])]
    books["cat3"] = books["categories"].map(lambda c: c[2] if len(c) > 2 else None)
    th = books[books["thematic"]]

    def heaviest(df: pd.DataFrame, by: list[str]) -> pd.DataFrame:
        w = df.groupby(by, dropna=False)["n_src"].sum().reset_index()
        return w.sort_values(["group", "n_src"], ascending=[True, False], kind="stable").drop_duplicates("group")[by]

    th = th.merge(heaviest(th, ["group", "cat2"]), on=["group", "cat2"])
    th = th.merge(heaviest(th, ["group", "cat3"]), on=["group", "cat3"])
    thematic_cats = (th.sort_values(["group", "n_src"], ascending=[True, False], kind="stable")
                     .groupby("group")["categories"].first().to_dict())
    any_cats = books[books["categories"].map(len) > 0].groupby("group")["categories"].first().to_dict()

    main = books[books["parent_asin"] == main_asin].set_index("group")
    for col in fill_cols:
        main[col] = filled[col].reindex(main.index)
    for col in ("features", "description"):
        main[col] = main[col].map(lambda x: list(x) if x is not None else [])
    main["categories"] = [thematic_cats.get(g, any_cats.get(g, [])) for g in main.index]
    main = main.reset_index(drop=True)

    # Оценки -> главная карточка; несколько изданий у одного пользователя -> последняя оценка
    ratings = ratings.assign(parent_asin=ratings["parent_asin"].map(asin_map))
    ratings = (ratings.sort_values("timestamp")
               .drop_duplicates(["user_id", "parent_asin"], keep="last")
               .sort_index())
    return main.drop(columns=["thematic", "n_src", "cat3"]), ratings, attached


def kcore(ratings: pd.DataFrame, k: int = MIN_RATINGS) -> tuple[pd.DataFrame, int]:
    iterations = 0
    while True:
        iterations += 1
        users_ok = ratings["user_id"].map(ratings["user_id"].value_counts()) >= k
        books_ok = ratings["parent_asin"].map(ratings["parent_asin"].value_counts()) >= k
        keep = users_ok & books_ok
        if keep.all():
            return ratings, iterations
        ratings = ratings[keep]


def main() -> None:
    books = pd.read_parquet(BOOKS_IN)
    ratings = pd.read_parquet(RATINGS_IN)
    funnel = []

    def log(step: str) -> None:
        row = {"шаг": step, "книг": books["parent_asin"].nunique(), "оценок": len(ratings),
               "пользователей": ratings["user_id"].nunique()}
        funnel.append(row)
        print(f"{step:42} книг {row['книг']:>8,}  оценок {row['оценок']:>10,}  пользователей {row['пользователей']:>8,}")

    def drop_books(mask: pd.Series) -> None:
        nonlocal books, ratings
        books = books[~mask]
        ratings = ratings[ratings["parent_asin"].isin(books["parent_asin"])]

    log("0. исходные данные (5-core)")

    # Разбираем details и считаем поля, нужные для правил
    details = books["details"].map(json.loads)
    books["language"] = details.map(lambda d: d.get("Language"))
    books["format"] = [extract_format(d, s) for d, s in zip(details, books["subtitle"])]
    books["year"] = pd.array([extract_year(d, s) for d, s in zip(details, books["subtitle"])], dtype="Int16")
    books["isbn13"] = details.map(extract_isbn13)
    books["categories"] = books["categories"].map(list)
    books["root"] = books["categories"].map(lambda c: c[0] if len(c) > 0 else None)
    books["cat2"] = books["categories"].map(lambda c: c[1] if len(c) > 1 else None)
    books["features"] = books["features"].map(list)
    books["description"] = books["description"].map(list)

    # Тематические разделы — по исходным данным: под Books, не служебные, ≥ 100 книг
    sizes = books.loc[books["root"] == "Books", "cat2"].value_counts()
    thematic_sections = set(sizes[sizes >= MIN_SECTION_BOOKS].index) - SERVICE_SECTIONS

    # 1. Не книги
    rules = non_book_mask(books)
    print("\nНе книги — сколько ловит каждое правило:")
    for name in rules.columns:
        print(f"  {name:32} {rules[name].sum():>6,}")
    drop_books(rules.any(axis=1))
    log("1. удалены не-книги")

    # 2. Язык: удаляем только если язык указан и английского среди языков нет
    non_en = books["language"].notna() & ~books["language"].fillna("").str.contains("English")
    drop_books(non_en)
    log("2. удалены книги не на английском")

    # 3. Склейка изданий
    tails = books["title"].fillna("").map(generic_tail).dropna()
    print(f"\nРодовые подзаголовки, убранные из ключа склейки: {len(tails):,} книг, {tails.nunique():,} вариантов. Топ-15:")
    for tail, n in tails.value_counts().head(15).items():
        print(f"  : {tail:40} {n:>6,}")
    before_merge = ratings["parent_asin"].value_counts()
    books, ratings, attached = merge_editions(books, ratings, thematic_sections)
    log("3. склеены издания")
    print(f"   из них приклеено книг без автора: {len(attached):,}")

    # 4. Повторный 5-core
    ratings, iterations = kcore(ratings)
    books = books[books["parent_asin"].isin(ratings["parent_asin"].unique())]
    log(f"4. повторный 5-core ({iterations} итер.)")

    # --- Итоговые поля
    books = books.copy()
    books["cat2"] = books["categories"].map(lambda c: c[1] if len(c) > 1 else None)
    books["cat3"] = books["categories"].map(lambda c: c[2] if len(c) > 2 else None)
    books["root"] = books["categories"].map(lambda c: c[0] if len(c) > 0 else None)
    final_sizes = books.loc[books["root"] == "Books", "cat2"].value_counts()
    onboarding = set(final_sizes[final_sizes >= MIN_SECTION_BOOKS].index) - SERVICE_SECTIONS
    books["onboarding_section"] = books["cat2"].where((books["root"] == "Books") & books["cat2"].isin(onboarding))
    books["text"] = [build_text(t, c, f) for t, c, f in zip(books["title"], books["categories"], books["features"])]
    books["n_ratings"] = books["parent_asin"].map(ratings["parent_asin"].value_counts()).astype("int32")

    columns = ["parent_asin", "title", "author", "year", "language", "format", "isbn13",
               "cat2", "cat3", "onboarding_section", "categories", "text", "features", "description",
               "image", "average_rating", "rating_number", "price", "store", "details",
               "n_editions", "n_ratings"]
    books = books[columns].sort_values("n_ratings", ascending=False).reset_index(drop=True)
    ratings = ratings.reset_index(drop=True)

    books.to_parquet(BOOKS_OUT, index=False)
    ratings.to_parquet(RATINGS_OUT, index=False)
    funnel_df = pd.DataFrame(funnel)
    funnel_df.to_csv(FUNNEL_OUT, index=False, encoding="utf-8")

    # --- Отчёт
    print("\nВоронка очистки:")
    print(funnel_df.to_string(index=False))

    print("\nПроверки:")
    dup = ratings.duplicated(["user_id", "parent_asin"]).sum()
    min_user = ratings["user_id"].value_counts().min()
    min_book = ratings["parent_asin"].value_counts().min()
    missing = (~ratings["parent_asin"].isin(books["parent_asin"])).sum()
    print(f"  дублей (user, book):                {dup}  {'OK' if dup == 0 else 'ОШИБКА'}")
    print(f"  мин. оценок у пользователя / книги:  {min_user} / {min_book}  "
          f"{'OK' if min(min_user, min_book) >= MIN_RATINGS else 'ОШИБКА'}")
    print(f"  книг из ratings нет в books:         {missing}  {'OK' if missing == 0 else 'ОШИБКА'}")
    print(f"  книг без ratings:                    {(~books['parent_asin'].isin(ratings['parent_asin'])).sum()}")

    merged = books[books["n_editions"] > 1]
    print(f"\nСклеенных карточек: {len(merged):,}, в них изданий: {merged['n_editions'].sum():,}")
    print("5 примеров (было — оценок у главного издания до склейки, стало — после):")
    sample = merged.sample(5, random_state=0)
    for _, b in sample.iterrows():
        was = int(before_merge.get(b["parent_asin"], 0))
        print(f"  {b['title'][:60]:60}  изданий {b['n_editions']:>2}  было {was:>5}  стало {b['n_ratings']:>5}")

    print(f"\nКниг без автора, приклеенных к группе с автором: {len(attached):,}. 5 примеров:")
    for _, a in attached.sample(min(5, len(attached)), random_state=0).iterrows():
        print(f"  {a['title'][:60]:60}  -> группа «{a['group'][:60]}»")

    print("\nЗаполненность новых полей:")
    for col in ["year", "language", "format", "isbn13", "cat2", "cat3", "onboarding_section"]:
        print(f"  {col:20} {books[col].notna().mean():6.1%}")
    no_text = books["features"].map(len) == 0
    print(f"  text только из названия и категорий (нет features): {no_text.mean():.1%}")
    print(f"  длина text: медиана {books['text'].str.len().median():.0f}, "
          f"обрезано до {TEXT_MAX_CHARS}: {(books['text'].str.len() >= TEXT_MAX_CHARS - 50).mean():.1%}")

    print(f"\nРазделы онбординга ({len(onboarding)}):")
    sec = books["onboarding_section"].value_counts()
    for name, n in sec.items():
        print(f"  {name:40} {n:>7,}")
    print(f"  {'— без раздела онбординга —':40} {books['onboarding_section'].isna().sum():>7,}")

    print(f"\nСохранено: {BOOKS_OUT.name} ({BOOKS_OUT.stat().st_size / 1e6:.0f} МБ), "
          f"{RATINGS_OUT.name} ({RATINGS_OUT.stat().st_size / 1e6:.0f} МБ), {FUNNEL_OUT.name}")


if __name__ == "__main__":
    main()
