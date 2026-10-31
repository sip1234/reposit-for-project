"""Constraint optimization core for BSM1: GP surrogate + EI + Pareto.

Used by both scripts/optimize-simulation.py and the optimizer worker.
"""
import math
import os
import time

import numpy as np

os.environ.setdefault("DATABASE_URL", "postgres://unused")

import run  # noqa: E402

FACTORS = ["doSetpoint", "recycleRatio", "carbonDose"]
LIMITS = {"effluentSnhMean": 4.0, "effluentNtotMean": 18.0, "effluentTssMean": 30.0,
          "effluentCodMean": 100.0, "effluentBod5Mean": 10.0}
DO_MIN = 1.0


class OptimizationCancelled(Exception):
    """Optimization was cancelled by the user."""


def actual_x(normalized):
    x = {}
    for name in FACTORS:
        lo = run.PROFILE["searchRanges"][name]["min"]
        hi = run.PROFILE["searchRanges"][name]["max"]
        x[name] = lo + normalized[name] * (hi - lo)
    return x


def evaluate(normalized, cfg):
    x = actual_x(normalized)
    params = {
        "profileId": run.PROFILE["profileId"],
        "horizonDays": cfg.get("horizon", run.PROFILE["evaluation"]["horizonDays"]),
        "evalDays": cfg.get("eval", run.PROFILE["evaluation"]["evalDays"]),
        "influent": cfg.get("weather", "dry"),
        "loadFactor": cfg.get("loadFactor", 1.0),
        "stabilize": not cfg.get("no_stabilize", False),
        **x,
    }
    try:
        metrics, _ = run.simulate(params, should_cancel=cfg.get("should_cancel"))
    except run.SimulationCancelled as error:
        raise OptimizationCancelled("用户取消") from error
    violation = 0.0
    for key, limit in LIMITS.items():
        violation += max(0.0, float(metrics[key]) - limit) / limit
    violation += max(0.0, DO_MIN - float(metrics["doTank5Min"])) / DO_MIN
    feasible = violation <= 0
    score = float(metrics["oci"]) + 1e5 * violation
    return {
        "x": x,
        "normalized": normalized,
        "metrics": {key: float(metrics[key]) for key in (
            "eqi", "oci", "aerationEnergy", "pumpingEnergy", "mixingEnergy",
            "energyPerM3", "effluentSnhMean", "effluentNtotMean", "effluentTssMean",
            "effluentCodMean", "effluentBod5Mean", "doTank5Mean", "doTank5Min", "doTank5Max")},
        "violation": violation,
        "feasible": feasible,
        "score": score,
    }


def rbf(a, b, length=0.3):
    sq = np.sum((a[:, None, :] - b[None, :, :]) ** 2, axis=2)
    return np.exp(-0.5 * sq / length ** 2)


def gp_ei(X, y, candidates, xi=0.01):
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    mean = float(np.mean(y))
    yy = y - mean
    K = rbf(X, X) + np.eye(len(X)) * 1e-6
    try:
        L = np.linalg.cholesky(K)
    except np.linalg.LinAlgError:
        L = np.linalg.cholesky(K + np.eye(len(X)) * 1e-3)
    alpha = np.linalg.solve(L.T, np.linalg.solve(L, yy))
    Ks = rbf(np.asarray(candidates), X)
    mu = Ks @ alpha + mean
    v = np.linalg.solve(L, Ks.T)
    variance = np.maximum(1.0 - np.sum(v ** 2, axis=0), 1e-9)
    sigma = np.sqrt(variance)
    best = float(np.min(y))
    improvement = best - mu - xi
    z = improvement / sigma
    cdf = 0.5 * (1 + np.vectorize(math.erf)(z / math.sqrt(2)))
    pdf = np.exp(-0.5 * z ** 2) / math.sqrt(2 * math.pi)
    ei = improvement * cdf + sigma * pdf
    return int(np.argmax(ei)), float(np.max(ei))


def pareto(points):
    feasible = [p for p in points if p["feasible"]]
    front = []
    for p in feasible:
        dominated = any(
            q is not p
            and q["metrics"]["oci"] <= p["metrics"]["oci"]
            and q["metrics"]["eqi"] <= p["metrics"]["eqi"]
            and (q["metrics"]["oci"] < p["metrics"]["oci"] or q["metrics"]["eqi"] < p["metrics"]["eqi"])
            for q in feasible
        )
        if not dominated:
            front.append(p)
    return sorted(front, key=lambda p: p["metrics"]["oci"])


def optimize(cfg, on_progress=None, should_cancel=None):
    """Run constrained GP-EI optimization. cfg is a dict."""
    cfg = dict(cfg)
    cfg["should_cancel"] = should_cancel
    evaluations = int(cfg.get("evaluations", 24))
    initial = min(int(cfg.get("initial", 6)), evaluations)
    candidates_n = int(cfg.get("candidates", 4000))
    rng = np.random.default_rng(int(cfg.get("seed", 42)))
    points, X, y = [], [], []
    started = time.time()

    def cancelled():
        return should_cancel is not None and should_cancel()

    baseline = {"doSetpoint": 0.5, "recycleRatio": 0.5, "carbonDose": 0.0}
    seeds = [baseline]
    while len(seeds) < initial:
        seeds.append({name: float(rng.random()) for name in FACTORS})

    for normalized in seeds:
        if cancelled():
            raise OptimizationCancelled("用户取消")
        point = evaluate(normalized, cfg)
        point["phase"] = "initial"
        points.append(point)
        X.append([normalized[name] for name in FACTORS])
        y.append(point["score"])
        if on_progress:
            on_progress(len(points), evaluations, point)
        if cancelled():
            raise OptimizationCancelled("用户取消")

    while len(points) < evaluations:
        if cancelled():
            raise OptimizationCancelled("用户取消")
        candidates = rng.random((candidates_n, len(FACTORS)))
        existing = np.asarray(X)
        distances = np.min(np.linalg.norm(candidates[:, None, :] - existing[None, :, :], axis=2), axis=1)
        candidates = candidates[distances > 0.05]
        if len(candidates) == 0:
            candidates = rng.random((candidates_n, len(FACTORS)))
        best_index, best_ei = gp_ei(X, y, candidates)
        normalized = {name: float(candidates[best_index][i]) for i, name in enumerate(FACTORS)}
        point = evaluate(normalized, cfg)
        point["phase"] = "bayesian"
        point["acquisition"] = best_ei
        points.append(point)
        X.append([normalized[name] for name in FACTORS])
        y.append(point["score"])
        if on_progress:
            on_progress(len(points), evaluations, point)
        if cancelled():
            raise OptimizationCancelled("用户取消")

    feasible = [p for p in points if p["feasible"]]
    best_oci = min(feasible, key=lambda p: p["metrics"]["oci"]) if feasible else None
    best_eqi = min(feasible, key=lambda p: p["metrics"]["eqi"]) if feasible else None
    front = pareto(points)
    return {
        "schemaVersion": 1,
        "algorithm": "gp-ei + pareto",
        "profileId": run.PROFILE["profileId"],
        "seed": int(cfg.get("seed", 42)),
        "evaluations": len(points),
        "initial": initial,
        "weather": cfg.get("weather", "dry"),
        "loadFactor": float(cfg.get("loadFactor", 1.0)),
        "stabilized": not cfg.get("no_stabilize", False),
        "elapsedSeconds": round(time.time() - started, 1),
        "constraints": {**LIMITS, "doTank5Min": DO_MIN},
        "points": points,
        "feasibleCount": len(feasible),
        "bestOci": best_oci,
        "bestEqi": best_eqi,
        "pareto": front,
    }
