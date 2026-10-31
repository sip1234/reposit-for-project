#!/usr/bin/env python3
"""BSM1 约束优化：GP 代理模型 + Expected Improvement + Pareto 筛选。

目标：在出水约束下最小化 OCI（含能耗、估算 SP、外加碳源）。
变量：DO 设定值、内回流倍数、外加碳源（searchRanges）。
输出：所有评估点、可行点、Pareto 前沿（OCI-EQI 双目标）、推荐点。

用法（仓库根目录）：
  New-Item -ItemType Directory -Force artifacts/optimization | Out-Null
  docker compose run --rm --no-deps \
    -v "${PWD}/scripts:/scripts:ro" \
    -v "${PWD}/artifacts/optimization:/app/artifacts" \
    simulator python /scripts/optimize-simulation.py --evaluations 24

估算：默认 24 次 × 约 36 秒 ≈ 15 分钟；--no-stabilize 会快一倍但 EQI 不可比。
"""
import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

os.environ.setdefault("DATABASE_URL", "postgres://unused")
sys.path.insert(0, "/app/simulator")
sys.path.insert(0, str(Path.cwd() / "simulator"))

import run  # noqa: E402

FACTORS = ["doSetpoint", "recycleRatio", "carbonDose"]
LABELS = {"doSetpoint": "DO", "recycleRatio": "回流", "carbonDose": "碳源"}
LIMITS = {"effluentSnhMean": 4.0, "effluentNtotMean": 18.0, "effluentTssMean": 30.0,
          "effluentCodMean": 100.0, "effluentBod5Mean": 10.0}
DO_MIN = 1.0


def actual_x(normalized):
    x = {}
    for name in FACTORS:
        lo = run.PROFILE["searchRanges"][name]["min"]
        hi = run.PROFILE["searchRanges"][name]["max"]
        x[name] = lo + normalized[name] * (hi - lo)
    return x


def evaluate(normalized, args):
    x = actual_x(normalized)
    params = {
        "profileId": run.PROFILE["profileId"],
        "horizonDays": args.horizon,
        "evalDays": args.eval,
        "influent": args.weather,
        "loadFactor": args.load,
        "stabilize": not args.no_stabilize,
        **x,
    }
    metrics, _ = run.simulate(params, should_cancel=None)
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


def optimize(args):
    rng = np.random.default_rng(args.seed)
    points = []
    X, y = [], []
    started = time.time()
    total = args.evaluations
    initial = min(args.initial, total)

    baseline = {"doSetpoint": 0.5, "recycleRatio": 0.5, "carbonDose": 0.0}
    seeds = [baseline]
    while len(seeds) < initial:
        seeds.append({name: float(rng.random()) for name in FACTORS})

    for index, normalized in enumerate(seeds):
        point = evaluate(normalized, args)
        point["phase"] = "initial"
        points.append(point)
        X.append([normalized[name] for name in FACTORS])
        y.append(point["score"])
        print(f"[{index + 1}/{total}] initial OCI={point['metrics']['oci']:.0f} "
              f"EQI={point['metrics']['eqi']:.0f} feasible={point['feasible']} "
              f"{time.time() - started:.0f}s", flush=True)

    while len(points) < total:
        candidates = rng.random((args.candidates, len(FACTORS)))
        existing = np.asarray(X)
        # Avoid exact duplicates; keep candidates reasonably far from known points.
        distances = np.min(np.linalg.norm(candidates[:, None, :] - existing[None, :, :], axis=2), axis=1)
        candidates = candidates[distances > 0.05]
        if len(candidates) == 0:
            candidates = rng.random((args.candidates, len(FACTORS)))
        best_index, best_ei = gp_ei(X, y, candidates)
        normalized = {name: float(candidates[best_index][i]) for i, name in enumerate(FACTORS)}
        point = evaluate(normalized, args)
        point["phase"] = "bayesian"
        point["acquisition"] = best_ei
        points.append(point)
        X.append([normalized[name] for name in FACTORS])
        y.append(point["score"])
        print(f"[{len(points)}/{total}] BO OCI={point['metrics']['oci']:.0f} "
              f"EQI={point['metrics']['eqi']:.0f} feasible={point['feasible']} "
              f"{time.time() - started:.0f}s", flush=True)

    feasible = [p for p in points if p["feasible"]]
    best_oci = min(feasible, key=lambda p: p["metrics"]["oci"]) if feasible else None
    best_eqi = min(feasible, key=lambda p: p["metrics"]["eqi"]) if feasible else None
    front = pareto(points)
    return {
        "algorithm": "gp-ei + pareto",
        "profileId": run.PROFILE["profileId"],
        "seed": args.seed,
        "evaluations": len(points),
        "initial": initial,
        "weather": args.weather,
        "loadFactor": args.load,
        "stabilized": not args.no_stabilize,
        "elapsedSeconds": round(time.time() - started, 1),
        "constraints": {**LIMITS, "doTank5Min": DO_MIN},
        "points": points,
        "feasibleCount": len(feasible),
        "bestOci": best_oci,
        "bestEqi": best_eqi,
        "pareto": front,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluations", type=int, default=24)
    parser.add_argument("--initial", type=int, default=6)
    parser.add_argument("--candidates", type=int, default=4000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--weather", choices=["dry", "rain"], default="dry")
    parser.add_argument("--load", type=float, default=1.0)
    parser.add_argument("--horizon", type=float, default=13.9)
    parser.add_argument("--eval", type=float, default=7)
    parser.add_argument("--no-stabilize", action="store_true")
    parser.add_argument("--output", default="/app/artifacts/optimization.json")
    args = parser.parse_args()
    if not 4 <= args.evaluations <= 200:
        parser.error("--evaluations 须在 4 到 200 之间")
    if not 2 <= args.initial <= args.evaluations:
        parser.error("--initial 须在 2 到 evaluations 之间")

    result = optimize(args)
    print(f"\n完成：{result['evaluations']} 次 · {result['elapsedSeconds']} 秒 · "
          f"可行 {result['feasibleCount']} 个 · Pareto {len(result['pareto'])} 个")
    if result["bestOci"]:
        best = result["bestOci"]
        print("最低 OCI:", json.dumps(best["x"], ensure_ascii=False),
              "OCI", round(best["metrics"]["oci"], 1), "EQI", round(best["metrics"]["eqi"], 1))
    if result["bestEqi"]:
        best = result["bestEqi"]
        print("最低 EQI:", json.dumps(best["x"], ensure_ascii=False),
              "OCI", round(best["metrics"]["oci"], 1), "EQI", round(best["metrics"]["eqi"], 1))
    print("Pareto:")
    for point in result["pareto"]:
        print(f"  OCI {point['metrics']['oci']:.0f}  EQI {point['metrics']['eqi']:.0f}  "
              f"DO {point['x']['doSetpoint']:.2f}  回流 {point['x']['recycleRatio']:.2f}  "
              f"碳源 {point['x']['carbonDose']:.2f}")

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nJSON: {output}")


if __name__ == "__main__":
    main()
