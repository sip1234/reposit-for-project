"""Optimization worker: polls opt_jobs, runs GP-EI + Pareto, writes opt_results."""
import json
import os
import signal
import sys
import time
import traceback

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

sys.path.insert(0, "/app/simulator")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "simulator"))

from optimizer_core import OptimizationCancelled, optimize  # noqa: E402

DB = os.environ["DATABASE_URL"]
POLL_SECONDS = 2.0
CODE_VERSION = os.environ.get("CODE_VERSION", "dev")

DDL = """
CREATE TABLE IF NOT EXISTS opt_jobs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued','running','ready','failed','cancelled')),
  params jsonb NOT NULL,
  progress numeric NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS opt_results (
  job_id uuid PRIMARY KEY REFERENCES opt_jobs(id) ON DELETE CASCADE,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE opt_jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
"""


def log(*args):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *args, flush=True)


def setup(conn):
    with conn.cursor() as cur:
        for statement in DDL.split(";"):
            if statement.strip():
                cur.execute(statement)
    conn.commit()


def claim(conn):
    with conn.transaction():
        conn.execute("""UPDATE opt_jobs SET status='cancelled', completed_at=now(),
                        error_message='用户取消' WHERE status='queued' AND cancel_requested""")
        row = conn.execute("""
            UPDATE opt_jobs SET status='running', started_at=now(), progress=0, error_message=NULL
            WHERE id = (
                SELECT id FROM opt_jobs WHERE status='queued'
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            RETURNING id, params""").fetchone()
    return row


def set_progress(conn, job_id, value):
    with conn.cursor() as cur:
        cur.execute("UPDATE opt_jobs SET progress=%s WHERE id=%s", (float(value), job_id))
    conn.commit()


def should_cancel(conn, job_id):
    row = conn.execute("SELECT cancel_requested FROM opt_jobs WHERE id=%s", (job_id,)).fetchone()
    return bool(row and row["cancel_requested"])


def run_job(conn, job):
    job_id, params = job["id"], dict(job["params"])
    log(f"优化任务 {job_id} 开始：evaluations={params.get('evaluations')} "
        f"seed={params.get('seed')} load={params.get('loadFactor')}")
    started = time.time()
    try:
        result = optimize(
            params,
            on_progress=lambda done, total, point: set_progress(conn, job_id, done / total),
            should_cancel=lambda: should_cancel(conn, job_id),
        )
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO opt_results (job_id, result) VALUES (%s, %s)
                           ON CONFLICT (job_id) DO UPDATE SET result=EXCLUDED.result""",
                        (job_id, Jsonb(result)))
            cur.execute("""UPDATE opt_jobs SET status='ready', progress=1, completed_at=now(),
                           error_message=NULL WHERE id=%s""", (job_id,))
        conn.commit()
        log(f"优化任务 {job_id} 完成，耗时 {time.time() - started:.1f} 秒，"
            f"Pareto {len(result['pareto'])} 个")
    except OptimizationCancelled:
        conn.rollback()
        conn.execute("""UPDATE opt_jobs SET status='cancelled', completed_at=now(),
                        error_message='用户取消' WHERE id=%s""", (job_id,))
        conn.commit()
        log(f"优化任务 {job_id} 已取消")
    except Exception as error:
        conn.rollback()
        log(f"优化任务 {job_id} 失败：{error}")
        traceback.print_exc()
        conn.execute("""UPDATE opt_jobs SET status='failed', error_message=%s,
                        completed_at=now() WHERE id=%s""", (str(error)[:500], job_id))
        conn.commit()


def main():
    log(f"优化服务启动：code={CODE_VERSION}")
    while True:
        try:
            with psycopg.connect(DB, row_factory=dict_row) as connection:
                setup(connection)
                while True:
                    job = claim(connection)
                    if job is None:
                        time.sleep(POLL_SECONDS)
                        continue
                    run_job(connection, job)
        except Exception as error:
            print(f"Optimizer reconnecting: {error}", flush=True)
            time.sleep(5)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
