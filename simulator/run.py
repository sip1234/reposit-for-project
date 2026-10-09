"""BSM1 机理模型仿真 worker。

轮询 PostgreSQL 的 sim_jobs 表，执行仿真并写入 sim_results。
采用与 worker/indexer.py 相同的"任务表轮询"模式。

模型：IWA BSM1 —— 5 格活性污泥反应池（2 缺氧 + 3 好氧）+ 10 层二沉池
实现：bsm2_python.BSM1OL

已知取舍（同样写入结果的 notes 字段，便于追溯）：
1. 不使用 bsm2_python.BSM1CL：其文档字符串明确标注 "Not validated yet!! Use at your own risk."
2. 第 5 格溶解氧由本文件自实现的 PI 控制器调节 KLa5，非库内控制器
3. EQI 实测比 IWA 官方参考值偏低约 5.8%（AE/PE/ME 与官方完全一致），故不作为主指标
4. 外加碳源投入第 1 格（缺氧区，规范说明其用途为强化反硝化），范围 0-5 m3/d
5. 本类不返回污泥产量 SP，因此无法组装官方 OCI
"""

import json
import os
import signal
import sys
import time
import traceback

import numpy as np
import psycopg
import bsm2_python
from bsm2_python import BSM1OL

DATABASE_URL = os.environ["DATABASE_URL"]
POLL_SECONDS = 2.0

# 平均干季流量（规范 §2.1），用于把内回流倍数换算成流量
QI_STAB = 18446.0
# KLa 单位 d-1。规范：第 3-4 格固定 240，第 5 格受控（库允许上限 360）
KLA_FIXED = 240.0
KLA5_MIN, KLA5_MAX = 0.0, 360.0
KLA5_OFFSET = 84.0
# PI 参数取自 bsm2-python 的 aerationcontrolinit_bsm1（基于 BSM1 调参）。
# 位置式：KLa5 = OFFSET + KP * e + KI * ∫e dt，限幅 [0,360]，带抗积分饱和。
# 实测该组参数把评价窗口内 DO 标准差从 0.474 降到 0.077（Kp=120/Ki=60 时），能耗仅高 0.4%。
KP = 25.0
KI = 12500.0

SO, SNO, SNH, TSS = 7, 8, 9, 13

INFLUENT_DIR = os.path.join(os.path.dirname(bsm2_python.__file__), "data")
INFLUENT_FILES = {"dry": "dryinfluent.csv", "rain": "raininfluent.csv"}
MAX_HORIZON_DAYS = 13.9  # 入流文件末时刻为 13.9896 天

SERIES_INTERVAL_MINUTES = 60  # 时间序列按小时抽样

DDL = """
CREATE TABLE IF NOT EXISTS sim_jobs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued','running','ready','failed')),
  params jsonb NOT NULL,
  progress numeric NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS sim_results (
  job_id uuid PRIMARY KEY REFERENCES sim_jobs(id) ON DELETE CASCADE,
  metrics jsonb NOT NULL,
  series jsonb NOT NULL,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
"""

NOTES = [
    "机理模型为 IWA BSM1；数值实现采用 bsm2-python 的 BSM1OL（AE/PE/ME 已与官方参考值一致）",
    "第 5 格溶解氧由自实现 PI 控制器调节 KLa5，KLa 单位 d-1，限幅 0-360",
    "EQI 实测比官方参考值偏低约 5.8%，仅供参考，不作为达标判据",
    "外加碳源投加至第 1 格（缺氧区）",
]


def log(*args):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *args, flush=True)


def setup(conn):
    with conn.cursor() as cur:
        cur.execute(DDL)
    conn.commit()


def step_count(model):
    """安全步数上界。

    该库中 simtime 与 timesteps 长度可能不一致：
    - timestep 为数值时 timesteps 比 simtime 少 1；
    - 传入 endtime 时只截断 simtime，timesteps 保持原长度。
    因此必须取两者较小值，否则 step(i) 会越界。
    """
    return min(len(model.simtime), len(model.timesteps))


