"""Сборка артефактов для рекомендаций на сайте — решения.md 3.8 (шаг S1).

То же, что финал E3 (3.3), но на дату сборки `cutoff`:
- ранжировщик учится на годе перед датой: признаки — по оценкам до cutoff − 1 год, ответы — оценки 4–5 за последний
  год; число деревьев — из E3;
- ItemKNN, ALS и статистика книг — по всем оценкам до cutoff (на сайте пользователи подставляются fold-in).

    uv run python src/serve/build.py --frac 0.2 --cutoff 2022-01-01   # как финал E3 — для проверки (check.py)
    uv run python src/serve/build.py --frac 1.0                       # для сайта: все оценки, дата — после последней

Результат — models/serve/<имя>/ (по умолчанию: e3-<доля>-<дата>): similarity.npz (ItemKNN), als_items.npy,
model_items.npy (id книг моделей по порядку), item_stats.parquet, tfidf.npz, allowed.npy (маска каталога по порядку
books_clean), books.parquet (автор, год, разделы), ranker.cbm, meta.json; item_neighbors.parquet — соседи ItemKNN по
книгам (book_id, neighbor_id, score, топ-20) для «Похожих» и «Потому что вам понравилась» на бэкенде.
"""

import os

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import argparse
import json
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import optuna
import pandas as pd
import scipy.sparse as sp
from rectools import Columns

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
warnings.filterwarnings("ignore")
from cf.models import SEED, fit_model
from cf.tune import STORAGE, best_params
from content.embeddings import catalog, load_books
from content.recommend import recommend, tfidf_vectors
from eval.coldstart import truncate_history
from eval.data import MIN_TRAIN_RATINGS, first_seen, known_at, load_ratings, subsample_users
from eval.metrics import eval_users
from eval.search import informative
from hybrid import candidates, ranker

U, I = Columns.User, Columns.Item
ROOT = Path(__file__).resolve().parents[3]
MODELS = ROOT / "models" / "serve"
K_LIST = 100
N_PROFILE = {"tfidf": 3, "e5": 1}   # E3
SOURCES = ["knn", "tfidf", "e5", "als"]  # E3: ALS добавляет +34% попаданий в кандидатах
TREES = 389                         # E3, «известные на дату»
M_WR = 20.0
N_NEIGHBORS = 20
KNN_K = 100   # ablation.py: K = 100 вместо подобранных 565 — разница в пределах ДИ, матрица сходства в ~5 раз меньше


def neighbors(sim: sp.csr_matrix, items: np.ndarray, skip: set[str], k: int = N_NEIGHBORS) -> pd.DataFrame:
    """Топ-k соседей каждой книги по сходству ItemKNN (строка матрицы — «кто оценил эту, оценил и эти»), без самой
    книги и без книг из skip (1–4 оценки — то же правило, что для рекомендаций)."""
    bad = np.isin(items, list(skip))
    src, dst, val = [], [], []
    for r in range(sim.shape[0]):
        if bad[r]:
            continue
        lo, hi = sim.indptr[r], sim.indptr[r + 1]
        cols, data = sim.indices[lo:hi], sim.data[lo:hi]
        keep = (cols != r) & ~bad[cols] & (data > 0)
        cols, data = cols[keep], data[keep]
        top = np.argsort(-data, kind="stable")[:k]
        src.append(np.full(len(top), r)); dst.append(cols[top]); val.append(data[top])
    src, dst, val = np.concatenate(src), np.concatenate(dst), np.concatenate(val)
    return pd.DataFrame({"book_id": items[src], "neighbor_id": items[dst], "score": val.astype(np.float32)})


