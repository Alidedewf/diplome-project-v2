"""Цена упрощений двухэтапной схемы для сайта — решения.md 3.8 (шаг S1), на тех же данных и разбиении, что E3.

Каталог «известные на дату»; ранжировщик учится на всей валидации с числом деревьев из E3 (389), проверка — на тесте.
Варианты: как в E3 / без TF-IDF (ни кандидатов, ни признаков) / ItemKNN с обрезкой до K соседей / оба упрощения.
Разница с E3 — парный bootstrap по пользователям теста. Результат — reports/metrics/hybrid_ablation.csv.

    uv run python src/hybrid/ablation.py
"""

import os

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import gc
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import optuna
import pandas as pd
from rectools import Columns

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
warnings.filterwarnings("ignore")
from cf.models import SEED, fit_model
from cf.tune import STORAGE, best_params
from content.embeddings import catalog, load_books
from content.recommend import recommend, tfidf_vectors
from eval.coldstart import truncate_history
from eval.data import TEST_START, VAL_START, first_seen, known_at, load_ratings, subsample_users, time_split
from eval.metrics import eval_users, evaluate, paired_bootstrap
from eval.search import informative
from hybrid import blend, candidates, ranker

U, I = Columns.User, Columns.Item
OUT = Path(__file__).resolve().parents[2] / "reports" / "metrics" / "hybrid_ablation.csv"
K_LIST = 100
N_PROFILE = {"tfidf": 3, "e5": 1}  # E3
TREES = 389  # E3, «известные»
TFIDF_COLS = ["tfidf_score", "tfidf_rank", "tfidf_sim"]
VARIANTS = [  # имя, K соседей ItemKNN (None — как в E3), с TF-IDF
    ("как в E3", None, True),
    ("без TF-IDF", None, False),
    ("ItemKNN K = 200", 200, True),
    ("ItemKNN K = 100", 100, True),
    ("без TF-IDF, ItemKNN K = 200", 200, False),
]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ratings = load_ratings()
    first = first_seen(ratings)
    sub = subsample_users(ratings, 0.2, seed=SEED)
    del ratings
    train, val, test = time_split(sub)
    train_full = pd.concat([train, val])
    users_val, users_test = eval_users(train, val), eval_users(train_full, test)

    books = load_books(["parent_asin", "author", "year", "cat2", "cat3", "text", "features", "categories"])
    ids_all = books["parent_asin"].to_numpy()
    allowed = informative(books)
    X_tfidf, _ = tfidf_vectors(books["text"])
    E5 = np.asarray(catalog("e5-base"))
    ctx = {"X_tfidf": X_tfidf, "E5": E5, "ids_all": ids_all}
    vectors = {"tfidf": X_tfidf, "e5": E5}
    study = lambda k: best_params(optuna.load_study(study_name=k, storage=f"sqlite:///{STORAGE}"))
    best = {k: study(k) for k in ["knn", "als"]}

    # Списки, общие для всех вариантов: ALS и content на val и test
    parts = {"val": (train, val, users_val, VAL_START), "test": (train_full, test, users_test, TEST_START)}
    base, als_m = {}, {}
    for name, (tr, part, users, cutoff) in parts.items():
        t0 = time.time()
        als = fit_model("als", best["als"], tr)
        als_m[name] = als
        L = {"als": als[0].recommend(users, als[1], k=K_LIST, filter_viewed=True, on_unsupported_targets="ignore")}
        mask = allowed & known_at(ids_all, first, cutoff)
        for s in ["tfidf", "e5"]:
            L[s] = recommend(vectors[s], ids_all, tr, users, k=K_LIST, allowed=mask,
                             profile_from=truncate_history(tr, users, N_PROFILE[s]))
        base[name] = {s: candidates.drop_survivors(lst, tr) for s, lst in L.items()}
        print(f"{name}: ALS и content — {time.time() - t0:.0f} с", flush=True)

    knn_cache, rows, per_user = {}, [], {}
    for vname, k_nn, with_tfidf in VARIANTS:
        t0 = time.time()
        sources = ["knn", "e5", "als"] + (["tfidf"] if with_tfidf else [])
        cands = {}
        for name, (tr, part, users, cutoff) in parts.items():
            key = (name, k_nn)
            if key not in knn_cache:
                p = dict(best["knn"], **({"K": k_nn} if k_nn else {}))
                knn, ds = fit_model("knn", p, tr)
                knn_cache[key] = candidates.drop_survivors(
                    knn.recommend(users, ds, k=K_LIST, filter_viewed=True, on_unsupported_targets="ignore"), tr)
            lists = {**base[name], "knn": knn_cache[key]}
            c = candidates.build(lists, tr, users, books, ctx, cutoff, N_PROFILE, als=als_m[name], sources=sources)
            if not with_tfidf:
                c = c.drop(columns=[x for x in TFIDF_COLS if x in c.columns])
            cands[name] = candidates.add_labels(c, part)
        model = ranker.fit(cands["val"], users_val, iterations=TREES)
        c = cands["test"]
        reco = blend.top_k(c, ranker.predict(model, c))
        t, pu = evaluate(reco, train_full, test, users_test)
        per_user[vname] = pu
        recall = candidates.recall_of_candidates(c, test, users_test)
        row = {"вариант": vname, **dict(zip(t["разрез"], t["NDCG@10"])), "попаданий в кандидатах": recall,
               "кандидатов на пользователя": len(c) / len(users_test), "с": round(time.time() - t0)}
        if vname != VARIANTS[0][0]:
            d = paired_bootstrap(pu["все"], per_user[VARIANTS[0][0]]["все"])
            row.update({"− E3": d["разница"], "ДИ low": d["low"], "ДИ high": d["high"]})
        rows.append(row)
        print(pd.DataFrame([row]).to_string(index=False), flush=True)
        del cands, c, model
        gc.collect()

    res = pd.DataFrame(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    res.to_csv(OUT, index=False)
    print(res.to_string(index=False))


if __name__ == "__main__":
    main()
