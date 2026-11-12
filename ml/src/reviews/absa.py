"""E6, шаг 5: подходы к разметке предложений отзывов — аспект + тональность (решения.md 3.6).

1. nli      — аспект: zero-shot NLI (гипотеза «предложение о …» на каждую метку типа книги), тональность — готовая
               модель тональности предложения (без учёта аспекта);
2. absa     — аспект: тот же NLI, тональность — ABSA-модель, обусловленная аспектом (предложение + название аспекта);
3. llm      — маленькая LLM (~3B, 4 бита): аспект(ы) и тональность одним ответом в JSON.
Все модели — по одной на видеокарте (6 ГБ), fp16; память освобождается между подходами (free()).
"""

import gc
import json
import re
import time

import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from reviews.aspects import labels

NLI_MODEL = "MoritzLaurer/deberta-v3-base-zeroshot-v2.0"
SENT_MODEL = "cardiffnlp/twitter-roberta-base-sentiment-latest"
ABSA_MODEL = "yangheng/deberta-v3-base-absa-v1.1"
TEMPLATE = "This sentence from a book review is about {}."
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
SECOND = 0.5     # второй аспект — если его вероятность «да» ≥ порога (и это не служебная метка)
SERVICE = {"none", "overall", "delivery"}
# Название аспекта для ABSA-модели (короткое, как термин в предложении)
ASPECT_TERM = {"plot": "plot", "characters": "characters", "style": "writing", "pace": "pacing", "ending": "ending",
               "world": "setting", "clarity": "explanations", "usefulness": "advice", "depth": "detail",
               "accuracy": "facts", "relevance": "information", "author_view": "author", "engagement": "book",
               "editing": "editing", "illustrations": "illustrations", "audience": "book", "edition": "print",
               "none": "book", "overall": "book", "delivery": "delivery"}


def free(*models):
    for m in models:
        del m
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _load(name, tokenizer: str | None = None):
    tok = AutoTokenizer.from_pretrained(tokenizer or name)
    model = AutoModelForSequenceClassification.from_pretrained(name, dtype=torch.float16).to(DEVICE).eval()
    return tok, model


@torch.inference_mode()
def _logits(tok, model, a: list[str], b: list[str] | None = None, batch: int = 64, max_len: int = 160) -> np.ndarray:
    order = np.argsort([len(x) for x in a])          # пачки по длине — меньше паддинга
    out = np.zeros((len(a), model.config.num_labels), np.float32)
    for s in range(0, len(a), batch):
        idx = order[s:s + batch]
        enc = tok([a[i] for i in idx], [b[i] for i in idx] if b is not None else None, truncation=True,
                  max_length=max_len, padding=True, return_tensors="pt").to(DEVICE)
        out[idx] = model(**enc).logits.float().cpu().numpy()
    return out


class NLIAspects:
    """Аспект предложения — метка с наибольшей вероятностью «следует» среди меток типа книги.

    hyps — свои гипотезы для части меток ({код: текст гипотезы}), bias — сдвиг к вероятности метки при выборе
    (подбираются на половине эталона «подстройка», reviews/tune_nli.py), second — порог второго аспекта."""

    def __init__(self, name: str = NLI_MODEL, hyps: dict | None = None, bias: dict | None = None,
                 second: float = SECOND):
        self.tok, self.model = _load(name)
        l2i = {k.lower(): v for k, v in self.model.config.label2id.items()}
        self.ent = l2i.get("entailment", 0)
        self.hyps, self.bias, self.second = hyps or {}, bias or {}, second

    def hypothesis(self, code: str, desc: str) -> str:
        return self.hyps.get(code) or TEMPLATE.format(desc)

    def scores(self, sents: list[str], kinds: list[str]) -> list[dict[str, float]]:
        """Вероятность «следует» для каждой метки типа книги."""
        pairs_a, pairs_b, owner = [], [], []
        for i, (s, k) in enumerate(zip(sents, kinds)):
            for code, (_, desc) in labels(k).items():
                pairs_a.append(s)
                pairs_b.append(self.hypothesis(code, desc))
                owner.append((i, code))
        lg = _logits(self.tok, self.model, pairs_a, pairs_b, batch=128)
        p = torch.softmax(torch.from_numpy(lg), -1).numpy()[:, self.ent]
        res = [{} for _ in sents]
        for (i, code), score in zip(owner, p):
            res[i][code] = float(score)
        return res

    def __call__(self, sents: list[str], kinds: list[str]) -> list[list[tuple[str, float]]]:
        return [decide(r, self.bias, self.second) for r in self.scores(sents, kinds)]