def lists_for(tr, users, best, ctx, mask):
    """Топ-100 всех источников для users (как в 08_hybrid), без книг с 1–4 оценками в tr."""
    knn, ds_knn = fit_model("knn", best["knn"], tr)
    als = fit_model("als", best["als"], tr)
    out = {"knn": knn.recommend(users, ds_knn, k=K_LIST, filter_viewed=True, on_unsupported_targets="ignore"),
           "als": als[0].recommend(users, als[1], k=K_LIST, filter_viewed=True, on_unsupported_targets="ignore")}
    for s, key in [("tfidf", "X_tfidf"), ("e5", "E5")]:
        out[s] = recommend(ctx[key], ctx["ids_all"], tr, users, k=K_LIST, allowed=mask,
                           profile_from=truncate_history(tr, users, N_PROFILE[s]))
    return {s: candidates.drop_survivors(lst, tr) for s, lst in out.items()}, (knn, ds_knn), als


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frac", type=float, default=1.0, help="доля пользователей (как subsample_users; 1 — все)")
    ap.add_argument("--cutoff", type=str, default=None, help="дата сборки; по умолчанию — день после последней оценки")
    ap.add_argument("--rank-users", type=int, default=50_000, help="сколько пользователей для обучения ранжировщика")
    ap.add_argument("--name", type=str, default=None)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    t_all = time.time()
    log = lambda msg: print(f"[{time.time() - t_all:6.0f} с] {msg}", flush=True)

    ratings = load_ratings()
    first = first_seen(ratings)
    data = subsample_users(ratings, a.frac, seed=SEED)
    del ratings
    dt = data[Columns.Datetime]
    cutoff = pd.Timestamp(a.cutoff) if a.cutoff else (dt.max() + pd.Timedelta(days=1)).normalize()
    data = data[dt < cutoff]
    t_rank = cutoff - pd.DateOffset(years=1)
    log(f"оценок до {cutoff.date()}: {len(data):,}; ранжировщик — признаки до {t_rank.date()}, ответы — последний год")

    books = load_books(["parent_asin", "author", "year", "cat2", "cat3", "text", "features", "categories"])
    ids_all = books["parent_asin"].to_numpy()
    X_tfidf, _ = tfidf_vectors(books["text"])
    ctx = {"X_tfidf": X_tfidf, "E5": np.asarray(catalog("e5-base")), "ids_all": ids_all}
    best = {k: best_params(optuna.load_study(study_name=k, storage=f"sqlite:///{STORAGE}")) for k in ["knn", "als"]}
    best["knn"]["K"] = KNN_K
    log("каталог и векторы загружены")

    # 1. Ранжировщик — на годе перед датой (как обучение на валидации в E3)
    tr, part = data[data[Columns.Datetime] < t_rank], data[data[Columns.Datetime] >= t_rank]
    users = eval_users(tr, part)
    if len(users) > a.rank_users:
        users = np.sort(np.random.default_rng(SEED).choice(users, a.rank_users, replace=False))
    mask = informative(books) & known_at(ids_all, first, t_rank)
    lists, _, als = lists_for(tr, users, best, ctx, mask)
    log(f"кандидаты для ранжировщика: {len(users):,} пользователей")
    cands = candidates.build(lists, tr, users, books, ctx, t_rank, N_PROFILE, als=als, sources=SOURCES, m_wr=M_WR)
    cands = candidates.add_labels(cands, part)
    recall = candidates.recall_of_candidates(cands, part, users)
    log(f"признаки: {len(cands):,} пар, попаданий в кандидатах {recall:.1%}")
    model = ranker.fit(cands, users, iterations=TREES)
    cols = list(model.feature_names_)
    del cands, lists, als, tr, part
    log("ранжировщик обучен")

    # 2. Модели для сайта — на всех оценках до даты
    knn, ds = fit_model("knn", best["knn"], data)
    als, ds_als = fit_model("als", best["als"], data)
    model_items = ds.item_id_map.external_ids.astype(str)
    assert (ds_als.item_id_map.external_ids.astype(str) == model_items).all()
    stats, c = candidates.item_stats(data, cutoff, M_WR)
    log("ItemKNN, ALS и статистика книг — по всем оценкам")

    name = a.name or f"e3-{a.frac:g}-{cutoff.date()}"
    out = MODELS / name
    out.mkdir(parents=True, exist_ok=True)
    sp.save_npz(out / "similarity.npz", knn.model.similarity.tocsr().astype(np.float32))
    itf = als.model.item_factors
    np.save(out / "als_items.npy", np.asarray(itf.to_numpy() if hasattr(itf, "to_numpy") else itf, np.float32))
    np.save(out / "model_items.npy", model_items)
    stats.to_parquet(out / "item_stats.parquet")
    nb = neighbors(knn.model.similarity.tocsr(), model_items, set(stats.index[stats["i_n"] < MIN_TRAIN_RATINGS]))
    nb.to_parquet(out / "item_neighbors.parquet", index=False)
    log(f"соседи ItemKNN: {nb['book_id'].nunique():,} книг, {len(nb):,} пар")
    sp.save_npz(out / "tfidf.npz", X_tfidf)
    np.save(out / "allowed.npy", informative(books) & known_at(ids_all, first, cutoff))
    books[["parent_asin", "author", "year", "cat2", "cat3"]].to_parquet(out / "books.parquet", index=False)
    model.save_model(str(out / "ranker.cbm"))
    meta = {"name": name, "cutoff": str(cutoff.date()), "ranker_cutoff": str(t_rank.date()), "frac": a.frac,
            "ratings": int(len(data)), "users": int(data[U].nunique()), "model_items": int(len(model_items)),
            "rank_users": int(len(users)), "candidate_recall": recall, "trees": TREES, "features": cols,
            "sources": SOURCES, "n_profile": N_PROFILE, "k_list": K_LIST, "m_wr": M_WR, "mean_rating": c,
            "params": best, "e5": "e5-base", "built_at": time.strftime("%Y-%m-%d %H:%M"),
            "seconds": round(time.time() - t_all)}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    log(f"готово → {out}")


if __name__ == "__main__":
    main()
