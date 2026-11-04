"""Эмбеддинги книг и запросов — решения.md, 3.5.

Текст книги — поле text из books_clean.parquet (название + категории + аннотация).
Векторы нормированы: косинусная близость = скалярное произведение.

Каталог считается один раз на модель и кэшируется в data/processed/embeddings/<ключ>.npy (float16,
порядок строк — как в books_clean.parquet). Из кэша для выбранной модели собирается файл для бэкенда
(load-embeddings.js): data/processed/book_embeddings.parquet — book_id, embedding, model.

    uv run python src/content/embeddings.py e5-base          # посчитать каталог (или взять из кэша)
    uv run python src/content/embeddings.py e5-base --export # + файл для бэкенда
    uv run python src/content/embeddings.py e5-base --own    # свой каталог (1.5): own_books.parquet →
                                                             # own_book_embeddings.parquet в том же формате
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[3]
PROCESSED = ROOT / "data" / "processed"
CACHE = PROCESSED / "embeddings"
EXPORT = PROCESSED / "book_embeddings.parquet"
OWN_IN = PROCESSED / "own_books.parquet"
OWN_EXPORT = PROCESSED / "own_book_embeddings.parquet"

# max_len — сколько токенов текста книги учитывается (дальше обрезается); у MiniLM обучение было на 128
MODELS = {
    "e5-small": {"name": "intfloat/multilingual-e5-small", "query": "query: ", "passage": "passage: ", "max_len": 256},
    "e5-base": {"name": "intfloat/multilingual-e5-base", "query": "query: ", "passage": "passage: ", "max_len": 256},
    "minilm": {"name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "query": "", "passage": "",
               "max_len": 128},
}

_loaded = {}


def load_model(key: str):
    if key not in _loaded:
        import torch
        from sentence_transformers import SentenceTransformer

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = SentenceTransformer(MODELS[key]["name"], device=device)
        model.max_seq_length = MODELS[key]["max_len"]
        if device == "cuda":
            model.half()
        _loaded[key] = model
    return _loaded[key]


def encode(key: str, texts: list[str], kind: str, batch_size: int = 128, progress: bool = False) -> np.ndarray:
    """kind: query или passage (у e5 разные префиксы)."""
    prefix = MODELS[key][kind]
    vecs = load_model(key).encode([prefix + t for t in texts], batch_size=batch_size, normalize_embeddings=True,
                                  convert_to_numpy=True, show_progress_bar=progress)
    return vecs.astype(np.float32)


def load_books(columns=("parent_asin", "text")) -> pd.DataFrame:
    return pd.read_parquet(PROCESSED / "books_clean.parquet", columns=list(columns))


def catalog(key: str, books: pd.DataFrame | None = None) -> np.ndarray:
    """Векторы всего каталога (float16) в порядке books_clean.parquet; считает, если нет в кэше."""
    path = CACHE / f"{key}.npy"
    meta_path = CACHE / f"{key}.json"
    if path.exists():
        return np.load(path, mmap_mode="r")
    books = load_books() if books is None else books
    # Сортировка по длине: в батче тексты похожей длины — меньше паддинга, в разы быстрее
    order = np.argsort(books["text"].str.len().to_numpy())
    t0 = time.time()
    vecs = encode(key, books["text"].to_numpy()[order].tolist(), "passage", progress=True)
    seconds = time.time() - t0
    out = np.empty_like(vecs, dtype=np.float16)
    out[order] = vecs
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(path, out)
    meta_path.write_text(json.dumps({"model": MODELS[key]["name"], "dim": out.shape[1], "books": len(out),
                                     "seconds": round(seconds, 1), "max_len": MODELS[key]["max_len"]}),
                         encoding="utf-8")
    return out


def catalog_info(key: str) -> dict:
    return json.loads((CACHE / f"{key}.json").read_text(encoding="utf-8"))


def _write(path: Path, ids, vecs: np.ndarray, key: str, text: str, excluded_rule: str, n_excluded: int) -> Path:
    """Parquet для load-embeddings.js: book_id, embedding (float32, обычный список), model; описание — рядом в .json."""
    name = MODELS[key]["name"]
    table = pa.table({
        "book_id": pa.array(np.asarray(ids, dtype=str), pa.string()),
        # Обычный список (FLOAT[] в DuckDB), как ждёт load-embeddings.js
        "embedding": pa.ListArray.from_arrays(pa.array(np.arange(0, vecs.size + 1, vecs.shape[1]), pa.int32()),
                                              pa.array(vecs.ravel(), pa.float32())),
        "model": pa.array([name] * len(vecs), pa.string()),
    })
    table = table.replace_schema_metadata({"model": name, "dim": str(vecs.shape[1]), "normalized": "true",
                                           "text": text, "query_prefix": MODELS[key]["query"],
                                           "excluded": excluded_rule})
    pq.write_table(table, path)
    path.with_suffix(".json").write_text(json.dumps({
        "model": name, "dim": int(vecs.shape[1]), "normalized": True, "query_prefix": MODELS[key]["query"],
        "passage_prefix": MODELS[key]["passage"], "text": text, "max_tokens": MODELS[key]["max_len"],
        "books": int(len(vecs)), "excluded": int(n_excluded), "excluded_rule": excluded_rule,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def export_own(key: str, src: Path = OWN_IN, path: Path = OWN_EXPORT) -> Path:
    """Свой каталог русских и казахских книг (1.5): те же модель, префикс «passage: », 256 токенов и нормировка, что у
    каталога Amazon. Правило «из одного названия» — то же по смыслу: без описания от 30 символов и без жанра не
    выгружаются (по названию их найдёт обычный поиск)."""
    own = pd.read_parquet(src)
    text = own["text"].fillna("").astype(str)
    if "description" in own:
        desc_ok = own["description"].fillna("").astype(str).str.len().to_numpy() >= 30
        genre_ok = own["genre"].fillna("").astype(str).str.len().to_numpy() > 0 if "genre" in own else False
        keep = desc_ok | genre_ok
        rule = "нет описания (короче 30 символов) и нет жанра"
    elif "title" in own:
        keep = (text.str.len() - own["title"].fillna("").astype(str).str.len()).to_numpy() >= 30
        rule = "текст длиннее названия меньше чем на 30 символов"
    else:
        keep = np.ones(len(own), bool)
        rule = "нет (в файле только id и текст)"
    order = np.argsort(text[keep].str.len().to_numpy())
    vecs = encode(key, text[keep].to_numpy()[order].tolist(), "passage")
    out = np.empty_like(vecs)
    out[order] = vecs
    return _write(path, own["id"].to_numpy()[keep], out, key, "own_books.parquet: text (название + жанр + описание)",
                  rule, int((~keep).sum()))


def export(key: str, path: Path = EXPORT) -> Path:
    """Файл для бэкенда: book_id, embedding (float32), model; модель и размерность — ещё и в метаданных parquet.

    Книги «из одного названия» (eval/search.py: informative) не выгружаются: в смысловом поиске и «похожих»
    они только мешают, по названию их находит обычный поиск.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from eval.search import informative

    books = load_books(["parent_asin", "features", "categories"])
    keep = informative(books)
    books = books[keep]
    vecs = np.asarray(catalog(key))[keep].astype(np.float32)
    return _write(path, books["parent_asin"].to_numpy(), vecs, key,
                  "books_clean.parquet: text (название + категории + аннотация)",
                  "нет аннотации (features короче 30 символов) и нет подраздела категорий "
                  "(categories — только Books и верхний уровень); см. ml/src/eval/search.py: informative",
                  int((~keep).sum()))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("model", choices=list(MODELS))
    p.add_argument("--export", action="store_true")
    p.add_argument("--own", action="store_true")
    a = p.parse_args()
    if a.own:
        print("свой каталог:", export_own(a.model))
        sys.exit(0)
    vecs = catalog(a.model)
    print(json.dumps(catalog_info(a.model), ensure_ascii=False))
    if a.export:
        print("файл для бэкенда:", export(a.model))
    sys.exit(0)
