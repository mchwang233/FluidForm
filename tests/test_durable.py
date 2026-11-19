"""A task cut off by a service restart goes on by itself (resume_after_restart), when it works in no
project and waits for nobody; finished steps keep their results."""
from super_partner.config import settings
from super_partner.models import ExecutionRun, NodeStatus, RunStatus, TaskNode, TaskPlan


def interrupted(api, run_id, **fields):
    nodes = [TaskNode(id="done", title="a", instructions="i", capability="coding", status=NodeStatus.SUCCEEDED),
             TaskNode(id="cut", title="b", instructions="i", capability="coding", status=NodeStatus.RUNNING)]
    api.db.save_run(ExecutionRun(id=run_id, prompt="p", status=RunStatus.RUNNING, budget_usd=1,
                                 plan=TaskPlan(summary="s", nodes=nodes), **fields))


async def test_a_task_cut_off_by_a_restart_goes_on_by_itself(task_api, monkeypatch, tmp_path):
    api, _ = task_api
    monkeypatch.setattr(api.catalog_sync, "start", lambda: None)
    monkeypatch.setattr(settings, "resume_after_restart", True)
    started = []
    monkeypatch.setattr(api.executor, "start", started.append)
    interrupted(api, "free")
    interrupted(api, "project", project_dir=str(tmp_path))
    interrupted(api, "asking", waiting_diagnosis_id="d1")
    async with api.lifespan(api.app):
        assert started == ["free"]
        run = api.db.get_run("free")
        assert run.status == RunStatus.QUEUED and run.plan.nodes[0].status == NodeStatus.SUCCEEDED
        assert [event.kind for event in api.db.events("free")] == ["run.restart_resumed"]
        for run_id in ("project", "asking"):
            assert api.db.get_run(run_id).status == RunStatus.PAUSED


async def test_without_the_setting_every_cut_off_task_waits(task_api, monkeypatch):
    api, _ = task_api
    monkeypatch.setattr(api.catalog_sync, "start", lambda: None)
    started = []
    monkeypatch.setattr(api.executor, "start", started.append)
    interrupted(api, "free")
    async with api.lifespan(api.app):
        assert not started and api.db.get_run("free").status == RunStatus.PAUSED
