"""Кандидаты и признаки для гибрида — решения.md, 3.3 (эксперимент E3, 3.7).

Кандидаты — объединение топ-k нескольких моделей (ItemKNN, content TF-IDF и e5-base с профилем по последним N
оценкам, по желанию ALS). Для каждой пары «пользователь — книга» — признаки: баллы и места моделей, баллы content и ALS
для любой пары (не только из своего списка), статистика книги **по обучению** (в books_clean n_ratings и
average_rating — по всем данным, это утечка), совпадение автора и раздела с историей, активность пользователя.
"""

import numpy as np
import pandas as pd
from rectools import Columns

from cf.models import als_pair_scores
from content.recommend import pair_scores
from eval.coldstart import truncate_history
from eval.data import HIT_RATING, drop_rare

U, I = Columns.User, Columns.Item


def drop_survivors(lst: pd.DataFrame, train: pd.DataFrame) -> pd.DataFrame:
    """Список модели без книг с 1–4 оценками в обучении (eval.data.drop_rare): ранжировщик выучил бы по числу оценок,
    что такие книги попали в подвыборку благодаря будущим оценкам."""
    return drop_rare(lst, train)


def item_stats(train: pd.DataFrame, cutoff: pd.Timestamp, m: float = 20.0) -> pd.DataFrame:
    """Статистика книг по обучению: число оценок, средняя, взвешенный рейтинг (байесовское среднее, порог m),
    дней с первой оценки, оценок за последний год."""
    t = pd.DataFrame({I: train[I].astype(str), "r": train["rating"].astype("float32"), "dt": train[Columns.Datetime]})
    c = t["r"].mean()
    g = t.groupby(I)
    s = pd.DataFrame({"i_n": g.size(), "i_mean": g["r"].mean(),
                      "i_days": (cutoff - g["dt"].min()).dt.days,
                      "i_n_year": t[t["dt"] >= cutoff - pd.Timedelta(days=365)].groupby(I).size()})
    s["i_n_year"] = s["i_n_year"].fillna(0)
    s["i_wr"] = (s["i_n"] * s["i_mean"] + m * c) / (s["i_n"] + m)
    return s.astype("float32"), float(c)


def user_stats(train: pd.DataFrame, users, cutoff: pd.Timestamp) -> pd.DataFrame:
    t = pd.DataFrame({U: train[U].astype(str), "r": train["rating"], "dt": train[Columns.Datetime]})
    t = t[t[U].isin(set(users))]
    g = t.groupby(U)
    return pd.DataFrame({"u_n": g.size(), "u_liked": (t["r"] >= HIT_RATING).groupby(t[U]).mean(),
                         "u_days_last": (cutoff - g["dt"].max()).dt.days}).astype("float32")


def _history_share(hist: pd.DataFrame, cands: pd.DataFrame, key: str, name: str) -> pd.Series:
    """Доля книг истории пользователя с тем же значением key (автор, раздел), что у кандидата; и число таких книг."""
    h = hist.dropna(subset=[key]).groupby([U, key]).size().rename(name).reset_index()
    out = cands[[U, key]].merge(h, on=[U, key], how="left")[name].fillna(0).to_numpy()
    return out


