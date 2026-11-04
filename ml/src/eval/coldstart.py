"""Холодный старт (эксперимент E2, решения.md 3.7): качество в зависимости от числа оценок пользователя.

Способ — усечение истории: берутся пользователи, у которых в обучении не меньше max(N) оценок, и их история
обрезается до N последних (по времени). Остальные пользователи остаются с полной историей — модель учится как обычно,
а «новичок с N оценками» — это те же самые люди при каждом N. Так кривые для разных N сравнимы между собой:
меняется только длина истории, а не состав пользователей (при корзинах по фактическому числу оценок в корзине
«1 оценка» и «20+» были бы разные люди с разными вкусами и активностью).
"""

import numpy as np
import pandas as pd
from rectools import Columns

from eval.metrics import eval_users


def cohort(train: pd.DataFrame, part: pd.DataFrame, min_ratings: int) -> np.ndarray:
    """Пользователи для проверки (eval_users), у которых в обучении не меньше min_ratings оценок."""
    counts = train[Columns.User].astype(str).value_counts()
    return np.intersect1d(eval_users(train, part), counts[counts >= min_ratings].index.to_numpy())


def truncate_history(train: pd.DataFrame, users: np.ndarray, n: int | None) -> pd.DataFrame:
    """Обучение, в котором у users осталось n последних оценок (None — вся история); у остальных — без изменений."""
    if n is None:
        return train
    target = train[Columns.User].astype(str).isin(set(users))
    last = (train[target].sort_values(Columns.Datetime, kind="stable")
            .groupby(Columns.User, observed=True).tail(n))
    return pd.concat([train[~target], last]).sort_index()
