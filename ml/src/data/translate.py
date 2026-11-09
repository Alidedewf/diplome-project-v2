"""Машинный перевод аннотаций en→ru для популярных книг — решения.md, 2.8 («Доработки после теста автора», п. 5).

Аннотация — как на карточке сайта (backend/scripts/load-books.js): features через пробел, пробелы схлопнуты,
длиннее 5000 символов — обрезка по слову. Переводятся книги с n_ratings ≥ 50; русская Википедия у бэкенда в
приоритете, он сам не перетирает её переводом. Текст режется на предложения, одинаковые предложения переводятся
один раз (в аннотациях много повторов: «#1 New York Times bestselling author…»), пачки — по длине.

    uv run python src/data/translate.py --compare 30           # opus-mt против NLLB на 30 аннотациях
    uv run python src/data/translate.py opus-mt                # весь прогон → data/processed/annotations_ru.parquet

Переведённые предложения складываются в data/processed/translations/<модель>.parquet — прерванный прогон
продолжается с места остановки.
"""

import argparse
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
PROCESSED = ROOT / "data" / "processed"
CACHE = PROCESSED / "translations"
OUT = PROCESSED / "annotations_ru.parquet"

MIN_RATINGS = 50
ANNOTATION_MAX = 5000  # как в load-books.js
MAX_WORDS = 60  # длиннее — режем по «;», «:», запятым, иначе по словам (модели обучены на предложениях)

MODELS = {
    "opus-mt": {"name": "Helsinki-NLP/opus-mt-en-ru"},
    "nllb": {"name": "facebook/nllb-200-distilled-600M", "src": "eng_Latn", "tgt": "rus_Cyrl"},
}


def annotation(features) -> str:
    if features is None or len(features) == 0:
        return ""
    text = re.sub(r"\s+", " ", " ".join(features)).strip()
    if len(text) > ANNOTATION_MAX:
        text = re.sub(r"\s+\S*$", "", text[: ANNOTATION_MAX - 1]).rstrip() + "…"
    return text


def fix_broken(text: str) -> str:
    """«�» в исходных данных — потерянные при выгрузке кавычки и тире: между буквами — апостроф, иначе тире."""
    text = re.sub(r"(?<=\w)�(?=\w)", "’", text)
    return text.replace("�", "—")


# Конец предложения: знак + пробел + заглавная; или склейка абзацев без пробела («once more.Against»)
_SENT = re.compile(r"(?<!Mr\.)(?<!Ms\.)(?<!Dr\.)(?<!St\.)(?<!Mrs\.)(?<!Jr\.)(?<=[.!?…])[\"”’)]*\s+(?=[\"“‘(]?[A-Z0-9#])|(?<=[a-z][.!?])(?=[A-Z][a-z])")


def sentences(text: str) -> list[str]:
    out = []
    for s in _SENT.split(text):
        s = s.strip()
        if not s:
            continue
        words = s.split()
        if len(words) <= MAX_WORDS:
            out.append(s)
            continue
        # Длинное «предложение» (часто — склеенные без точки абзацы): режем по знакам, затем по словам
        parts, cur = [], []
        for w in words:
            cur.append(w)
            if len(cur) >= MAX_WORDS or (len(cur) >= 20 and w[-1] in ";:"):
                parts.append(" ".join(cur))
                cur = []
        if cur:
            parts.append(" ".join(cur))
        out.extend(parts)
    return out


# Отрезки капсом из 3+ слов («#1 NEW YORK TIMES BESTSELLER», «NAMED ONE OF THE BEST BOOKS…») модель калечит
# («БЕСТЕЛЕР», «NYYORK»); перед переводом они приводятся к виду «Каждое Слово С Заглавной» — имена при этом остаются
# с заглавной буквы. Ключ кэша — исходное предложение.
_CAPS = re.compile(r"(?:\b[A-Z][A-Z'’.&-]+\b[\s,•:#0-9-]*){3,}")


def decaps(text: str) -> str:
    return _CAPS.sub(lambda m: m.group(0).title(), text)


