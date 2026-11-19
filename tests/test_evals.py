"""The eval suite (evals.py): each case planned, confirmed and followed through the API, judged
against its expectations, summarised and compared with an earlier report."""
import json
from pathlib import Path

import httpx
from super_partner import evals


def service(final):
    """A service whose task ends as ``final`` after one look."""
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path))
        if request.url.path == "/api/tasks":
            body = json.loads(request.content)
            assert body["allow_network"] is True and body["budget_usd"] == 0.5
            return httpx.Response(201, json={"id": "t1", "plan": {"nodes": [{}], "planning_note": "一步就能做完"}})
        if request.url.path.endswith("/confirm"):
            return httpx.Response(200, json={"id": "t1", "status": "queued"})
        return httpx.Response(200, json=final)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://svc"), seen


CASE = {"name": "换算", "prompt": "37 摄氏度是多少华氏度", "budget_usd": 0.5, "allow_network": True,
        "expect": {"contains_any": ["98.6"], "max_cost_usd": 0.1}}


async def test_a_case_is_followed_to_its_end_and_judged():
    done = {"status": "succeeded", "final_result": "98.6°F", "actual_cost_usd": 0.004,
            "plan": {"nodes": [{"attempts": [{}]}]}, "decisions": []}
    client, seen = service(done)
    async with client:
        report = await evals.run_suite(client, [CASE], poll=0)
    [row] = report["cases"]
    assert row["passed"] and row["problems"] == [] and (row["steps"], row["attempts"], row["cost_usd"]) == (1, 1, 0.004)
    assert seen == [("POST", "/api/tasks"), ("POST", "/api/tasks/t1/confirm"), ("GET", "/api/tasks/t1")]
    assert report["summary"]["passed"] == 1


async def test_a_wrong_or_costly_result_does_not_pass():
    client, _ = service({"status": "succeeded", "final_result": "100°F", "actual_cost_usd": 0.5, "plan": {"nodes": []}})
    async with client:
        [row] = (await evals.run_suite(client, [CASE], poll=0))["cases"]
    assert not row["passed"] and len(row["problems"]) == 2


def test_reports_are_compared_case_by_case():
    before = {"summary": {"cases": 1, "passed": 0, "median_seconds": 200, "total_cost_usd": 0.1},
              "cases": [{"name": "换算", "passed": False, "plan_seconds": 150, "run_seconds": 50}]}
    now = {"summary": evals.summary([{"name": "换算", "passed": True, "plan_seconds": 2, "run_seconds": 40}]),
           "cases": [{"name": "换算", "passed": True, "plan_seconds": 2, "run_seconds": 40}]}
    lines = evals.compare(now, before)
    assert lines[0] == "换算：现在通过" and lines[1] == "换算：200 秒 → 42 秒" and lines[2].startswith("通过 0/1 → 1/1")


def test_the_suite_in_the_repository_loads():
    cases = evals.load(Path(__file__).parent.parent / "evals" / "basic.json")
    assert len(cases) >= 5 and len({case["name"] for case in cases}) == len(cases)
