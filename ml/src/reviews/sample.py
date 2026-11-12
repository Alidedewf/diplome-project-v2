"""E6, шаг 4: выборка отзывов для ручной разметки → CSV по предложениям (решения.md 3.6).

200 отзывов (по 100 на художку и нон-фикшн, ~1200 предложений — больше автору не разметить), только книги с ≥ 20
отзывами (кому пойдёт сводка), по звёздам — с перевесом критики против реального распределения (иначе минусов в
эталоне будет единицы); среди 4–5★ не меньше половины — смешанные (but / however / although…).

    uv run python src/reviews/sample.py      → data/processed/reviews_gold/sentences.csv (+ reviews.parquet)
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reviews.sentences import split as sentences
from reviews.aspects import book_type

ROOT = Path(__file__).resolve().parents[3]
REVIEWS = ROOT / "data" / "processed" / "reviews_top50.parquet"
OUT = ROOT / "data" / "processed" / "reviews_gold"
SEED = 42
MIN_REVIEWS = 20
PER_TYPE = {5: 30, 4: 25, 3: 20, 2: 12, 1: 13}   # 100 отзывов на тип
MIXED = r"(?i)\b(but|however|although|though|except|unfortunately|wish)\b"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    rng = np.random.default_rng(SEED)
    t = pq.read_table(REVIEWS, columns=["book_id"], read_dictionary=["book_id"])
    vc = pc.value_counts(t["book_id"].combine_chunks())
    cnt = pd.Series(vc.field("counts").to_numpy(), index=vc.field("values").to_pylist())
    del t
    books = pd.read_parquet(ROOT / "data" / "processed" / "books_clean.parquet",
                            columns=["parent_asin", "title", "author", "cat2", "cat3"]).set_index("parent_asin")
    books["type"] = [book_type(a, c) for a, c in zip(books["cat2"], books["cat3"])]
    ok_books = set(cnt.index[cnt >= MIN_REVIEWS])

    f = pq.ParquetFile(REVIEWS)
    groups = rng.choice(f.num_row_groups, 12, replace=False)
    d = pd.concat([f.read_row_group(int(g)).to_pandas() for g in groups], ignore_index=True)
    d = d[d["book_id"].isin(ok_books)].join(books, on="book_id", rsuffix="_book")
    d["sents"] = d["text"].map(sentences)
    d["n_sent"] = d["sents"].map(len)
    d = d[d["n_sent"].between(2, 12)]   # одно предложение — нечего делить; длинные съедят бюджет разметки
    d["mixed"] = d["text"].str.contains(MIXED)

    picked = []
    for kind in ["fiction", "nonfiction"]:
        for stars, n in PER_TYPE.items():
            x = d[(d["type"] == kind) & (d["rating"] == stars)].drop_duplicates("book_id")
            if stars >= 4:   # половина — смешанные
                m = x[x["mixed"]].sample(n // 2 + n % 2, random_state=SEED)
                rest = x[~x.index.isin(m.index)].sample(n // 2, random_state=SEED)
                picked += [m, rest]
            else:
                picked.append(x.sample(n, random_state=SEED))
    s = pd.concat(picked).drop_duplicates("book_id").reset_index(drop=True)
    s["review_id"] = [f"r{i + 1:03d}" for i in range(len(s))]
    OUT.mkdir(parents=True, exist_ok=True)
    s.drop(columns=["sents"]).to_parquet(OUT / "reviews.parquet", index=False)

    rows = []
    for r in s.itertuples():
        for k, sent in enumerate(r.sents, 1):
            rows.append({"review_id": r.review_id, "тип": "художка" if r.type == "fiction" else "нон-фикшн",
                         "звёзды": r.rating, "книга": f"{r.title_book} — {r.author}" if k == 1 else "",
                         "отзыв": r.text if k == 1 else "", "№": k, "предложение": sent,
                         "аспект": "", "тональность": "", "аспект_2": "", "тональность_2": "", "исправление": ""})
    out = pd.DataFrame(rows)
    out.to_csv(OUT / "sentences.csv", index=False, encoding="utf-8-sig")
    print(f"отзывов {len(s)}, предложений {len(out)} → {OUT / 'sentences.csv'}")
    print(s.groupby(["type", "rating"]).size().unstack().to_string())
    print(f"смешанных среди 4–5★: {s.loc[s['rating'] >= 4, 'mixed'].mean():.0%}; "
          f"предложений на отзыв: медиана {s['n_sent'].median():.0f}")


if __name__ == "__main__":
    main()
