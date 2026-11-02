"""Загрузка данных Amazon Reviews 2023 (Books): оценки 5-core и метаданные книг.

Запуск из папки ml/:
    uv run python src/data/download.py ratings   # оценки 5-core -> ratings_5core.parquet
    uv run python src/data/download.py meta      # скачать meta_Books.jsonl (14,7 ГБ, с докачкой)
    uv run python src/data/download.py extract   # метаданные книг из 5-core -> books_meta.parquet
    uv run python src/data/download.py report    # проверка результата
"""

import argparse
import json
import os
import random
import re
import shutil
import sys
import time
from pathlib import Path

# Загрузка через xet без токена HF шла ~0,1 МБ/с, обычный HTTP — ~5 МБ/с; к тому же HTTP докачивает с места обрыва
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[3]
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"

REPO_ID = "McAuley-Lab/Amazon-Reviews-2023"
RATINGS_REMOTE = "benchmark/5core/rating_only/Books.csv"
META_REMOTE = "raw/meta_categories/meta_Books.jsonl"

RATINGS_CSV = RAW / "Books_5core.csv"
META_JSONL = RAW / "meta_Books.jsonl"
RATINGS_PARQUET = PROCESSED / "ratings_5core.parquet"
META_PARQUET = PROCESSED / "books_meta.parquet"

META_SCHEMA = pa.schema([
    ("parent_asin", pa.string()),
    ("title", pa.string()),
    ("subtitle", pa.string()),
    ("author", pa.string()),
    ("average_rating", pa.float32()),
    ("rating_number", pa.int32()),
    ("features", pa.list_(pa.string())),
    ("description", pa.list_(pa.string())),
    ("categories", pa.list_(pa.string())),
    ("image", pa.string()),
    ("details", pa.string()),
    ("store", pa.string()),
    ("price", pa.float32()),
])
CHUNK_ROWS = 50_000
PARENT_ASIN_RE = re.compile(r'"parent_asin":\s*"([^"]+)"')


def download(remote: str, target: Path, retries: int = 20) -> Path:
    """Скачивает файл из датасета в target. При обрыве повторяет: уже скачанное не качается заново."""
    if target.exists():
        print(f"Уже скачан: {target} ({target.stat().st_size / 1e9:.2f} ГБ)")
        return target
    for attempt in range(1, retries + 1):
        try:
            path = hf_hub_download(REPO_ID, remote, repo_type="dataset", local_dir=RAW)
            break
        except Exception as e:  # сетевые ошибки бывают разные — просто пробуем снова
            print(f"Обрыв ({type(e).__name__}: {e}), попытка {attempt}/{retries} через 30 с", flush=True)
            time.sleep(30)
    else:
        sys.exit(f"Не удалось скачать {remote}")
    # hf_hub_download повторяет структуру папок репозитория — переносим файл прямо в data/raw/
    shutil.move(path, target)
    shutil.rmtree(RAW / remote.split("/")[0], ignore_errors=True)
    print(f"Скачан: {target} ({target.stat().st_size / 1e9:.2f} ГБ)")
    return target


def cmd_ratings() -> None:
    download(RATINGS_REMOTE, RATINGS_CSV)
    df = pd.read_csv(
        RATINGS_CSV,
        dtype={"user_id": "string", "parent_asin": "string", "rating": "float32", "timestamp": "int64"},
    )
    df["rating"] = df["rating"].astype("int8")

    # Amazon Reviews 2023 хранит время в миллисекундах; проверяем по величине (секунды сейчас ~1.7e9)
    ts_max = df["timestamp"].max()
    unit = "ms" if ts_max > 1e11 else "s"

    PROCESSED.mkdir(parents=True, exist_ok=True)
    df.to_parquet(RATINGS_PARQUET, index=False)

    dates = pd.to_datetime(df["timestamp"], unit=unit)
    print(f"\nСохранено: {RATINGS_PARQUET}")
    print(f"Строк:          {len(df):,}")
    print(f"Пользователей:  {df['user_id'].nunique():,}")
    print(f"Книг:           {df['parent_asin'].nunique():,}")
    print(f"timestamp:      единицы = {unit} (max = {ts_max})")
    print(f"Даты:           {dates.min()} — {dates.max()}")
    print("Оценки:")
    counts = df["rating"].value_counts().sort_index()
    for r, n in counts.items():
        print(f"  {r}: {n:>12,}  ({n / len(df):.1%})")


