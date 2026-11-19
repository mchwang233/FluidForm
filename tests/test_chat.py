"""A chat: only a conversation with a model, which the user can later turn into a task."""
import pytest
from super_partner import supervisor
from super_partner.config import settings
from super_partner.models import (
    CapabilityScore,
    ExecutionRun,
    ModelProfile,
    RunStatus,
    TaskNode,
    TaskPlan,
)
from super_partner.providers import ProviderError, ProviderResult
from super_partner.supervisor import CHAT_ROLE

ORIGIN = {"origin": "http://localhost:5173"}


def profile(model_id, planning):
    return ModelProfile(id=model_id, provider="x", display_name=model_id.upper(), channel="api", context_window=1_000_000,
                        input_per_million=1, output_per_million=1, execution_priority=100,
                        scores=CapabilityScore(coding=90, planning=planning, reliability=90))


BEST, OTHER = profile("x:best", 95), profile("x:other", 80)


class Sent(list):
    """(model, cwd, prompt) of every message sent; ``attached``: the attachment names of each."""


def chatting(api, monkeypatch, answers=("好的。",)):
    """Two API models that can talk; returns what was sent to them (Sent)."""
    sent, replies, attached = Sent(), list(answers), []
    models = {BEST.id: BEST, OTHER.id: OTHER}
    monkeypatch.setattr(api, "models", models)
    monkeypatch.setattr(api.executor, "model_lookup", models)
    monkeypatch.setattr(api.providers, "configured_models", lambda _ids: set(models))

    async def converse(session, prompt, timeout=None, spend_ok=None, attachments=()):
        sent.append((session.model_id, session.cwd, prompt))
        attached.append([item.name for item in attachments])
        session.calls += 1
        return ProviderResult(replies.pop(0) if replies else "嗯。", 10, 10)

    monkeypatch.setattr(api.providers, "converse", converse)
    sent.attached = attached
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


CHEAP = ModelProfile(id="x:cheap", provider="x", display_name="Cheap", channel="api", context_window=1_000_000,
                     input_per_million=0.1, output_per_million=0.1, execution_priority=10,
                     scores=CapabilityScore(coding=50, planning=50, reliability=80))


def triaging(api, monkeypatch, verdict):
    """``chatting``, plus the cheap model that tells a chat from a task and a stub planner."""
    sent = chatting(api, monkeypatch)
    models = {**api.models, CHEAP.id: CHEAP}
    monkeypatch.setattr(api, "models", models)
    monkeypatch.setattr(api.executor, "model_lookup", models)
    monkeypatch.setattr(api.providers, "configured_models", lambda _ids: set(models))
    asked = []

    async def complete(model_id, prompt, *_args, **_kwargs):
        asked.append((model_id, prompt))
        if isinstance(verdict, Exception):
            raise verdict
        return ProviderResult(verdict, 1000, 10)

    async def plan(prompt, *_args, **_kwargs):
        return TaskPlan(summary="加缓存", nodes=[TaskNode(id="a", title="加缓存", instructions="i", capability="coding")])

    monkeypatch.setattr(api.providers, "complete", complete)
    monkeypatch.setattr(api, "autonomous_plan", plan)
    return sent, asked


async def test_a_question_left_to_super_partner_becomes_a_chat(task_api, monkeypatch):
    api, client = task_api
    sent, asked = triaging(api, monkeypatch, '{"kind": "chat"}')
    response = await client.post("/api/start", json={"prompt": "WAL 和回滚日志有什么区别？"}, headers=ORIGIN)
    assert response.status_code == 201, response.text
    run = response.json()
    await api.executor.lead_tasks[run["id"]]
    # The cheapest model decided; deciding is paid by the chat, which the best chat model answers.
    assert [model for model, _ in asked] == ["x:cheap"] and "WAL 和回滚日志" in asked[0][1]
    saved = api.db.get_run(run["id"])
    assert (saved.kind, saved.status, saved.auto_routed) == ("chat", RunStatus.DRAFT, True)
    assert saved.actual_cost_usd > 0 and sent[0][0] == "x:best"


