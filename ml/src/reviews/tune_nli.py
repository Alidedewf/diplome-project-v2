"""E6, шаг 5: подстройка zero-shot NLI на половине эталона «подстройка» (split.csv); отчёт — только по «отчёт».

1. scores — модель один раз считает вероятности всех меток для каждого варианта гипотез (кэш в reviews_gold/);
2. fit    — на кэше без модели: выбор варианта гипотез и сдвигов для служебных меток (none, overall, delivery) и
            общего сдвига аспектов — по macro-F1 аспекта на «подстройке»; результат → nli_params.json.

    uv run python src/reviews/tune_nli.py scores --gold gold.csv
    uv run python src/reviews/tune_nli.py fit --gold gold.csv
"""

import argparse
import itertools
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import f1_score

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reviews import absa

GOLD = Path(__file__).resolve().parents[3] / "data" / "processed" / "reviews_gold"
PARAMS = GOLD / "nli_params.json"

# Варианты гипотез для служебных меток — главная ошибка NLI (overall слишком общий, none почти не находится)
VARIANTS = {
    "base": {},
    "opinion": {
        "none": "This sentence only retells the story or gives background and does not judge the book.",
        "overall": "This sentence gives an overall verdict on the whole book, like recommending it or rating it.",
        "delivery": "This sentence is about shipping, the seller, the price or the condition of the delivered copy.",
    },
    "short": {
        "none": "This sentence contains no opinion about the book.",
        "overall": "This sentence recommends or rates the book as a whole.",
        "delivery": "This sentence is about delivery or the seller.",
    },
}


def load(gold: str, part: str) -> pd.DataFrame:
    g = pd.read_csv(GOLD / gold, encoding="utf-8-sig", keep_default_na=False)
    sp = pd.read_csv(GOLD / "split.csv", encoding="utf-8-sig")
    g = g.merge(sp, on="review_id", how="left")
    assert g["часть"].notna().all()
    return g[g["часть"] == part].reset_index(drop=True)


def cmd_scores(gold: str):
    g = load(gold, "подстройка")
    kinds = ["fiction" if t == "художка" else "nonfiction" for t in g["тип"]]
    nli = absa.NLIAspects()
    for name, hyps in VARIANTS.items():
        nli.hyps = hyps
        sc = nli.scores(g["предложение"].tolist(), kinds)
        pd.DataFrame(sc).to_parquet(GOLD / f"nli_scores_{name}.parquet", index=False)
        print(f"{name}: {len(sc)} предложений")
    absa.free(nli)


def cmd_fit(gold: str):
    g = load(gold, "подстройка")
    gold_a = g["аспект"].to_numpy()
    best = None
    grid = np.round(np.arange(-0.3, 0.31, 0.05), 2)
    for name in VARIANTS:
        sc = pd.read_parquet(GOLD / f"nli_scores_{name}.parquet").to_dict("records")
        sc = [{k: v for k, v in r.items() if v == v} for r in sc]       # NaN — метка не из типа книги
        for b_none, b_over, b_del in itertools.product(grid, grid, grid):
            bias = {"none": b_none, "overall": b_over, "delivery": b_del}
            pred = np.array([absa.decide(r, bias)[0][0] for r in sc])
            f1 = f1_score(gold_a, pred, average="macro", zero_division=0)
            acc = float(np.mean(pred == gold_a))
            if best is None or (f1, acc) > (best["macro_f1"], best["acc"]):
                best = {"variant": name, "bias": bias, "macro_f1": f1, "acc": acc}
        base = np.array([absa.decide(r)[0][0] for r in sc])
        print(f"{name}: без сдвигов — acc {np.mean(base == gold_a):.3f}, "
              f"macro-F1 {f1_score(gold_a, base, average='macro', zero_division=0):.3f}")
    best["hyps"] = VARIANTS[best["variant"]]
    best["gold"] = gold
    PARAMS.write_text(json.dumps(best, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"лучшее на «подстройке»: {best['variant']}, сдвиги {best['bias']} — acc {best['acc']:.3f}, "
          f"macro-F1 {best['macro_f1']:.3f} → {PARAMS.name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["scores", "fit"])
    ap.add_argument("--gold", default="gold.csv")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    cmd_scores(a.gold) if a.cmd == "scores" else cmd_fit(a.gold)


if __name__ == "__main__":
    main()
