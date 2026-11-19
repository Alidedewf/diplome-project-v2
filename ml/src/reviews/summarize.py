"""E6, шаг 6: сводки отзывов по книгам (решения.md 3.6).

predict   — ученик v2 (student.py, softmax-голова) размечает предложения top-20 отзывов каждой книги с ≥ MIN отзывами
            в reviews_top50. Top-20 — тем же правилом, что и отбор 50 (collect.pick): по полезности внутри звезды,
            квоты по долям звёзд (доли — по 50 сохранённым отзывам книги, они уже взяты по квотам). Тип книги —
            по разделу (aspects.book_type). Пишется частями по группам строк → data/processed/review_aspects/
            (готовые части при перезапуске пропускаются).
            Добор книг с 20–49 отзывами: отбор ≥ 20 минус уже размеченные ≥ 50, части — в review_aspects/min20/.
summarize — агрегат книга × аспект (обе папки частей) → data/processed/review_summary.parquet.
site      — правило показа → data/processed/review_summary_site.parquet (строка на показанный пункт, для сайта).
show      — сводки из файла для сайта в консоли.

    uv run python src/reviews/summarize.py select --min-reviews 50
    uv run python src/reviews/summarize.py predict --min-reviews 50
    uv run python src/reviews/summarize.py select --min-reviews 20 --exclude 50
    uv run python src/reviews/summarize.py predict --min-reviews 20 --subdir min20
    uv run python src/reviews/summarize.py summarize
    uv run python src/reviews/summarize.py site
    uv run python src/reviews/summarize.py show --books 0441172717
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reviews.aspects import INFO_ONLY, book_type
from reviews.collect import pick
from reviews.sentences import split

ROOT = Path(__file__).resolve().parents[3]
REVIEWS = ROOT / "data" / "processed" / "reviews_top50.parquet"
OUT = ROOT / "data" / "processed" / "review_aspects"
SUMMARY = ROOT / "data" / "processed" / "review_summary.parquet"
TOP = 20
NOT_IN_SUMMARY = {"none", "delivery"}          # в сводку о книге не идут; overall — отдельно, «в целом»
EX_MIN, EX_MAX = 25, 200                       # длина предложения-примера, символов
# Пример берётся только из главного аспекта предложения (у второго своей уверенности нет) и только уверенный:
# у Gone Girl в «Качество издания» попадала фраза про полицию (уверенность аспекта 0,45), у Dune в минус издания —
# бессмыслица (уверенность тональности 0,73)
EX_PROB, EX_SENT = 0.5, 0.85
# положительный пример не должен начинаться с оговорки: «Unfortunately…», «However…», «But…» — это обычно минус
EX_POS_BAD_START = r"^\W*(?:unfortunately|however|but|although|though|sadly)\b"
# пример не короче EX_WORDS слов («Looking forward to finishing.» — пустой) и не пункт списка / цитата из другого
# отзыва, начинающаяся с тире («-"Atonement" has a mind-blowing ending…» — про другую книгу)
EX_WORDS = 6
EX_BAD_START = r"^\s*[-–—*•]"
SRC_DEFAULT = ["part-*.parquet", "min20/part-*.parquet"]   # прогон ≥ 50 и добор ≥ 20 (книги 20–49 отзывов)


def log(t0, msg):
    print(f"[{time.perf_counter() - t0:7.0f} с] {msg}", flush=True)


def selection(min_reviews: int, t0) -> pd.DataFrame:
    """(группа строк, строка) отобранных отзывов: книги с ≥ min_reviews, по TOP на книгу."""
    f = pq.ParquetFile(REVIEWS)
    t = pq.read_table(REVIEWS, columns=["book_id"])
    vc = pc.value_counts(t["book_id"].combine_chunks())
    ok = pa.array([b for b, c in zip(vc.field("values").to_pylist(), vc.field("counts").to_pylist())
                   if c >= min_reviews])
    del t, vc
    parts = []
    for rg in range(f.num_row_groups):
        t = f.read_row_group(rg, columns=["book_id", "rating", "helpful_vote", "text"])
        idx = pc.indices_nonzero(pc.is_in(t["book_id"], value_set=ok))     # только книги с ≥ min_reviews
        t = t.take(idx)
        parts.append(pd.DataFrame({"rg": np.int16(rg), "row": idx.to_numpy().astype(np.int32),
                                   "book_id": pd.Categorical(t["book_id"].to_numpy()), "rating": t["rating"].to_numpy(),
                                   "h": t["helpful_vote"].to_numpy(), "l": pc.utf8_length(t["text"]).to_numpy()}))
    from pandas.api.types import union_categoricals
    bid = union_categoricals([x["book_id"] for x in parts])
    d = pd.concat([x.drop(columns="book_id") for x in parts], ignore_index=True)
    d["book_id"] = bid
    del parts, bid
    d = d.sort_values(["book_id", "h", "l"], ascending=[True, False, False], kind="stable")
    keep = []
    for _, x in d.groupby("book_id", sort=False, observed=True):
        stars = np.clip(x["rating"].to_numpy().astype(int), 1, 5)
        share = np.bincount(stars - 1, minlength=5) / len(stars)
        keep.append(x.index.to_numpy()[pick(stars, share, TOP)])
    sel = d.loc[np.concatenate(keep), ["rg", "row", "book_id"]]
    log(t0, f"книг с ≥ {min_reviews} отзывами: {sel['book_id'].nunique():,}, отзывов к разметке: {len(sel):,}")
    return sel


def cmd_select(min_reviews: int, exclude: int | None = None):
    """Отбор отдельным процессом (пик памяти — здесь, без модели): → review_aspects/selection_{min}.parquet.
    exclude — убрать книги из selection_{exclude}.parquet (уже размечены прошлым прогоном): ≥ 20 минус ≥ 50."""
    t0 = time.perf_counter()
    OUT.mkdir(parents=True, exist_ok=True)
    sel = selection(min_reviews, t0)
    sel["book_id"] = sel["book_id"].astype(str)
    if exclude:
        done = set(pd.read_parquet(OUT / f"selection_{exclude}.parquet", columns=["book_id"])["book_id"])
        sel = sel[~sel["book_id"].isin(done)]
        log(t0, f"минус книги selection_{exclude}: осталось книг {sel['book_id'].nunique():,}, отзывов {len(sel):,}")
    sel.to_parquet(OUT / f"selection_{min_reviews}.parquet", index=False)


def book_kinds(book_ids) -> dict:
    books = pd.read_parquet(ROOT / "data" / "processed" / "books_clean.parquet",
                            columns=["parent_asin", "cat2", "cat3"])
    books = books[books["parent_asin"].isin(set(book_ids))]
    return {b: book_type(c2, c3) for b, c2, c3 in zip(books["parent_asin"], books["cat2"], books["cat3"])}


CHUNK = 3000      # отзывов за раз внутри группы: списки предложений и разбор ответов держим только для куска
BATCH = 128       # предложений в батче модели (было 256)


def label_rows(f, rg: int, x: pd.DataFrame, kind: dict, model, tok, prm, chunk: int = CHUNK,
               batch: int = BATCH) -> pd.DataFrame:
    """Разметка учеником отобранных отзывов одной группы строк → предложения. По кускам из chunk отзывов:
    пик памяти — от куска, а не от всей группы (~24 тыс. отзывов, ~190 тыс. предложений)."""
    from reviews import student as st
    t = f.read_row_group(int(rg), columns=["text"])["text"]
    rows = x["row"].to_numpy()
    texts = t.take(pa.array(rows)).to_pylist()
    del t
    books = x["book_id"].to_numpy()
    out = []
    for c in range(0, len(rows), chunk):
        sb, sr, sn, ss, sk = [], [], [], [], []
        for b, r, text in zip(books[c:c + chunk], rows[c:c + chunk], texts[c:c + chunk]):
            k = kind.get(b, "fiction")
            for i, s in enumerate(split(text), 1):
                sb.append(b), sr.append(f"{rg}:{r}"), sn.append(i), ss.append(s), sk.append(k)
        pa_, ps_ = st.predict_probs(model, tok, ss, sk, batch=batch, head="softmax")
        p = pd.DataFrame(st.decode(pa_, ps_, sk, prm["bias"], prm["second"]))
        out.append(pd.DataFrame({"book_id": sb, "review_id": sr, "sent_no": np.array(sn, np.int16), "type": sk,
                                 "sentence": ss, "aspect": p["aspect"], "sentiment": p["sentiment"],
                                 "prob": p["score"].astype(np.float32), "sent_prob": ps_.max(1).astype(np.float32),
                                 "aspect_2": p["aspect_2"], "sentiment_2": p["sentiment_2"]}))
        del sb, sr, sn, ss, sk, pa_, ps_, p
    return pd.concat(out, ignore_index=True)


def cmd_predict(min_reviews: int, subdir: str = "", chunk: int = CHUNK, batch: int = BATCH,
                max_groups: int | None = None):
    """subdir — своя папка частей внутри review_aspects/ (части называются по группе строк, и у прогона ≥ 20 они
    совпали бы с готовыми частями ≥ 50 и были бы пропущены)."""
    from reviews import student as st
    t0 = time.perf_counter()
    out_dir = OUT / subdir
    out_dir.mkdir(parents=True, exist_ok=True)
    import gc
    import psutil
    import torch
    proc = psutil.Process()

    def mem() -> str:      # peak_wset — пик рабочего набора, есть только на Windows
        m = proc.memory_info()
        pk = f", пик {m.peak_wset / 2**30:.2f} ГБ" if hasattr(m, "peak_wset") else ""
        return f"память процесса {m.rss / 2**30:.2f} ГБ{pk}"

    # отбор — только оставшихся групп (готовые части не грузим), book_id — категориальный
    done = {int(p.stem.split("-")[1]) for p in out_dir.glob("part-*.parquet")}
    sel = pd.read_parquet(OUT / f"selection_{min_reviews}.parquet", filters=[("rg", "not in", sorted(done))]
                          if done else None)
    sel["book_id"] = sel["book_id"].astype("category")
    groups = sorted(sel["rg"].unique())[:max_groups] if max_groups else sorted(sel["rg"].unique())
    log(t0, f"готово частей {len(done)}, осталось групп {sel['rg'].nunique()}, в этом запуске {len(groups)}")
    kind = book_kinds(sel["book_id"].cat.categories)
    model, tok, prm = st.load_student(head="softmax")
    f = pq.ParquetFile(REVIEWS)
    done_n = 0
    log(t0, f"модель загружена, {mem()}")
    for rg in groups:
        part = out_dir / f"part-{rg:03d}.parquet"
        x = sel[sel["rg"] == rg]
        x = x.assign(book_id=x["book_id"].astype(str))
        out = label_rows(f, rg, x, kind, model, tok, prm, chunk=chunk, batch=batch)
        out.to_parquet(part.with_suffix(".tmp"), index=False)
        part.with_suffix(".tmp").replace(part)
        done_n += len(x)
        n_out = len(out)
        del out, x
        gc.collect()
        torch.cuda.empty_cache()
        log(t0, f"группа {rg}: предложений {n_out:,} (всего отзывов {done_n:,}); {mem()}")
    log(t0, "готово")


KNOWN = {"0441172717": "Dune", "B006LSZECO": "Gone Girl", "0553418025": "The Martian",
         "059035342X": "Harry Potter and the Sorcerer's Stone", "0062316095": "Sapiens"}
SAMPLE_SEED = 2026


def cmd_sample(min_reviews: int, n_random: int = 5):
    """Пробная выборка для просмотра: известные книги + n_random случайных из selection (сид SAMPLE_SEED)."""
    from reviews import student as st
    t0 = time.perf_counter()
    sel = pd.read_parquet(OUT / f"selection_{min_reviews}.parquet")
    rest = sorted(set(sel["book_id"]) - set(KNOWN))
    rnd = list(np.random.default_rng(SAMPLE_SEED).choice(rest, n_random, replace=False))
    books = list(KNOWN) + rnd
    assert set(KNOWN) <= set(sel["book_id"])
    sel = sel[sel["book_id"].isin(books)]
    kind = book_kinds(books)
    model, tok, prm = st.load_student(head="softmax")
    f = pq.ParquetFile(REVIEWS)
    out = pd.concat([label_rows(f, rg, x, kind, model, tok, prm) for rg, x in sel.groupby("rg")], ignore_index=True)
    out.to_parquet(OUT / "sample10.parquet", index=False)
    log(t0, f"sample10.parquet: книг {out['book_id'].nunique()}, отзывов {out['review_id'].nunique()}, "
            f"предложений {len(out)}; случайные: {rnd}")


def mentions(d: pd.DataFrame) -> pd.DataFrame:
    """Упоминания аспектов: главный и второй (у второго та же тональность — так устроен ученик); без none / delivery."""
    cols = ["book_id", "review_id", "sentence", "aspect", "sentiment", "conf"]
    m = pd.concat([d[cols], d.loc[d["aspect_2"] != "", ["book_id", "review_id", "sentence", "aspect_2",
                                                         "sentiment_2", "conf"]].set_axis(cols, axis=1)])
    return m[~m["aspect"].isin(NOT_IN_SUMMARY)]


_STARS: dict = {}


def review_stars(review_ids: pd.Series) -> pd.Series:
    """Звёзды отзывов по review_id «группа:строка» (из reviews_top50; колонка rating группы кэшируется)."""
    rg_row = review_ids.str.split(":", expand=True).astype(int) if len(review_ids) else None
    out = pd.Series(np.zeros(len(review_ids), np.int8), index=review_ids.index)
    if rg_row is None:
        return out
    f = None
    for rg, idx in rg_row.groupby(0).groups.items():
        if rg not in _STARS:
            f = f or pq.ParquetFile(REVIEWS)
            _STARS.clear()          # части идут по группам по порядку — держим одну-две
            _STARS[rg] = f.read_row_group(int(rg), columns=["rating"])["rating"].to_numpy()
        out[idx] = _STARS[rg][rg_row.loc[idx, 1].to_numpy()]
    return out


def cmd_summarize(src: list[str] = SRC_DEFAULT, dst: Path = SUMMARY, books: list[str] | None = None):
    """Потоково по частям (книга может быть в нескольких частях): из каждой части — флаги pos/neg на
    (книга, аспект, отзыв), число отзывов и тип книги, лучший пример на (книга, аспект, тональность); потом сводим."""
    t0 = time.perf_counter()
    flags, revs, exs = [], [], []
    filt = [("book_id", "in", books)] if books else None
    files = [f for pat in src for f in sorted(OUT.glob(pat))]
    log(t0, f"частей: {len(files)} ({', '.join(src)})")
    for f in files:
        has_sp = "sent_prob" in pq.read_schema(f).names     # в первых частях (до 12.11 вечера) уверенности тональности нет
        d = pd.read_parquet(f, columns=["book_id", "review_id", "type", "sentence", "aspect", "sentiment", "prob",
                                        "aspect_2", "sentiment_2"] + (["sent_prob"] if has_sp else []), filters=filt)
        if d.empty:
            continue
        # уверенность для выбора примера: аспект × тональность
        d["conf"] = d["prob"] * (d["sent_prob"] if has_sp else 1.0)
        revs.append(d[["book_id", "review_id", "type"]].drop_duplicates(["book_id", "review_id"]))
        m = mentions(d)
        fp = (m.assign(p=m["sentiment"] == "pos", n=m["sentiment"] == "neg")
              .groupby(["book_id", "aspect", "review_id"])[["p", "n"]].max().reset_index())
        # «В целом» — звёзды как опора (2.6.1): и плюс, и минус о книге в целом в отзыве на 4–5★ — это плюс
        # с оговоркой, на 1–2★ — минус; на 3★ остаётся mixed
        o = fp["aspect"] == "overall"
        st = review_stars(fp.loc[o, "review_id"])
        both = fp.loc[o, "p"] & fp.loc[o, "n"]
        fp.loc[o & both.reindex(fp.index, fill_value=False) & (st >= 4).reindex(fp.index, fill_value=False), "n"] = False
        fp.loc[o & both.reindex(fp.index, fill_value=False) & (st <= 2).reindex(fp.index, fill_value=False), "p"] = False
        flags.append(fp)
        ok = (~d["aspect"].isin(NOT_IN_SUMMARY) & d["sentence"].str.len().between(EX_MIN, EX_MAX)
              & (d["sentence"].str.count(r"\S+") >= EX_WORDS) & ~d["sentence"].str.match(EX_BAD_START)
              & d["sentiment"].isin(["pos", "neg"]) & (d["prob"] >= EX_PROB)
              & (d["sent_prob"] >= EX_SENT if has_sp else True))
        ok &= ~((d["sentiment"] == "pos") & d["sentence"].str.contains(EX_POS_BAD_START, case=False, regex=True))
        ex = d.loc[ok, ["book_id", "aspect", "sentiment", "sentence", "conf"]]
        exs.append(ex.sort_values("conf", ascending=False).drop_duplicates(["book_id", "aspect", "sentiment"]))
        del d, m, ex
    rv_all = pd.concat(revs).drop_duplicates(["book_id", "review_id"])
    n_rev = rv_all.groupby("book_id")["review_id"].nunique().rename("отзывов_проанализировано")
    kind = rv_all.groupby("book_id")["type"].first()
    # Тональность отзыва к аспекту: pos / neg, если все его предложения о нём такие (или нейтральные); и pos, и neg —
    # mixed; только нейтральные — neu
    fl = pd.concat(flags).groupby(["book_id", "aspect", "review_id"])[["p", "n"]].max()
    log(t0, f"отзывов {len(rv_all):,}, пар отзыв × аспект {len(fl):,}")
    rv = np.select([fl["p"] & fl["n"], fl["p"], fl["n"]], ["mixed", "pos", "neg"], "neu")
    g = pd.Series(rv, index=fl.index, name="s").groupby(["book_id", "aspect"]).value_counts().unstack(fill_value=0)
    for c in ["pos", "neg", "neu", "mixed"]:
        if c not in g:
            g[c] = 0
    g["отзывов_упоминают"] = g[["pos", "neg", "neu", "mixed"]].sum(1)
    g["доля_pos"] = (g["pos"] + 0.5 * g["mixed"]) / (g["pos"] + g["neg"] + g["mixed"]).replace(0, np.nan)
    g = g.join(n_rev, on="book_id").join(kind, on="book_id")
    g["доля_упоминаний"] = g["отзывов_упоминают"] / g["отзывов_проанализировано"]
    # Примеры: самое уверенное короткое предложение с pos и с neg
    ex = pd.concat(exs).sort_values("conf", ascending=False).drop_duplicates(["book_id", "aspect", "sentiment"])
    exw = ex.pivot(index=["book_id", "aspect"], columns="sentiment", values="sentence")
    exw.columns = [f"пример_{c}" for c in exw.columns]
    g = g.join(exw).reset_index().rename(columns={"pos": "отзывов_pos", "neg": "отзывов_neg", "neu": "отзывов_neu",
                                                  "mixed": "отзывов_mixed"})
    g.to_parquet(dst, index=False)
    log(t0, f"{dst.name}: {len(g):,} пар книга × аспект, книг {g['book_id'].nunique():,}")


# Правило показа (черновик, решения.md 3.6) → review_summary_site.parquet, строка на показанный пункт.
# - Аспект-кандидат: упоминают ≥ SHOW_MIN отзывов и ≥ SHOW_SHARE проанализированных, и ≥ SHOW_MIN отзывов с оценкой
#   (pos / neg / mixed) — иначе вердикт держится на одном-двух отзывах. accuracy и editing — при доле ≥ STRICT_SHARE:
#   о них пишут почти только чтобы поругать (медиана доли pos 0), а при доле 15–25% это чаще шум ученика
#   («не согласен с автором» → достоверность).
# - На книгу — не больше MAX_ASPECTS аспектов, по числу упоминаний; «в целом» (overall) — отдельно, первым;
#   «Кому подойдёт» (audience) — справка без вердикта, последней, в лимит не входит.
# - Вердикт по доле pos (с ½ mixed): ≥ POS — «хвалят», ≤ NEG — «ругают», иначе «мнения расходятся».
# - Пример с плюсом / минусом — только если таких отзывов (с mixed) ≥ EX_SIDE_MIN: одинокий минус при +12 чаще
#   ошибка модели.
# - Явные не-книги (nonbook.py, «явно»: наклейки, карточки, закладки, Misc. Supplies…) сводку не получают.
SHOW_MIN, SHOW_SHARE, STRICT_SHARE, MAX_ASPECTS = 3, 0.15, 0.25, 5
STRICT = {"accuracy", "editing"}
POS, NEG = 0.7, 0.4
EX_SIDE_MIN = 2
SITE = ROOT / "data" / "processed" / "review_summary_site.parquet"
NONBOOK = ROOT / "data" / "processed" / "nonbook_books.parquet"
VERDICT_RU = {"praise": "хвалят", "mixed": "мнения расходятся", "criticize": "ругают"}


def verdict(share, pos: float = POS, neg: float = NEG):
    return np.select([share >= pos, share <= neg], ["praise", "criticize"], "mixed")


def explicit_nonbooks() -> set:
    nb = pd.read_parquet(NONBOOK)
    return set(nb.loc[nb["nonbook"] == "явно", "parent_asin"])


def site_rows(g: pd.DataFrame, pos: float = POS, neg: float = NEG) -> pd.DataFrame:
    """Агрегат книга × аспект → показанные пункты (схема review_summary_site согласована с бэкендом — не менять)."""
    from reviews.aspects import COMMON, FICTION, NONFICTION
    cap = {k: v[0] for k, v in {**FICTION, **NONFICTION, **COMMON}.items()} | {"overall": "В целом"}
    g = g[g["aspect"].isin(cap)].copy()
    opinion = g["отзывов_pos"] + g["отзывов_neg"] + g["отзывов_mixed"]
    need = np.where(g["aspect"].isin(STRICT), STRICT_SHARE, SHOW_SHARE)
    ok = (g["отзывов_упоминают"] >= SHOW_MIN) & (g["доля_упоминаний"] >= need - 1e-9)
    g = g[ok & ((g["aspect"] == "audience") | (opinion >= SHOW_MIN))].copy()
    g["kind"] = np.select([g["aspect"] == "overall", g["aspect"].isin(INFO_ONLY)], ["overall", "info"], "aspect")
    # аспекты: top-MAX_ASPECTS по числу упоминаний (при равенстве — по коду аспекта, чтобы порядок был воспроизводим)
    g = g.sort_values(["book_id", "отзывов_упоминают", "aspect"], ascending=[True, False, True])
    a = g[g["kind"] == "aspect"]
    a = a[a.groupby("book_id").cumcount() < MAX_ASPECTS]
    g = pd.concat([g[g["kind"] == "overall"], a, g[g["kind"] == "info"]])
    g["_k"] = g["kind"].map({"overall": 0, "aspect": 1, "info": 2})
    g = g.sort_values(["book_id", "_k", "отзывов_упоминают", "aspect"], ascending=[True, True, False, True])
    g["rank"] = (g.groupby("book_id").cumcount() + 1).astype(np.int16)
    v = pd.Series(verdict(g["доля_pos"].to_numpy(), pos, neg), index=g.index, dtype=object)
    v[g["kind"] == "info"] = None
    none = pd.Series(None, index=g.index, dtype=object)
    qp = g["пример_pos"].where(g["отзывов_pos"] + g["отзывов_mixed"] >= EX_SIDE_MIN) if "пример_pos" in g else none
    qn = g["пример_neg"].where(g["отзывов_neg"] + g["отзывов_mixed"] >= EX_SIDE_MIN) if "пример_neg" in g else none
    return pd.DataFrame({
        "book_id": g["book_id"].astype(str), "analyzed": g["отзывов_проанализировано"].astype(np.int16),
        "aspect": g["aspect"], "label_ru": g["aspect"].map(cap), "kind": g["kind"], "verdict": v,
        "share_pos": g["доля_pos"].astype(np.float32), "mentions": g["отзывов_упоминают"].astype(np.int16),
        "mention_share": g["доля_упоминаний"].astype(np.float32), "quote_pos": qp, "quote_neg": qn,
        "rank": g["rank"]}).reset_index(drop=True)


def cmd_site(src: Path = SUMMARY, dst: Path = SITE):
    t0 = time.perf_counter()
    g = pd.read_parquet(src)
    nb = explicit_nonbooks()
    books = set(g["book_id"])
    drop = books & nb
    s = site_rows(g[~g["book_id"].isin(nb)])
    s.to_parquet(dst, index=False)
    per = s.groupby("book_id").size()
    asp = s[s["kind"] == "aspect"]
    log(t0, f"книг в агрегате {len(books):,}; явные не-книги, без сводки: {len(drop):,}; "
            f"без единого показанного пункта: {len(books) - len(drop) - s['book_id'].nunique():,}")
    log(t0, f"{dst.name}: {len(s):,} пунктов, книг со сводкой {s['book_id'].nunique():,}; на книгу пунктов — "
            f"медиана {per.median():.0f}, аспектов — медиана {asp.groupby('book_id').size().median():.0f}")
    print(s["kind"].value_counts().to_string())
    print("вердикты аспектов:", asp["verdict"].value_counts(normalize=True).round(3).to_dict())
    print("вердикты «в целом»:", s.loc[s["kind"] == "overall", "verdict"].value_counts(normalize=True).round(3).to_dict())


def cmd_show(src: Path = SITE, books: list[str] | None = None):
    s = pd.read_parquet(src)
    titles = pd.read_parquet(ROOT / "data" / "processed" / "books_clean.parquet",
                             columns=["parent_asin", "title", "author"]).set_index("parent_asin")
    for b in books or list(s["book_id"].unique()):
        x = s[s["book_id"] == b].sort_values("rank")
        t = titles.loc[b] if b in titles.index else None
        print(f"\n=== {b} — {t['title'][:70] if t is not None else '?'} ({t['author'] if t is not None else ''})"
              + (f"; отзывов проанализировано {int(x['analyzed'].iloc[0])}" if len(x) else ": сводки нет"))
        for _, r in x.iterrows():
            v = "справка" if r["kind"] == "info" else VERDICT_RU[r["verdict"]]
            print(f"  {r['rank']}. {r['label_ru']:<20} {v:<18} доля+ {r['share_pos']:.2f} | "
                  f"упоминают {r['mentions']} ({r['mention_share']:.0%})")
            for c, sign in [("quote_pos", "+"), ("quote_neg", "−")]:
                if isinstance(r[c], str):
                    print(f"        {sign} «{r[c]}»")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select", "predict", "sample", "summarize", "site", "show"])
    ap.add_argument("--src", nargs="+", default=SRC_DEFAULT, help="summarize: какие файлы review_aspects/ брать")
    ap.add_argument("--dst", default=str(SUMMARY), help="summarize: куда писать агрегат; site: откуда брать")
    ap.add_argument("--site", default=str(SITE), help="site: куда писать файл для сайта; show: какой показать")
    ap.add_argument("--books", nargs="*", help="summarize / show: только эти книги (по умолчанию все)")
    ap.add_argument("--min-reviews", type=int, default=50)
    ap.add_argument("--exclude", type=int, help="select: убрать книги из selection_{N}.parquet")
    ap.add_argument("--subdir", default="", help="predict: папка частей внутри review_aspects/")
    ap.add_argument("--chunk", type=int, default=CHUNK, help="predict: отзывов за раз внутри группы")
    ap.add_argument("--batch", type=int, default=BATCH, help="predict: предложений в батче модели")
    ap.add_argument("--max-groups", type=int, help="predict: обработать не больше N групп (замер памяти)")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    {"select": lambda: cmd_select(a.min_reviews, a.exclude),
     "predict": lambda: cmd_predict(a.min_reviews, a.subdir, a.chunk, a.batch, a.max_groups),
     "sample": lambda: cmd_sample(a.min_reviews), "summarize": lambda: cmd_summarize(a.src, Path(a.dst), a.books),
     "site": lambda: cmd_site(Path(a.dst), Path(a.site)), "show": lambda: cmd_show(Path(a.site), a.books)}[a.cmd]()


if __name__ == "__main__":
    main()
