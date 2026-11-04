"""Проверка запущенного ML-сервиса: /health, время /embed и совпадение с векторами ноутбука 04.

    uv run python src/service/check.py [--url http://127.0.0.1:8000]

Вектор из сервиса сравнивается с тем, что считает content.embeddings.encode (путь ноутбука), и по каждому запросу —
топ-10 книг поиска по каталогу (без книг «из одного названия», как в book_embeddings.parquet).
"""

import argparse
import json
import statistics
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")   # консоль Windows (cp1251) не печатает казахские буквы
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from content.embeddings import MODELS, catalog, encode, load_books  # noqa: E402
from eval.search import informative, search_vectors  # noqa: E402

QUERIES = ["грокаем алгоритмы", "a cozy mystery set in a small English village", "Гарри Поттер және философиялық тас"]


def call(url: str, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:8000")
    p.add_argument("--repeat", type=int, default=30)
    a = p.parse_args()

    health = call(a.url, "/health")
    print("health:", health)
    key = next(k for k, m in MODELS.items() if m["name"] == health["model"])

    call(a.url, "/embed", {"texts": QUERIES[:1]})   # прогрев
    times = []
    for i in range(a.repeat):
        t0 = time.perf_counter()
        call(a.url, "/embed", {"texts": [QUERIES[i % len(QUERIES)]]})
        times.append((time.perf_counter() - t0) * 1000)
    print(f"/embed, один запрос, тёплый: медиана {statistics.median(times):.1f} мс, "
          f"мин {min(times):.1f}, макс {max(times):.1f} (вместе с HTTP)")

    resp = call(a.url, "/embed", {"texts": QUERIES})
    service = np.array(resp["vectors"], dtype=np.float32)
    assert resp["dim"] == service.shape[1] == len(catalog(key)[0]), "размерность не совпадает с каталогом"
    notebook = encode(key, QUERIES, "query")
    books = load_books(["parent_asin", "features", "categories"])
    vecs = catalog(key)
    allowed = informative(books)
    ids = books["parent_asin"].to_numpy()
    top_s = search_vectors(service, vecs, ids, 10, allowed=allowed)
    top_n = search_vectors(notebook, vecs, ids, 10, allowed=allowed)
    ok = True
    for q, s, n, ts, tn in zip(QUERIES, service, notebook, top_s, top_n):
        same = len(set(ts) & set(tn))
        ok &= same >= 9 and float(s @ n) > 0.999
        print(f"«{q}»: норма {np.linalg.norm(s):.4f}, косинус с ноутбуком {float(s @ n):.5f}, "
              f"топ-10 совпадает {same}/10, порядок {'тот же' if list(ts) == list(tn) else 'другой'}")
    print("OK" if ok else "РАСХОЖДЕНИЕ")
    sys.exit(0 if ok else 1)
