"""Данные для экспериментов: загрузка, разбиение по времени, подвыборка, перевод в формат RecTools.

Правила — решения.md, 3.1 (разбиение) и 1.2 (подвыборка).
"""

from pathlib import Path

import numpy as np
import pandas as pd
from rectools import Columns
from rectools.dataset import Dataset

ROOT = Path(__file__).resolve().parents[3]
PROCESSED = ROOT / "data" / "processed"

VAL_START = pd.Timestamp("2021-01-01")
TEST_START = pd.Timestamp("2022-01-01")
HIT_RATING = 4  # попадание при проверке — оценка 4–5

# Веса оценок при обучении (3.1: «все оценки с весами»): чем выше оценка, тем сильнее сигнал «понравилось»
RATING_WEIGHTS = {1: 0.1, 2: 0.25, 3: 0.5, 4: 0.8, 5: 1.0}


def load_ratings() -> pd.DataFrame:
    """Оценки после очистки в колонках RecTools: user_id, item_id, weight (= оценка), datetime."""
    r = pd.read_parquet(PROCESSED / "ratings_clean.parquet")
    return pd.DataFrame({
        Columns.User: r["user_id"].astype("category"),
        Columns.Item: r["parent_asin"].astype("category"),
        "rating": r["rating"].astype("int8"),
        Columns.Datetime: pd.to_datetime(r["timestamp"], unit="ms"),
    })


def subsample_users(ratings: pd.DataFrame, frac: float, seed: int = 42) -> pd.DataFrame:
    """Случайные пользователи со всей их историей (обучение + валидация + тест).

    Пользователей выбираем случайно, а не по активности — так сохраняется длинный хвост и доля
    «новых» книг; затем убираем книги, у которых в подвыборке меньше 5 оценок (как в 5-core).
    """
    users = ratings[Columns.User].unique()
    rng = np.random.default_rng(seed)
    chosen = rng.choice(users, size=int(len(users) * frac), replace=False)
    sub = ratings[ratings[Columns.User].isin(chosen)]
    book_counts = sub[Columns.Item].value_counts()
    sub = sub[sub[Columns.Item].isin(book_counts[book_counts >= 5].index)]
    for col in (Columns.User, Columns.Item):
        sub[col] = sub[col].cat.remove_unused_categories()
    return sub.reset_index(drop=True)


def time_split(ratings: pd.DataFrame, val_start=VAL_START, test_start=TEST_START):
    """Обучение — до val_start, валидация — [val_start, test_start), тест — с test_start."""
    dt = ratings[Columns.Datetime]
    return ratings[dt < val_start], ratings[(dt >= val_start) & (dt < test_start)], ratings[dt >= test_start]


def to_dataset(train: pd.DataFrame, weighted: bool = True) -> Dataset:
    """Dataset RecTools из обучающих оценок. weighted=False — все оценки с весом 1."""
    weight = train["rating"].map(RATING_WEIGHTS).astype("float32") if weighted else 1.0
    df = pd.DataFrame({
        Columns.User: train[Columns.User].astype(str),
        Columns.Item: train[Columns.Item].astype(str),
        Columns.Weight: weight,
        Columns.Datetime: train[Columns.Datetime],
    })
    return Dataset.construct(df)


def describe_split(train: pd.DataFrame, val: pd.DataFrame, test: pd.DataFrame) -> pd.DataFrame:
    """Сколько оценок / пользователей / книг в каждой части, сколько «тёплых» пользователей и «новых» книг."""
    rows = []
    seen_users, seen_items = set(), set()
    for name, part in [("обучение", train), ("валидация", val), ("тест", test)]:
        users, items = set(part[Columns.User].unique()), set(part[Columns.Item].unique())
        row = {"часть": name, "оценок": len(part), "пользователей": len(users), "книг": len(items)}
        if seen_users:
            row["польз. с историей"] = len(users & seen_users) / len(users)
            row["оценок на новые книги"] = (~part[Columns.Item].isin(seen_items)).mean()
        rows.append(row)
        seen_users |= users
        seen_items |= items
    return pd.DataFrame(rows)
