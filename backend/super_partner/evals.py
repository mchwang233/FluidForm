"""A fixed set of tasks run on the live service, to see whether a change made FluidForm better or
worse: how many pass, how long they take, what they cost (`super-partner eval`).

A suite is a JSON file (evals/basic.json): {"cases": [{"name", "prompt", "budget_usd",
"allow_network", "timeout_seconds", "expect": {"status", "contains_any", "max_seconds",
"max_cost_usd"}}]}. Each case is planned, confirmed and followed through the service's own API,
as a user would; the report lists every case and a summary, and can be compared with an earlier
one."""
from __future__ import annotations

import asyncio
import json
import statistics
import time
from pathlib import Path
from typing import Optional

import httpx

FINAL = {"succeeded", "failed", "cancelled", "incomplete", "paused"}
POLL_SECONDS = 2.0


def load(path: Path) -> list[dict]:
    cases = json.loads(Path(path).read_text()).get("cases") or []
    for case in cases:
        if not isinstance(case.get("name"), str) or not isinstance(case.get("prompt"), str):
            raise TypeError("every case needs a name and a prompt")
    return cases


def judge(case: dict, run: dict, seconds: float) -> list[str]:
    """What a finished task fails of the case's expectations (empty: it passed)."""
    expect = case.get("expect") or {}
    problems = []
    if run.get("status") != expect.get("status", "succeeded"):
        problems.append(f"状态 {run.get('status')}" + (f"：{str(run.get('error'))[:200]}" if run.get("error") else ""))
    text = f"{run.get('final_result') or ''}"
    wanted = expect.get("contains_any") or []
    if wanted and not any(item.lower() in text.lower() for item in wanted):
        problems.append("结果里没有：" + " / ".join(wanted))
    if expect.get("max_seconds") and seconds > expect["max_seconds"]:
        problems.append(f"用了 {seconds:.0f} 秒，超过 {expect['max_seconds']} 秒")
    if expect.get("max_cost_usd") is not None and (run.get("actual_cost_usd") or 0) > expect["max_cost_usd"]:
        problems.append(f"花了 ${run.get('actual_cost_usd'):.4f}，超过 ${expect['max_cost_usd']}")
    return problems


async def run_case(client: httpx.AsyncClient, case: dict, poll: float = POLL_SECONDS) -> dict:
    """Plan, confirm and follow one case to its end; what happened."""
    began = time.monotonic()
    row = {"name": case["name"], "passed": False}
    created = await client.post("/api/tasks", json={
        "prompt": case["prompt"], "budget_usd": case.get("budget_usd", 1.0),
        "allow_network": bool(case.get("allow_network")), "use_cli": case.get("use_cli", True)}, timeout=600)
    row["plan_seconds"] = round(time.monotonic() - began, 1)
    if created.is_error:
        return {**row, "problems": [f"排计划失败：HTTP {created.status_code} {created.text[:200]}"]}
    task = created.json()
    row.update(task_id=task["id"], steps=len(task["plan"]["nodes"]), planning_note=task["plan"].get("planning_note") or "")
    confirmed = await client.post(f"/api/tasks/{task['id']}/confirm", json={"budget_usd": case.get("budget_usd", 1.0)})
    if confirmed.is_error:
        return {**row, "problems": [f"确认失败：HTTP {confirmed.status_code} {confirmed.text[:200]}"]}
    started = time.monotonic()
    deadline = started + case.get("timeout_seconds", 900)
    run = confirmed.json()
    while run.get("status") not in FINAL and time.monotonic() < deadline:
        await asyncio.sleep(poll)
        run = (await client.get(f"/api/tasks/{task['id']}")).json()
    seconds = time.monotonic() - started
    if run.get("status") not in FINAL:
        await client.post(f"/api/tasks/{task['id']}/cancel")
        run["status"] = "timed out"
    nodes = run.get("plan", {}).get("nodes", [])
    problems = judge(case, run, seconds)
    return {**row, "status": run.get("status"), "passed": not problems, "problems": problems,
            "run_seconds": round(seconds, 1), "cost_usd": round(run.get("actual_cost_usd") or 0, 6),
            "attempts": sum(len(node.get("attempts") or []) for node in nodes),
            "decisions": len(run.get("decisions") or [])}


def summary(rows: list[dict]) -> dict:
    timed = [row["plan_seconds"] + row.get("run_seconds", 0) for row in rows]
    return {"cases": len(rows), "passed": sum(row["passed"] for row in rows),
            "median_seconds": round(statistics.median(timed), 1) if timed else 0,
            "total_cost_usd": round(sum(row.get("cost_usd", 0) for row in rows), 6),
            "decisions": sum(row.get("decisions", 0) for row in rows)}


async def run_suite(client: httpx.AsyncClient, cases: list[dict], only: Optional[list[str]] = None,
                    poll: float = POLL_SECONDS) -> dict:
    """Every case, one after another (so their times do not disturb each other)."""
    rows = [await run_case(client, case, poll) for case in cases if not only or case["name"] in only]
    return {"summary": summary(rows), "cases": rows}


def compare(report: dict, before: dict) -> list[str]:
    """Lines saying what changed since an earlier report, case by case and overall."""
    lines = []
    old = {row["name"]: row for row in before.get("cases") or []}
    for row in report["cases"]:
        earlier = old.get(row["name"])
        if not earlier:
            continue
        if earlier["passed"] != row["passed"]:
            lines.append(f"{row['name']}：{'现在通过' if row['passed'] else '现在没通过'}")
        then = earlier["plan_seconds"] + earlier.get("run_seconds", 0)
        now = row["plan_seconds"] + row.get("run_seconds", 0)
        if then and abs(now - then) / then > 0.25:
            lines.append(f"{row['name']}：{then:.0f} 秒 → {now:.0f} 秒")
    a, b = before.get("summary") or {}, report["summary"]
    if a:
        lines.append(f"通过 {a.get('passed')}/{a.get('cases')} → {b['passed']}/{b['cases']}；"
                     f"中位耗时 {a.get('median_seconds')} → {b['median_seconds']} 秒；"
                     f"总花费 ${a.get('total_cost_usd')} → ${b['total_cost_usd']}")
    return lines
