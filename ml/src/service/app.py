"""ML-сервис для сайта — решения.md, 3.8: эмбеддинги запросов для смыслового поиска (3.5) и лента «Для вас» (3.3).

Вектор запроса считается так же, как в ноутбуке 04 и при выгрузке каталога (content/embeddings.py):
префикс «query: », обрезка до max_len токенов, нормировка. Каталог — data/processed/book_embeddings.parquet.

    cd ml
    uv run uvicorn service.app:app --app-dir src --port 8000

Переменные окружения:
    ML_MODEL    ключ модели из content/embeddings.py: MODELS (по умолчанию e5-base — как в book_embeddings.parquet)
    ML_DEVICE   cpu | cuda | auto (по умолчанию cpu)
    ML_THREADS  потоки torch на процессоре (по умолчанию 4: при 8 = числу логических ядер запрос в разы медленнее)
    ML_RECO     папка артефактов рекомендаций (serve/build.py) или latest — последняя в models/serve; не задана —
                POST /recommend отвечает 503 (рекомендатель занимает несколько ГБ памяти, включается явно)
"""

import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import pandas as pd
import torch
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

from content.embeddings import MODELS

KEY = os.environ.get("ML_MODEL", "e5-base")
DEVICE = os.environ.get("ML_DEVICE", "cpu")
THREADS = int(os.environ.get("ML_THREADS", "4"))
MAX_TEXTS = 64
RECO = os.environ.get("ML_RECO")
MAX_EVENTS = 300

state = {}
_lock = threading.Lock()   # запросы по одному: параллельные вызовы делят те же потоки и только мешают друг другу


def load(key: str = KEY, device: str = DEVICE) -> SentenceTransformer:
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.set_num_threads(THREADS)
    model = SentenceTransformer(MODELS[key]["name"], device=device)
    model.max_seq_length = MODELS[key]["max_len"]
    if device == "cuda":
        model.half()   # каталог тоже считался в fp16 на видеокарте
    model.encode([MODELS[key]["query"] + "прогрев"])
    return model


def embed_texts(model: SentenceTransformer, texts: list[str], key: str = KEY) -> list[list[float]]:
    prefix = MODELS[key]["query"]
    with _lock:
        vecs = model.encode([prefix + t for t in texts], normalize_embeddings=True, convert_to_numpy=True)
    return vecs.astype("float32").tolist()


@asynccontextmanager
async def lifespan(app: FastAPI):
    model = load()
    state.update(model=model, name=MODELS[KEY]["name"], dim=model.get_embedding_dimension(),
                 device=str(model.device))
    if RECO:
        from serve.recommender import Recommender
        root = Path(__file__).resolve().parents[3] / "models" / "serve"
        path = max(root.iterdir(), key=lambda p: p.stat().st_mtime) if RECO == "latest" else Path(RECO)
        state["reco"] = Recommender(path)
    yield
    state.clear()


app = FastAPI(title="ML-сервис рекомендаций книг", lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_TEXTS)


class EmbedResponse(BaseModel):
    model: str
    dim: int
    vectors: list[list[float]]


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    return {"model": state["name"], "dim": state["dim"], "vectors": embed_texts(state["model"], req.texts)}


class Event(BaseModel):
    bookId: str
    kind: str = Field(default="rating", pattern="^(rating|like|read|want|dislike|hide)$")
    value: int | None = Field(default=None, ge=1, le=5)
    at: str | None = None


class RecommendRequest(BaseModel):
    events: list[Event] = Field(max_length=MAX_EVENTS)
    exclude: list[str] = []
    n: int = Field(default=50, ge=1, le=100)


@app.post("/recommend")
def recommend(req: RecommendRequest):
    """Лента «Для вас»: [{bookId, score, reasons}]; 204 — у пользователя нет истории, которую знают модели."""
    reco = state.get("reco")
    if reco is None:
        raise HTTPException(503, "рекомендатель не загружен (ML_RECO)")
    with _lock:
        out = reco.recommend([e.model_dump() for e in req.events], exclude=req.exclude, n=req.n,
                             now=pd.Timestamp.now(tz="UTC").tz_convert(None))
    if out is None:
        return Response(status_code=204)
    return out


@app.get("/health")
def health():
    reco = state.get("reco")
    return {"status": "ok", "model": state["name"], "dim": state["dim"], "device": state["device"],
            "reco": reco.meta["name"] if reco else None}
