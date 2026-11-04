# ML-часть

Окружение — см. CLAUDE.md в корне (uv, Python 3.11). Решения — `решения.md`, раздел 3.

## ML-сервис (FastAPI, порт 8000)

```powershell
cd ml
uv run uvicorn service.app:app --app-dir src --port 8000
uv run python src/service/check.py      # проверка запущенного сервиса: время /embed и совпадение с ноутбуком
```

- Адрес — `http://127.0.0.1:8000` (uvicorn слушает только IPv4; через `localhost` Windows сначала пробует IPv6,
  и запрос идёт 250–400 мс вместо ~40).
- `POST /embed` `{ "texts": ["..."] }` → `{ "model", "dim", "vectors" }` — векторы запросов (до 64 текстов),
  нормированы, сравнивать с `data/processed/book_embeddings.parquet` скалярным произведением.
- `GET /health` → `{ "status", "model", "dim", "device" }`.
- Переменные окружения: `ML_MODEL` (по умолчанию `e5-base`), `ML_DEVICE` (`cpu` | `cuda` | `auto`, по умолчанию `cpu`),
  `ML_THREADS` (потоки torch на процессоре, по умолчанию 4).
