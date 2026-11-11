"""Двухэтапная схема E3 для одного пользователя сайта — решения.md 3.8 (шаги S2–S3).

Пользователь сайта не входил в обучение, поэтому модели подставляют его историю без переобучения (fold-in):
- ItemKNN — строка событий × матрица сходства книг (как implicit при обучении);
- ALS — вектор пользователя одной регрессией по факторам книг (implicit `recalculate_user`);
- content — среднее векторов последних понравившихся книг (TF-IDF N = 3, e5-base N = 1, как в E3).
Кандидаты и признаки — тем же кодом, что в E3 (hybrid.candidates), статистика книг — с даты сборки.

События → псевдооценки (как веса RATING_WEIGHTS в обучении): оценка 1–5 — сама оценка; «Нравится» — 5; «Прочитал»
без оценки и «Хочу прочитать» — 3 (вес 0,5); «Не моё» и «Скрыть» — только исключения.
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.sparse as sp
from catboost import CatBoostRanker, Pool
from implicit.cpu.als import AlternatingLeastSquares
from implicit.nearest_neighbours import ItemItemRecommender, NearestNeighboursScorer
from rectools import Columns
from sklearn.preprocessing import normalize

from content.embeddings import catalog
from eval.data import HIT_RATING, MIN_TRAIN_RATINGS, RATING_WEIGHTS
from hybrid import candidates
from hybrid.ranker import CAT

U, I, DT = Columns.User, Columns.Item, Columns.Datetime
USER = "u"
PSEUDO_RATING = {"like": 5, "read": 3, "want": 3}
EXCLUDE_ONLY = {"dislike", "hide"}

# Признаки → тип объяснения (3.8). Подпись — только по группе с положительным вкладом SHAP и выполненным условием;
# сначала личные (PERSONAL: «похожа на», «тот же автор»), остальные — только если личного вклада нет; внутри уровня —
# по величине вклада. Ни одна группа не тянет книгу вверх — подписи нет (неправдивую не показываем).
REASON_GROUPS = {
    "similar": ["knn_score", "knn_rank", "als_score", "als_rank", "als_pair", "tfidf_score", "tfidf_rank", "tfidf_sim",
                "e5_score", "e5_rank", "e5_sim", "n_sources"],
    "author": ["author_cnt", "author_last5"],
    "trending": ["i_n_year", "i_days", "i_n", "i_mean", "i_wr"],
    "new": ["i_age"],
    "topics": ["section_share", "subsection_share", "section"],
}
PERSONAL = ("similar", "author")


class Recommender:
    def __init__(self, path: Path):
        path = Path(path)
        self.meta = json.loads((path / "meta.json").read_text(encoding="utf-8"))
        self.cutoff = pd.Timestamp(self.meta["cutoff"])
        self.n_profile = self.meta["n_profile"]
        self.k = self.meta["k_list"]

        self.knn = ItemItemRecommender()
        self.knn.similarity = sp.load_npz(path / "similarity.npz").tocsr()
        self.knn.scorer = NearestNeighboursScorer(self.knn.similarity)
        Y = np.load(path / "als_items.npy")
        p = self.meta["params"]["als"]
        self.als = AlternatingLeastSquares(factors=Y.shape[1], regularization=p["regularization"], alpha=p["alpha"])
        self.als.item_factors = Y
        self.model_items = np.load(path / "model_items.npy", allow_pickle=True).astype(str)
        self.model_index = pd.Index(self.model_items)

        stats = pd.read_parquet(path / "item_stats.parquet")
        self.stats = (stats, self.meta["mean_rating"])
        self.rare = set(stats.index[stats["i_n"] < MIN_TRAIN_RATINGS])
        self.books = pd.read_parquet(path / "books.parquet")
        self.ids_all = self.books["parent_asin"].to_numpy().astype(str)
        self.catalog_index = pd.Index(self.ids_all)
        self.allowed = np.load(path / "allowed.npy")
        self.X_tfidf = sp.load_npz(path / "tfidf.npz").tocsr()
        self.E5 = np.asarray(catalog(self.meta["e5"]), dtype=np.float32)
        self.meta_books = self.books.set_index("parent_asin")[["author", "year", "cat2", "cat3"]]
        self.ctx = {"X_tfidf": self.X_tfidf, "E5": self.E5, "ids_all": self.ids_all,
                    "item_index": self.catalog_index, "meta": self.meta_books}
        self.author = self.books.set_index("parent_asin")["author"]
        self.section = self.books.set_index("parent_asin")["cat2"]

        # Content-списки TF-IDF и e5 независимы и упираются в память, а не в Python (numpy/scipy отпускают GIL) —
        # считаются параллельно, запрос ждёт более долгий из двух
        self.pool = ThreadPoolExecutor(max_workers=2)

        self.ranker = CatBoostRanker()
        self.ranker.load_model(str(path / "ranker.cbm"))
        self.cols = list(self.ranker.feature_names_)
        self.shap_calc = "Approximate"

    # ——— История ———

    def history(self, events: list[dict], ref: pd.Timestamp | None = None) -> tuple[pd.DataFrame, set[str]]:
        """События → оценки в формате обучения (user_id, item_id, rating, datetime) и исключения; без даты — ref."""
        ref = self.cutoff if ref is None else pd.Timestamp(ref)
        rows, excl = [], set()
        for e in events:
            book, kind = str(e["bookId"]), e.get("kind", "rating")
            excl.add(book)
            if kind in EXCLUDE_ONLY:
                continue
            r = int(e["value"]) if kind == "rating" else PSEUDO_RATING.get(kind)
            if r is None or not 1 <= r <= 5:
                continue
            at = pd.Timestamp(e["at"]) if e.get("at") else ref - pd.Timedelta(seconds=1)
            rows.append((book, r, at.tz_convert(None) if at.tzinfo else at))
        h = pd.DataFrame(rows, columns=[I, "rating", DT])
        h = h[self.catalog_index.get_indexer(h[I]) >= 0]
        # Одна книга — последнее событие
        h = h.sort_values(DT, kind="stable").drop_duplicates(I, keep="last").reset_index(drop=True)
        h.insert(0, U, USER)
        h["rating"] = h["rating"].astype("int8")
        return h, excl

    def _row(self, hist: pd.DataFrame) -> sp.csr_matrix:
        idx = self.model_index.get_indexer(hist[I])
        ok = idx >= 0
        w = hist["rating"].map(RATING_WEIGHTS).to_numpy(np.float32)[ok]
        return sp.csr_matrix((w, (np.zeros(ok.sum(), int), idx[ok])), shape=(1, len(self.model_items)))

    # ——— Списки источников (как в E3: топ-100, затем без книг с 1–4 оценками) ———

    def _list(self, items: np.ndarray, scores: np.ndarray) -> pd.DataFrame:
        df = pd.DataFrame({U: USER, I: items.astype(str), Columns.Score: scores.astype(np.float32)})
        df = df[~df[I].isin(self.rare)].reset_index(drop=True)
        df[Columns.Rank] = np.arange(1, len(df) + 1)
        return df

    def _cf_list(self, ids: np.ndarray, scores: np.ndarray, viewed: set[str]) -> pd.DataFrame:
        items = self.model_items[ids]
        keep = ~np.isin(items, list(viewed))
        return self._list(items[keep][: self.k], scores[keep][: self.k])

    def _content_list(self, scores: np.ndarray, viewed_idx: np.ndarray) -> pd.DataFrame:
        scores = np.where(self.allowed, scores, -np.inf)
        scores[viewed_idx] = -np.inf
        top = np.argpartition(-scores, self.k)[: self.k]
        top = top[np.argsort(-scores[top], kind="stable")]
        top = top[np.isfinite(scores[top])]
        return self._list(self.ids_all[top], scores[top])

    def _profile_rows(self, hist: pd.DataFrame, n: int) -> np.ndarray:
        last = hist.sort_values(DT, kind="stable").tail(n)
        liked = last[last["rating"] >= HIT_RATING]
        use = liked if len(liked) else last
        return self.catalog_index.get_indexer(use[I])

    def lists(self, hist: pd.DataFrame, exclude: set[str]) -> tuple[dict, np.ndarray, dict]:
        t, timing = time.perf_counter(), {}
        viewed = set(hist[I]) | exclude
        row = self._row(hist)
        n_viewed = row.nnz
        ids, sc = self.knn.recommend(0, row, N=self.k + n_viewed, filter_already_liked_items=False)
        out = {"knn": self._cf_list(ids, sc, viewed)}
        timing["knn"] = time.perf_counter() - t

        t = time.perf_counter()
        uvec = self.als.recalculate_user(0, row)
        sc = self.als.item_factors @ uvec
        n = min(self.k + n_viewed, len(sc) - 1)
        ids = np.argpartition(-sc, n)[:n]
        ids = ids[np.argsort(-sc[ids], kind="stable")]
        out["als"] = self._cf_list(ids, sc[ids], viewed)
        timing["als"] = time.perf_counter() - t

        viewed_idx = self.catalog_index.get_indexer(list(viewed))
        viewed_idx = viewed_idx[viewed_idx >= 0]

        def tfidf():
            t = time.perf_counter()
            rows = self._profile_rows(hist, self.n_profile["tfidf"])
            # Профиль — плотный вектор: разреженная матрица × плотный вектор в разы быстрее, чем × разреженный
            prof = normalize(np.asarray(self.X_tfidf[rows].mean(axis=0), dtype=np.float32)).ravel()
            return self._content_list(self.X_tfidf @ prof, viewed_idx), time.perf_counter() - t

        def e5():
            t = time.perf_counter()
            rows = self._profile_rows(hist, self.n_profile["e5"])
            return self._content_list(self.E5 @ self.E5[rows].mean(axis=0), viewed_idx), time.perf_counter() - t

        t = time.perf_counter()
        jobs = {"tfidf": self.pool.submit(tfidf), "e5": self.pool.submit(e5)}
        for name, job in jobs.items():
            out[name], timing[name] = job.result()
        timing["content"] = time.perf_counter() - t   # оба параллельно — это и входит в общее время
        return out, uvec, timing

    # ——— Рекомендации ———

    def recommend(self, events: list[dict], exclude=(), n: int = 50, now: pd.Timestamp | None = None,
                  explain: int = 10) -> dict | None:
        """Лента: [{bookId, score, reasons}] — первые n по ранжировщику; None — нет истории (нечего подставлять)."""
        t0 = time.perf_counter()
        hist, excl = self.history(events, now)
        excl |= {str(x) for x in exclude}
        if hist.empty:
            return None
        if now is not None:
            # Время сайта переносится на дату сборки: «последняя оценка неделю назад» остаётся неделей, а возраст
            # и динамика популярности книг — как в данных, на которых учился ранжировщик (каталог кончается 2023 годом)
            hist[DT] = hist[DT] + (self.cutoff - pd.Timestamp(now))
        lists, uvec, timing = self.lists(hist, excl)

        t = time.perf_counter()
        def als_pair(users, items):
            idx = self.model_index.get_indexer(np.asarray(items, dtype=str))
            out = np.full(len(idx), np.nan, np.float32)
            out[idx >= 0] = self.als.item_factors[idx[idx >= 0]] @ uvec
            return out
        cands = candidates.build(lists, hist, [USER], self.books, self.ctx, self.cutoff, self.n_profile,
                                 als=als_pair, sources=self.meta["sources"], m_wr=self.meta["m_wr"], stats=self.stats)
        cands = cands[~cands[I].isin(excl)].reset_index(drop=True)
        timing["features"] = time.perf_counter() - t

        t = time.perf_counter()
        pool = Pool(cands[self.cols], cat_features=[c for c in CAT if c in self.cols])
        score = self.ranker.predict(pool)
        order = np.argsort(-score, kind="stable")[:n]
        timing["rank"] = time.perf_counter() - t

        t = time.perf_counter()
        top = cands.iloc[order].reset_index(drop=True)
        reasons = self.reasons(top.head(explain), hist) if explain else {}
        timing["reasons"] = time.perf_counter() - t
        items = [{"bookId": b, "score": float(s), "reasons": reasons.get(b, [])}
                 for b, s in zip(top[I], score[order])]
        timing["total"] = time.perf_counter() - t0
        return {"modelVersion": self.meta["name"], "items": items, "candidates": len(cands),
                "timing_ms": {k: round(v * 1000, 1) for k, v in timing.items()}}

    # ——— Объяснения «почему» (S3) ———

    def reasons(self, top: pd.DataFrame, hist: pd.DataFrame) -> dict[str, list[dict]]:
        # Приближённый SHAP (вклад по пути документа в каждом дереве): 10 мс против 77 у точного на 10 книгах; для
        # выбора типа подписи точность хватает (совпадение с точным — в check.py)
        shap = self.ranker.get_feature_importance(
            Pool(top[self.cols], cat_features=[c for c in CAT if c in self.cols]), type="ShapValues",
            shap_calc_type=self.shap_calc)[:, :-1]
        contrib = pd.DataFrame(shap, columns=self.cols)
        groups = {g: contrib[[c for c in cols if c in self.cols]].sum(axis=1).to_numpy() for g, cols in REASON_GROUPS.items()}
        liked = hist[hist["rating"] >= HIT_RATING]
        base = liked if len(liked) else hist
        out = {}
        for j, r in top.iterrows():
            book = r[I]
            ok = {
                "similar": True,
                "author": r["author_cnt"] > 0 and pd.notna(r["author"]),
                "trending": r["i_n_year"] > 0,
                "new": pd.notna(r["i_age"]) and r["i_age"] <= 1,
                "topics": r["section_share"] > 0,
            }
            ranked = sorted(groups, key=lambda g: (g not in PERSONAL, -groups[g][j]))
            g = next((g for g in ranked if ok[g] and groups[g][j] > 0), None)
            if g is None:
                out[book] = []
            elif g == "similar":
                out[book] = [{"type": "similar", "bookId": self._closest(book, base)}]
            elif g == "author":
                same = hist[hist[I].map(self.author) == r["author"]]
                out[book] = [{"type": "author", "bookId": same.sort_values(DT).iloc[-1][I]}]
            elif g == "trending":
                out[book] = [{"type": "trending", "section": r["section"] if r["section_share"] > 0 else None}]
            elif g == "new":
                out[book] = [{"type": "new"}]
            else:
                out[book] = [{"type": "topics", "section": r["section"]}]
        return out

    def _closest(self, book: str, base: pd.DataFrame) -> str | None:
        """Книга истории, ближе всех к рекомендованной: по сходству ItemKNN, если оно есть, иначе по e5."""
        j = self.model_index.get_indexer([book])[0]
        hist_m = self.model_index.get_indexer(base[I])
        if j >= 0 and (hist_m >= 0).any():
            # Вклад книги истории h в балл ItemKNN — S[h, j] (строки CSR берутся быстро, столбец — нет)
            sims = np.zeros(len(hist_m))
            ok = hist_m >= 0
            sims[ok] = self.knn.similarity[hist_m[ok]][:, [j]].toarray().ravel()
            if sims.max() > 0:
                return base[I].iloc[int(np.argmax(sims))]
        jc = self.catalog_index.get_indexer([book])[0]
        hc = self.catalog_index.get_indexer(base[I])
        if jc < 0 or not (hc >= 0).any():
            return None
        sims = np.where(hc >= 0, self.E5[np.maximum(hc, 0)] @ self.E5[jc], -np.inf)
        return base[I].iloc[int(np.argmax(sims))]
