"""Capabilities: a succeeded task's lead proposes what it built that is reusable; the user
solidifies it; later steps are told how to use it (capabilities.py, docs/design/capabilities.md)."""
import json

import pytest
from super_partner import agent, capabilities, quality
from super_partner.config import settings
from super_partner.executor import Executor
from super_partner.models import CapabilityProposal, ExecutionRun, RunStatus, TaskNode, TaskPlan
from super_partner.providers import ProviderResult
from test_leading import MODELS, Team

ORIGIN = {"origin": "http://localhost:5173"}
CARD = {"name": "飞书发消息", "kind": "tool", "summary": "向飞书群发一条消息。", "usage": "python send.py --chat <id> --text <内容>",
        "files": ["feishu"], "check": "python3 feishu/send.py --help", "secrets": ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
        "domains": ["open.feishu.cn"]}


class Lead(Team):
    """A team whose lead names what the task built when asked."""

    def __init__(self, reply):
        super().__init__([], fails=0)
        self.reply = reply

    async def converse(self, session, prompt, spend_ok=None, timeout=600, **_kwargs):
        if capabilities.PROMPT in prompt:
            self.lead.append(prompt)
            return ProviderResult(self.reply, 0, 0, session.model_id)
        return await super().converse(session, prompt, spend_ok, timeout)


def test_the_leads_cards_are_read_carefully():
    text = "这样吧：\n```json\n" + json.dumps({"capabilities": [
        CARD, {**CARD, "name": "无文件"} | {"files": []}, {**CARD, "name": "x", "kind": "daemon"},
        {**CARD, "name": "y"}, {**CARD, "name": "z"}]}, ensure_ascii=False) + "\n```"
    cards = capabilities.read_cards(text)
    # Nothing to keep without files; an unknown kind is a tool; at most three.
    assert [(card.name, card.kind) for card in cards] == [("飞书发消息", "tool"), ("x", "tool"), ("y", "tool")]
    assert cards[0].secrets == ["FEISHU_APP_ID", "FEISHU_APP_SECRET"] and cards[0].status == "proposed"
    assert capabilities.read_cards("没有") == capabilities.read_cards('{"capabilities": []}') == []


async def test_a_succeeded_task_gets_its_leads_proposals_when_enabled(database, monkeypatch):
    monkeypatch.setattr(settings, "capability_proposals", True)
    team = Lead(json.dumps({"capabilities": [CARD]}, ensure_ascii=False))
    executor = Executor(database, team, MODELS)
    await executor.execute("r")
    assert database.get_run("r").status == RunStatus.SUCCEEDED
    await executor.capability_tasks["r"]
    [proposal] = database.get_run("r").capability_proposals
    assert proposal.name == "飞书发消息" and proposal.status == "proposed"
    assert [event.kind for event in database.events("r")][-1] == "run.capabilities_proposed"


async def test_without_the_setting_the_lead_is_not_asked(database, monkeypatch):
    monkeypatch.setattr(settings, "capability_proposals", False)
    team = Lead(json.dumps({"capabilities": [CARD]}))
    executor = Executor(database, team, MODELS)
    await executor.execute("r")
    assert executor.capability_tasks == {} and not any(capabilities.PROMPT in prompt for prompt in team.lead)
    assert database.get_run("r").capability_proposals == []


def finished(api, tmp_path, check="python3 feishu/send.py --help") -> ExecutionRun:
    run = ExecutionRun(id="built", prompt="接飞书", status=RunStatus.SUCCEEDED, budget_usd=1,
                       plan=TaskPlan(summary="接飞书", nodes=[TaskNode(id="a", title="a", instructions="i", capability="coding")]),
                       capability_proposals=[CapabilityProposal(**{**CARD, "check": check})])
    folder = settings.workspace_root / run.folder_id / "feishu"
    folder.mkdir(parents=True)
    (folder / "send.py").write_text("import sys\nprint('usage: send.py --chat ID --text TEXT')\n")
    (settings.workspace_root / run.folder_id / "secret.txt").write_text("not part of it")
    api.db.save_run(run)
    return run


