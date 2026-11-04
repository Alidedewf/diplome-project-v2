"""Коллаборативные модели — решения.md, 3.2 (модели 4–6) и 3.7 (E1).

- ItemKNN — «кто оценил эту книгу, оценил и эти»: implicit (cosine / BM25 / TF-IDF) через RecTools.
- ALS — матричная факторизация implicit через RecTools.
- ALS с признаками книг — тот же ALS, к скрытым факторам добавлены признаки: раздел, подраздел, автор
  (RecTools: ImplicitALSWrapperModel, признаки — отдельные столбцы векторов). Признак — одно значение
  на столбец, поэтому авторы — только частые (min_author_books): все 34 тыс. авторов не помещаются в память.

Модель задаётся словарём параметров (params) — его же подбирает Optuna (cf/tune.py).
"""

import time

import numpy as np
import pandas as pd
from implicit.cpu.als import AlternatingLeastSquares
from implicit.nearest_neighbours import BM25Recommender, CosineRecommender, TFIDFRecommender
from rectools import Columns
from rectools.dataset import Dataset
from rectools.models import ImplicitALSWrapperModel, ImplicitItemKNNWrapperModel

from eval.data import to_dataset

SEED = 42
FEATURES = ("section", "subsection", "author")


def item_features(items: np.ndarray, books: pd.DataFrame, use=FEATURES, min_author_books: int = 10) -> pd.DataFrame:
    """Признаки книг в формате RecTools (id, feature, value) для книг items.

    books — books_clean с parent_asin, author, categories. Раздел — categories[1], подраздел — categories[1:3].
    Автор — только если у него ≥ min_author_books книг среди items (0 — без авторов).
    """
    b = books[books["parent_asin"].isin(set(items))]
    cats = b["categories"]
    cols = {
        "section": cats.map(lambda c: c[1] if len(c) > 1 else None),
        "subsection": cats.map(lambda c: " > ".join(c[1:3]) if len(c) > 2 else None),
        "author": b["author"],
    }
    if min_author_books:
        counts = b["author"].value_counts()
        cols["author"] = b["author"].where(b["author"].isin(counts[counts >= min_author_books].index))
    else:
        use = [f for f in use if f != "author"]
    parts = [pd.DataFrame({"id": b["parent_asin"].to_numpy(), "feature": f, "value": cols[f].to_numpy()}) for f in use]
    return pd.concat(parts).dropna().reset_index(drop=True)


def dataset(train: pd.DataFrame, weighted: bool = True, features: pd.DataFrame | None = None) -> Dataset:
    """Dataset RecTools: веса оценок (eval/data.py) или 1; признаки книг — категориальные."""
    ds = to_dataset(train, weighted=weighted)
    if features is None:
        return ds
    return Dataset.construct(ds.get_raw_interactions(), item_features_df=features,
                             cat_item_features=list(features["feature"].unique()))


def make_model(kind: str, p: dict):
    """kind: knn | als | als_features; p — параметры (см. tune.py: SPACES)."""
    if kind == "knn":
        if p["similarity"] == "bm25":
            base = BM25Recommender(K=p["K"], K1=p["K1"], B=p["B"])
        elif p["similarity"] == "tfidf":
            base = TFIDFRecommender(K=p["K"])
        else:
            base = CosineRecommender(K=p["K"])
        return ImplicitItemKNNWrapperModel(base)
    als = AlternatingLeastSquares(factors=p["factors"], regularization=p["regularization"], alpha=p["alpha"],
                                  iterations=p["iterations"], random_state=SEED, num_threads=0)
    return ImplicitALSWrapperModel(als, fit_features_together=p.get("together", False))


def fit_model(kind: str, p: dict, train: pd.DataFrame, books: pd.DataFrame | None = None):
    """Обученная модель и её Dataset."""
    features = None
    if kind == "als_features":
        features = item_features(train[Columns.Item].astype(str).unique(), books, use=p["use"],
                                 min_author_books=p["min_author_books"])
    ds = dataset(train, weighted=p.get("weighted", True), features=features)
    return make_model(kind, p).fit(ds), ds


def fit_recommend(kind: str, p: dict, train: pd.DataFrame, users: np.ndarray, books: pd.DataFrame | None = None,
                  k: int = 10) -> tuple[pd.DataFrame, float]:
    """Обучить модель на train и выдать топ-k для users (без оценённых). Возвращает (рекомендации, секунды)."""
    t0 = time.time()
    model, ds = fit_model(kind, p, train, books)
    reco = model.recommend(users, ds, k=k, filter_viewed=True, on_unsupported_targets="ignore")
    return reco, time.time() - t0


def als_pair_scores(model, ds: Dataset, users, items) -> np.ndarray:
    """Балл ALS (скалярное произведение факторов) для пар (users[i], items[i]); NaN — книга или пользователь не из обучения."""
    u = ds.user_id_map.to_internal.reindex(np.asarray(users, dtype=str)).to_numpy()
    i = ds.item_id_map.to_internal.reindex(np.asarray(items, dtype=str)).to_numpy()
    ok = ~(np.isnan(u) | np.isnan(i))
    out = np.full(len(u), np.nan, np.float32)
    uf, itf = model.model.user_factors, model.model.item_factors
    uf = uf.to_numpy() if hasattr(uf, "to_numpy") else np.asarray(uf)
    itf = itf.to_numpy() if hasattr(itf, "to_numpy") else np.asarray(itf)
    uu, ii = u[ok].astype(int), i[ok].astype(int)
    out[ok] = np.einsum("ij,ij->i", uf[uu], itf[ii])
    return out
