#!/usr/bin/env python3
"""BSM1 EQI 诊断脚本：复现开环基准并分解 EQI 各项。

用法（在仓库根目录）：
  docker compose run --rm --no-deps -v "${PWD}/scripts:/scripts:ro" simulator \
    python /scripts/eqi_probe.py --horizon 13.9 --eval 7

默认参数是 BSM1 开环：KLa5=84 d-1、Qint=55338 m3/d，不做 DO 控制。
输出 JSON，包含库内 EQI、按官方公式重算的 EQI、分项均值、评价窗口与 TSS/X_TSS 差异。
"""
import argparse
import json
import os

import numpy as np
import bsm2_python
from bsm2_python import BSM1OL
from bsm2_python.bsm2.init import asm1init_bsm1 as asm1init

SI, SS, XI, XS, XBH, XBA, XP, SO, SNO, SNH, SND, XND, SALK, TSS, Q, TEMP = range(16)
BSS, BCOD, BNKJ, BNO, BBOD5 = 2, 1, 30, 10, 2
FP, IXB, IXP = asm1init.PAR1[16], asm1init.PAR1[17], asm1init.PAR1[18]
DATA = os.path.join(os.path.dirname(bsm2_python.__file__), "data", "dryinfluent.csv")


def step_count(model):
    return min(len(model.simtime), len(model.timesteps))


def run(horizon, evaltime, kla5, qintr, timestep, verbose=False, stabilize=False, atol=1e-3):
    model = BSM1OL(data_in=DATA, timestep=timestep, endtime=horizon, evaltime=int(evaltime))
    model.qintr = qintr
    klass = np.array([0.0, 0.0, 240.0, 240.0, kla5], dtype=float)
    if stabilize:
        model.stabilize(atol=atol)
    total = step_count(model)
    for i in range(total):
        model.step(i, klass)
        if verbose and i and i % 2000 == 0:
            print(f"step {i}/{total}", flush=True)
    model.finish_evaluation(plot=False)

    iqi, eqi, me, pe, ae = (float(v) for v in model.get_final_performance())
    start, end = int(model.eval_idx[0]), int(model.eval_idx[1])
    eff = model.ys_eff_all[start:end]

    kj = (eff[:, SNH] + eff[:, SND] + eff[:, XND]
          + IXB * (eff[:, XBH] + eff[:, XBA])
          + IXP * (eff[:, XP] + eff[:, XI]))
    cod = (eff[:, SS] + eff[:, SI] + eff[:, XS] + eff[:, XI]
           + eff[:, XBH] + eff[:, XBA] + eff[:, XP])
    bod5e = 0.25 * (eff[:, SS] + eff[:, XS] + (1 - FP) * (eff[:, XBH] + eff[:, XBA]))
    tss_col = eff[:, TSS]
    xtss = 0.75 * (eff[:, XS] + eff[:, XP] + eff[:, XI] + eff[:, XBH] + eff[:, XBA])
    qe = eff[:, Q]

    terms = {
        "tss": float(np.mean(tss_col)),
        "xtss": float(np.mean(xtss)),
        "cod": float(np.mean(cod)),
        "kjeldahlN": float(np.mean(kj)),
        "sno": float(np.mean(eff[:, SNO])),
        "bod5e": float(np.mean(bod5e)),
        "q": float(np.mean(qe)),
    }
    eqi_direct_samples = (BSS * tss_col + BCOD * cod + BNKJ * kj + BNO * eff[:, SNO] + BBOD5 * bod5e) * qe / 1000
    eqi_direct = float(np.mean(eqi_direct_samples))
    eqi_library_window = float(np.mean(model.eqi_all[start:end]))
    tss_diff = float(np.max(np.abs(tss_col - xtss)))

    return {
        "implementation": "bsm2-python",
        "version": getattr(bsm2_python, "__version__", "unknown"),
        "mode": "open-loop",
        "horizonDays": horizon,
        "evalDays": evaltime,
        "stepMinutes": round(timestep * 1440, 6),
        "kla5": kla5,
        "qintr": qintr,
        "stabilized": bool(stabilize),
        "steps": total,
        "simtimeStart": float(model.simtime[0]),
        "simtimeEnd": float(model.simtime[-1]),
        "evaltime": [float(model.evaltime[0]), float(model.evaltime[1])],
        "evalIdx": [start, end],
        "library": {"iqi": iqi, "eqi": eqi, "me": me, "pe": pe, "ae": ae},
        "eqiLibraryWindowMean": eqi_library_window,
        "eqiDirect": eqi_direct,
        "eqiDirectMinusLibrary": eqi_direct - eqi_library_window,
        "terms": terms,
        "tssVsXtssMaxAbs": tss_diff,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--horizon", type=float, default=13.9)
    parser.add_argument("--eval", type=float, default=7.0)
    parser.add_argument("--kla5", type=float, default=84.0)
    parser.add_argument("--qintr", type=float, default=55338.0)
    parser.add_argument("--timestep", type=float, default=1 / 1440)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--stabilize", action="store_true", help="先按默认 KLa5=84 稳定到稳态，再跑动态")
    parser.add_argument("--atol", type=float, default=1e-3)
    args = parser.parse_args()
    result = run(args.horizon, args.eval, args.kla5, args.qintr, args.timestep, args.verbose,
                 args.stabilize, args.atol)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
