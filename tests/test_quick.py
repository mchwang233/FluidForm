"""Faster tasks: a task one model can do in one go skips the lead's planning (triage.quick), an
easy step stands on its own result (review_easy_steps), and a passed check before the first step
stands for a while (preflight_cache_minutes)."""
import pytest
from super_partner import preflight, triage
from super_partner.config import settings
from super_partner.db import Database
from super_partner.executor import Executor
from super_partner.models import ExecutionRun, PreflightCheck, RunStatus, TaskNode, TaskPlan
from super_partner.providers import ProviderResult
from test_chat import ORIGIN, chatting

QUICK = ('{"quick": true, "title": "海边女孩头像", "capability": "tool_use", "needs_images": true, '
         '"acceptance": "一张方形的海边女孩头像图片"}')


def judging(api, monkeypatch, answer):
    """The cheap model's answer to whether a task is quick, and a planner that records being asked."""
    chatting(api, monkeypatch)
    asked, planned = [], []

    async def complete(model_id, prompt, *_args, **_kwargs):
        asked.append(prompt)
        return ProviderResult(answer, 100, 10)

    async def plan(prompt, *_args, **_kwargs):
        planned.append(prompt)
        return TaskPlan(summary="排好的计划", nodes=[TaskNode(id="a", title="做", instructions="i", capability="coding")])

    monkeypatch.setattr(api.providers, "complete", complete)
    monkeypatch.setattr(api, "autonomous_plan", plan)
    return asked, planned


async def test_a_quick_task_gets_one_easy_step_without_the_leads_planning(task_api, monkeypatch):
    api, client = task_api
    monkeypatch.setattr(settings, "quick_tasks", True)
    asked, planned = judging(api, monkeypatch, QUICK)
    created = await client.post("/api/tasks", json={"prompt": "画一张海边女孩的头像"}, headers=ORIGIN)
    assert created.status_code == 201, created.text
    plan = created.json()["plan"]
    assert not planned and len(asked) == 1 and asked[0].startswith("Is this request work that one capable model")
    [node] = plan["nodes"]
    assert (node["title"], node["difficulty"], node["needs_images"], node["capability"]) == ("海边女孩头像", "easy", True, "tool_use")
    assert "画一张海边女孩的头像" in node["instructions"] and plan["planning_note"].startswith("一步就能做完")
    assert created.json()["status"] == RunStatus.AWAITING_CONFIRMATION


@pytest.mark.parametrize("answer", ['{"quick": false}', "不确定", '{"quick": "yes"}'])
async def test_anything_else_is_planned_as_before(task_api, monkeypatch, answer):
    api, client = task_api
    monkeypatch.setattr(settings, "quick_tasks", True)
    _, planned = judging(api, monkeypatch, answer)
    created = await client.post("/api/tasks", json={"prompt": "做一个记账网站"}, headers=ORIGIN)
    assert created.status_code == 201 and len(planned) == 1


async def test_without_the_setting_or_for_a_project_every_task_is_planned(task_api, monkeypatch, tmp_path):
    api, client = task_api
    asked, planned = judging(api, monkeypatch, QUICK)
    await client.post("/api/tasks", json={"prompt": "画一张头像"}, headers=ORIGIN)
    assert len(planned) == 1 and not asked
    monkeypatch.setattr(settings, "quick_tasks", True)
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr(settings, "project_roots", [tmp_path])
    await client.post("/api/tasks", json={"prompt": "画一张头像", "project_dir": str(project)}, headers=ORIGIN)
    assert len(planned) == 2 and not [prompt for prompt in asked if prompt.startswith("Is this request")]


async def test_a_quick_answer_is_read_defensively():
    class Model:
        id = "x:cheap"
        input_per_million = output_per_million = cached_input_per_million = 0

    class Providers:
        def __init__(self, text):
            self.text = text

        async def complete(self, *args, **kwargs):
            return ProviderResult(self.text, 1, 1)

    step, _ = await triage.quick("x", Providers('好的：{"quick": true, "capability": "rm -rf"}'), Model())
    assert step["capability"] == "tool_use" and step["title"] == "x" and step["needs_images"] is False
    assert (await triage.quick("x", Providers("{"), Model()))[0] is None
    assert (await triage.quick("x", Providers(QUICK), None))[0] is None


def saved(db, difficulty):
    node = TaskNode(id="n", title="头像", instructions="画", capability="tool_use", model_id="x:api", difficulty=difficulty)
    run = ExecutionRun(id="r", prompt="p", status=RunStatus.RUNNING, budget_usd=1, plan=TaskPlan(summary="p", nodes=[node]))
    db.save_run(run)
    return run, node


async def test_an_easy_step_stands_on_its_own_result_when_easy_reviews_are_off(tmp_path, monkeypatch):
    db = Database(tmp_path / "t.db")
    executor = Executor(db, None, {})  # no providers: a review would fail
    monkeypatch.setattr(settings, "review_easy_steps", False)
    run, node = saved(db, "easy")
    verdict = await executor._check(run, node, "画好了 avatar.jpg", [], tmp_path)
    assert verdict.passed and "简单步骤" in verdict.reason
    # A normal step is still reviewed by another model (here none can: it is left unverified).
    run, node = saved(db, "normal")
    verdict = await executor._check(run, node, "画好了", [], tmp_path)
    assert "简单步骤" not in verdict.reason and not (verdict.passed and verdict.verified)


async def test_a_passed_check_stands_for_the_next_task_alike_until_it_expires(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "preflight", True)
    monkeypatch.setattr(settings, "workspace_root", tmp_path / "ws")
    monkeypatch.setattr(settings, "preflight_cache_minutes", 60)
    monkeypatch.setattr(preflight, "PASSED", {})
    db = Database(tmp_path / "t.db")
    executor = Executor(db, None, {})
    ran = []

    async def all_checks(run, workspace):
        ran.append(run.id)
        return [PreflightCheck(name="步骤沙箱", command="(内置)", ok=True)]

    async def prepare(run_id, workspace, checks):
        return []

    monkeypatch.setattr(executor, "_all_checks", all_checks)
    monkeypatch.setattr(executor, "_prepare_skills", prepare)

    def task(run_id, network=False):
        node = TaskNode(id="n", title="t", instructions="i", capability="coding", model_id="x:api")
        db.save_run(ExecutionRun(id=run_id, prompt="p", status=RunStatus.QUEUED, budget_usd=1, allow_network=network,
                                 plan=TaskPlan(summary="s", nodes=[node])))

    for run_id in ("a", "b"):
        task(run_id)
        assert await executor._preflight(run_id)
    assert ran == ["a"] and db.get_run("b").preflight.cached and not db.get_run("a").preflight.cached
    # A task with other settings is checked; so is one after the cache expires, or with it off.
    task("c", network=True)
    assert await executor._preflight("c") and ran == ["a", "c"]
    monkeypatch.setattr(settings, "preflight_cache_minutes", 0)
    task("d")
    assert await executor._preflight("d") and ran == ["a", "c", "d"]


async def test_a_failed_check_is_not_remembered(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "preflight_cache_minutes", 60)
    monkeypatch.setattr(preflight, "PASSED", {})
    run = ExecutionRun(id="r", prompt="p", status=RunStatus.QUEUED, budget_usd=1,
                       plan=TaskPlan(summary="s", nodes=[TaskNode(id="n", title="t", instructions="i", capability="coding")]))
    assert preflight.passed_before(preflight.cache_key(run)) is None
