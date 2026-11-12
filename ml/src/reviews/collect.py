"""E6, шаг 1 — тексты отзывов для книг каталога: до 50 самых полезных на книгу (решения.md 2.6.1, 3.6).

Источник — Amazon Reviews 2023, raw/review_categories/Books.jsonl (20 ГБ, 29,5 млн отзывов), качается в data/raw
(`download`). Отбор — два потоковых прохода, чтобы в памяти не держать тексты:
1. Построчно, без разбора JSON: для отзывов на книги каталога (с учётом склеенных изданий) пишем на диск короткие
   записи (книга, helpful_vote, длина текста, хеш пользователя, смещение строки в файле) — по 16 корзинам.
2. По корзинам: на книгу — до 50 отзывов **с квотами по звёздам** пропорционально всем отзывам книги, внутри звезды —
   самые полезные (helpful_vote, при равенстве — длиннее); один отзыв на пользователя (несколько изданий одной книги),
   текст ≥ 30 символов. Чистый top-50 по helpful_vote у популярных книг на 60% из отзывов на 1 звезду (Gone Girl — 29
   из 50 при среднем 4,1): за разгромные отзывы голосуют охотнее, и сводка выходила бы «читатели ругают».
   Затем по отобранным смещениям читаем строки (HTML-разметка → текст) и пишем parquet партиями.

Сырой Books.jsonl после отбора удалён (решение автора, 11.11): повторный отбор — только после нового скачивания
(`download`, ~20 ГБ, ~15 мин). Дальше работаем с reviews_top50.parquet.

    uv run python src/reviews/collect.py download   # скачать Books.jsonl (с докачкой)
    uv run python src/reviews/collect.py select     # отбор → data/processed/reviews_top50.parquet
"""

import argparse
import html
import json
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import clean
from data.download import PROCESSED, RAW, download

REMOTE = "raw/review_categories/Books.jsonl"
JSONL = RAW / "Books.jsonl"
OUT = PROCESSED / "reviews_top50.parquet"
WORK = PROCESSED / "_reviews_index"   # временные корзины первого прохода, удаляются в конце
TOP = 50
MIN_TEXT = 30
N_BUCKETS = 16
FLUSH = 500_000
BATCH = 100_000
REC = np.dtype([("b", "<i4"), ("h", "<i4"), ("l", "<i4"), ("r", "<i4"), ("u", "<i8"), ("o", "<i8")])
_BR = re.compile(r"<br\s*/?>", re.I)
_TAG = re.compile(r"<[^>]+>|\[\[VIDEOID:[^\]]*\]\]")
SCHEMA = pa.schema([("book_id", pa.string()), ("asin", pa.string()), ("rating", pa.int8()), ("title", pa.string()),
                    ("text", pa.string()), ("helpful_vote", pa.int32()), ("verified", pa.bool_()),
                    ("timestamp", pa.int64()), ("user_id", pa.string())])


def log(t0: float, msg: str) -> None:
    print(f"[{time.time() - t0:7.0f} с] {msg}", flush=True)


