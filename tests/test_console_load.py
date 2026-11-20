"""The console polls every few seconds: the task list carries no step logs, and nothing is sent
again when nothing changed. The web page was slow with 20 tasks, because every two seconds it
fetched 7 MB of task list (every step's tool output and changed files) and 650 KB of engineer
jobs (every change's diff)."""
from super_partner.models import (
    Decision,
    EngineerJob,
    ExecutionRun,
    LeadMessage,
    NodeAttempt,
    RunStatus,
    SupervisorSession,
    TaskNode,
    TaskPlan,
    ToolCall,
)


def heavy_run(run_id="r"):
    calls = [ToolCall(turn=i, tool="command", detail="make", output="x" * 5000) for i in range(20)]
    node = TaskNode(id="a", title="实现", instructions="写代码", capability="coding",
                    changed_files=[f"src/file{i}.py" for i in range(2000)],
                    attempts=[NodeAttempt(model_id="cli:codex", outcome="passed", tool_calls=calls, result="做完了")])
    node.result = "做完了"
    return ExecutionRun(id=run_id, prompt="写个模块", status=RunStatus.SUCCEEDED, budget_usd=1,
                        plan=TaskPlan(summary="s", nodes=[node]),
                        decisions=[Decision(event="all_done", action="done", reason="好")],
                        lead_messages=[LeadMessage(role="user", text="z" * 20000)],
                        supervisor=SupervisorSession(model_id="cli:claude", history=[{"role": "user", "content": "y" * 50000}]))


async def test_the_task_list_is_brief_and_a_task_in_full(task_api):
    api, client = task_api
    api.db.save_run(heavy_run())
    full = (await client.get("/api/tasks")).json()[0]
    brief = await client.get("/api/tasks", params={"brief": "true"})
    listed = brief.json()[0]
    assert len(brief.content) < 5000
    step = listed["plan"]["nodes"][0]
    assert step["changed_files"] == [] and step["attempts"][0]["tool_calls"] == []
    assert step["attempts"][0]["result"] is None and step["attempts"][0]["outcome"] == "passed"
    assert listed["supervisor"]["model_id"] == "cli:claude" and listed["supervisor"]["history"] == []
    assert step["result"] is None and listed["decisions"] == [] and listed["plan"]["employees"] == []
    assert [message["role"] for message in listed["lead_messages"]] == ["user"]
    assert listed["lead_messages"][0]["text"] == ""
    # The task opened is read in full, but for its changed files: the page shows 50 and the count
    # (the axi-to-apb task's simulation left 2.3 MB of them).
    detail = (await client.get("/api/tasks/r")).json()
    opened = detail["plan"]["nodes"][0]
    assert opened["attempts"][0]["result"] == "做完了" and len(opened["attempts"][0]["tool_calls"]) == 20
    assert detail["supervisor"]["model_id"] == "cli:claude" and detail["supervisor"]["history"] == []
    assert len(opened["changed_files"]) == 50 and opened["changed_files_total"] == 2000
    assert full["plan"]["nodes"][0]["changed_files_total"] is None  # nothing cut, nothing said


async def test_nothing_is_sent_again_when_nothing_changed(task_api):
    api, client = task_api
    api.db.save_run(heavy_run())
    tags = {}
    for url, params in [("/api/tasks", {"brief": "true"}), ("/api/tasks/r", {}), ("/api/engineer", {})]:
        first = await client.get(url, params=params)
        tags[url] = first.headers["etag"]
        again = await client.get(url, params=params, headers={"If-None-Match": tags[url]})
        assert again.status_code == 304 and again.content == b"", url
    run = api.db.get_run("r")
    run.final_result = "改了"
    api.db.save_run(run)
    # A change is sent, whether or not the task's time was updated with it.
    changed = await client.get("/api/tasks/r", headers={"If-None-Match": tags["/api/tasks/r"]})
    assert changed.status_code == 200 and changed.json()["final_result"] == "改了"
    listed = await client.get("/api/tasks", params={"brief": "true"}, headers={"If-None-Match": tags["/api/tasks"]})
    assert listed.status_code == 200 and listed.json()[0]["final_result"] == "改了"


async def test_engineer_jobs_are_listed_without_their_diff(task_api):
    api, client = task_api
    api.db.save_engineer_job(EngineerJob(id="j1", title="修", request="修一下", diff="+" * 400_000))
    overview = await client.get("/api/engineer")
    [job] = overview.json()["jobs"]
    assert len(overview.content) < 20_000 and job["diff"] is None and job["has_diff"] is True
    assert (await client.get("/api/engineer/jobs/j1/diff")).json() == {"diff": "+" * 400_000}


async def test_an_opened_task_leaves_tool_output_to_be_read_when_shown(task_api):
    # The server-IME task opened was 2.8 MB, 60% of it tool output few people open, and while a
    # task runs it is sent again at every change.
    api, client = task_api
    run = heavy_run()
    run.plan.nodes[0].attempts[0].tool_calls[3].detail = "c" * 2000
    api.db.save_run(run)
    opened = await client.get("/api/tasks/r")
    assert len(opened.content) < 60_000
    calls = opened.json()["plan"]["nodes"][0]["attempts"][0]["tool_calls"]
    assert len(calls) == 20 and calls[0]["tool"] == "command" and calls[0]["output"] == ""
    assert calls[0]["output_size"] == 5000 and len(calls[3]["detail"]) <= 301
    shown = await client.get("/api/tasks/r/nodes/a/attempts/0/calls/0/output")
    assert shown.json() == {"output": "x" * 5000}
    assert (await client.get("/api/tasks/r/nodes/a/attempts/0/calls/99/output")).status_code == 404