def cmd_meta() -> None:
    download(META_REMOTE, META_JSONL)


def largest_image(images: list | None) -> str | None:
    """Ссылка на самую крупную обложку: hi_res > large > thumb, приоритет у основной (MAIN)."""
    if not images:
        return None
    images = sorted(images, key=lambda im: im.get("variant") != "MAIN")
    for key in ("hi_res", "large", "thumb"):
        for im in images:
            if im.get(key):
                return im[key]
    return None


def to_float(value) -> float | None:
    try:
        return float(str(value).replace("$", "").replace(",", ""))
    except (TypeError, ValueError):
        return None


def parse_meta(rec: dict) -> dict:
    author = rec.get("author")
    return {
        "parent_asin": rec["parent_asin"],
        "title": rec.get("title") or None,
        "subtitle": rec.get("subtitle") or None,
        "author": (author or {}).get("name") or None,
        "average_rating": rec.get("average_rating"),
        "rating_number": rec.get("rating_number"),
        "features": rec.get("features") or [],
        "description": rec.get("description") or [],
        "categories": rec.get("categories") or [],
        "image": largest_image(rec.get("images")),
        "details": json.dumps(rec.get("details") or {}, ensure_ascii=False),
        "store": rec.get("store") or None,
        "price": to_float(rec.get("price")),
    }


def cmd_extract() -> None:
    if not META_JSONL.exists():
        sys.exit("Сначала скачайте метаданные: download.py meta")
    wanted = set(pd.read_parquet(RATINGS_PARQUET, columns=["parent_asin"])["parent_asin"].unique())
    print(f"Книг в 5-core: {len(wanted):,}")

    tmp = META_PARQUET.with_suffix(".parquet.tmp")
    seen, buffer, total = set(), [], 0
    with open(META_JSONL, "rb") as f, pq.ParquetWriter(tmp, META_SCHEMA) as writer, tqdm(
        total=META_JSONL.stat().st_size, unit="B", unit_scale=True, desc="meta_Books.jsonl", mininterval=5
    ) as bar:
        for line in f:
            bar.update(len(line))
            # parent_asin достаём регуляркой: полный json.loads только для нужных строк — в разы быстрее
            m = PARENT_ASIN_RE.search(line.decode("utf-8", errors="replace"))
            if not m or m.group(1) not in wanted or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            buffer.append(parse_meta(json.loads(line)))
            if len(buffer) >= CHUNK_ROWS:
                writer.write_table(pa.Table.from_pylist(buffer, schema=META_SCHEMA))
                total += len(buffer)
                buffer.clear()
        if buffer:
            writer.write_table(pa.Table.from_pylist(buffer, schema=META_SCHEMA))
            total += len(buffer)
    tmp.replace(META_PARQUET)
    print(f"Сохранено: {META_PARQUET} — {total:,} книг")


def cmd_report() -> None:
    ratings_books = pd.read_parquet(RATINGS_PARQUET, columns=["parent_asin"])["parent_asin"].nunique()
    meta = pd.read_parquet(META_PARQUET)

    print(f"Книг из 5-core найдено в метаданных: {len(meta):,} из {ratings_books:,} ({len(meta) / ratings_books:.1%})")
    print("\nДоля пустых значений:")
    empty = {
        "title": meta["title"].isna() | (meta["title"].str.strip() == ""),
        "author": meta["author"].isna(),
        "description": meta["description"].map(lambda x: len(x) == 0 or not "".join(x).strip()),
        "categories": meta["categories"].map(len) == 0,
        "images": meta["image"].isna(),
    }
    for col, mask in empty.items():
        print(f"  {col:12} {mask.mean():6.1%}  ({mask.sum():,})")

    print("\n3 случайные записи:")
    for i in random.Random(42).sample(range(len(meta)), 3):
        rec = meta.iloc[i].to_dict()
        rec = {k: (list(v) if hasattr(v, "tolist") else v) for k, v in rec.items()}
        rec["details"] = json.loads(rec["details"])
        print(json.dumps(rec, ensure_ascii=False, indent=2, default=str))

    print("\nРазмеры файлов:")
    for p in (RATINGS_PARQUET, META_PARQUET):
        print(f"  {p.name:24} {p.stat().st_size / 1e6:8.1f} МБ")


if __name__ == "__main__":
    commands = {"ratings": cmd_ratings, "meta": cmd_meta, "extract": cmd_extract, "report": cmd_report}
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=commands)
    commands[parser.parse_args().command]()
