"""E6, подход 3: маленькая LLM (Qwen2.5-3B-Instruct, 4 бита) размечает отзыв целиком — аспект(ы) и тональность
каждого предложения одним ответом. Отзыв — один запрос: инструкция со списком меток идёт один раз на отзыв, а не на
предложение. Ответ — строки «номер|аспект|тональность[|аспект_2|тональность_2]»; непонятое — none / neu.

Модель — заранее квантованная (bnb 4 бита, ~2,2 ГБ): грузится сразу в видеокарту, без полной копии в ОЗУ.
"""

import re
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from reviews.absa import free
from reviews.aspects import SENTIMENTS, labels

MODEL = "unsloth/Qwen2.5-3B-Instruct-bnb-4bit"
BATCH = 8
_LINE = re.compile(r"^\s*(\d+)\s*\|\s*([a-z_]+)\s*\|\s*(pos|neg|neu)(?:\s*\|\s*([a-z_]+)\s*\|\s*(pos|neg|neu))?", re.M)

RULES = """You label sentences of an Amazon book review for aspect-based sentiment analysis.
Book type: {kind}. Allowed aspect codes (use ONLY these):
{codes}
Rules:
- For each sentence give the main aspect and its sentiment: pos, neg or neu.
- If a sentence clearly evaluates a second aspect, add it after the first.
- none = plot summary, background or personal story without judging the book (sentiment neu).
- overall = a general verdict or recommendation without a specific aspect.
- Judge sentiment by the sentence itself, not by the star rating ("the ending dragged" in a 5-star review is neg).
Answer with exactly one line per sentence and nothing else, in the format:
number|aspect|sentiment   or   number|aspect|sentiment|aspect2|sentiment2"""


class LLM:
    def __init__(self, name: str = MODEL):
        self.tok = AutoTokenizer.from_pretrained(name, padding_side="left")
        self.model = AutoModelForCausalLM.from_pretrained(name, device_map="cuda", dtype=torch.float16).eval()

    def prompt(self, sents: list[str], kind: str, stars: int) -> str:
        codes = "\n".join(f"{k}: {d}" for k, (_, d) in labels(kind).items())
        body = f"Star rating: {stars}\n" + "\n".join(f"{i + 1}. {s}" for i, s in enumerate(sents))
        msgs = [{"role": "system", "content": RULES.format(kind="fiction" if kind == "fiction" else "non-fiction",
                                                            codes=codes)},
                {"role": "user", "content": body}]
        return self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)

    @torch.inference_mode()
    def __call__(self, reviews: list[tuple[list[str], str, int]]) -> list[list[dict]]:
        out = [None] * len(reviews)
        order = sorted(range(len(reviews)), key=lambda i: len(reviews[i][0]))
        for s in range(0, len(order), BATCH):
            idx = order[s:s + BATCH]
            texts = [self.prompt(*reviews[i]) for i in idx]
            enc = self.tok(texts, return_tensors="pt", padding=True).to("cuda")
            n_max = max(len(reviews[i][0]) for i in idx)
            gen = self.model.generate(**enc, max_new_tokens=16 * n_max + 16, do_sample=False,
                                      pad_token_id=self.tok.pad_token_id)
            for j, i in enumerate(idx):
                text = self.tok.decode(gen[j, enc["input_ids"].shape[1]:], skip_special_tokens=True)
                out[i] = self.parse(text, reviews[i][0], reviews[i][1])
        return out

    @staticmethod
    def parse(text: str, sents: list[str], kind: str) -> list[dict]:
        ok = labels(kind)
        res = [{"aspect": "none", "sentiment": "neu", "aspect_2": "", "sentiment_2": "", "score": 0.0}
               for _ in sents]
        for m in _LINE.finditer(text):
            i = int(m.group(1)) - 1
            if not 0 <= i < len(sents) or m.group(2) not in ok:
                continue
            res[i] = {"aspect": m.group(2), "sentiment": m.group(3) if m.group(2) != "none" else "neu",
                      "aspect_2": m.group(4) if m.group(4) in ok else "",
                      "sentiment_2": m.group(5) if m.group(4) in ok else "", "score": 1.0}
        return res


def run(sents: list[str], kinds: list[str], stars: list[int], review_ids: list | None = None):
    """Предложения подряд → группируем в отзывы (по review_ids, иначе — по смене типа/звёзд не группируем: каждые
    подряд идущие предложения одного отзыва должны иметь общий id)."""
    if review_ids is None:
        review_ids = list(range(len(sents)))
    groups, cur = [], None
    for i, r in enumerate(review_ids):
        if r != cur:
            groups.append([])
            cur = r
        groups[-1].append(i)
    m = LLM()
    t = time.perf_counter()
    res = m([([sents[i] for i in g], kinds[g[0]], stars[g[0]]) for g in groups])
    dt = time.perf_counter() - t
    free(m)
    out = [None] * len(sents)
    for g, r in zip(groups, res):
        for i, x in zip(g, r):
            out[i] = x
    return out, dt
