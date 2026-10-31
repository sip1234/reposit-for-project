#!/usr/bin/env python3
"""Morris elementary-effects sensitivity for BSM1 operating variables.

默认对 searchRanges 里的三个变量做 Morris 采样：
  DO 设定值 / 内回流倍数 / 外加碳源
每次运行复用 simulator/run.py 的 simulate()，不经过数据库。

用法（仓库根目录）：
  New-Item -ItemType Directory -Force artifacts/simulation | Out-Null
  docker compose run --rm --no-deps \
    -v "${PWD}/scripts:/scripts:ro" \
    -v "${PWD}/artifacts/simulation:/app/artifacts" \
    simulator python /scripts/morris-sensitivity.py --trajectories 4

估算：默认 4 条轨迹 × (3+1) = 16 次仿真；按 36 秒/次约 10 分钟。
"""
import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "postgres://unused")
sys.path.insert(0, "/app/simulator")
sys.path.insert(0, str(Path.cwd() / "simulator"))

import run  # noqa: E402

FACTORS = [
    ("doSetpoint", "DO 设定值", "mg/L"),
    ("recycleRatio", "内回流倍数", "×Q"),
    ("carbonDose", "外加碳源", "m³/d"),
]
OUTPUTS = [
    ("eqi", "EQI"),
    ("oci", "OCI"),
    ("aerationEnergy", "曝气能耗"),
    ("energyPerM3", "单位水量能耗"),
    ("effluentSnhMean", "出水 NH4"),
    ("effluentNtotMean", "出水 Ntot"),
    ("effluentTssMean", "出水 TSS"),
]


def actual_x(name, normalized):
    lo = run.PROFILE["searchRanges"][name]["min"]
    hi = run.PROFILE["searchRanges"][name]["max"]
    return lo + normalized * (hi - lo)


def params_for(x, args):
    return {
        "profileId": run.PROFILE["profileId"],
        "horizonDays": args.horizon,
        "evalDays": args.eval,
        "influent": args.weather,
        "loadFactor": args.load,
        "stabilize": not args.no_stabilize,
        "doSetpoint": actual_x("doSetpoint", x["doSetpoint"]),
        "recycleRatio": actual_x("recycleRatio", x["recycleRatio"]),
        "carbonDose": actual_x("carbonDose", x["carbonDose"]),
    }


def evaluate(x, args):
    metrics, _ = run.simulate(params_for(x, args), should_cancel=None)
    return {key: float(metrics[key]) for key, _ in OUTPUTS}


def morris(args):
    names = [name for name, _, _ in FACTORS]
    levels = args.levels
    delta = levels / (2 * (levels - 1))
    base_levels = [i / (levels - 1) for i in range(levels)]
    base_choices = [value for value in base_levels if value <= 1 - delta + 1e-12]
    rng = random.Random(args.seed)
    samples = []
    effects = {output: {name: [] for name in names} for output, _ in OUTPUTS}
    started = time.time()

    for trajectory in range(args.trajectories):
        base = {name: rng.choice(base_choices) for name in names}
        point = dict(base)
        values = evaluate(point, args)
        samples.append({"trajectory": trajectory, "step": 0, "x": dict(point), "metrics": values})
        order = names.copy()
        rng.shuffle(order)
        for step, name in enumerate(order, 1):
            point = dict(point)
            point[name] = min(1.0, point[name] + delta)
            values = evaluate(point, args)
            samples.append({"trajectory": trajectory, "step": step, "x": dict(point), "metrics": values})
            for output, _ in OUTPUTS:
                effect = (values[output] - samples[-2]["metrics"][output]) / delta
                effects[output][name].append(effect)
            print(f"轨迹 {trajectory + 1}/{args.trajectories} · 变量 {name} · "
                  f"{time.time() - started:.0f}s", flush=True)

    summary = {}
    for output, label in OUTPUTS:
        summary[output] = {}
        for name, display, unit in FACTORS:
            values = effects[output][name]
            mean = sum(values) / len(values)
            variance = sum((v - mean) ** 2 for v in values) / len(values)
            summary[output][name] = {
                "display": display,
                "unit": unit,
                "mu": mean,
                "muStar": sum(abs(v) for v in values) / len(values),
                "sigma": variance ** 0.5,
                "min": min(values),
                "max": max(values),
                "effects": values,
            }
    return {
        "algorithm": "morris",
        "profileId": run.PROFILE["profileId"],
        "seed": args.seed,
        "levels": levels,
        "delta": delta,
        "trajectories": args.trajectories,
        "runs": len(samples),
        "weather": args.weather,
        "loadFactor": args.load,
        "stabilized": not args.no_stabilize,
        "elapsedSeconds": round(time.time() - started, 1),
        "samples": samples,
        "summary": summary,
    }


def print_summary(result, output_key="eqi"):
    print(f"\nMorris · {output_key.upper()} · {result['runs']} 次运行 · "
          f"{result['elapsedSeconds']} 秒 · load={result['loadFactor']}")
    print(f"{'变量':<14}{'μ*':>12}{'μ':>12}{'σ':>12}")
    ranked = sorted(result["summary"][output_key].items(), key=lambda item: -item[1]["muStar"])
    for name, item in ranked:
        print(f"{item['display']:<14}{item['muStar']:>12.4f}{item['mu']:>12.4f}{item['sigma']:>12.4f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trajectories", type=int, default=4)
    parser.add_argument("--levels", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--weather", choices=["dry", "rain"], default="dry")
    parser.add_argument("--load", type=float, default=1.0, help="入流负荷系数，例如 0.7/1.0/1.3")
    parser.add_argument("--horizon", type=float, default=13.9)
    parser.add_argument("--eval", type=float, default=7)
    parser.add_argument("--no-stabilize", action="store_true", help="跳过稳态初始化（更快，但 EQI 不可比）")
    parser.add_argument("--output", default="/app/artifacts/morris.json")
    args = parser.parse_args()
    if not 1 <= args.trajectories <= 20:
        parser.error("--trajectories 须在 1 到 20 之间")
    if args.levels < 3:
        parser.error("--levels 至少为 3")

    result = morris(args)
    print_summary(result, "eqi")
    print_summary(result, "oci")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nJSON: {output}")


if __name__ == "__main__":
    main()
