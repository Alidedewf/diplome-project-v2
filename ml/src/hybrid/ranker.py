"""Гибрид, способ 2 — двухэтапная схема (решения.md 3.3): кандидаты от нескольких моделей → переранжирование CatBoost.

Ранжировщик учится на валидации: признаки — по обучению (до 2021), ответы — оценки 4–5 в 2021. Подбор и сравнение —
на разных пользователях валидации. На тесте признаки считаются по обучению + валидации (до 2022), ранжировщик —
обученный на всей валидации; оценки 2022–2023 в обучение не попадают ни в каком виде.
"""

import numpy as np
import pandas as pd
from catboost import CatBoostRanker, Pool
from rectools import Columns

U = Columns.User
CAT = ["section"]


def feature_columns(cands: pd.DataFrame) -> list[str]:
    skip = {U, Columns.Item, "hit", "author"}
    return [c for c in cands.columns if c not in skip]


def _pool(cands: pd.DataFrame, cols: list[str]) -> Pool:
    df = cands.sort_values(U, kind="stable")
    return Pool(df[cols], label=df["hit"], group_id=pd.factorize(df[U])[0], cat_features=[c for c in CAT if c in cols])


def fit(cands: pd.DataFrame, train_users, es_users=None, cols=None, iterations: int = 1000, seed: int = 42,
        **params) -> CatBoostRanker:
    """YetiRank по пользователям train_users (только те, у кого среди кандидатов есть попадание — остальные не дают
    сигнала); es_users — для ранней остановки по NDCG@10. Без es_users — ровно iterations деревьев."""
    cols = cols or feature_columns(cands)
    with_hit = cands.groupby(U)["hit"].transform("max") > 0
    tr = cands[with_hit & cands[U].isin(set(train_users))]
    model = CatBoostRanker(loss_function="YetiRank", eval_metric="NDCG:top=10", iterations=iterations,
                           random_seed=seed, verbose=200, thread_count=-1, allow_writing_files=False, **params)
    if es_users is not None:
        es = cands[with_hit & cands[U].isin(set(es_users))]
        model.fit(_pool(tr, cols), eval_set=_pool(es, cols), early_stopping_rounds=100, use_best_model=True)
    else:
        model.fit(_pool(tr, cols))
    return model


def predict(model: CatBoostRanker, cands: pd.DataFrame) -> np.ndarray:
    cols = model.feature_names_
    return model.predict(Pool(cands[cols], cat_features=[c for c in CAT if c in cols]))