async def test_work_left_to_super_partner_is_planned_as_a_task_and_can_still_become_a_chat(task_api, monkeypatch):
    api, client = task_api
    sent, _ = triaging(api, monkeypatch, '{"kind": "task"}')
    run = (await client.post("/api/start", json={"prompt": "给商品接口加 Redis 缓存"}, headers=ORIGIN)).json()
    saved = api.db.get_run(run["id"])
    assert (saved.kind, saved.status, saved.auto_routed) == ("task", RunStatus.AWAITING_CONFIRMATION, True)
    assert [node.title for node in saved.plan.nodes] == ["加缓存"]

    # It was only a question after all: the plan goes, the request is answered as a chat.
    response = await client.post(f"/api/tasks/{run['id']}/as-chat", headers=ORIGIN)
    assert response.status_code == 200, response.text
    await api.executor.lead_tasks[run["id"]]
    chat = api.db.get_run(run["id"])
    assert (chat.kind, chat.status, chat.plan.nodes) == ("chat", RunStatus.DRAFT, [])
    assert [m.role for m in chat.lead_messages] == ["user", "lead"] and "给商品接口加 Redis 缓存" in sent[0][2]
    # Only a task waiting for confirmation.
    assert (await client.post(f"/api/tasks/{run['id']}/as-chat", headers=ORIGIN)).status_code == 409


async def test_without_a_clear_answer_it_is_a_task(task_api, monkeypatch):
    api, client = task_api
    _, asked = triaging(api, monkeypatch, RuntimeError("provider down"))
    run = (await client.post("/api/start", json={"prompt": "随便看看这个"}, headers=ORIGIN)).json()
    # The model was asked and failed: as before chats existed, it is planned as a task.
    assert len(asked) == 1 and api.db.get_run(run["id"]).kind == "task"

    from super_partner.triage import read_kind
    assert [read_kind(text) for text in ['{"kind": "chat"}', "```json\n{\"kind\":\"chat\"}\n```", "chat", "", '{"kind": "task"}']] == \
        ["chat", "chat", "task", "task", "task"]


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def test_a_question_about_an_attached_screenshot_is_a_chat_that_sees_it(task_api, monkeypatch):
    api, client = task_api
    from super_partner import attachments as files
    sent, asked = triaging(api, monkeypatch, '{"kind": "chat"}')
    # The best talker cannot see images: the chat goes to one that can.
    monkeypatch.setitem(api.models, BEST.id, BEST.model_copy(update={"supports_vision": False}))
    shot, log = files.save("error.png", PNG), files.save("trace.log", b"Traceback: KeyError 'id'\n")
    run = (await client.post("/api/start", json={"prompt": "这个报错是什么意思？", "attachments": [shot.id, log.id]},
                             headers=ORIGIN)).json()
    await api.executor.lead_tasks[run["id"]]
    # Deciding knows files came with it; they do not make it a task.
    assert "error.png" in asked[0][1] and "trace.log" in asked[0][1]
    chat = api.db.get_run(run["id"])
    assert chat.kind == "chat" and [item.name for item in chat.attachments] == ["error.png", "trace.log"]
    assert sent[0][0] == "x:other" and sent.attached == [["error.png", "trace.log"]]
    # Only the first message carries them; the conversation remembers.
    await client.post(f"/api/tasks/{run['id']}/lead", json={"message": "怎么修？"}, headers=ORIGIN)
    await api.executor.lead_tasks[run["id"]]
    assert sent.attached == [["error.png", "trace.log"], []]


