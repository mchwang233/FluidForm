"""A chat: only a conversation with a model, which the user can later turn into a task."""
from super_partner.config import settings
from super_partner.models import (
    CapabilityScore,
    ExecutionRun,
    ModelProfile,
    RunStatus,
    TaskNode,
    TaskPlan,
)
from super_partner.providers import ProviderResult
from super_partner.supervisor import CHAT_ROLE

ORIGIN = {"origin": "http://localhost:5173"}


def profile(model_id, planning):
    return ModelProfile(id=model_id, provider="x", display_name=model_id.upper(), channel="api", context_window=1_000_000,
                        input_per_million=1, output_per_million=1, execution_priority=100,
                        scores=CapabilityScore(coding=90, planning=planning, reliability=90))


BEST, OTHER = profile("x:best", 95), profile("x:other", 80)


def chatting(api, monkeypatch, answers=("好的。",)):
    """Two API models that can talk; returns the (model, cwd, prompt) of every message sent."""
    sent, replies = [], list(answers)
    models = {BEST.id: BEST, OTHER.id: OTHER}
    monkeypatch.setattr(api, "models", models)
    monkeypatch.setattr(api.executor, "model_lookup", models)
    monkeypatch.setattr(api.providers, "configured_models", lambda _ids: set(models))

    async def converse(session, prompt, timeout=None, spend_ok=None):
        sent.append((session.model_id, session.cwd, prompt))
        session.calls += 1
        return ProviderResult(replies.pop(0) if replies else "嗯。", 10, 10)

    monkeypatch.setattr(api.providers, "converse", converse)
    return sent


async def test_a_chat_is_answered_by_the_model_chosen_without_planning_anything(task_api, monkeypatch):
    api, client = task_api
    sent = chatting(api, monkeypatch, ["SQLite 的 WAL 模式允许读写并发。", "检查点会把日志写回主库。"])

    listed = (await client.get("/api/chats/models")).json()
    assert [item["id"] for item in listed] == ["x:best", "x:other"]
    response = await client.post("/api/chats", json={"message": "WAL 是什么？\n顺便说说检查点", "model_id": "x:other"},
                                 headers=ORIGIN)
    assert response.status_code == 201, response.text
    chat = response.json()
    assert (chat["kind"], chat["status"], chat["plan"]["nodes"], chat["plan"]["summary"]) == ("chat", "draft", [], "WAL 是什么？")
    await api.executor.lead_tasks[chat["id"]]
    assert (await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": "检查点呢？"}, headers=ORIGIN)).status_code == 202
    await api.executor.lead_tasks[chat["id"]]

    run = api.db.get_run(chat["id"])
    assert [(m.role, m.status, m.text) for m in run.lead_messages] == [
        ("user", "done", "WAL 是什么？\n顺便说说检查点"), ("lead", "done", "SQLite 的 WAL 模式允许读写并发。"),
        ("user", "done", "检查点呢？"), ("lead", "done", "检查点会把日志写回主库。")]
    # The chosen model answers as a conversation partner, told so once; not as a task's lead.
    assert [model for model, _, _ in sent] == ["x:other", "x:other"]
    assert sent[0][2].startswith(CHAT_ROLE) and "WAL 是什么" in sent[0][2] and "MESSAGE from the user" not in sent[0][2]
    assert sent[1][2] == "检查点呢？"
    assert run.status == RunStatus.DRAFT and run.supervisor.model_id == "x:other"


async def test_a_chat_about_a_project_reads_it_from_its_folder(task_api, monkeypatch, tmp_path):
    api, client = task_api
    sent = chatting(api, monkeypatch)
    project = tmp_path / "projects" / "shop"
    project.mkdir(parents=True)
    monkeypatch.setattr(settings, "project_roots", [tmp_path / "projects"])

    chat = (await client.post("/api/chats", json={"message": "这个项目的入口在哪？", "project_dir": str(project)},
                              headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    [(model, cwd, prompt)] = sent
    # The best model by default, in the project folder (a CLI's lead conversation there is read-only).
    assert model == "x:best" and cwd == str(project.resolve()) and str(project.resolve()) in prompt


async def test_a_chat_needs_a_model_that_can_hold_a_conversation(task_api, monkeypatch):
    api, client = task_api
    chatting(api, monkeypatch)
    response = await client.post("/api/chats", json={"message": "你好", "model_id": "x:missing"}, headers=ORIGIN)
    assert response.status_code == 422 and api.db.list_runs() == []


async def test_a_chat_turns_into_a_task_planned_with_the_conversation(task_api, monkeypatch):
    api, client = task_api
    chatting(api, monkeypatch, ["可以用 Redis 做缓存，命中率会更高。"])
    prompts = []

    async def plan(prompt, *_args, **_kwargs):
        prompts.append(prompt)
        return TaskPlan(summary="加缓存", folder="add cache",
                        nodes=[TaskNode(id="a", title="加缓存", instructions="add a cache", capability="coding")])

    monkeypatch.setattr(api, "autonomous_plan", plan)
    chat = (await client.post("/api/chats", json={"message": "接口太慢怎么办？"}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]

    response = await client.post(f"/api/tasks/{chat['id']}/promote", json={"prompt": "给商品接口加 Redis 缓存", "budget_usd": 3},
                                 headers=ORIGIN)
    assert response.status_code == 200, response.text
    task = api.db.get_run(chat["id"])
    assert (task.kind, task.status, task.prompt, task.budget_usd) == ("task", RunStatus.AWAITING_CONFIRMATION, "给商品接口加 Redis 缓存", 3)
    assert [node.title for node in task.plan.nodes] == ["加缓存"] and task.folder_name
    # The planner, and later the steps' checks, know the conversation it grew out of.
    [prompt] = prompts
    assert "接口太慢怎么办" in prompt and "Redis 做缓存" in prompt and prompt.rstrip().endswith("给商品接口加 Redis 缓存")
    assert "Redis 做缓存" in task.background
    # The conversation stays with it.
    assert [m.text for m in task.lead_messages][:2] == ["接口太慢怎么办？", "可以用 Redis 做缓存，命中率会更高。"]
    # Only once, and only a chat.
    assert (await client.post(f"/api/tasks/{chat['id']}/promote", json={}, headers=ORIGIN)).status_code == 409


async def test_a_chat_can_be_deleted(task_api, monkeypatch):
    api, client = task_api
    chatting(api, monkeypatch)
    chat = (await client.post("/api/chats", json={"message": "随便聊聊"}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    assert (await client.delete(f"/api/tasks/{chat['id']}", headers=ORIGIN)).status_code in {200, 204}
    assert api.db.get_run(chat["id"]) is None


def test_records_saved_before_chats_existed_are_tasks():
    stored = {"id": "old", "prompt": "p", "status": "succeeded", "budget_usd": 1, "plan": {"summary": "s", "nodes": []}}
    assert ExecutionRun.model_validate(stored).kind == "task"
