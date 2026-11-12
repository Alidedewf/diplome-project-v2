"""E6: ученик — быстрая модель на разметке Claude (решения.md 3.6).

deberta-v3-xsmall, две головы над [CLS]:
- аспекты — multi-label (сигмоида на каждую из 20 меток; цели — аспект и аспект_2); при выборе метки чужого типа
  книги маскируются, главный — max(p + сдвиг) (сдвиги для none / overall подбираются, как у NLI), второй — если
  p ≥ порога и обе метки не служебные (reviews.absa.decide);
- тональность главного аспекта — 3 класса (none → neu).
Вход — «fiction: предложение» / «non-fiction: предложение».

Учится на data/processed/reviews_train (разметка Claude). Гиперпараметры (lr, число эпох), сдвиги и порог второго
аспекта подбираются только на половине эталона «подстройка» (471); «отчёт» (550) — один прогон в конце (evaluate).

    uv run python src/reviews/student.py train      → models/reviews_student/ + reports/metrics/reviews_student_tune.csv
    uv run python src/reviews/student.py evaluate   → reports/metrics/reviews_final_table.csv
"""

import argparse
import itertools
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn
from transformers import AutoModel, AutoTokenizer, get_linear_schedule_with_warmup

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reviews import absa
from reviews.aspects import labels

ROOT = Path(__file__).resolve().parents[3]
TRAIN = ROOT / "data" / "processed" / "reviews_train" / "sentences.csv"
GOLD = ROOT / "data" / "processed" / "reviews_gold"
OUT_MODEL = ROOT / "models" / "reviews_student"
METRICS = ROOT / "ml" / "reports" / "metrics"
BASE = "microsoft/deberta-v3-xsmall"
TOKENIZER = absa.NLI_MODEL          # словарь deberta-v3 общий; у xsmall нет tokenizer.json (та же история, что с ABSA)
SENTS = ["pos", "neg", "neu"]
CODES = sorted(set(labels("fiction")) | set(labels("nonfiction")))
MASK = {k: np.array([c in labels(k) for c in CODES]) for k in ["fiction", "nonfiction"]}
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MAX_LEN = 96
SEED = 2026


def kind_of(t: str) -> str:
    return "fiction" if t == "художка" else "nonfiction"


def text_of(sent: str, kind: str) -> str:
    return f"{'fiction' if kind == 'fiction' else 'non-fiction'}: {sent}"


class Student(nn.Module):
    def __init__(self, base: str = BASE):
        super().__init__()
        self.enc = AutoModel.from_pretrained(base, dtype=torch.float32)   # transformers 5 берёт dtype чекпойнта (fp16)
        h = self.enc.config.hidden_size
        self.drop = nn.Dropout(0.1)
        self.asp = nn.Linear(h, len(CODES))
        self.sen = nn.Linear(h, len(SENTS))

    def forward(self, **enc):
        x = self.drop(self.enc(**enc).last_hidden_state[:, 0])
        return self.asp(x), self.sen(x)