def edition_map() -> tuple[dict[bytes, int], np.ndarray]:
    """parent_asin любого издания → номер книги каталога. Ключ склейки — тот же, что в clean.merge_editions
    (автор + название, тома не склеиваются, книга без автора приклеивается к единственной группе с тем же
    названием); главная карточка группы — та, что есть в books_clean."""
    catalog = pd.read_parquet(PROCESSED / "books_clean.parquet", columns=["parent_asin", "n_editions"])
    ids = catalog["parent_asin"].to_numpy().astype(str)
    books = pd.read_parquet(PROCESSED / "books_meta.parquet",
                            columns=["parent_asin", "title", "subtitle", "author", "categories", "details"])
    details = books["details"].map(json.loads)
    books["language"] = details.map(lambda d: d.get("Language"))
    books["format"] = [clean.extract_format(d, s) for d, s in zip(details, books["subtitle"])]
    books["categories"] = books["categories"].map(list)
    del details
    books = books[~clean.non_book_mask(books).any(axis=1)]
    books = books[~(books["language"].notna() & ~books["language"].fillna("").str.contains("English"))]

    has_author = books["author"].notna()
    tkey = books["title"].fillna("").map(clean.title_key)
    key = books["author"].fillna("").map(clean.norm_text) + " | " + tkey
    key = key.where(has_author, "noauthor | " + books["parent_asin"])
    vols = books["title"].map(clean.volumes)
    conflict = vols.groupby(key).agg(lambda v: len({x for x in v if x}) > 1)
    key = key.where(~key.map(conflict), "volume | " + books["parent_asin"])
    authored = has_author & ~key.str.startswith("volume | ")
    by_title = pd.DataFrame({"t": tkey[authored], "g": key[authored]}).drop_duplicates().groupby("t")["g"].agg(list)
    group_vols = vols[authored].groupby(key[authored]).agg(lambda v: frozenset().union(*v))
    attach = {}
    for idx, gs in tkey[~has_author].map(by_title).dropna().items():
        if len(gs) == 1 and tkey[idx] and (not vols[idx] or vols[idx] == group_vols[gs[0]]):
            attach[idx] = gs[0]
    key.update(pd.Series(attach, dtype=object))

    pos = pd.Series(np.arange(len(ids), dtype=np.int32), index=ids)
    g = pd.DataFrame({"asin": books["parent_asin"].astype(str).to_numpy(), "group": key.to_numpy()})
    g["book"] = g["asin"].map(pos)
    main = g.dropna(subset=["book"]).drop_duplicates("group").set_index("group")["book"]
    g["book"] = g["group"].map(main)
    g = g.dropna(subset=["book"])
    # Проверка: размеры групп = n_editions каталога
    sizes = g.groupby("book").size().reindex(np.arange(len(ids)), fill_value=0).to_numpy()
    ok = (sizes == catalog["n_editions"].to_numpy()).mean()
    print(f"  изданий → книг каталога: {len(g):,} → {g['book'].nunique():,}; n_editions совпадает у {ok:.2%} книг")
    return {a.encode(): int(b) for a, b in zip(g["asin"], g["book"])}, ids


def _field(line: bytes, name: bytes, start: int = 0) -> bytes | None:
    """Строковое значение "name": "…" без разбора JSON (ключи в файле — в постоянном порядке)."""
    i = line.find(name, start)
    if i < 0:
        return None
    i += len(name)
    return line[i:line.find(b'"', i)]


def pass1(amap: dict[bytes, int], t0: float) -> int:
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True)
    bufs = [[] for _ in range(N_BUCKETS)]
    files = [open(WORK / f"{k:02d}.bin", "wb") for k in range(N_BUCKETS)]
    seen = kept = off = 0

    def flush(k):
        files[k].write(np.array(bufs[k], dtype=REC).tobytes())
        bufs[k].clear()

    with open(JSONL, "rb", buffering=16 << 20) as f:
        for line in f:
            n = len(line)
            seen += 1
            p = line.rfind(b'"parent_asin": "')
            if p >= 0:
                b = amap.get(line[p + 16:line.find(b'"', p + 16)])
                if b is not None:
                    s = line.find(b'"text": "')
                    e = line.find(b'", "images": ', s)
                    rt = line.find(b'"rating": ')
                    r = int(float(line[rt + 10:line.find(b",", rt + 10)])) if rt >= 0 else 0
                    hv = line.rfind(b'"helpful_vote": ')
                    h = int(line[hv + 16:line.find(b",", hv + 16)]) if hv >= 0 else 0
                    u = _field(line, b'"user_id": "', p)
                    k = b % N_BUCKETS
                    bufs[k].append((b, h, e - s - 9 if s >= 0 and e >= 0 else 0, r, hash(u), off))
                    kept += 1
                    if len(bufs[k]) >= FLUSH:
                        flush(k)
            off += n
            if seen % 5_000_000 == 0:
                log(t0, f"проход 1: {seen / 1e6:.0f} млн строк, на книги каталога {kept / 1e6:.1f} млн, "
                        f"{off / 1e9:.1f} ГБ")
    for k in range(N_BUCKETS):
        flush(k)
        files[k].close()
    log(t0, f"проход 1 готов: {seen:,} отзывов, на книги каталога {kept:,}")
    return seen


def quotas(share: np.ndarray, n: int) -> np.ndarray:
    """Целые квоты по звёздам, сумма n, пропорционально share (метод наибольших остатков)."""
    q = share * n
    out = np.floor(q).astype(int)
    out[np.argsort(-(q - out), kind="stable")[: n - out.sum()]] += 1
    return out


