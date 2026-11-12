"""E6: обучающая выборка для ученика (быстрая модель на разметке Claude), решения.md 3.6.

random — 1000 отзывов (по 500 на художку и нон-фикшн) с теми же квотами, что и эталон (sample.py, × 5): звёзды
         5/4/3/2/1 = 150/125/100/60/65 на тип, среди 4–5★ половина — смешанные; книги с ≥ 20 отзывами, по отзыву на
         книгу, 2–12 предложений. Книги эталона (все 200, обе половины) исключены целиком — чтобы другие отзывы на ту
         же книгу не попали в обучение.
boost  — добор предложений с редкими аспектами по ключевым словам (source = keyword_boost): из тех же групп строк,
         кроме уже взятых отзывов и книг эталона.

    uv run python src/reviews/train_sample.py random
    uv run python src/reviews/train_sample.py boost --aspects delivery pace depth --per 150

Результат — data/processed/reviews_train/sentences.csv (разметка заполняется отдельно, см. README там же).
"""

import argparse
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reviews.aspects import book_type
from reviews.sample import MIN_REVIEWS, MIXED, PER_TYPE
from reviews.sentences import split as sentences

ROOT = Path(__file__).resolve().parents[3]
REVIEWS = ROOT / "data" / "processed" / "reviews_top50.parquet"
GOLD = ROOT / "data" / "processed" / "reviews_gold"
OUT = ROOT / "data" / "processed" / "reviews_train"
SEED = 7
SCALE = 5
N_GROUPS = 10
COLS = ["review_id", "source", "тип", "звёзды", "book_id", "№", "предложение",
        "аспект", "тональность", "аспект_2", "тональность_2", "сомнение"]

# Ключевые слова для добора редких аспектов (регулярки по предложению; тип книги — какой аспект допустим)
BOOST = {
    "delivery": ("both", r"(?i)\b(arriv\w*|shipp\w*|deliver\w*|seller|packag\w*|damaged|came (in|with)|condition)\b"),
    "pace": ("fiction", r"(?i)\b(pac(e|ed|ing)|slow\w*|drag\w*|fast[- ]moving|page[- ]turner|bogged)\b"),
    "ending": ("fiction", r"(?i)\b(ending|ended|cliffhanger|conclusion|last (few )?chapters?|finale)\b"),
    "world": ("fiction", r"(?i)\b(world[- ]?building|setting|atmospher\w*|the world)\b"),
    "depth": ("nonfiction", r"(?i)\b(superficial|in[- ]depth|shallow|thorough\w*|detail\w*|scratch\w* the surface)\b"),
    "accuracy": ("nonfiction", r"(?i)\b(accura\w*|inaccura\w*|errors?|mistakes?|wrong|research\w*|facts?|sources?)\b"),
    "relevance": ("nonfiction", r"(?i)\b(outdated|out of date|dated|up[- ]to[- ]date|current|old information|timeless)\b"),
    "author_view": ("nonfiction", r"(?i)\b(bias\w*|agenda|political|preach\w*|opinion\w*|perspective|viewpoint)\b"),
    "editing": ("both", r"(?i)\b(typos?|editing|edited|editor|proofread\w*|grammar\w*|spelling)\b"),
    "illustrations": ("both", r"(?i)\b(illustrat\w*|pictures?|photos?|drawings?|artwork|art)\b"),
    "edition": ("both", r"(?i)\b(paperback|hardcover|binding|print(ed)?|font|kindle|audio\w*|narrat\w*|pages fell)\b"),
}


def book_counts() -> set:
    t = pq.read_table(REVIEWS, columns=["book_id"], read_dictionary=["book_id"])
    vc = pc.value_counts(t["book_id"].combine_chunks())
    cnt = pd.Series(vc.field("counts").to_numpy(), index=vc.field("values").to_pylist())
    return set(cnt.index[cnt >= MIN_REVIEWS])


def load(rng) -> pd.DataFrame:
    gold_books = set(pd.read_parquet(GOLD / "reviews.parquet", columns=["book_id"])["book_id"])
    ok = book_counts() - gold_books
    books = pd.read_parquet(ROOT / "data" / "processed" / "books_clean.parquet",
                            columns=["parent_asin", "cat2", "cat3"]).set_index("parent_asin")
    books["type"] = [book_type(a, c) for a, c in zip(books["cat2"], books["cat3"])]
    f = pq.ParquetFile(REVIEWS)
    groups = rng.choice(f.num_row_groups, N_GROUPS, replace=False)
    d = pd.concat([f.read_row_group(int(g), columns=["book_id", "rating", "text", "user_id"]).to_pandas()
                   for g in groups], ignore_index=True)
    d = d[d["book_id"].isin(ok)].join(books[["type"]], on="book_id")
    d["key"] = d["user_id"] + "|" + d["book_id"]
    print(f"группы {sorted(groups.tolist())}: {len(d)} отзывов, книг вне эталона {d['book_id'].nunique()}")
    return d