def targets(d: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    ya = np.zeros((len(d), len(CODES)), np.float32)
    for i, (a1, a2) in enumerate(zip(d["аспект"], d["аспект_2"])):
        ya[i, CODES.index(a1)] = 1
        if a2:
            ya[i, CODES.index(a2)] = 1
    ys = np.array([SENTS.index("neu" if a == "none" else s) for a, s in zip(d["аспект"], d["тональность"])],
                  dtype=np.int64)       # на Windows numpy по умолчанию int32, а CrossEntropy ждёт int64
    ym = np.array([CODES.index(a) for a in d["аспект"]], dtype=np.int64)
    return ya, ys, ym


@torch.inference_mode()
def predict_probs(model, tok, sents: list[str], kinds: list[str], batch: int = 256,
                  head: str = "sigmoid") -> tuple[np.ndarray, np.ndarray]:
    model.eval()
    texts = [text_of(s, k) for s, k in zip(sents, kinds)]
    order = np.argsort([len(t) for t in texts])
    pa = np.zeros((len(texts), len(CODES)), np.float32)
    ps = np.zeros((len(texts), len(SENTS)), np.float32)
    for s in range(0, len(texts), batch):
        idx = order[s:s + batch]
        enc = tok([texts[i] for i in idx], truncation=True, max_length=MAX_LEN, padding=True,
                  return_tensors="pt").to(DEVICE)
        with torch.autocast(DEVICE, dtype=torch.float16, enabled=DEVICE == "cuda"):
            la, ls = model(**enc)
        if head == "softmax":     # главный аспект — один из допустимых для типа книги
            mk = torch.from_numpy(np.stack([MASK[kinds[i]] for i in idx])).to(DEVICE)
            pa[idx] = torch.softmax(la.float().masked_fill(~mk, -1e4), -1).cpu().numpy()
        else:
            pa[idx] = torch.sigmoid(la.float()).cpu().numpy()
        ps[idx] = torch.softmax(ls.float(), -1).cpu().numpy()
    return pa, ps


def decode(pa: np.ndarray, ps: np.ndarray, kinds: list[str], bias: dict | None = None,
           second: float = absa.SECOND) -> list[dict]:
    out = []
    for a, s, k in zip(pa, ps, kinds):
        r = {c: float(p) for c, p, ok in zip(CODES, a, MASK[k]) if ok}
        top = absa.decide(r, bias, second)
        sen = "neu" if top[0][0] == "none" else SENTS[int(s.argmax())]
        out.append({"aspect": top[0][0], "sentiment": sen, "aspect_2": top[1][0] if len(top) > 1 else "",
                    "sentiment_2": sen if len(top) > 1 else "", "score": top[0][1]})
    return out


def load_gold(part: str | None = None) -> pd.DataFrame:
    g = pd.read_csv(GOLD / "gold.csv", encoding="utf-8-sig", keep_default_na=False)
    g = g.merge(pd.read_csv(GOLD / "split.csv", encoding="utf-8-sig"), on="review_id", how="left")
    return g if part is None else g[g["часть"] == part].reset_index(drop=True)


def score(g: pd.DataFrame, pred: list[dict]) -> dict:
    p = pd.DataFrame(pred)
    a = (p["aspect"].to_numpy() == g["аспект"].to_numpy())
    s = (p["sentiment"].to_numpy() == g["тональность"].to_numpy())
    return {"аспект acc": a.mean(), "тональность acc": s.mean(), "пара acc": (a & s).mean()}


def fit_one(tok, d: pd.DataFrame, tune: pd.DataFrame, lr: float, epochs: int, batch: int = 32, log=print,
            base: str = BASE, head: str = "sigmoid"):
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    model = Student(base).to(DEVICE)
    ya, ys, ym = targets(d)
    kinds_d = [kind_of(t) for t in d["тип"]]
    texts = [text_of(s, kind_of(t)) for s, t in zip(d["предложение"], d["тип"])]
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    steps = epochs * ((len(d) + batch - 1) // batch)
    sch = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    scaler = torch.amp.GradScaler(enabled=DEVICE == "cuda")
    bce, ce = nn.BCEWithLogitsLoss(), nn.CrossEntropyLoss()
    tk = [kind_of(t) for t in tune["тип"]]
    history, best = [], None
    rng = np.random.default_rng(SEED)
    for ep in range(1, epochs + 1):
        model.train()
        perm = rng.permutation(len(d))
        tot = 0.0
        for s in range(0, len(d), batch):
            idx = perm[s:s + batch]
            enc = tok([texts[i] for i in idx], truncation=True, max_length=MAX_LEN, padding=True,
                      return_tensors="pt").to(DEVICE)
            with torch.autocast(DEVICE, dtype=torch.float16, enabled=DEVICE == "cuda"):
                la, ls = model(**enc)
                if head == "softmax":
                    mk = torch.from_numpy(np.stack([MASK[kinds_d[i]] for i in idx])).to(DEVICE)
                    la_loss = ce(la.float().masked_fill(~mk, -1e4), torch.from_numpy(ym[idx]).to(DEVICE))
                else:
                    la_loss = bce(la.float(), torch.from_numpy(ya[idx]).to(DEVICE))
                loss = la_loss + ce(ls.float(), torch.from_numpy(ys[idx]).to(DEVICE))
            opt.zero_grad()
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
            sch.step()
            tot += loss.item() * len(idx)
        pa, ps = predict_probs(model, tok, tune["предложение"].tolist(), tk, head=head)
        m = score(tune, decode(pa, ps, tk))
        history.append({"lr": lr, "эпоха": ep, "loss": tot / len(d), **m})
        log(f"  lr {lr:g} эпоха {ep}: loss {tot / len(d):.3f}, «подстройка» аспект {m['аспект acc']:.3f}, "
            f"тональность {m['тональность acc']:.3f}, пара {m['пара acc']:.3f}")
        key = (m["аспект acc"] + m["тональность acc"]) / 2
        if best is None or key > best[0]:
            best = (key, ep, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}, pa, ps)
    del model, opt
    absa.free()
    return history, best


def cmd_train(lrs: list[float], epochs: int, base: str = BASE, head: str = "sigmoid"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    d = pd.read_csv(TRAIN, encoding="utf-8-sig", keep_default_na=False)
    tune = load_gold("подстройка")
    tok = AutoTokenizer.from_pretrained(TOKENIZER)
    print(f"обучение: {len(d)} предложений; подбор — «подстройка» {len(tune)}")
    hist, best = [], None
    for lr in lrs:
        h, b = fit_one(tok, d, tune, lr, epochs, base=base, head=head)
        hist += h
        if best is None or b[0] > best[1][0]:
            best = (lr, b)
    lr, (key, ep, state, pa, ps) = best
    # сдвиги служебных меток и порог второго аспекта — на «подстройке», по сохранённым вероятностям
    tk = [kind_of(t) for t in tune["тип"]]
    grid = np.round(np.arange(-0.3, 0.31, 0.05), 2)
    fit = None
    for b_none, b_over, sec in itertools.product(grid, grid, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]):
        bias = {"none": b_none, "overall": b_over}
        m = score(tune, decode(pa, ps, tk, bias, sec))
        k2 = (m["аспект acc"] + m["тональность acc"]) / 2
        if fit is None or k2 > fit[0]:
            fit = (k2, bias, sec, m)
    out = model_dir(base, head)
    out.mkdir(parents=True, exist_ok=True)
    torch.save(state, out / "model.pt")
    prm = {"base": base, "head": head, "tokenizer": TOKENIZER, "lr": lr, "epochs": ep, "bias": fit[1], "second": fit[2],
           "tune": fit[3], "train": str(TRAIN.relative_to(ROOT)), "n_train": len(d), "seed": SEED}
    (out / "params.json").write_text(json.dumps(prm, ensure_ascii=False, indent=2), encoding="utf-8")
    pd.DataFrame(hist).to_csv(METRICS / f"reviews_student_tune_{base.split('-')[-1]}_{head}.csv", index=False, encoding="utf-8-sig")
    print(f"лучшее: lr {lr:g}, эпох {ep}; сдвиги {fit[1]}, порог второго {fit[2]} — «подстройка»: "
          + ", ".join(f"{k} {v:.3f}" for k, v in fit[3].items()))


def model_dir(base: str, head: str = "sigmoid") -> Path:
    return OUT_MODEL / (base.split("/")[-1] + ("" if head == "sigmoid" else f"-{head}"))


def load_student(base: str = BASE, head: str = "sigmoid"):
    out = model_dir(base, head)
    prm = json.loads((out / "params.json").read_text(encoding="utf-8"))
    tok = AutoTokenizer.from_pretrained(prm["tokenizer"])
    model = Student(prm["base"]).to(DEVICE)
    model.load_state_dict(torch.load(out / "model.pt", map_location=DEVICE))
    return model, tok, prm


def run_student(sents, kinds, base: str = BASE, head: str = "sigmoid") -> tuple[list[dict], float]:
    model, tok, prm = load_student(base, head)
    t = time.perf_counter()
    pa, ps = predict_probs(model, tok, sents, kinds, head=prm.get("head", "sigmoid"))
    out = decode(pa, ps, kinds, prm["bias"], prm["second"])
    dt = time.perf_counter() - t
    del model
    absa.free()
    return out, dt


VERSIONS = {"v1": ("sigmoid", "ученик v1 (по протоколу, 1 прогон)"),
            "v2": ("softmax", "ученик v2 (исправление головы, найдено на подстройке; 2-й взгляд на отчёт)")}


def cmd_evaluate(speed: int, base: str = BASE, version: str = "v1"):
    """Прогон версии ученика на эталоне (один раз на «отчёте») + итоговая таблица: NLI/ABSA/LLM — из прогона 12.11,
    ученики — из своих сохранённых предсказаний (уже прогнанная версия повторно не запускается)."""
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    from reviews.evaluate import speed_sample
    g = load_gold()
    kinds = [kind_of(t) for t in g["тип"]]
    head = VERSIONS[version][0]
    sp_file = METRICS / "reviews_student_speed.json"
    sp = json.loads(sp_file.read_text(encoding="utf-8")) if sp_file.exists() else {}
    pred, _ = run_student(g["предложение"].tolist(), kinds, base, head)
    pd.DataFrame(pred).to_csv(METRICS / f"reviews_pred_student_{version}.csv", index=False, encoding="utf-8-sig")
    ss, kk, n, _ = speed_sample(speed)
    _, t = run_student(ss, kk, base, head)
    sp[version] = t / n * 1000
    sp_file.write_text(json.dumps(sp, indent=2), encoding="utf-8")
    speeds = {"nli": 133.7, "absa": 138.7, "llm": 2077.9}          # замеры 12.11 (решения.md 3.6), 1000 отзывов
    files = {"nli": "reviews_pred_nli_final.csv", "absa": "reviews_pred_absa_final.csv",
             "llm": "reviews_pred_llm_final_llm.csv"}
    names = {"nli": "NLI (подстроенный) + тональность предложения", "absa": "NLI (подстроенный) + ABSA-тональность",
             "llm": "LLM Qwen2.5-3B, 4 бита"}
    for v, (_, nm) in VERSIONS.items():
        if (METRICS / f"reviews_pred_student_{v}.csv").exists() and v in sp:
            files[v], names[v], speeds[v] = f"reviews_pred_student_{v}.csv", nm, sp[v]
    spot = pd.read_csv(GOLD / "spotcheck30.csv", encoding="utf-8-sig", keep_default_na=False)
    spot_key = set(zip(spot["review_id"], spot["№"].astype(int)))
    masks = {"отчёт": (g["часть"] == "отчёт").to_numpy(),
             "автор (33)": (g["source"] == "author").to_numpy(),
             "spotcheck (30)": np.array([(r, int(k)) in spot_key for r, k in zip(g["review_id"], g["№"])])}
    assert masks["spotcheck (30)"].sum() == 30 and masks["автор (33)"].sum() == 33
    rows = []
    for m, f in files.items():
        p = pd.read_csv(METRICS / f, encoding="utf-8-sig", keep_default_na=False)
        assert len(p) == len(g)
        for sl, mk in masks.items():
            r = score(g[mk].reset_index(drop=True), p[mk].to_dict("records"))
            rows.append({"подход": names[m], "срез": sl, "n": int(mk.sum()), **r,
                         "с на 1000 отзывов": speeds[m] if sl == "отчёт" else np.nan})
    res = pd.DataFrame(rows)
    res.to_csv(METRICS / "reviews_final_table.csv", index=False, encoding="utf-8-sig")
    print(f"ученик {version}: скорость {sp[version]:.1f} с на 1000 отзывов ({len(ss)} предложений)")
    print(res.round(3).to_string(index=False))
    # F1 по аспектам на «отчёте» с числом примеров — видно, где цифра держится на единицах примеров
    from sklearn.metrics import precision_recall_fscore_support
    rep = masks["отчёт"]
    ga = g.loc[rep, "аспект"].to_numpy()
    per = []
    show = ["nli"] + [v for v in VERSIONS if v in files]
    for m in show:
        pa_ = pd.read_csv(METRICS / files[m], encoding="utf-8-sig", keep_default_na=False)["aspect"].to_numpy()[rep]
        codes = sorted(set(ga) | set(pa_))
        p, r, f, sup = precision_recall_fscore_support(ga, pa_, labels=codes, zero_division=0)
        per += [{"подход": names[m], "аспект": c, "примеров в отчёте": int(n_), "precision": p_, "recall": r_,
                 "F1": f_} for c, p_, r_, f_, n_ in zip(codes, p, r, f, sup)]
    per = pd.DataFrame(per)
    per.to_csv(METRICS / "reviews_per_aspect_report.csv", index=False, encoding="utf-8-sig")
    w = per.pivot(index="аспект", columns="подход", values="F1")[[names[m] for m in show]]
    w.columns = show
    w.insert(0, "примеров", per.drop_duplicates("аспект").set_index("аспект")["примеров в отчёте"])
    print("\nF1 по аспектам, «отчёт»:\n" + w.sort_values("примеров", ascending=False).round(2).to_string())
    for m in show:
        x = per[(per["подход"] == names[m]) & (per["примеров в отчёте"] > 0)]
        print(f"{m}: macro-F1 {x['F1'].mean():.3f} по {len(x)} аспектам; "
              f"по аспектам с ≥ 15 примерами — {x[x['примеров в отчёте'] >= 15]['F1'].mean():.3f}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["train", "evaluate"])
    ap.add_argument("--lr", type=float, nargs="+", default=[3e-5, 6e-5, 1e-4])
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--speed", type=int, default=1000)
    ap.add_argument("--head", default="sigmoid", choices=["sigmoid", "softmax"],
                    help="аспектная голова: sigmoid на метку (v1) или softmax по меткам типа книги (v2)")
    ap.add_argument("--version", default="v1", choices=["v1", "v2"], help="evaluate: какую версию ученика прогнать")
    ap.add_argument("--base", default=BASE, help="microsoft/deberta-v3-xsmall | microsoft/deberta-v3-base")
    a = ap.parse_args()
    cmd_train(a.lr, a.epochs, a.base, a.head) if a.cmd == "train" else cmd_evaluate(a.speed, a.base, a.version)


if __name__ == "__main__":
    main()