def warm_up():
    """跑一个极短仿真以触发 numba JIT 编译。该成本每进程只付一次。"""
    started = time.perf_counter()
    try:
        model = BSM1OL(data_in=os.path.join(INFLUENT_DIR, INFLUENT_FILES["dry"]),
                       timestep=1 / 1440, endtime=1, evaltime=1)
        for i in range(step_count(model)):
            model.step(i)
        log(f"JIT 预热完成，耗时 {time.perf_counter() - started:.1f} 秒")
    except Exception:
        log("JIT 预热失败（不影响任务正确性，但首个任务会更慢）")
        traceback.print_exc()


def claim(conn):
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE sim_jobs SET status='running', started_at=now(), progress=0
            WHERE id = (
                SELECT id FROM sim_jobs WHERE status='queued'
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            RETURNING id, params""")
        row = cur.fetchone()
    conn.commit()
    return row


def set_progress(conn, job_id, value):
    with conn.cursor() as cur:
        cur.execute("UPDATE sim_jobs SET progress=%s WHERE id=%s", (float(value), job_id))
    conn.commit()


def validate(params):
    horizon = float(params.get("horizonDays", 14))
    values = {
        "horizonDays": horizon,
        "evalDays": float(params.get("evalDays", 7)),
        "doSetpoint": float(params.get("doSetpoint", 2.0)),
        "recycleRatio": float(params.get("recycleRatio", 3.0)),
        "carbonDose": float(params.get("carbonDose", 0.0)),
        "weather": str(params.get("influent", "dry")),
    }
    if values["weather"] not in INFLUENT_FILES:
        raise ValueError(f"不支持的天气文件：{values['weather']}")
    if not 0.0 < horizon <= MAX_HORIZON_DAYS:
        raise ValueError(f"仿真时长须在 0 到 {MAX_HORIZON_DAYS} 天之间")
    # evaltime 在该库中只接受整数天（或二元素数组），故评价窗口按整天处理
    if not 1 <= round(values["evalDays"]) <= horizon:
        raise ValueError("评价窗口须为不小于 1 的整天，且不超过仿真时长")
    if not 0.5 <= values["doSetpoint"] <= 4.0:
        raise ValueError("溶解氧设定值须在 0.5 到 4 mg/L 之间")
    if not 0.0 <= values["recycleRatio"] <= 5.0:
        raise ValueError("内回流倍数须在 0 到 5 之间")
    if not 0.0 <= values["carbonDose"] <= 5.0:
        raise ValueError("外加碳源投加量须在 0 到 5 m3/d 之间")
    return values


def simulate(params, on_progress=None):
    """执行一次 BSM1 仿真，返回 (metrics, series)。"""
    cfg = validate(params)
    model = BSM1OL(data_in=os.path.join(INFLUENT_DIR, INFLUENT_FILES[cfg["weather"]]),
                   timestep=1 / 1440, endtime=cfg["horizonDays"],
                   evaltime=int(round(cfg["evalDays"])))
    model.qintr = cfg["recycleRatio"] * QI_STAB
    model.reactor1.carb = cfg["carbonDose"]

    dt_days = 1 / 1440
    klass = np.array([0.0, 0.0, KLA_FIXED, KLA_FIXED, KLA5_OFFSET], dtype=float)
    integral = 0.0
    total_steps = step_count(model)
    report_every = max(1, total_steps // 100)
    eval_start = float(model.evaltime[0])
    sample_every = SERIES_INTERVAL_MINUTES

    times, so5_series, effluent_series = [], [], []

    for i in range(total_steps):
        # 第 5 格溶解氧 -> KLa5 的位置式 PI 控制
        error = cfg["doSetpoint"] - float(model.y_out5[SO])
        candidate = KLA5_OFFSET + KP * error + KI * integral
        klass[4] = float(np.clip(candidate, KLA5_MIN, KLA5_MAX))
        if KLA5_MIN < candidate < KLA5_MAX:  # 未饱和时才累积，抗积分饱和
            integral += error * dt_days
        model.step(i, klass)

        now = float(model.simtime[i])
        if now >= eval_start and i % sample_every == 0:
            times.append(round(now, 4))
            so5_series.append(round(float(model.y_out5[SO]), 3))
            effluent_series.append([round(float(model.ys_eff[SNH]), 3),
                                    round(float(model.ys_eff[TSS]), 3),
                                    round(float(model.ys_eff[SNO]), 3)])
        if on_progress is not None and i % report_every == 0:
            on_progress(min(i / total_steps, 0.98))

    model.finish_evaluation(plot=False)

    iqi, eqi, me, pe, ae = (float(v) for v in model.get_final_performance())
    start = min(int(model.eval_idx[0]), len(model.y_out5_all) - 1)
    end = min(int(model.eval_idx[1]) + 1, len(model.y_out5_all))
    so5 = model.y_out5_all[start:end, SO]
    eff = model.ys_eff_all[start:end]

    metrics = {
        "iqi": round(iqi, 2),
        "eqi": round(eqi, 2),
        "aerationEnergy": round(ae, 4),
        "pumpingEnergy": round(pe, 4),
        "mixingEnergy": round(me, 4),
        "effluentSnhMean": round(float(np.mean(eff[:, SNH])), 4),
        "effluentTssMean": round(float(np.mean(eff[:, TSS])), 4),
        "effluentSnoMean": round(float(np.mean(eff[:, SNO])), 4),
        "doSetpoint": cfg["doSetpoint"],
        "doTank5Mean": round(float(np.mean(so5)), 3),
        "doTank5Min": round(float(np.min(so5)), 3),
        "doTank5Max": round(float(np.max(so5)), 3),
        "recycleRatio": cfg["recycleRatio"],
        "internalRecycle": float(model.qintr),
        "carbonDose": cfg["carbonDose"],
        "horizonDays": cfg["horizonDays"],
        "evalDays": cfg["evalDays"],
        "weather": cfg["weather"],
        "steps": total_steps,
    }
    series = {
        "time": times,
        "soTank5": so5_series,
        "effluent": effluent_series,
        "effluentColumns": ["SNH", "TSS", "SNO"],
        "intervalMinutes": SERIES_INTERVAL_MINUTES,
    }
    return metrics, series


def run_job(conn, job_id, params):
    log(f"任务 {job_id} 开始：{json.dumps(params, ensure_ascii=False)}")
    started = time.perf_counter()
    try:
        metrics, series = simulate(params, lambda value: set_progress(conn, job_id, value))
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO sim_results (job_id, metrics, series, notes)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (job_id) DO UPDATE
                   SET metrics=EXCLUDED.metrics, series=EXCLUDED.series, notes=EXCLUDED.notes""",
                (job_id, json.dumps(metrics), json.dumps(series),
                 json.dumps(NOTES, ensure_ascii=False)))
            cur.execute("""UPDATE sim_jobs SET status='ready', progress=1, completed_at=now(),
                           error_message=NULL WHERE id=%s""", (job_id,))
        conn.commit()
        log(f"任务 {job_id} 完成，耗时 {time.perf_counter() - started:.1f} 秒")
    except Exception as error:
        conn.rollback()
        log(f"任务 {job_id} 失败：{error}")
        traceback.print_exc()
        with conn.cursor() as cur:
            cur.execute("""UPDATE sim_jobs SET status='failed', error_message=%s, completed_at=now()
                           WHERE id=%s""", (str(error)[:500], job_id))
        conn.commit()


def main():
    log("仿真服务启动")
    conn = psycopg.connect(DATABASE_URL, autocommit=False)
    setup(conn)
    warm_up()
    log("开始轮询任务")
    while True:
        try:
            job = claim(conn)
        except Exception:
            conn.rollback()
            traceback.print_exc()
            time.sleep(POLL_SECONDS)
            continue
        if job is None:
            time.sleep(POLL_SECONDS)
            continue
        run_job(conn, job[0], job[1])


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