def decide(r: dict[str, float], bias: dict | None = None, second: float = SECOND) -> list[tuple[str, float]]:
    """Правило выбора по вероятностям меток: главный — max(p + сдвиг), второй — если p ≥ second (не служебные)."""
    bias = bias or {}
    ranked = sorted(r.items(), key=lambda x: -(x[1] + bias.get(x[0], 0.0)))
    top = [ranked[0]]
    if len(ranked) > 1 and ranked[1][1] >= second and ranked[1][0] not in SERVICE and ranked[0][0] not in SERVICE:
        top.append(ranked[1])
    return top


class SentenceSentiment:
    """Тональность предложения целиком (без аспекта)."""

    def __init__(self, name: str = SENT_MODEL):
        self.tok, self.model = _load(name)
        self.map = {i: l.lower()[:3] for i, l in self.model.config.id2label.items()}   # negative → neg …

    def __call__(self, sents: list[str]) -> list[str]:
        lg = _logits(self.tok, self.model, sents, batch=128, max_len=128)
        return [self.map[i] for i in lg.argmax(1)]


class AspectSentiment:
    """Тональность к аспекту: ABSA-модель получает пару (предложение, термин аспекта)."""

    def __init__(self, name: str = ABSA_MODEL):
        # В репозитории ABSA нет tokenizer.json, а сборка из spm в transformers 5 требует tiktoken; модель дообучена
        # из deberta-v3-base — берём тот же токенизатор (словарь общий) из NLI-модели
        self.tok, self.model = _load(name, tokenizer=NLI_MODEL)
        self.map = {i: l.lower()[:3] for i, l in self.model.config.id2label.items()}

    def __call__(self, sents: list[str], aspects: list[str]) -> list[str]:
        lg = _logits(self.tok, self.model, sents, [ASPECT_TERM.get(a, "book") for a in aspects], batch=128)
        return [self.map[i] for i in lg.argmax(1)]


def run_nli(sents, kinds, nli_kw: dict | None = None) -> tuple[list[dict], float]:
    """Подход 1. Возвращает разметку и время (с), без загрузки моделей. nli_kw — hyps / bias из подстройки."""
    asp = NLIAspects(**(nli_kw or {}))
    sen = SentenceSentiment()
    t = time.perf_counter()
    a = asp(sents, kinds)
    s = sen(sents)
    dt = time.perf_counter() - t
    free(asp, sen)
    out = []
    for top, ss in zip(a, s):
        out.append({"aspect": top[0][0], "sentiment": "neu" if top[0][0] == "none" else ss,
                    "aspect_2": top[1][0] if len(top) > 1 else "", "sentiment_2": ss if len(top) > 1 else "",
                    "score": top[0][1]})
    return out, dt


def run_absa(sents, kinds, aspects: list[dict] | None = None, nli_kw: dict | None = None) -> tuple[list[dict], float]:
    """Подход 2: аспекты — из NLI (можно передать готовые из подхода 1, тогда время NLI прибавляется отдельно)."""
    t_nli = 0.0
    if aspects is None:
        asp = NLIAspects(**(nli_kw or {}))
        t = time.perf_counter()
        a = asp(sents, kinds)
        t_nli = time.perf_counter() - t
        free(asp)
        aspects = [{"aspect": x[0][0], "aspect_2": x[1][0] if len(x) > 1 else "", "score": x[0][1]} for x in a]
    absa = AspectSentiment()
    t = time.perf_counter()
    s1 = absa(sents, [x["aspect"] for x in aspects])
    idx2 = [i for i, x in enumerate(aspects) if x["aspect_2"]]
    s2 = absa([sents[i] for i in idx2], [aspects[i]["aspect_2"] for i in idx2]) if idx2 else []
    dt = time.perf_counter() - t + t_nli
    free(absa)
    out = [{"aspect": x["aspect"], "sentiment": "neu" if x["aspect"] == "none" else s, "aspect_2": x["aspect_2"],
            "sentiment_2": "", "score": x["score"]} for x, s in zip(aspects, s1)]
    for i, s in zip(idx2, s2):
        out[i]["sentiment_2"] = s
    return out, dt