def rows_of(s: pd.DataFrame, source: str, start: int) -> list[dict]:
    rows = []
    for i, r in enumerate(s.itertuples(), start):
        rid = f"t{i:05d}"
        for k, sent in enumerate(r.sents, 1):
            if source == "keyword_boost" and k != r.k:
                continue
            rows.append({"review_id": rid, "source": source, "тип": "художка" if r.type == "fiction" else "нон-фикшн",
                         "звёзды": r.rating, "book_id": r.book_id, "№": k, "предложение": sent,
                         "аспект": "", "тональность": "", "аспект_2": "", "тональность_2": "", "сомнение": "",
                         "key": r.key})
    return rows


def cmd_random():
    rng = np.random.default_rng(SEED)
    d = load(rng)
    d["mixed"] = d["text"].str.contains(MIXED)
    picked = []
    for kind in ["fiction", "nonfiction"]:
        for stars, n in PER_TYPE.items():
            n *= SCALE
            x = d[(d["type"] == kind) & (d["rating"] == stars)].drop_duplicates("book_id")
            x = x.sample(min(len(x), 4 * n), random_state=SEED)          # запас: часть отсеется по длине
            x["sents"] = x["text"].map(sentences)
            x = x[x["sents"].map(len).between(2, 12)]
            if stars >= 4:
                m = x[x["mixed"]].head(n // 2 + n % 2)
                picked += [m, x[~x["mixed"]].head(n // 2)]
            else:
                picked.append(x.head(n))
    s = pd.concat(picked).drop_duplicates("book_id").reset_index(drop=True)
    out = pd.DataFrame(rows_of(s, "random", 1))
    OUT.mkdir(parents=True, exist_ok=True)
    out.drop(columns="key").to_csv(OUT / "sentences.csv", index=False, encoding="utf-8-sig")
    out[["review_id", "key"]].drop_duplicates().to_csv(OUT / "keys.csv", index=False)
    print(f"отзывов {len(s)}, предложений {len(out)}")
    print(s.groupby(["type", "rating"]).size().unstack().to_string())
    print(f"смешанных среди 4–5★: {s.loc[s['rating'] >= 4, 'mixed'].mean():.0%}")


def cmd_boost(aspects: list[str], per: int):
    rng = np.random.default_rng(SEED)
    d = load(rng)
    cur = pd.read_csv(OUT / "sentences.csv", encoding="utf-8-sig", keep_default_na=False)
    keys = pd.read_csv(OUT / "keys.csv")
    d = d[~d["key"].isin(set(keys["key"]))]
    have = set(cur["предложение"])
    start = int(cur["review_id"].str[1:].astype(int).max()) + 1
    add = []
    for a in aspects:
        kind, pat = BOOST[a]
        rx = re.compile(pat)
        x = d if kind == "both" else d[d["type"] == kind]
        x = x[x["text"].str.contains(pat)].sample(frac=1, random_state=SEED)
        got = []
        for r in x.itertuples():
            ss = sentences(r.text)
            hits = [k for k, s in enumerate(ss, 1) if rx.search(s) and s not in have and 15 <= len(s) <= 400]
            if hits:
                k = hits[int(rng.integers(len(hits)))]
                have.add(ss[k - 1])
                got.append({"book_id": r.book_id, "rating": r.rating, "type": r.type, "key": r.key,
                            "sents": ss, "k": k})
            if len(got) >= per:
                break
        g = pd.DataFrame(got)
        add += rows_of(g, "keyword_boost", start)
        start += len(g)
        d = d[~d["key"].isin(set(g["key"]))]
        print(f"{a}: +{len(g)} предложений")
    add = pd.DataFrame(add)
    out = pd.concat([cur, add.drop(columns="key")], ignore_index=True)
    out.to_csv(OUT / "sentences.csv", index=False, encoding="utf-8-sig")
    pd.concat([keys, add[["review_id", "key"]].drop_duplicates()]).to_csv(OUT / "keys.csv", index=False)
    print(f"итого предложений {len(out)}, из них keyword_boost {(out['source'] == 'keyword_boost').sum()}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["random", "boost"])
    ap.add_argument("--aspects", nargs="*", default=[])
    ap.add_argument("--per", type=int, default=150)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    cmd_random() if a.cmd == "random" else cmd_boost(a.aspects, a.per)


if __name__ == "__main__":
    main()
