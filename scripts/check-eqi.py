#!/usr/bin/env python3
"""BSM1 开环官方基准的 EQI golden test。

用法（在仓库根目录）：
  docker compose run --rm --no-deps -v "${PWD}/scripts:/scripts:ro" simulator \
    python /scripts/check-eqi.py

要求：先按默认 KLa5=84 稳定到稳态，再跑 13.9 天动态，评价最后 7 天。
阈值：AE/PE/ME 对齐官方，IQI 偏差 <0.2%，EQI 偏差 <1%。
"""
import json
import math
import sys

from eqi_probe import run

OFFICIAL = {
    "ae": 3341.3867,
    "pe": 388.17,
    "me": 240.0,
    "iqi": 52100.0,
    "eqi": 6700.0,
}

def close(actual, expected, rel):
    return abs(actual - expected) <= abs(expected) * rel

def main():
    result = run(horizon=13.9, evaltime=7, kla5=84.0, qintr=55338.0,
                 timestep=1 / 1440, stabilize=True, atol=1e-3)
    lib = result["library"]
    checks = []

    def check(name, condition, detail):
        checks.append({"name": name, "pass": bool(condition), "detail": detail})
        if not condition:
            print(f"FAIL {name}: {detail}", file=sys.stderr)

    check("AE exact", abs(lib["ae"] - OFFICIAL["ae"]) <= 1e-3, lib["ae"])
    check("PE exact", abs(lib["pe"] - OFFICIAL["pe"]) <= 1e-3, lib["pe"])
    check("ME exact", abs(lib["me"] - OFFICIAL["me"]) <= 1e-3, lib["me"])
    check("IQI within 0.2%", close(lib["iqi"], OFFICIAL["iqi"], 0.002), lib["iqi"])
    check("EQI within 1%", close(lib["eqi"], OFFICIAL["eqi"], 0.01), lib["eqi"])
    check("direct EQI matches library", abs(result["eqiDirect"] - result["eqiLibraryWindowMean"]) < 1e-6,
          result["eqiDirect"] - result["eqiLibraryWindowMean"])
    check("TSS equals X_TSS", result["tssVsXtssMaxAbs"] < 1e-9, result["tssVsXtssMaxAbs"])
    check("evaluation window is last 7 days", result["evalIdx"] == [10080, 20016], result["evalIdx"])
    check("stabilized before dynamic", result["stabilized"] is True, result["stabilized"])

    report = {
        "result": "PASS" if all(c["pass"] for c in checks) else "FAIL",
        "checks": checks,
        "official": OFFICIAL,
        "actual": {k: lib[k] for k in ("ae", "pe", "me", "iqi", "eqi")},
        "deviation": {
            "eqiPercent": round((lib["eqi"] / OFFICIAL["eqi"] - 1) * 100, 3),
            "iqiPercent": round((lib["iqi"] / OFFICIAL["iqi"] - 1) * 100, 3),
        },
        "terms": result["terms"],
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["result"] == "PASS" else 1

if __name__ == "__main__":
    sys.exit(main())
