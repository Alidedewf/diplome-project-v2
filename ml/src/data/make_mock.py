"""Тестовые данные для фронтенда: shared/mock/books_sample.json из books_clean.parquet.

Отбор: топ-12 книг каждого раздела онбординга по числу оценок, только с обложкой и автором.

Запуск из папки ml/:
    uv run python src/data/make_mock.py
"""

import json
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
BOOKS = ROOT / "data" / "processed" / "books_clean.parquet"
OUT = ROOT / "shared" / "mock" / "books_sample.json"

PER_SECTION = 12
ANNOTATION_MAX = 700
NOTE = ("Тестовые данные для фронтенда: топ-12 книг каждого раздела онбординга из books_clean "
        "(Amazon Reviews 2023). Сгенерировано скриптом, не редактировать вручную.")


def annotation(features) -> str:
    """Аннотация — features (см. решения.md, 1.3), обрезанная по слову до ANNOTATION_MAX символов с «…»."""
    text = re.sub(r"\s+", " ", " ".join(features)).strip()
    if len(text) <= ANNOTATION_MAX:
        return text
    cut = text[:ANNOTATION_MAX - 1]
    if text[ANNOTATION_MAX - 1] != " ":  # отрезали посреди слова — убираем его хвост
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip() + "…"


def main() -> None:
    books = pd.read_parquet(BOOKS, columns=[
        "parent_asin", "title", "author", "year", "onboarding_section", "cat3",
        "image", "average_rating", "n_ratings", "features",
    ])

    sections = books["onboarding_section"].value_counts()
    eligible = books[books["onboarding_section"].notna() & books["image"].notna() & books["author"].notna()]
    top = (eligible.sort_values("n_ratings", ascending=False)
           .groupby("onboarding_section", sort=False).head(PER_SECTION)
           .sort_values("n_ratings", ascending=False))

    def nullable(v):
        return None if pd.isna(v) else v

    data = {
        "note": NOTE,
        "sections": [{"name": name, "books": int(n)} for name, n in sections.items()],
        "books": [
            {
                "id": b.parent_asin,
                "title": b.title,
                "author": b.author,
                "year": None if pd.isna(b.year) else int(b.year),
                "section": b.onboarding_section,
                "subsection": nullable(b.cat3),
                "cover": b.image,
                "rating": None if pd.isna(b.average_rating) else round(float(b.average_rating), 1),
                "ratingsCount": int(b.n_ratings),
                "annotation": annotation(b.features),
            }
            for b in top.itertuples()
        ],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    per_section = top["onboarding_section"].value_counts()
    print(f"Сохранено: {OUT} ({OUT.stat().st_size / 1e3:.0f} КБ)")
    print(f"Разделов: {len(data['sections'])}, книг: {len(data['books'])} "
          f"(по {per_section.min()}–{per_section.max()} на раздел)")
    print(f"Без года: {sum(b['year'] is None for b in data['books'])}, "
          f"без подраздела: {sum(b['subsection'] is None for b in data['books'])}, "
          f"без аннотации: {sum(not b['annotation'] for b in data['books'])}")


if __name__ == "__main__":
    main()