def build(lists: dict[str, pd.DataFrame], train: pd.DataFrame, users, books: pd.DataFrame, ctx: dict,
          cutoff: pd.Timestamp, n_profile: dict[str, int], als=None, sources=("knn", "tfidf", "e5"),
          m_wr: float = 20.0, stats: tuple[pd.DataFrame, float] | None = None) -> pd.DataFrame:
    """Таблица кандидатов с признаками.

    lists — топ-k моделей (user_id, item_id, score, rank), ключи — имена источников; в кандидаты идут sources.
    books — parent_asin, author, year, cat2, cat3; ctx — X_tfidf, E5, ids_all (векторы content-моделей).
    als — (модель, Dataset) для балла ALS любой пары или функция (users, items) → баллы (сайт: вектор пользователя
    после fold-in). stats — готовая статистика книг item_stats(...) (сайт: train — только история пользователя, а
    статистика книг посчитана при сборке по всем оценкам). Пользователи — строки (str).
    """
    users = np.asarray(users, dtype=str)
    norm = {s: lists[s].assign(**{U: lists[s][U].astype(str), I: lists[s][I].astype(str)}) for s in lists}
    cands = pd.concat([norm[s][[U, I]] for s in sources]).drop_duplicates().reset_index(drop=True)
    for s, df in norm.items():
        cands = cands.merge(df[[U, I, Columns.Score, Columns.Rank]].rename(
            columns={Columns.Score: f"{s}_score", Columns.Rank: f"{s}_rank"}), on=[U, I], how="left")
    cands["n_sources"] = sum(cands[f"{s}_rank"].notna() for s in sources).astype("int8")

    # Баллы content-моделей и ALS для любой пары
    for s, key in [("tfidf", "X_tfidf"), ("e5", "E5")]:
        prof = truncate_history(train, users, n_profile[s])
        cands[f"{s}_sim"] = pair_scores(ctx[key], ctx["ids_all"], prof, users_of(cands), cands[I].to_numpy())
    if callable(als):
        cands["als_pair"] = als(users_of(cands), cands[I].to_numpy())
    elif als is not None:
        cands["als_pair"] = als_pair_scores(als[0], als[1], users_of(cands), cands[I].to_numpy())

    # Книга: статистика по обучению, год издания, раздел
    stats, c = item_stats(train, cutoff, m_wr) if stats is None else stats
    cands = cands.join(stats, on=I)
    cands["i_n"] = cands["i_n"].fillna(0)
    cands["i_n_year"] = cands["i_n_year"].fillna(0)
    cands["i_wr"] = cands["i_wr"].fillna(c)
    meta = books.set_index("parent_asin")[["author", "year", "cat2", "cat3"]]
    cands = cands.join(meta, on=I)
    cands["i_age"] = (cutoff.year - cands["year"].astype("float32")).clip(lower=-1)

    # Пользователь и совпадение с историей
    cands = cands.join(user_stats(train, users, cutoff), on=U)
    hist = pd.DataFrame({U: train[U].astype(str), I: train[I].astype(str), "dt": train[Columns.Datetime]})
    hist = hist[hist[U].isin(set(users))].join(meta, on=I)
    last5 = hist.sort_values("dt", kind="stable").groupby(U).tail(5)
    cands["author_cnt"] = _history_share(hist, cands, "author", "n")
    cands["author_last5"] = _history_share(last5, cands, "author", "n")
    cands["section_share"] = _history_share(hist, cands, "cat2", "n") / cands["u_n"]
    cands["subsection_share"] = _history_share(hist, cands, "cat3", "n") / cands["u_n"]
    cands["section"] = cands["cat2"].fillna("—").astype(str)
    return cands.drop(columns=["year", "cat2", "cat3"])


def users_of(cands: pd.DataFrame) -> np.ndarray:
    return cands[U].to_numpy()


def add_labels(cands: pd.DataFrame, part: pd.DataFrame) -> pd.DataFrame:
    """hit = 1, если книга оценена в проверочной части на 4–5 (как в eval.metrics)."""
    hits = part[part["rating"] >= HIT_RATING]
    key = set(zip(hits[U].astype(str), hits[I].astype(str)))
    return cands.assign(hit=np.fromiter((p in key for p in zip(cands[U], cands[I])), bool, len(cands)).astype("int8"))


def n_relevant(part: pd.DataFrame, users) -> pd.Series:
    """Число разных попаданий у пользователя (для нормировки NDCG на достижимый максимум)."""
    hits = part[part["rating"] >= HIT_RATING]
    hits = pd.DataFrame({U: hits[U].astype(str), I: hits[I].astype(str)}).drop_duplicates()
    return hits.groupby(U).size().reindex(np.asarray(users, dtype=str), fill_value=0)


def recall_of_candidates(cands: pd.DataFrame, part: pd.DataFrame, users) -> float:
    """Доля попаданий проверочной части, попавших в кандидаты (потолок для переранжирования)."""
    return float(cands["hit"].sum() / n_relevant(part, users).sum())
