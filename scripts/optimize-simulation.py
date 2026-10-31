#!/usr/bin/env python3
"""BSM1 约束优化 CLI：GP-EI + Pareto（核心在 simulator/optimizer_core.py）。

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
import os
import sys
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "postgres://unused")
sys.path.insert(0, "/app/simulator")
sys.path.insert(0, str(Path.cwd() / "simulator"))

from optimizer_core import optimize  # noqa: E402


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

    cfg = {
        "evaluations": args.evaluations,
        "initial": args.initial,
        "candidates": args.candidates,
        "seed": args.seed,
        "weather": args.weather,
        "loadFactor": args.load,
        "horizon": args.horizon,
        "eval": args.eval,
        "no_stabilize": args.no_stabilize,
    }

    def progress(done, total, point):
        print(f"[{done}/{total}] {point['phase']} OCI={point['metrics']['oci']:.0f} "
              f"EQI={point['metrics']['eqi']:.0f} feasible={point['feasible']}", flush=True)

    result = optimize(cfg, on_progress=progress)
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