def pick(stars: np.ndarray, share: np.ndarray, top: int = TOP) -> np.ndarray:
    """Индексы отобранных отзывов одной книги: stars уже по убыванию полезности. Квота звезды, которой не хватает
    отзывов, переходит к остальным — по общему порядку полезности."""
    n = min(top, len(stars))
    if len(stars) <= top:
        return np.arange(len(stars))
    q = quotas(share, n)
    taken = np.zeros(len(stars), bool)
    for star in range(5):
        idx = np.flatnonzero(stars == star + 1)[: q[star]]
        taken[idx] = True
    rest = np.flatnonzero(~taken)[: n - taken.sum()]
    taken[rest] = True
    return np.flatnonzero(taken)


def choose(t0: float) -> np.ndarray:
    """Отобранные записи (книга, смещение), по возрастанию смещения."""
    parts = []
    for k in range(N_BUCKETS):
        r = np.fromfile(WORK / f"{k:02d}.bin", dtype=REC)
        # Доли звёзд книги — по всем её отзывам (и коротким: это мнение читателей, а не материал для анализа)
        cnt = np.zeros((r["b"].max() + 1, 5))
        np.add.at(cnt, (r["b"], np.clip(r["r"], 1, 5) - 1), 1)
        r = r[r["l"] >= MIN_TEXT]
        r = r[np.lexsort((-r["l"].astype(np.int64), -r["h"].astype(np.int64), r["b"]))]
        # Один отзыв на пользователя и книгу (тот же человек на двух изданиях) — лучший по порядку выше
        d = pd.DataFrame({"b": r["b"], "u": r["u"]})
        r = r[~d.duplicated().to_numpy()]
        start = np.r_[0, np.flatnonzero(np.diff(r["b"])) + 1]
        end = np.r_[start[1:], len(r)]
        keep = []
        for a, e in zip(start, end):
            b = r["b"][a]
            keep.append(a + pick(r["r"][a:e], cnt[b] / cnt[b].sum()))
        parts.append(r[np.concatenate(keep)][["b", "o"]])
    sel = np.concatenate(parts)
    sel = sel[np.argsort(sel["o"], kind="stable")]
    log(t0, f"отобрано {len(sel):,} отзывов на {len(np.unique(sel['b'])):,} книг")
    return sel


def clean_text(t: str | None) -> str | None:
    """HTML Amazon → текст: <br /> — перенос строки, сущности (&#34;) — символы, теги и видеовставки — прочь."""
    if not t:
        return t
    return html.unescape(_TAG.sub(" ", _BR.sub("\n", t))).strip()


def pass2(sel: np.ndarray, ids: np.ndarray, t0: float) -> None:
    tmp = OUT.with_suffix(".tmp")
    writer = pq.ParquetWriter(tmp, SCHEMA, compression="zstd")
    cols = {name: [] for name in SCHEMA.names}

    def write():
        writer.write_table(pa.table(cols, schema=SCHEMA))
        for v in cols.values():
            v.clear()

    with open(JSONL, "rb") as f:
        for i, (b, o) in enumerate(zip(sel["b"], sel["o"])):
            f.seek(int(o))
            d = json.loads(f.readline())
            text = clean_text(d.get("text"))
            if not text or len(text) < MIN_TEXT:
                continue
            cols["book_id"].append(ids[b])
            cols["asin"].append(d["parent_asin"])
            cols["rating"].append(int(d["rating"]))
            cols["title"].append(d.get("title"))
            cols["text"].append(text)
            cols["helpful_vote"].append(int(d.get("helpful_vote") or 0))
            cols["verified"].append(bool(d.get("verified_purchase")))
            cols["timestamp"].append(int(d["timestamp"]))
            cols["user_id"].append(d.get("user_id"))
            if len(cols["text"]) >= BATCH:
                write()
            if (i + 1) % 1_000_000 == 0:
                log(t0, f"проход 2: {(i + 1) / 1e6:.0f} млн из {len(sel) / 1e6:.1f}")
    if cols["text"]:
        write()
    writer.close()
    tmp.replace(OUT)
    log(t0, f"готово → {OUT} ({OUT.stat().st_size / 1e9:.2f} ГБ)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["download", "select"])
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if a.cmd == "download":
        download(REMOTE, JSONL)
        return
    t0 = time.time()
    amap, ids = edition_map()
    log(t0, "склейка изданий восстановлена")
    pass1(amap, t0)
    del amap
    sel = choose(t0)
    pass2(sel, ids, t0)
    shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    main()