@pytest.mark.skipif(not agent.sandbox_available(), reason="bubblewrap is not installed")
async def test_a_proposal_solidified_is_copied_checked_listed_and_told_to_later_steps(task_api, tmp_path):
    api, client = task_api
    finished(api, tmp_path)
    response = await client.post("/api/tasks/built/capabilities/0/solidify", headers=ORIGIN)
    assert response.status_code == 200, response.text
    proposal = api.db.get_run("built").capability_proposals[0]
    assert proposal.status == "solidified" and proposal.capability_id
    [capability] = (await client.get("/api/capabilities")).json()
    assert (capability["name"], capability["status"], capability["check_ok"], capability["source_run_id"]) == \
        ("飞书发消息", "active", True, "built")
    assert "usage: send.py" in capability["check_output"]
    folder = capabilities.root() / capability["id"]
    assert (folder / "feishu" / "send.py").is_file() and not (folder / "secret.txt").exists()
    # Later steps are told it, with where it is and what it needs.
    later = ExecutionRun(id="later", prompt="p", status=RunStatus.RUNNING, budget_usd=1,
                         plan=TaskPlan(summary="s", nodes=[TaskNode(id="n", title="通知", instructions="发通知", capability="coding")]))
    prompt, _ = quality.node_prompt(later.plan.nodes[0], later, 4000)
    assert "飞书发消息" in prompt and str(folder) in prompt and "FEISHU_APP_SECRET" in prompt
    # Switched off, later work is no longer told; removed, it is gone.
    assert (await client.patch(f"/api/capabilities/{capability['id']}", json={"enabled": False}, headers=ORIGIN)).json()["status"] == "disabled"
    assert "飞书发消息" not in quality.node_prompt(later.plan.nodes[0], later, 4000)[0]
    assert (await client.delete(f"/api/capabilities/{capability['id']}", headers=ORIGIN)).status_code == 204
    assert (await client.get("/api/capabilities")).json() == [] and not folder.exists()
    # A proposal is handled once.
    assert (await client.post("/api/tasks/built/capabilities/0/solidify", headers=ORIGIN)).status_code == 409


@pytest.mark.skipif(not agent.sandbox_available(), reason="bubblewrap is not installed")
async def test_a_capability_whose_check_fails_is_kept_failed_and_cannot_be_enabled(task_api, tmp_path):
    api, client = task_api
    finished(api, tmp_path, check="python3 feishu/send.py && exit 3")
    await client.post("/api/tasks/built/capabilities/0/solidify", headers=ORIGIN)
    [capability] = (await client.get("/api/capabilities")).json()
    assert capability["status"] == "failed" and capability["check_ok"] is False and "Exit code 3" in capability["check_output"]
    assert (await client.patch(f"/api/capabilities/{capability['id']}", json={"enabled": True}, headers=ORIGIN)).status_code == 409
    assert "飞书发消息" not in capabilities.section()


async def test_only_files_inside_the_tasks_folder_are_kept_and_a_proposal_can_be_dismissed(task_api, tmp_path):
    api, client = task_api
    run = finished(api, tmp_path)
    run.capability_proposals = [CapabilityProposal(**{**CARD, "files": ["../../outside"]}), CapabilityProposal(**CARD)]
    api.db.save_run(run)
    response = await client.post("/api/tasks/built/capabilities/0/solidify", headers=ORIGIN)
    assert response.status_code == 422 and "不在任务目录里" in response.text
    assert capabilities.library() == []
    assert (await client.post("/api/tasks/built/capabilities/1/dismiss", headers=ORIGIN)).json()["capability_proposals"][1]["status"] == "dismissed"


def test_records_saved_before_capabilities_existed_load():
    stored = {"id": "old", "prompt": "p", "status": "succeeded", "budget_usd": 1, "plan": {"summary": "s", "nodes": []}}
    assert ExecutionRun.model_validate(stored).capability_proposals == []
