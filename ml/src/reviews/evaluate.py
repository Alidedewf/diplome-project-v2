"""E6, шаг 5: сравнение подходов с эталоном и замер скорости (решения.md 3.6, 3.7 — E6).

    uv run python src/reviews/evaluate.py nli absa [llm] [--gold gold.csv] [--part отчёт] [--speed 1000]

Эталон — data/processed/reviews_gold/gold.csv (reviews/gold.py: предразметка Claude + 33 спорные строки, проверенные
автором, source = author). Метрики — по предложениям:
- аспект: accuracy (главный аспект = главному в эталоне), macro-F1 по аспектам; «мягкая» точность — главный
  предсказанный ∈ {аспект, аспект_2} эталона;
- тональность: accuracy и macro-F1 (pos / neg / neu) — по главному аспекту;
- пара аспект + тональность: accuracy;
- отдельно для смешанных отзывов (4–5★ с but / however / although…) и остальных, и на строках автора (контроль:
  эталон без проверки человеком — версия Claude); матрицы ошибок — в CSV.
Скорость — на N случайных отзывах из reviews_top50 (книги с ≥ 20 отзывами), без загрузки моделей.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from sklearn.metrics import confusion_matrix, f1_score

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reviews import absa
from reviews.aspects import book_type
from reviews.sample import MIXED
from reviews.sentences import split

ROOT = Path(__file__).resolve().parents[3]
GOLD = ROOT / "data" / "processed" / "reviews_gold"
OUT = ROOT / "ml" / "reports" / "metrics"


def metrics(g: pd.DataFrame, p: pd.DataFrame) -> dict:
    ga, pa = g["аспект"].to_numpy(), p["aspect"].to_numpy()
    gs, ps = g["тональность"].to_numpy(), p["sentiment"].to_numpy()
    soft = np.mean([x in (a, b) for x, a, b in zip(pa, ga, g["аспект_2"])])
    return {"n": len(g), "аспект acc": np.mean(pa == ga), "аспект мягкая acc": soft,
            "аспект macro-F1": f1_score(ga, pa, average="macro", zero_division=0),
            "тональность acc": np.mean(ps == gs),
            "тональность macro-F1": f1_score(gs, ps, average="macro", labels=["pos", "neg", "neu"], zero_division=0),
            "пара acc": np.mean((pa == ga) & (ps == gs))}


def speed_sample(n: int, seed: int = 0) -> tuple[list[str], list[str], int, list[int]]:
    f = pq.ParquetFile(ROOT / "data" / "processed" / "reviews_top50.parquet")
    rng = np.random.default_rng(seed)
    d = f.read_row_group(int(rng.integers(f.num_row_groups)), columns=["book_id", "text"]).to_pandas()
    d = d.sample(n, random_state=seed)
    books = pd.read_parquet(ROOT / "data" / "processed" / "books_clean.parquet",
                            columns=["parent_asin", "cat2", "cat3"]).set_index("parent_asin")
    kinds = [book_type(*books.loc[b, ["cat2", "cat3"]]) if b in books.index else "fiction" for b in d["book_id"]]
    sents, k, rid = [], [], []
    for j, (t, kind) in enumerate(zip(d["text"], kinds)):
        for s in split(t):
            sents.append(s)
            k.append(kind)
            rid.append(j)
    return sents, k, n, rid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("methods", nargs="+", choices=["nli", "absa", "llm"])
    ap.add_argument("--gold", default="gold.csv")
    ap.add_argument("--speed", type=int, default=1000, help="отзывов для замера скорости (0 — без замера)")
    ap.add_argument("--speed-llm", type=int, default=100, help="отзывов для замера скорости LLM (она медленнее)")
    ap.add_argument("--part", choices=["все", "подстройка", "отчёт"], default="отчёт",
                    help="половина эталона (split.csv); итоговые метрики — только «отчёт»")
    ap.add_argument("--tuned", action="store_true", help="NLI с параметрами из nli_params.json (tune_nli.py fit)")
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    g = pd.read_csv(GOLD / a.gold, encoding="utf-8-sig", keep_default_na=False)
    g = g.merge(pd.read_csv(GOLD / "split.csv", encoding="utf-8-sig"), on="review_id", how="left")
    if a.part != "все":
        g = g[g["часть"] == a.part].reset_index(drop=True)
    nli_kw = None
    if a.tuned:
        prm = json.loads((GOLD / "nli_params.json").read_text(encoding="utf-8"))
        nli_kw = {"hyps": prm["hyps"], "bias": prm["bias"]}
    rev = pd.read_parquet(GOLD / "reviews.parquet").set_index("review_id")
    g["смешанный"] = g["review_id"].map((rev["rating"] >= 4) & rev["text"].str.contains(MIXED, regex=True))
    author = [("автор", (g["source"] == "author").to_numpy())] if "source" in g else []
    kinds = ["fiction" if t == "художка" else "nonfiction" for t in g["тип"]]
    sents = g["предложение"].tolist()
    rows, cms = [], {}
    for m in a.methods:
        if m == "nli":
            pred, dt = absa.run_nli(sents, kinds, nli_kw)
        elif m == "absa":
            pred, dt = absa.run_absa(sents, kinds, nli_kw=nli_kw)
        else:
            from reviews import llm
            pred, dt = llm.run(sents, kinds, g["звёзды"].tolist(), g["review_id"].tolist())
        p = pd.DataFrame(pred)
        p.to_csv(OUT / f"reviews_pred_{m}{a.tag}.csv", index=False, encoding="utf-8-sig")
        for part, mask in [("все", np.ones(len(g), bool)), ("смешанные", g["смешанный"].to_numpy()),
                           ("остальные", ~g["смешанный"].to_numpy())] + author:
            rows.append({"подход": m, "срез": part, **metrics(g[mask], p[mask])})
        cms[m] = {"аспект": pd.crosstab(g["аспект"], p["aspect"]), "тональность": pd.crosstab(g["тональность"],
                                                                                           p["sentiment"])}
        for kind, cm in cms[m].items():
            cm.to_csv(OUT / f"reviews_cm_{m}_{'aspect' if kind == 'аспект' else 'sentiment'}{a.tag}.csv",
                      encoding="utf-8-sig")
        print(f"{m}: эталон ({a.part}) {len(g)} предложений — {dt:.1f} с")
        if a.speed:
            ss, kk, n, rid = speed_sample(a.speed if m != "llm" else a.speed_llm)
            if m == "nli":
                _, t = absa.run_nli(ss, kk, nli_kw)
            elif m == "absa":
                _, t = absa.run_absa(ss, kk, nli_kw=nli_kw)
            else:
                from reviews import llm
                _, t = llm.run(ss, kk, [5] * len(ss), rid)
            first = len(rows) - 3 - len(author)
            rows[first]["с на 1000 отзывов"] = t / n * 1000
            rows[first]["предложений в замере"] = len(ss)
            print(f"  скорость: {n} отзывов, {len(ss)} предложений — {t:.1f} с")
    res = pd.DataFrame(rows)
    res.to_csv(OUT / f"reviews_methods{a.tag}.csv", index=False, encoding="utf-8-sig")
    print(res.round(3).to_string(index=False))
    for m, c in cms.items():
        print(f"\n{m} — тональность (строки — эталон):\n{c['тональность'].to_string()}")


if __name__ == "__main__":
    main()