async def test_a_chat_with_attachments_hands_them_to_the_task_it_becomes(task_api, monkeypatch):
    api, client = task_api
    from super_partner import attachments as files
    chatting(api, monkeypatch)
    prompts = []

    async def plan(prompt, *_args, **_kwargs):
        prompts.append(prompt)
        return TaskPlan(summary="修复", nodes=[TaskNode(id="a", title="修复", instructions="i", capability="coding")])

    monkeypatch.setattr(api, "autonomous_plan", plan)
    log = files.save("trace.log", b"Traceback: KeyError 'id'\n")
    chat = (await client.post("/api/chats", json={"message": "这个报错怎么回事？", "attachments": [log.id]}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    assert (await client.post(f"/api/tasks/{chat['id']}/promote", json={"prompt": "修复这个 KeyError"}, headers=ORIGIN)).status_code == 200
    task = api.db.get_run(chat["id"])
    assert [item.name for item in task.attachments] == ["trace.log"] and "trace.log" in prompts[0]


async def test_a_conversation_message_carries_attachments_to_either_kind_of_model(monkeypatch, tmp_path):
    from super_partner import attachments as files
    from super_partner.models import SupervisorSession
    from super_partner.providers import ProviderRegistry
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    shot, log = files.save("error.png", PNG), files.save("trace.log", b"KeyError 'id'\n")
    registry = ProviderRegistry()
    calls = []

    async def complete(model_id, prompt, *_args, **kwargs):
        calls.append((prompt, [item.name for item in kwargs.get("attachments", [])]))
        return ProviderResult("看到了。", 10, 10)

    monkeypatch.setattr(registry, "complete", complete)
    session = SupervisorSession(model_id="x:api")
    await registry.converse(session, "这是什么错？", attachments=[shot, log])
    await registry.converse(session, "怎么修？")
    # An API model: text inline and kept in the conversation; the image sent as an image, once.
    (first, images), (second, later) = calls
    assert "KeyError 'id'" in first and images == ["error.png"] and later == []
    assert "KeyError 'id'" in session.history[0]["content"] and "KeyError 'id'" in second

    # A CLI: told where the files are, allowed to read just those folders, the image given as an image.
    commands = []

    async def run_input(spec, command, cwd, prompt, timeout, **_kwargs):
        commands.append((command, prompt))
        raise RuntimeError("stop here")

    monkeypatch.setattr(registry.cli, "_run_input", run_input)
    monkeypatch.setattr("super_partner.cli_channels.shutil.which", lambda name: f"/usr/bin/{name}")
    for model_id in ("cli:codex", "cli:claude"):
        with pytest.raises(ProviderError):
            await registry.converse(SupervisorSession(model_id=model_id, cwd=str(tmp_path / model_id)), "这是什么错？",
                                    attachments=[shot, log])
    (codex, codex_prompt), (claude, _) = commands
    folders = {str(files.path(item).parent) for item in (shot, log)}
    assert f"--image={files.path(shot)}" in codex and str(files.path(log)) in codex_prompt
    table = next(arg for arg in codex if "filesystem=" in arg)
    assert all(f'"{folder}" = "read"' in table for folder in folders)
    assert set(claude[claude.index("--add-dir") + 1:][:2]) == folders


async def test_files_sent_later_in_a_conversation_reach_the_lead_once_and_join_the_task(task_api, monkeypatch):
    api, client = task_api
    from super_partner import attachments as files
    sent = chatting(api, monkeypatch)
    chat = (await client.post("/api/chats", json={"message": "看看这个"}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    log = files.save("trace.log", b"Traceback: KeyError 'id'\n")
    # A file alone is a message.
    response = await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": "", "attachments": [log.id]}, headers=ORIGIN)
    assert response.status_code == 202, response.text
    await api.executor.lead_tasks[chat["id"]]
    await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": "怎么修？"}, headers=ORIGIN)
    await api.executor.lead_tasks[chat["id"]]
    assert sent.attached == [[], ["trace.log"], []]
    run = api.db.get_run(chat["id"])
    assert [item.name for item in run.attachments] == ["trace.log"]
    assert [(m.text, [a.name for a in m.attachments]) for m in run.lead_messages if m.role == "user"] == [
        ("看看这个", []), ("（见附件）", ["trace.log"]), ("怎么修？", [])]
    # Sent with a task, it is the task's: not discarded on its own.
    assert (await client.delete(f"/api/attachments/{log.id}", headers=ORIGIN)).status_code == 409
    assert (await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": ""}, headers=ORIGIN)).status_code == 422
    assert (await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": "x", "attachments": ["0" * 32]},
                              headers=ORIGIN)).status_code == 422


async def test_a_lead_that_spoke_before_files_could_be_sent_along_is_not_sent_them_again(task_api, monkeypatch):
    api, client = task_api
    from super_partner import attachments as files
    sent = chatting(api, monkeypatch)
    chat = (await client.post("/api/chats", json={"message": "看看", "attachments": [files.save("a.log", b"x\n").id]},
                              headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    run = api.db.get_run(chat["id"])
    run.lead_seen_attachments = None  # as saved before
    api.db.save_run(run)
    await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": "然后呢？"}, headers=ORIGIN)
    await api.executor.lead_tasks[chat["id"]]
    assert sent.attached == [["a.log"], []]


async def test_an_answer_to_the_leads_question_can_carry_files(task_api, monkeypatch):
    api, client = task_api
    from super_partner import attachments as files
    from super_partner.models import Diagnosis
    run = ExecutionRun(id="asked", prompt="p", status=RunStatus.PAUSED, budget_usd=1, waiting_diagnosis_id="q",
                       plan=TaskPlan(summary="s", nodes=[TaskNode(id="a", title="a", instructions="i", capability="coding")]),
                       diagnoses=[Diagnosis(id="q", trigger="lead", node_id="a", question="哪个界面？")])
    api.db.save_run(run)
    answered = []
    monkeypatch.setattr(api.executor, "start_lead_answer", lambda run_id, question_id: answered.append(question_id))
    shot = files.save("screen.png", PNG)
    response = await client.post("/api/tasks/asked/diagnoses/q/reply", json={"attachments": [shot.id]}, headers=ORIGIN)
    assert response.status_code == 200, response.text
    saved = api.db.get_run("asked")
    assert answered == ["q"] and [item.name for item in saved.attachments] == ["screen.png"]
    assert [a.name for a in saved.diagnoses[0].messages[-1].attachments] == ["screen.png"]


async def test_a_lead_that_cannot_see_images_is_told_of_them_instead(task_api, monkeypatch):
    api, client = task_api
    from super_partner import attachments as files
    sent = chatting(api, monkeypatch)
    monkeypatch.setitem(api.executor.model_lookup, BEST.id, BEST.model_copy(update={"supports_vision": False}))
    chat = (await client.post("/api/chats", json={"message": "你好", "model_id": BEST.id}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    shot, log = files.save("screen.png", PNG), files.save("a.log", b"x\n")
    await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": "看图", "attachments": [shot.id, log.id]}, headers=ORIGIN)
    await api.executor.lead_tasks[chat["id"]]
    assert sent.attached[-1] == ["a.log"] and "images you cannot see: screen.png" in sent[-1][2]


async def test_the_models_page_gets_each_models_calls_spend_and_work(task_api):
    """GET /api/models/usage totals the recorded model calls of the last days, per model."""
    from datetime import datetime, timedelta, timezone
    api, client = task_api
    api.db.save_run(ExecutionRun(id="ime", prompt="p", status=RunStatus.SUCCEEDED, budget_usd=1,
                                 plan=TaskPlan(summary="写输入法", title="中文输入法", nodes=[])))
    now = datetime.now(timezone.utc)

    def call(n, model, cost, run="ime", days_ago=0, **extra):
        api.db.save_model_call({"id": f"c{n}", "model_id": model, "run_id": run, "cost_usd": cost,
                                "started_at": (now - timedelta(days=days_ago)).isoformat(), **extra})
    call(1, "x:best", 0.25)
    call(2, "x:best", 0.5)
    call(3, "cli:codex", 0.0, delegated=True)  # handed its work on: counted as the other model's
    call(4, "x:best", 9.0, days_ago=40)  # too long ago
    call(5, "x:other", 0.1, run=None)
    body = (await client.get("/api/models/usage")).json()
    assert body["days"] == 30 and set(body["models"]) == {"x:best", "x:other"}
    best = body["models"]["x:best"]
    assert (best["calls"], best["cost_usd"], best["run_count"]) == (2, 0.75, 1)
    assert best["runs"] == [{"id": "ime", "title": "中文输入法", "kind": "task", "calls": 2}]
    assert body["models"]["x:other"]["runs"] == []
    assert (await client.get("/api/models/usage?days=60")).json()["models"]["x:best"]["calls"] == 3


async def test_a_chat_model_is_told_which_model_it_is_and_that_earlier_replies_were_not_its_own(task_api, monkeypatch):
    """Regression: told nothing about itself, a chat model guessed its identity, and after a model
    change took the previous model's self-description from the transcript as its own."""
    api, client = task_api
    sent = chatting(api, monkeypatch, ["我是 X:OTHER。"])
    chat = (await client.post("/api/chats", json={"message": "你是谁？", "model_id": "x:other"}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    assert "X:OTHER (x:other, through its API)" in sent[0][2]
    assert "How to talk here" not in sent[0][2] and "group chat" not in sent[0][2]
    # Another model takes the conversation over: told who it is, and whose the earlier replies were.
    run = api.db.get_run(chat["id"])
    run.supervisor = supervisor.new_session(BEST, run.supervisor)
    api.db.save_run(run)
    assert (await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": "你到底是谁？"}, headers=ORIGIN)).status_code == 202
    await api.executor.lead_tasks[chat["id"]]
    model, _, prompt = sent[1]
    assert model == "x:best" and "X:BEST (x:best, through its API)" in prompt
    assert "x:other" in prompt and "我是 X:OTHER。" in prompt and "not yours" in prompt
    # The same model again, in a conversation of its own: its earlier replies are named too.
    run = api.db.get_run(chat["id"])
    run.supervisor = supervisor.new_session(BEST, run.supervisor)
    api.db.save_run(run)
    assert (await client.post(f"/api/tasks/{chat['id']}/lead", json={"message": "再说一次？"}, headers=ORIGIN)).status_code == 202
    await api.executor.lead_tasks[chat["id"]]
    assert "another model (x:other, x:best)" in sent[2][2]
