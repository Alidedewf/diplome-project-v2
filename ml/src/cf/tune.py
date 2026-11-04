"""Подбор параметров коллаборативных моделей на валидации — решения.md, 3.1 (Optuna), 3.7 (E1).

Цель — NDCG@10 «все» на валидации. Попытки хранятся в sqlite (models/optuna/cf.db, не в git): если ноутбук
прервался, при перезапуске подбор продолжается с того же места, уже сделанные попытки не пересчитываются.
"""

import json
from pathlib import Path

import optuna
import pandas as pd

from cf.models import SEED, fit_recommend
from eval.metrics import evaluate

STORAGE = Path(__file__).resolve().parents[3] / "models" / "optuna" / "cf.db"


def suggest(kind: str, t: optuna.Trial) -> dict:
    """Пространство поиска модели."""
    if kind == "knn":
        p = {"similarity": t.suggest_categorical("similarity", ["cosine", "bm25", "tfidf"]),
             "K": t.suggest_int("K", 10, 1000, log=True),
             "weighted": t.suggest_categorical("weighted", [True, False])}
        if p["similarity"] == "bm25":
            p["K1"] = t.suggest_float("K1", 0.3, 3.0)
            p["B"] = t.suggest_float("B", 0.2, 1.0)
        return p
    p = {"factors": t.suggest_categorical("factors", [32, 64, 128, 256] if kind == "als" else [32, 64, 128]),
         "regularization": t.suggest_float("regularization", 1e-3, 10.0, log=True),
         "alpha": t.suggest_float("alpha", 0.5, 100.0, log=True),
         "iterations": t.suggest_int("iterations", 5, 40) if kind == "als" else 15,
         "weighted": t.suggest_categorical("weighted", [True, False])}
    if kind == "als_features":
        features = t.suggest_categorical("features", ["section+subsection", "section+subsection+author", "author"])
        p["use"] = features.split("+")
        p["min_author_books"] = t.suggest_categorical("min_author_books", [10, 20]) if "author" in p["use"] else 0
        p["together"] = t.suggest_categorical("together", [False, True])
    return p


def run(kind: str, p: dict, train, part, users, books=None):
    """Обучение + оценка: (таблица evaluate, NDCG по пользователям, секунды обучения и рекомендаций)."""
    reco, seconds = fit_recommend(kind, p, train, users, books)
    table, per_user = evaluate(reco, train, part, users)
    return table, per_user, seconds


def tune(kind: str, train, part, users, books=None, n_trials: int = 25, name: str | None = None,
         storage: Path = STORAGE) -> optuna.Study:
    STORAGE.parent.mkdir(parents=True, exist_ok=True)
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(study_name=name or kind, storage=f"sqlite:///{storage}", direction="maximize",
                                sampler=optuna.samplers.TPESampler(seed=SEED), load_if_exists=True)

    def objective(t):
        p = suggest(kind, t)
        table, _, seconds = run(kind, p, train, part, users, books)
        s = table.set_index("разрез")
        t.set_user_attr("params", json.dumps(p))
        t.set_user_attr("seconds", round(seconds, 1))
        t.set_user_attr("ndcg_old", float(s.loc["старые", "NDCG@10"]))
        t.set_user_attr("recall", float(s.loc["все", "Recall@10"]))
        return float(s.loc["все", "NDCG@10"])

    done = sum(t.state == optuna.trial.TrialState.COMPLETE for t in study.trials)
    study.optimize(objective, n_trials=max(0, n_trials - done))
    return study


def best_params(study: optuna.Study) -> dict:
    return json.loads(study.best_trial.user_attrs["params"])


def trials_table(study: optuna.Study, model: str) -> pd.DataFrame:
    rows = []
    for t in study.trials:
        if t.state != optuna.trial.TrialState.COMPLETE:
            continue
        rows.append({"модель": model, "попытка": t.number, "NDCG@10": t.value, "NDCG@10 старые": t.user_attrs["ndcg_old"],
                     "Recall@10": t.user_attrs["recall"], "секунд": t.user_attrs["seconds"],
                     "параметры": t.user_attrs["params"]})
    return pd.DataFrame(rows).sort_values("NDCG@10", ascending=False, ignore_index=True)
