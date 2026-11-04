"""Content-based рекомендации — решения.md, 3.2 (модели 2 и 3).

Профиль пользователя — среднее векторов книг, которые ему понравились в обучении (4–5★); если таких нет —
всех оценённых. Рекомендации — книги, ближайшие к профилю по косинусу, без уже оценённых.
Векторы книг — TF-IDF по полю text или эмбеддинги (content/embeddings.py). Выбирать можно из любых книг
каталога, в том числе без единой оценки в обучении — в этом отличие от коллаборативных моделей.
"""

import numpy as np
import pandas as pd
import scipy.sparse as sp
from rectools import Columns
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize

from eval.data import HIT_RATING


def tfidf_vectors(texts, **kwargs) -> tuple[sp.csr_matrix, TfidfVectorizer]:
    """TF-IDF по тексту книги; строки нормированы (косинус = скалярное произведение).

    Только отдельные слова: словарь пар слов на 408 тыс. книг не помещается в 16 ГБ памяти.
    """
    params = dict(sublinear_tf=True, min_df=3, max_df=0.5, stop_words="english", max_features=200_000,
                  dtype=np.float32)
    vec = TfidfVectorizer(**{**params, **kwargs})
    return vec.fit_transform(texts).tocsr(), vec


def _profile_weights(train: pd.DataFrame, users: np.ndarray, item_index: pd.Index) -> sp.csr_matrix:
    """Матрица пользователи × книги: 1/n у понравившихся книг (или у всех оценённых, если понравившихся нет)."""
    df = pd.DataFrame({"u": train[Columns.User].astype(str), "i": train[Columns.Item].astype(str),
                       "liked": train["rating"].to_numpy() >= HIT_RATING})
    df = df[df["u"].isin(users)]
    has_liked = df.groupby("u")["liked"].transform("any")
    df = df[df["liked"] | ~has_liked]
    rows = pd.Index(users).get_indexer(df["u"])
    cols = item_index.get_indexer(df["i"])
    w = sp.csr_matrix((np.ones(len(df), np.float32), (rows, cols)), shape=(len(users), len(item_index)))
    return sp.diags(1 / np.maximum(w.sum(axis=1).A1, 1)).astype(np.float32) @ w


def _viewed(train: pd.DataFrame, users: np.ndarray, item_index: pd.Index) -> sp.csr_matrix:
    u = pd.Index(users).get_indexer(train[Columns.User].astype(str))
    keep = u >= 0
    i = item_index.get_indexer(train[Columns.Item].astype(str)[keep])
    return sp.csr_matrix((np.ones(keep.sum(), bool), (u[keep], i)), shape=(len(users), len(item_index)))


def pair_scores(vectors, item_ids, profile_from: pd.DataFrame, users, items, chunk: int = 200_000) -> np.ndarray:
    """Косинус профиля пользователя и книги для пар (users[i], items[i]) — признак для гибрида (3.3).

    Профиль — как в recommend (по оценкам profile_from); книги не из каталога — NaN.
    """
    item_index = pd.Index(item_ids)
    users, items = np.asarray(users, dtype=str), np.asarray(items, dtype=str)
    uniq, u_idx = np.unique(users, return_inverse=True)
    profiles = _profile_weights(profile_from, uniq, item_index) @ vectors
    i_idx = item_index.get_indexer(items)
    out = np.full(len(users), np.nan, np.float32)
    if sp.issparse(profiles):
        profiles = normalize(profiles).tocsr()
    else:
        profiles = np.asarray(profiles, np.float32)
        profiles /= np.maximum(np.linalg.norm(profiles, axis=1, keepdims=True), 1e-12)
        vectors = np.asarray(vectors)
    for s in range(0, len(users), chunk):
        sl = slice(s, s + chunk)
        ok = i_idx[sl] >= 0
        pu, it = u_idx[sl][ok], i_idx[sl][ok]
        if sp.issparse(profiles):
            v = np.asarray(profiles[pu].multiply(vectors[it]).sum(axis=1)).ravel()
        else:
            v = np.einsum("ij,ij->i", profiles[pu], np.asarray(vectors[it], np.float32))
        out[np.arange(s, min(s + chunk, len(users)))[ok]] = v
    return out


def recommend(vectors, item_ids, train: pd.DataFrame, users: np.ndarray, k: int = 10,
              batch: int = 1024, allowed: np.ndarray | None = None,
              profile_from: pd.DataFrame | None = None) -> pd.DataFrame:
    """Топ-k книг для каждого пользователя в формате RecTools (user_id, item_id, score, rank).

    vectors — векторы книг (np.ndarray или разреженная матрица), строки нормированы; item_ids — их id по порядку.
    allowed — маска книг, которые можно рекомендовать (в профиль идут все оценённые).
    profile_from — оценки для профиля (например, только последние N); исключаются всё равно все оценённые в train.
    """
    import torch

    item_index = pd.Index(item_ids)
    users = np.asarray(users)
    dense = not sp.issparse(vectors)
    if dense:
        vectors = np.asarray(vectors, np.float32)
    profiles = _profile_weights(train if profile_from is None else profile_from, users, item_index) @ vectors
    viewed = _viewed(train, users, item_index)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if dense:
        items_t = torch.as_tensor(vectors, dtype=torch.float16 if device == "cuda" else torch.float32, device=device)
    else:
        # TF-IDF: книги — разреженная матрица на видеокарте, профили пачки — плотные (книги × слова @ слова × пачка)
        profiles = normalize(profiles).tocsr()
        coo = vectors.tocoo()
        items_t = torch.sparse_coo_tensor(np.vstack([coo.row, coo.col]), coo.data, coo.shape,
                                          device=device).to_sparse_csr()
        batch = min(batch, 256)

    blocked = None if allowed is None else torch.as_tensor(~np.asarray(allowed), device=device)
    out_items, out_scores = [], []
    for start in range(0, len(users), batch):
        sl = slice(start, start + batch)
        if dense:
            p = torch.as_tensor(np.asarray(profiles[sl]), dtype=items_t.dtype, device=device)
            scores = (p @ items_t.T).float()
        else:
            p = torch.as_tensor(profiles[sl].toarray(), device=device)
            scores = (items_t @ p.T).T.contiguous()
        v = viewed[sl].tocoo()
        scores[torch.as_tensor(v.row, dtype=torch.long, device=scores.device),
               torch.as_tensor(v.col, dtype=torch.long, device=scores.device)] = -np.inf
        if blocked is not None:
            scores[:, blocked] = -np.inf
        top = torch.topk(scores, k, dim=1)
        out_items.append(top.indices.cpu().numpy())
        out_scores.append(top.values.cpu().numpy())

    items = np.vstack(out_items)
    return pd.DataFrame({
        Columns.User: np.repeat(users, k),
        Columns.Item: item_index.to_numpy()[items.ravel()],
        Columns.Score: np.vstack(out_scores).ravel(),
        Columns.Rank: np.tile(np.arange(1, k + 1), len(users)),
    })