# Рекламная шапка в начале аннотации («#1 NEW YORK TIMES BESTSELLER • Now a major motion picture…», цитаты прессы)
# переводится хуже всего, а читатель видит её первой строкой. Для перевода её отрезаем: сегменты с начала (разделители —
# «•», «*», тире, конец предложения), пока сегмент рекламный; на первом обычном — стоп. Английский оригинал не трогаем.
_PROMO = re.compile(
    r"#\s?1\b|№\s?1|\bbest[- ]?sell|book club|\bpicks?\b|netflix|hbo|hulu|amazon prime|motion picture|\bfilm\b|"
    r"\bmovie\b|tv series|limited series|\bseries\b.*\b(?:netflix|hbo|tv|coming)|pulitzer|\baward|\bwinner\b|"
    r"finalist|book of the year|best books? of|best of the year|now a\b|soon to be|starring|new york times|usa today|"
    r"wall street journal|washington post|publishers weekly|kirkus|booklist|library journal|oprah|reese|"
    r"instant classic|named one of|one of the (?:best|most)|acclaimed|praise for|\breview\b|sunday times|"
    r"the guardian|npr\b|people magazine|entertainment weekly|vanity fair|the economist|copies sold|million copies",
    re.IGNORECASE)
_QUOTE = re.compile(r"[\"“”].{3,}[\"“”]\s*(?:[—–-]|\(|$)|[”\"]\s*[—–-]\s*[A-Z]|\(\s*[A-Z][^()]{1,40}\)\s*$|"
                    r"^[—–-]\s*[A-Z]")
_SMALL = {"of", "the", "and", "a", "an", "in", "on", "for", "to", "by", "with", "&"}
_SEP = re.compile(r"\s*•\s*|(?:^|\s)\*\s*|\s*[—–]\s*|(?<=[.!?”\"])\s+")


def _promo(seg: str) -> bool:
    letters = [c for c in seg if c.isalpha()]
    if not letters:
        return True
    if len(seg.split()) >= 2 and sum(c.isupper() for c in letters) / len(letters) > 0.6:
        return True
    words = seg.split()
    # Короткий сегмент из слов с заглавной — название издания в списке («People • Slate • Kansas City Star»)
    if len(words) <= 4 and all(w[0].isupper() or w.lower() in _SMALL or not w[0].isalpha() for w in words):
        return True
    if _QUOTE.search(seg):
        return True
    # Длинное предложение с одним рекламным словом («Rich Dad Poor Dad, the #1 Personal Finance book…, tells the story
    # of…») — уже описание книги; рекламным считаем, только если признаков два и больше
    hits = {m.group(0).lower() for m in _PROMO.finditer(seg)}
    return len(hits) >= (2 if len(words) >= 15 else 1)


def strip_blurb(text: str) -> str:
    """Аннотация без рекламной шапки; если отрезалось бы всё — как есть."""
    cuts = [0] + [m.end() for m in _SEP.finditer(text)] + [len(text)]
    for a, b in zip(cuts, cuts[1:]):
        seg = text[a:b].strip(" *•—–-")
        # Начинать только с начала фразы: сегмент с маленькой буквы — хвост предложения, поглощённого шапкой
        if seg and not _promo(seg) and (seg[0].isupper() or seg[0].isdigit() or seg[0] in "\"“‘'"):
            rest = text[a:].lstrip(" *•—–-")
            return rest if len(rest) >= 30 else text
    return text


def load_books(min_ratings: int = MIN_RATINGS) -> pd.DataFrame:
    # Фильтр при чтении: features всего каталога в pandas — несколько ГБ
    b = pd.read_parquet(PROCESSED / "books_clean.parquet",
                        columns=["parent_asin", "title", "author", "cat2", "features", "n_ratings"],
                        filters=[("n_ratings", ">=", min_ratings)])
    b["annotation"] = b["features"].map(annotation).map(fix_broken)
    return b[b["annotation"] != ""].drop(columns="features").reset_index(drop=True)


