"""Гибрид, способ 1 — смешивание по формуле (решения.md 3.3): итог = Σ wₘ · нормированный балл модели m.

Баллы моделей несравнимы (BM25-сумма у ItemKNN, косинус у content, звёзды у рейтинга) и у разных пользователей
распределены по-разному, поэтому их нормируют внутри пользователя — по месту в списке модели или min-max (выбор — на
валидации). Веса свои для корзин по числу оценок пользователя (по E2: ≤ 5 / 6–19 / 20+).

Быстрая проверка весов: кандидаты раскладываются в матрицу «пользователь × место» — сотни наборов весов за минуты.
"""

import itertools

import numpy as np
import pandas as pd
from rectools import Columns

U, I = Columns.User, Columns.Item
BUCKETS = [(1, 5, "≤ 5"), (6, 19, "6–19"), (20, None, "20+")]


def bucket_of(u_n: pd.Series) -> pd.Series:
    out = pd.Series("20+", index=u_n.index)
    for lo, hi, name in BUCKETS:
        if hi is not None:
            out[(u_n >= lo) & (u_n <= hi)] = name
    return out


def components(cands: pd.DataFrame, sources, method: str = "rank", k_list: int = 100) -> pd.DataFrame:
    """Нормированные баллы: c_<источник> для списков моделей и c_wr для взвешенного рейтинга; 0 — нет в списке.

    rank — 1 − (место − 1) / k_list (сумма таких баллов — счёт Борда); minmax — (балл − min) / (max − min) внутри
    пользователя по его списку. Рейтинг — по всем кандидатам пользователя тем же способом.
    """
    out = pd.DataFrame(index=cands.index)
    for s in sources:
        if method == "rank":
            out[f"c_{s}"] = (1 - (cands[f"{s}_rank"] - 1) / k_list).fillna(0)
        else:
            sc = cands[f"{s}_score"]
            g = sc.groupby(cands[U])
            lo, hi = g.transform("min"), g.transform("max")
            out[f"c_{s}"] = ((sc - lo) / (hi - lo).where(hi > lo, 1)).fillna(0)
    wr = cands["i_wr"]
    g = wr.groupby(cands[U])
    if method == "rank":
        n = g.transform("size")
        out["c_wr"] = 1 - (g.rank(ascending=False, method="first") - 1) / n
    else:
        lo, hi = g.transform("min"), g.transform("max")
        out["c_wr"] = (wr - lo) / (hi - lo).where(hi > lo, 1)
    return out.astype("float32")


def to_matrix(cands: pd.DataFrame, cols: list[str]):
    """(users, F[пользователь, кандидат, признак], hit[пользователь, кандидат], valid) — кандидаты в порядке таблицы."""
    users, u_idx = np.unique(cands[U].to_numpy(), return_inverse=True)
    pos = pd.Series(np.zeros(len(cands), int)).groupby(u_idx).cumcount().to_numpy()
    width = pos.max() + 1
    F = np.zeros((len(users), width, len(cols)), np.float32)
    F[u_idx, pos] = cands[cols].to_numpy(np.float32)
    hit = np.zeros((len(users), width), np.float32)
    hit[u_idx, pos] = cands["hit"].to_numpy()
    valid = np.zeros((len(users), width), bool)
    valid[u_idx, pos] = True
    return users, F, hit, valid


def ndcg_matrix(score: np.ndarray, hit: np.ndarray, valid: np.ndarray, n_rel: np.ndarray, k: int = 10) -> np.ndarray:
    """NDCG@k по пользователям, нормировка на достижимый максимум (min(n_rel, k) попаданий наверху) — как в eval.metrics."""
    s = np.where(valid, score, -np.inf)
    top = np.argpartition(-s, k, axis=1)[:, :k]
    order = np.take_along_axis(top, np.argsort(-np.take_along_axis(s, top, 1), axis=1, kind="stable"), 1)
    disc = 1 / np.log2(np.arange(2, k + 2))
    dcg = (np.take_along_axis(hit, order, 1) * disc).sum(1)
    idcg = np.cumsum(disc)[np.clip(n_rel, 1, k) - 1]
    return np.where(n_rel > 0, dcg / idcg, 0.0)


def simplex(n: int, step: float = 0.1) -> np.ndarray:
    m = round(1 / step)
    return np.array([c for c in itertools.product(range(m + 1), repeat=n) if sum(c) == m], np.float32) / m


def grid(F: np.ndarray, hit, valid, n_rel, weights: np.ndarray) -> np.ndarray:
    """Средняя NDCG@10 для каждого набора весов."""
    return np.array([ndcg_matrix(F @ w, hit, valid, n_rel).mean() for w in weights])


def top_k(cands: pd.DataFrame, score: np.ndarray, k: int = 10, max_per_author: int | None = None) -> pd.DataFrame:
    """Рекомендации RecTools (user_id, item_id, score, rank) по баллу; max_per_author — не больше стольких книг автора."""
    df = pd.DataFrame({U: cands[U].to_numpy(), I: cands[I].to_numpy(), Columns.Score: score,
                       "author": cands["author"].to_numpy()})
    df = df.sort_values([U, Columns.Score], ascending=[True, False], kind="stable")
    if max_per_author:
        a = df["author"].fillna(df[I])   # без автора — каждая книга сама по себе
        df = df[df.groupby([df[U], a]).cumcount() < max_per_author]
    df = df.groupby(U).head(k)
    df[Columns.Rank] = df.groupby(U).cumcount() + 1
    return df.drop(columns="author").reset_index(drop=True)
