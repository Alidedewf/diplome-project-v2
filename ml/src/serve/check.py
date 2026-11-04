"""Проверка рекомендаций сайта (решения.md 3.8, шаг S2): сервис для одного пользователя = пакетный E3.

На артефактах, собранных как финал E3 (`build.py --frac 0.2 --cutoff 2022-01-01`), берутся случайные пользователи
теста; их история (обучение + валидация) подаётся в Recommender по одному, как с сайта. Сравнение с пакетным расчётом
(те же модули, что в 08_hybrid) на тех же пользователях: совпадение топ-10, NDCG@10 на тесте, время.

    uv run python src/serve/check.py models/serve/e3-0.2-2022-01-01 --users 500
"""

import argparse
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from rectools import Columns

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
warnings.filterwarnings("ignore")
from cf.models import SEED
from eval.data import load_ratings, subsample_users, time_split
from eval.metrics import eval_users, evaluate
from hybrid import blend, candidates, ranker
from serve.build import lists_for
from serve.recommender import Recommender

U, I = Columns.User, Columns.Item


def events_of(tr: pd.DataFrame) -> dict[str, list[dict]]:
    ev = {}
    for u, i, r, at in zip(tr[U].astype(str), tr[I].astype(str), tr["rating"], tr[Columns.Datetime]):
        ev.setdefault(u, []).append({"bookId": i, "kind": "rating", "value": int(r), "at": at.isoformat()})
    return ev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", type=Path)
    ap.add_argument("--users", type=int, default=500)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    rec = Recommender(a.path)
    meta = rec.meta
    cutoff = pd.Timestamp(meta["cutoff"])
    r = load_ratings()
    sub = subsample_users(r, meta["frac"], seed=SEED)
    del r
    train, val, test = time_split(sub, val_start=cutoff - pd.DateOffset(years=1), test_start=cutoff)
    train_full = pd.concat([train, val])
    users = eval_users(train_full, test)
    users = np.sort(np.random.default_rng(SEED).choice(users, min(a.users, len(users)), replace=False))
    hist = train_full[train_full[U].astype(str).isin(set(users))]
    print(f"Пользователей: {len(users):,} из теста; история — до {cutoff.date()}")

    # Пакетный расчёт (как в 08_hybrid) — модели заново на train_full, ранжировщик — из артефактов
    import optuna
    from cf.tune import STORAGE, best_params
    best = {k: best_params(optuna.load_study(study_name=k, storage=f"sqlite:///{STORAGE}")) for k in ["knn", "als"]}
    t0 = time.time()
    lists, _, als = lists_for(train_full, users, best, rec.ctx, rec.allowed)
    c = candidates.build(lists, train_full, users, rec.books, rec.ctx, cutoff, rec.n_profile, als=als,
                         sources=meta["sources"], m_wr=meta["m_wr"])
    batch = blend.top_k(c, ranker.predict(rec.ranker, c))
    print(f"Пакетный расчёт: {time.time() - t0:.0f} с")

    # Сервис — по одному пользователю
    ev = events_of(hist)
    rows, times = [], []
    for u in users:
        out = rec.recommend(ev[u], n=10, explain=10)
        times.append(out["timing_ms"])
        rows += [(u, x["bookId"], k + 1) for k, x in enumerate(out["items"])]
    online = pd.DataFrame(rows, columns=[U, I, Columns.Rank])

    b = batch.groupby(U)[I].apply(list)
    o = online.groupby(U)[I].apply(list)
    overlap = np.mean([len(set(b.get(u, [])) & set(o.get(u, []))) / 10 for u in users])
    same = np.mean([b.get(u, []) == o.get(u, []) for u in users])
    print(f"Совпадение топ-10: {overlap:.1%} книг, одинаковый порядок у {same:.1%} пользователей")
    for name, reco in [("пакетный", batch), ("сервис", online)]:
        t, _ = evaluate(reco, train_full, test, users)
        print(f"NDCG@10 {name}: " + " / ".join(f"{s} {v:.4f}" for s, v in zip(t["разрез"], t["NDCG@10"])))
    tm = pd.DataFrame(times)
    print("Время сервиса, мс (медиана / 90-й перцентиль):")
    print(pd.DataFrame({"медиана": tm.median(), "p90": tm.quantile(0.9)}).round(1).to_string())


if __name__ == "__main__":
    main()
