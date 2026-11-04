"""Эксперимент E5 (решения.md 3.5, 3.7): поиск сайта — обычный / смысловой / гибридный — на тестовых запросах.

Бьёт в GET /api/search бэкенда (mode=keyword|semantic|hybrid), выдача — первые 10 книг. Метрики и разметка — те же,
что в ноутбуке 04 (search_queries.json, eval/search.py). Для сверки — точный перебор e5-base, как в ноутбуке:
разница со «смысловым» сайта — потери HNSW-индекса pgvector и фильтров.

    uv run python src/eval/search_backend.py [--url http://127.0.0.1:3000/api]

Бэкенд и ML-сервис должны быть запущены; адрес — 127.0.0.1, не localhost (на Windows через localhost в разы медленнее).
"""

import argparse
import json
import statistics
import sys
import time
import urllib.parse
import urllib.request
import warnings
from pathlib import Path

import pandas as pd

sys.stdout.reconfigure(encoding="utf-8")
warnings.filterwarnings("ignore")   # группы в регулярках правил разметки — pandas предупреждает, на результат не влияет
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from content.embeddings import catalog, encode, load_books  # noqa: E402
from eval.metrics import paired_bootstrap  # noqa: E402
from eval.search import evaluate_search, informative, load_queries, resolve, search_vectors, summary  # noqa: E402

MODES = ["keyword", "semantic", "hybrid"]
REFERENCE = "e5-base"
ORDER = ["все", "en", "ru", "kk", "title", "author", "topic", "typo"]
REPORTS = Path(__file__).resolve().parents[2] / "reports" / "metrics"
K = 10


def search(url: str, q: str, mode: str) -> tuple[dict, float]:
    """mode: keyword | semantic | hybrid, или hybrid@<вес> — вес смыслового списка в RRF (semWeight бэкенда; auto)."""
    mode, _, weight = mode.partition("@")
    params = {"q": q, "mode": mode, "limit": K} | ({"semWeight": weight} if weight else {})
    query = urllib.parse.urlencode(params)
    t0 = time.perf_counter()
    with urllib.request.urlopen(f"{url}/search?{query}", timeout=120) as r:
        body = json.loads(r.read())
    return body, (time.perf_counter() - t0) * 1000


def run_backend(url: str, queries: list[dict], modes: list[str] = MODES) -> tuple[dict, pd.DataFrame]:
    results, log = {m: {} for m in modes}, []
    for mode in modes:
        search(url, queries[0]["query"], mode)   # прогрев
        for q in queries:
            try:
                body, ms = search(url, q["query"], mode)
                results[mode][q["id"]] = [b["id"] for b in body["items"]]
                log.append({"id": q["id"], "режим": mode, "ответил": body["mode"], "мс": ms, "найдено": body["total"]})
            except Exception as e:   # ошибка одного запроса не останавливает прогон — выдача пустая
                results[mode][q["id"]] = []
                log.append({"id": q["id"], "режим": mode, "ответил": f"ошибка: {e}", "мс": None, "найдено": None})
    return results, pd.DataFrame(log)


def run_reference(queries: list[dict], books: pd.DataFrame) -> dict:
    vecs = encode(REFERENCE, [q["query"] for q in queries], "query")
    found = search_vectors(vecs, catalog(REFERENCE), books["parent_asin"].to_numpy(), K, allowed=informative(books))
    return {q["id"]: f for q, f in zip(queries, found)}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:3000/api")
    p.add_argument("--modes", default=",".join(MODES),
                   help="через запятую, например keyword,hybrid или hybrid@1,hybrid@2,hybrid@auto")
    p.add_argument("--tag", default="", help="суффикс файлов результатов, например _semweight")
    a = p.parse_args()

    queries = load_queries()
    books = load_books(["parent_asin", "title", "author", "features", "categories"])
    relevant = resolve(queries, books)
    modes = a.modes.split(",")
    results, log = run_backend(a.url, queries, modes)
    results[f"{REFERENCE} (ноутбук)"] = run_reference(queries, books)

    log["ok"] = log["ответил"] == log["режим"].str.partition("@")[0]
    bad = log[~log["ok"]]
    if len(bad):
        print(f"ВНИМАНИЕ: {len(bad)} ответов не в том режиме или с ошибкой (ML-сервис недоступен → keyword):")
        print(bad.groupby(["режим", "ответил"]).size().to_string())

    per_query = {name: evaluate_search(res, queries, relevant).set_index("id") for name, res in results.items()}
    rows = [summary(pq.reset_index()).reindex(ORDER).assign(поиск=name).rename_axis("срез").reset_index()
            for name, pq in per_query.items()]
    table = pd.concat(rows)
    wide = table.pivot_table(index="срез", columns="поиск", values=["Recall@10", "MRR"], sort=False).reindex(ORDER)
    wide.insert(0, "запросов", summary(next(iter(per_query.values())).reset_index())["запросов"].reindex(ORDER))
    pd.options.display.float_format = "{:.3f}".format
    pd.options.display.width = 200
    print("\nRecall@10 и MRR по срезам:")
    print(wide.to_string())

    pairs = [("hybrid", "keyword"), ("hybrid", "semantic"), ("semantic", "keyword"), ("semantic", f"{REFERENCE} (ноутбук)")]
    pairs += [(m, "hybrid@1") for m in modes if m.startswith("hybrid@") and m != "hybrid@1"]
    sig = []
    for x, y in [(x, y) for x, y in pairs if x in per_query and y in per_query]:
        for m in ["Recall@10", "MRR"]:
            r = paired_bootstrap(per_query[x][m], per_query[y][m])
            sig.append({"сравнение": f"{x} − {y}", "метрика": m, "разница": round(r["разница"], 3),
                        "95% ДИ": f"{r['low']:+.3f} … {r['high']:+.3f}",
                        "значимо": "да" if r["low"] > 0 or r["high"] < 0 else "нет"})
    if sig:
        print("\nЗначимость (парный bootstrap по запросам):")
        print(pd.DataFrame(sig).to_string(index=False))

    # Смысловой сайта против точного перебора: сколько из топ-10 совпадает (потери HNSW, фильтров, неполной загрузки)
    if "semantic" in results:
        ref = results[f"{REFERENCE} (ноутбук)"]
        same = pd.Series({i: len(set(results["semantic"][i]) & set(ref[i])) for i in ref})
        print(f"\nsemantic и точный перебор: в среднем {same.mean():.1f} из 10 книг совпадают; "
              f"меньше 7 — у {(same < 7).sum()} запросов: {', '.join(same[same < 7].index)}")

    ok = log[log["ok"]]
    print("\nВремя ответа /api/search (тёплый, первые 10, вместе с HTTP), мс:")
    for mode in modes:
        ms = ok.loc[ok["режим"] == mode, "мс"]
        if len(ms):
            print(f"  {mode:8} медиана {statistics.median(ms):.0f}, 90-й перцентиль {ms.quantile(0.9):.0f}, макс {ms.max():.0f}")

    out = REPORTS / f"search_backend{a.tag}"
    table.to_csv(f"{out}.csv", index=False, encoding="utf-8")
    pq_tab = pd.concat({name: pq["Recall@10"] for name, pq in per_query.items()}, axis=1)
    pq_tab.insert(0, "запрос", [q["query"] for q in queries])
    pq_tab.to_csv(f"{out}_per_query.csv", encoding="utf-8")
    log.drop(columns="ok").to_csv(f"{out}_timing.csv", index=False, encoding="utf-8")
    print(f"\nзаписано: {out}.csv, …_per_query.csv, …_timing.csv")
