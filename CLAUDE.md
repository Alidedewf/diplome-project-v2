# Рекомендательная система книг — дипломный проект

ML-часть на Python (модели рекомендаций, поиск по смыслу, анализ отзывов) + сайт на Node.js (Express, Prisma, PostgreSQL + pgvector) и React. ML отдаётся сайту через отдельный сервис на FastAPI.

Данные: Amazon Reviews 2023 (McAuley Lab), категория Books.

## Решения

**Все решения по проекту фиксируются в [решения.md](решения.md).** Перед работой читать соответствующий раздел; новое или изменённое решение — сразу записывать туда (со статусом: принято / черновик / открыто).

## Правила работы

- После каждого шага — отчёт, проверка, затем коммит и пуш **только по команде автора**.
- Данные (`data/`) и модели (`models/`) в git не попадают.
- Remote: `origin` → https://github.com/Alidedewf/diplome-project-v2.git, основная ветка `main`.

## Структура

```
ml/              Python: ML-окружение (uv, Python 3.11)
  notebooks/     Jupyter-ноутбуки (EDA, эксперименты)
  src/           переиспользуемый код
  pyproject.toml зависимости (менять через `uv add` / `uv remove`)
data/            данные, не в git
  raw/           исходные файлы
  processed/     очищенные данные (Parquet)
models/          обученные модели, не в git
backend/         Node.js (позже)
frontend/        React (позже)
решения.md       журнал решений
```

## ML-окружение

Отдельное окружение на Python 3.11 в `ml/.venv` (системный Python 3.13 не используется — часть ML-библиотек на нём не ставится). Менеджер — [uv](https://docs.astral.sh/uv/), установлен в `~/.local/bin`.

```powershell
cd ml
uv sync                      # восстановить окружение из uv.lock
.venv\Scripts\activate       # активировать (PowerShell)
uv run python script.py      # или запускать без активации
uv run jupyter lab
```

- PyTorch ставится с CUDA (индекс `pytorch-cu128` в `pyproject.toml`). Видеокарта: RTX 3050 6GB Laptop.
- Новые зависимости — только через `uv add <пакет>`, чтобы они попадали в `pyproject.toml` и `uv.lock`.
- Ограничения версий из-за RecTools: `numpy < 2`, `pandas < 3`, `pyarrow < 22`. Зависимости фиксируются только для Windows и Linux.
- LightFM не используется (не ставится на Windows) — см. решения.md, 3.2.
- Большие данные: сырые JSONL читать потоково, хранить в Parquet, ID — `int32`, матрицы — разреженные.
