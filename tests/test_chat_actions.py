"""A chat asks FluidForm to start a task, send a file or call the platform engineer through tool
calls (chat_actions.py, settings.chat_action_tools); each becomes the line it stands for."""
import json

from super_partner import agent, chat_actions, supervisor
from super_partner.config import settings
from super_partner.models import ExecutionRun, RunStatus, SupervisorSession, TaskPlan
from super_partner.providers import ProviderRegistry, ProviderResult


async def test_tool_calls_become_the_lines_the_answer_is_read_by(monkeypatch, tmp_path):
    registry = ProviderRegistry()
    offered = []

    async def complete(model_id, prompt, *args, **kwargs):
        # What _loop does: offer the tools, run the calls the model makes in its workspace.
        offered.append([tool["name"] for tool in chat_actions.offered()])
        workspace = agent.Workspace(tmp_path)
        assert (await workspace.run("StartTask", {"request": "做一个记账网站\n要能导出"}))[1]
        assert not (await workspace.run("StartTask", {"request": "再来一个"}))[1]
        assert (await workspace.run("SendFile", {"name": "avatar.png"}))[1]
        return ProviderResult("好的，我来安排。", 1, 1)

    monkeypatch.setattr(registry, "complete", complete)
    session = SupervisorSession(model_id="x:best", cwd=str(tmp_path))
    tools = {"folder": tmp_path, "network": False, "turns": 5, "seconds": 5, "actions": ["StartTask", "SendFile"]}
    result = await registry.converse(session, "帮我做个网站", tools=tools)
    assert offered == [["StartTask", "SendFile"]]
    text, request = supervisor.split_task(result.text)
    assert request == "做一个记账网站\n要能导出"
    assert supervisor.split_sends(text) == ("好的，我来安排。", ["avatar.png"])
    assert supervisor.for_person(result.text) == "好的，我来安排。"
    # Outside that answer nothing is offered, and a call does nothing.
    assert chat_actions.offered() == []
    assert not (await agent.Workspace(tmp_path).run("StartTask", {"request": "x"}))[1]


def test_an_engineer_call_reads_as_its_line():
    lines = []
    token = chat_actions.pending.set((lines, frozenset({"CallEngineer"})))
    try:
        assert chat_actions.run("CallEngineer", {"kind": "anything", "request": "飞书收不到图片"})[1]
        assert not chat_actions.run("SendFile", {"name": "a.png"})[1]
    finally:
        chat_actions.pending.reset(token)
    _, call = supervisor.split_engineer(chat_actions.with_actions("我请平台工程师来看看。", lines))
    assert call == {"kind": "repair", "request": "飞书收不到图片"}
    assert json.loads(lines[0].split(":", 1)[1])["kind"] == "repair"


def test_which_chats_get_which_tools(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "chat_tools", True)
    monkeypatch.setattr(settings, "workspace_root", tmp_path)
    web = ExecutionRun(id="c", prompt="p", kind="chat", status=RunStatus.DRAFT, budget_usd=1, plan=TaskPlan(summary="s", nodes=[]))
    feishu = web.model_copy(update={"origin": {"capability": "feishu-bot"}})
    assert supervisor.chat_tools(feishu)["actions"] == []  # off by default
    monkeypatch.setattr(settings, "chat_action_tools", True)
    assert supervisor.chat_tools(web)["actions"] == ["CallEngineer"]
    assert supervisor.chat_tools(feishu)["actions"] == ["StartTask", "SendFile", "CallEngineer"]