class Translator:
    def __init__(self, key: str, device: str = "cuda"):
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        self.key, self.cfg, self.device = key, MODELS[key], device
        kw = {"src_lang": self.cfg["src"]} if "src" in self.cfg else {}
        self.tok = AutoTokenizer.from_pretrained(self.cfg["name"], **kw)
        dtype = torch.float16 if device == "cuda" else torch.float32
        self.model = AutoModelForSeq2SeqLM.from_pretrained(self.cfg["name"], dtype=dtype).to(device).eval()
        self.torch = torch

    def __call__(self, texts: list[str], num_beams: int = 1, max_tokens: int = 10_000, **extra) -> list[str]:
        """Перевод списка предложений: пачки по длине, в пачке не больше max_tokens входных токенов."""
        torch = self.torch
        lens = np.array([len(t) for t in texts])
        order = np.argsort(-lens, kind="stable")
        out = [None] * len(texts)
        i = 0
        while i < len(order):
            longest = max(len(self.tok(texts[order[i]]).input_ids), 1)
            size = max(1, min(256, max_tokens // longest))
            idx = order[i:i + size]
            batch = self.tok([texts[j] for j in idx], return_tensors="pt", padding=True, truncation=True,
                             max_length=512).to(self.device)
            gen = {"num_beams": num_beams, "max_new_tokens": int(batch.input_ids.shape[1] * 2 + 10), **extra}
            if "tgt" in self.cfg:
                gen["forced_bos_token_id"] = self.tok.convert_tokens_to_ids(self.cfg["tgt"])
            with torch.inference_mode():
                res = self.model.generate(**batch, **gen)
            for j, t in zip(idx, self.tok.batch_decode(res, skip_special_tokens=True)):
                out[j] = t.strip()
            i += size
        return out


def translate_texts(tr: Translator, texts: list[str], cache: dict[str, str] | None = None,
                    save=None, chunk: int = 20_000, **kw) -> list[str]:
    """Перевод аннотаций по предложениям; cache — уже переведённые предложения (дополняется)."""
    cache = {} if cache is None else cache
    split = [sentences(t) for t in texts]
    todo = sorted({s for ss in split for s in ss} - cache.keys(), key=len)
    print(f"  предложений: {sum(map(len, split)):,}, разных: {len(todo) + len(cache):,}, к переводу: {len(todo):,}",
          flush=True)
    t0 = time.perf_counter()
    for k in range(0, len(todo), chunk):
        part = todo[k:k + chunk]
        cache.update(zip(part, tr([decaps(x) for x in part], **kw)))
        if save is not None:
            save(cache)
        done = k + len(part)
        rate = done / (time.perf_counter() - t0)
        print(f"  {done:,} / {len(todo):,}  {rate:.0f} предл./с, осталось ~{(len(todo) - done) / rate / 60:.0f} мин",
              flush=True)
    return [" ".join(cache[s] for s in ss) for ss in split]


def compare(n: int, seed: int = 42):
    """n аннотаций (поровну художественных и остальных) обеими моделями: текст для просмотра и скорость."""
    books = load_books()
    fiction = books["cat2"].isin(["Literature & Fiction", "Mystery, Thriller & Suspense", "Science Fiction & Fantasy",
                                  "Romance", "Teen & Young Adult"])
    sample = pd.concat([books[fiction].sample(n // 2, random_state=seed),
                        books[~fiction].sample(n - n // 2, random_state=seed)]).reset_index(drop=True)
    out = sample[["parent_asin", "title", "author", "cat2", "annotation"]].copy()
    timing = {}
    for key in MODELS:
        tr = Translator(key)
        tr(["Warm-up sentence."])
        tr.torch.cuda.synchronize()
        t0 = time.perf_counter()
        out[key] = translate_texts(tr, out["annotation"].tolist())
        tr.torch.cuda.synchronize()
        timing[key] = time.perf_counter() - t0
        timing[key + "_vram_gb"] = tr.torch.cuda.max_memory_allocated() / 2**30
        del tr
    chars = out["annotation"].str.len().sum()
    for key in MODELS:
        print(f"{key}: {timing[key]:.1f} с на {n} аннотаций ({chars:,} символов) — "
              f"{chars / timing[key]:,.0f} символов/с, видеопамять до {timing[key + '_vram_gb']:.2f} ГБ")
    return out, timing


# Зацикливание модели: слово 4+ раза подряд («обе обе обе обе», «СОГРАМИ СОГРАМИ …») — ~0,5% аннотаций, чаще на
# строках капсом. Такие предложения переводятся заново с запретом повторов и лучом 2.
_LOOP = re.compile(r"(\b\w+\b)(?:[ ,]+\1\b){3,}")


def fix_loops(tr: "Translator", cache: dict[str, str]) -> int:
    bad = [en for en, ru in cache.items() if _LOOP.search(ru) and not _LOOP.search(en)]
    if not bad:
        return 0
    # Капс модель переводит плохо — подаём как обычный текст (первая буква слова заглавная)
    src = [decaps(en) for en in bad]
    cache.update(zip(bad, tr(src, num_beams=2, no_repeat_ngram_size=3, max_tokens=4000)))
    return len(bad)


def refresh_caps(tr: "Translator", cache: dict[str, str]) -> int:
    """Перевести заново предложения с отрезками капсом, переведённые до decaps (разовая правка кэша)."""
    bad = [en for en in cache if _CAPS.search(en)]
    for k in range(0, len(bad), 20_000):
        part = bad[k:k + 20_000]
        cache.update(zip(part, tr([decaps(x) for x in part])))
    return len(bad)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", nargs="?", choices=list(MODELS))
    ap.add_argument("--compare", type=int, metavar="N")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--refresh-caps", action="store_true", help="перевести заново предложения с отрезками капсом")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    if a.compare:
        out, _ = compare(a.compare)
        path = a.out or PROCESSED / "translations" / "compare.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        out.to_parquet(path, index=False)
        print(f"→ {path}")
        return

    books = load_books()
    print(f"Книг с ≥ {MIN_RATINGS} оценками и аннотацией: {len(books):,}, "
          f"символов: {books['annotation'].str.len().sum():,}")
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE / f"{a.model}.parquet"
    cache = {}
    if cache_path.exists():
        c = pd.read_parquet(cache_path)
        cache = dict(zip(c["en"], c["ru"]))

    def save(c):
        pd.DataFrame({"en": list(c.keys()), "ru": list(c.values())}).to_parquet(cache_path, index=False)

    t0 = time.perf_counter()
    tr = Translator(a.model)
    if a.refresh_caps:
        print(f"  с отрезками капсом переведено заново: {refresh_caps(tr, cache):,}", flush=True)
        save(cache)
    books["annotation_ru"] = translate_texts(tr, books["annotation"].tolist(), cache, save)
    n = fix_loops(tr, cache)
    if n:
        save(cache)
        books["annotation_ru"] = translate_texts(tr, books["annotation"].tolist(), cache)
        print(f"  зацикленных предложений переведено заново: {n:,}")
    took = time.perf_counter() - t0
    # Перевод — без рекламной шапки: предложения после неё уже в кэше, заново — только остаток первого предложения
    src = books["annotation"].map(strip_blurb)
    cut = (src != books["annotation"]).to_numpy()
    books.loc[cut, "annotation_ru"] = translate_texts(tr, src[cut].tolist(), cache, save)
    print(f"  рекламная шапка отрезана у {cut.sum():,} аннотаций ({cut.mean():.0%})")
    res = pd.DataFrame({"book_id": books["parent_asin"], "annotation_ru": books["annotation_ru"],
                        "model": MODELS[a.model]["name"]})
    (a.out or OUT).parent.mkdir(parents=True, exist_ok=True)
    res.to_parquet(a.out or OUT, index=False)
    print(f"Готово: {len(res):,} аннотаций за {took / 60:.1f} мин → {a.out or OUT}")


if __name__ == "__main__":
    main()
