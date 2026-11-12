"""E6, шаг 4: итоговый эталон и выборка для проверки согласия (решения.md 3.6).

gold      — gold.csv: предразметка Claude (prelabel_claude.csv), где строки из author_decisions.csv заменены версией
            автора; колонка source = author / claude. sentences.csv и prelabel_claude.csv не меняются.
spotcheck — spotcheck30.csv: 30 случайных строк без «?» из части «отчёт» (сид 2026) для быстрой проверки автором.

    uv run python src/reviews/gold.py gold
    uv run python src/reviews/gold.py spotcheck
"""

import argparse
import sys
from pathlib import Path

import pandas as pd

GOLD = Path(__file__).resolve().parents[3] / "data" / "processed" / "reviews_gold"
COLS = ["аспект", "тональность", "аспект_2", "тональность_2"]
SEED = 2026


def read(name: str) -> pd.DataFrame:
    return pd.read_csv(GOLD / name, encoding="utf-8-sig", keep_default_na=False, dtype={"№": int})


def cmd_gold():
    pre = read("prelabel_claude.csv")
    dec = read("author_decisions.csv")
    key = ["review_id", "№"]
    assert not dec.duplicated(key).any()
    g = pre.merge(dec[key + COLS], on=key, how="left", suffixes=("", "_автор"), indicator=True)
    found = g["_merge"] == "both"
    assert found.sum() == len(dec), "строки автора не найдены в предразметке"
    unsure = g["исправление"].str.startswith("?")
    assert unsure[found].all(), "автор правил строку без «?»"
    changed = found & (g[COLS].to_numpy() != g[[c + "_автор" for c in COLS]].to_numpy()).any(axis=1)
    for c in COLS:
        g.loc[found, c] = g.loc[found, c + "_автор"]
    g["source"] = "claude"
    g.loc[found, "source"] = "author"
    g["сомнение"] = unsure.astype(int)
    g = g.drop(columns=[c + "_автор" for c in COLS] + ["_merge"])
    g.to_csv(GOLD / "gold.csv", index=False, encoding="utf-8-sig")
    print(f"gold.csv: {len(g)} предложений; «?» — {unsure.sum()}, из них автор проверил {found.sum()}, "
          f"изменил {changed.sum()} ({changed.sum() / found.sum():.0%}); без проверки человеком — "
          f"{len(g) - found.sum()}")
    for c in COLS:
        print(f"  изменено «{c}»: {(found & (pre[c] != g[c])).sum()}")


def cmd_spotcheck(n: int = 30):
    g = read("gold.csv").merge(pd.read_csv(GOLD / "split.csv", encoding="utf-8-sig"), on="review_id")
    pool = g[(g["часть"] == "отчёт") & (g["сомнение"] == 0)]
    s = pool.sample(n, random_state=SEED).sort_values(["review_id", "№"])
    out = s[["review_id", "№", "тип", "звёзды", "предложение"] + COLS].copy()
    out["согласен (да/нет)"] = ""
    out["исправление"] = ""
    out.to_csv(GOLD / "spotcheck30.csv", index=False, encoding="utf-8-sig")
    print(f"spotcheck30.csv: {len(out)} строк из {len(pool)} (часть «отчёт», без «?»), сид {SEED}; "
          f"отзывов {out['review_id'].nunique()}")
    print(out["аспект"].value_counts().to_string())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["gold", "spotcheck"])
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    cmd_gold() if a.cmd == "gold" else cmd_spotcheck()


if __name__ == "__main__":
    main()
