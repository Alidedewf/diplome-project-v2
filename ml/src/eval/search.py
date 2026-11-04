"""Тестовые запросы поиска и метрики — решения.md, 3.5.

Запросы — search_queries.json. Подходящие книги задаются тремя способами:
- ids — издания одной книги: запрос решён, если в выдаче есть любое из них;
- ids_any — несколько разных подходящих книг, отобранных вручную;
- rule — правило по каталогу (категория, слова в названии и начале описания) для широких тем.

Recall@k — доля найденных подходящих книг из min(k, их число): для темы в 500 книг это доля подходящих среди первых k,
для одной книги — найдена или нет. Издания одной книги (ids) считаются за одну. MRR — 1 / место первой подходящей книги.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

QUERIES = Path(__file__).with_name("search_queries.json")
HEAD_CHARS = 400


def load_queries(path: Path = QUERIES) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["queries"]


def _match(books: pd.DataFrame, rule: dict) -> pd.Series:
    cats = books["categories"].map(lambda c: " > ".join(c[1:]))
    features = books["features"].map(lambda f: " ".join(f)[:HEAD_CHARS] if f is not None else "")
    head = books["title"].fillna("") + " || " + features
    fields = {"title": books["title"], "author": books["author"], "cat": cats, "head": head}
    m = pd.Series(True, index=books.index)
    for key, pattern in rule.items():
        if key == "not_cat":
            m &= ~cats.str.contains(pattern, case=False, regex=True, na=False)
        else:
            m &= fields[key].str.contains(pattern, case=False, regex=True, na=False)
    return m


def resolve(queries: list[dict], books: pd.DataFrame, pooled: bool = True) -> dict[str, list[set[str]]]:
    """Подходящие книги для каждого запроса: список групп (группа — издания одной книги).

    pooled — добавлять книги, найденные моделями и отмеченные вручную после прогона (поле pooled; у запросов
    с same — и pooled исходного запроса). pooled=False — разметка до прогона.
    """
    by_id = {q["id"]: q for q in queries}
    known = set(books["parent_asin"])
    out = {}
    for q in queries:
        rel = q["relevant"]
        extra = list(rel.get("pooled", []))
        while "same" in rel:
            rel = by_id[rel["same"]]["relevant"]
            extra += rel.get("pooled", [])
        if "ids" in rel:
            groups = [set(rel["ids"]) & known]
        elif "ids_any" in rel:
            groups = [{i} for i in rel["ids_any"] if i in known]
        else:
            exclude = set(rel.get("exclude", []))
            groups = [{i} for i in books.loc[_match(books, rel["rule"]), "parent_asin"] if i not in exclude]
        if pooled:
            have = set().union(*groups) if groups else set()
            groups += [{i} for i in dict.fromkeys(extra) if i in known and i not in have]
        out[q["id"]] = [g for g in groups if g]
    return out


def informative(books: pd.DataFrame, min_chars: int = 30) -> np.ndarray:
    """Книги, у которых текст — не одно название: аннотация от min_chars символов или категория с подразделом.

    Книги из одного названия (~0,6% каталога; верхний уровень вроде «Books on CD», «Deals in Books» не в счёт)
    смысловая модель считает близкими почти к любому короткому запросу — они забивают выдачу.
    """
    ann = books["features"].map(lambda f: 0 if f is None else len(" ".join(f))).to_numpy() >= min_chars
    return ann | (books["categories"].map(len).to_numpy() > 2)


def search_vectors(query_vecs, book_vecs, book_ids: np.ndarray, k: int = 10, allowed: np.ndarray | None = None
                   ) -> list[list[str]]:
    """Ближайшие книги по косинусу (векторы нормированы); плотные — на GPU, если есть.

    allowed — маска книг, среди которых искать (остальные не выдаются). Книги с нулевой близостью
    (у TF-IDF — ни одного общего слова) в выдачу не попадают.
    """
    import scipy.sparse as sp
    import torch

    if sp.issparse(book_vecs):
        scores = torch.from_numpy((query_vecs @ book_vecs.T).toarray()).float()
    else:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32
        books_t = torch.as_tensor(np.asarray(book_vecs), dtype=dtype, device=device)
        scores = (torch.as_tensor(np.asarray(query_vecs), dtype=dtype, device=device) @ books_t.T).float()
    if allowed is not None:
        scores[:, torch.as_tensor(~allowed, device=scores.device)] = -np.inf
    top = torch.topk(scores, k, dim=1)
    idx, val = top.indices.cpu().numpy(), top.values.cpu().numpy()
    return [list(book_ids[row][v > 0]) for row, v in zip(idx, val)]


def query_metrics(found: list[str], groups: list[set[str]], k: int = 10) -> tuple[float, float]:
    """Recall@k и reciprocal rank одного запроса; found — выдача по порядку."""
    top = found[:k]
    hit = sum(any(i in g for i in top) for g in groups)
    recall = hit / min(k, len(groups))
    relevant = set().union(*groups)
    rr = next((1 / (r + 1) for r, i in enumerate(top) if i in relevant), 0.0)
    return recall, rr


def evaluate_search(results: dict[str, list[str]], queries: list[dict], relevant: dict[str, list[set[str]]],
                    k: int = 10) -> pd.DataFrame:
    """Метрики по каждому запросу; results — {id запроса: выдача}."""
    rows = []
    for q in queries:
        recall, rr = query_metrics(results[q["id"]], relevant[q["id"]], k)
        rows.append({"id": q["id"], "lang": q["lang"], "kind": q["kind"], f"Recall@{k}": recall, "MRR": rr})
    return pd.DataFrame(rows)


def summary(per_query: pd.DataFrame) -> pd.DataFrame:
    """Средние по всем запросам и по языку / типу запроса."""
    metrics = [c for c in per_query.columns if c.startswith("Recall") or c == "MRR"]
    parts = [per_query[metrics].mean().to_frame("все").T]
    for col in ("lang", "kind"):
        parts.append(per_query.groupby(col)[metrics].mean())
    out = pd.concat(parts)
    out.insert(0, "запросов", [len(per_query)] + list(per_query["lang"].value_counts().sort_index())
               + list(per_query["kind"].value_counts().sort_index()))
    return out
