"""Оценка качества рекомендаций @k — решения.md, 3.1.

- Попадание — книга, оценённая в проверочной части на 4–5.
- Уже оценённые в обучении книги из рекомендаций исключаются (filter_viewed при recommend).
- Разрез по книгам: «все»; «старые» — у книги есть оценки в обучении; «новые» — нет.
  В разрезе участвуют пользователи, у которых есть хотя бы одно попадание этого типа; список рекомендаций один и тот же.
- NDCG, Recall, Precision — по разрезам; Coverage и Novelty — по всем рекомендациям.
- NDCG нормируется на достижимый максимум (divide_by_achievable): у пользователя с 2 попаданиями идеал — 2 попадания на первых местах.
- Доверительные интервалы — bootstrap по пользователям.
"""

import numpy as np
import pandas as pd
from rectools import Columns
from rectools.metrics import NDCG, CatalogCoverage, MeanInvUserFreq, Precision, Recall, calc_metrics

from eval.data import HIT_RATING

K = 10
SLICES = ("все", "старые", "новые")


def eval_users(train: pd.DataFrame, part: pd.DataFrame) -> np.ndarray:
    """Пользователи для проверки: есть попадание (4–5) в проверочной части и есть история в обучении.

    Пользователи без истории — это холодный старт (эксперименты E2, E4), коллаборативные модели им ничего не дадут.
    """
    hit_users = part.loc[part["rating"] >= HIT_RATING, Columns.User].astype(str).unique()
    return np.intersect1d(hit_users, train[Columns.User].astype(str).unique())


def _hits(train: pd.DataFrame, part: pd.DataFrame, users: np.ndarray) -> dict[str, pd.DataFrame]:
    hits = part[part["rating"] >= HIT_RATING]
    hits = pd.DataFrame({Columns.User: hits[Columns.User].astype(str), Columns.Item: hits[Columns.Item].astype(str)})
    hits = hits[hits[Columns.User].isin(users)].drop_duplicates()
    old = hits[Columns.Item].isin(set(train[Columns.Item].astype(str).unique()))
    return {"все": hits, "старые": hits[old], "новые": hits[~old]}


def evaluate(reco: pd.DataFrame, train: pd.DataFrame, part: pd.DataFrame, users: np.ndarray, k: int = K):
    """Метрики @k по разрезам «все / старые / новые».

    reco — рекомендации RecTools (user_id, item_id, rank) для users.
    Возвращает (таблица метрик, NDCG по пользователям для каждого разреза — для bootstrap).
    """
    reco = reco.assign(**{Columns.User: reco[Columns.User].astype(str), Columns.Item: reco[Columns.Item].astype(str)})
    reco = reco[reco[Columns.Rank] <= k]
    prev = pd.DataFrame({Columns.User: train[Columns.User].astype(str), Columns.Item: train[Columns.Item].astype(str)})
    catalog = prev[Columns.Item].unique()

    rows, per_user = [], {}
    for name, hits in _hits(train, part, users).items():
        ndcg = NDCG(k=k, divide_by_achievable=True)
        # Пользователь без рекомендаций (модель его не знает) получает 0, а не выпадает из среднего
        per_user[name] = ndcg.calc_per_user(reco, hits).reindex(hits[Columns.User].unique(), fill_value=0.0)
        metrics = calc_metrics({"recall": Recall(k=k), "precision": Precision(k=k)}, reco=reco[reco[Columns.User].isin(hits[Columns.User])],
                               interactions=hits)
        row = {"разрез": name, "пользователей": hits[Columns.User].nunique(),
               f"NDCG@{k}": per_user[name].mean(), f"Recall@{k}": metrics["recall"], f"Precision@{k}": metrics["precision"]}
        if name == "все":
            extra = calc_metrics({"coverage": CatalogCoverage(k=k, normalize=True), "novelty": MeanInvUserFreq(k=k)},
                                 reco=reco, prev_interactions=prev, catalog=catalog)
            row[f"Coverage@{k}"] = extra["coverage"]
            row[f"Novelty@{k}"] = extra["novelty"]
        rows.append(row)
    return pd.DataFrame(rows), per_user


def bootstrap_ci(per_user: pd.Series, n_boot: int = 1000, alpha: float = 0.05, seed: int = 42) -> tuple[float, float]:
    """Доверительный интервал для среднего по пользователям (перевыборка пользователей с возвращением)."""
    values = per_user.to_numpy()
    rng = np.random.default_rng(seed)
    means = np.array([values[rng.integers(0, len(values), len(values))].mean() for _ in range(n_boot)])
    return float(np.quantile(means, alpha / 2)), float(np.quantile(means, 1 - alpha / 2))


def paired_bootstrap(a: pd.Series, b: pd.Series, n_boot: int = 1000, alpha: float = 0.05, seed: int = 42) -> dict:
    """Разница средних a − b на одних и тех же пользователях: интервал и доля перевыборок, где a ≤ b.

    Если интервал не содержит 0 — разница между моделями не случайна.
    """
    users = a.index.union(b.index)
    diff = (a.reindex(users, fill_value=0.0) - b.reindex(users, fill_value=0.0)).to_numpy()
    rng = np.random.default_rng(seed)
    means = np.array([diff[rng.integers(0, len(diff), len(diff))].mean() for _ in range(n_boot)])
    return {"разница": float(diff.mean()), "low": float(np.quantile(means, alpha / 2)),
            "high": float(np.quantile(means, 1 - alpha / 2)), "p": float((means <= 0).mean())}


def with_ci(table: pd.DataFrame, per_user: dict[str, pd.Series], k: int = K) -> pd.DataFrame:
    """Добавляет к таблице evaluate() 95%-интервал для NDCG."""
    ci = [bootstrap_ci(per_user[s]) for s in table["разрез"]]
    return table.assign(**{f"NDCG@{k} 95% ДИ": [f"{lo:.4f}–{hi:.4f}" for lo, hi in ci]})
