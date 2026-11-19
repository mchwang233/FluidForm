"""What chats remember (remembering.py): the owner's web chats keep REMEMBER facts too, a new chat
is told them, and the 记住的事 page lists and deletes them; profiles switch while running."""
from super_partner import remembering, supervisor
from super_partner.config import settings
from test_chat import ORIGIN, chatting


async def test_the_owners_chats_remember_and_a_new_chat_is_told(task_api, monkeypatch):
    api, client = task_api
    monkeypatch.setattr(settings, "user_memory", True)
    sent = chatting(api, monkeypatch, ["好的，记住了。\nREMEMBER: 用户: 写代码用 TypeScript", "好。"])
    chat = (await client.post("/api/chats", json={"message": "我写代码都用 TypeScript", "model_id": "x:other"}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    assert "REMEMBER:" in sent[0][2]
    assert api.db.get_run(chat["id"]).lead_messages[-1].text == "好的，记住了。"
    assert remembering.facts(remembering.WEB) == ["用户: 写代码用 TypeScript"]
    other = (await client.post("/api/chats", json={"message": "写个排序", "model_id": "x:other"}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[other["id"]]
    assert "你记得的" in sent[1][2] and "TypeScript" in sent[1][2]
    # The page lists it, and deletes it.
    listed = (await client.get("/api/memory")).json()
    assert listed["enabled"] and listed["places"] == [{"key": "web", "label": "网页对话", "facts": ["用户: 写代码用 TypeScript"]}]
    forgot = await client.post("/api/memory/forget", json={"key": "web", "fact": "用户: 写代码用 TypeScript"}, headers=ORIGIN)
    assert forgot.status_code == 200 and forgot.json()["places"] == []
    assert (await client.post("/api/memory/forget", json={"key": "web", "fact": "x"}, headers=ORIGIN)).status_code == 404


async def test_without_the_setting_nothing_is_kept_or_told(task_api, monkeypatch):
    api, client = task_api
    sent = chatting(api, monkeypatch, ["好。\nREMEMBER: 用户: x"])
    chat = (await client.post("/api/chats", json={"message": "你好", "model_id": "x:other"}, headers=ORIGIN)).json()
    await api.executor.lead_tasks[chat["id"]]
    assert "REMEMBER:" not in sent[0][2] and remembering.load() == {}
    assert api.db.get_run(chat["id"]).lead_messages[-1].text == "好。"


def test_a_broken_memory_file_is_nothing_remembered(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    (tmp_path / "memory.json").write_text("{bad")
    assert remembering.load() == {}
    remembering.update("web", ["a"], [])
    assert remembering.facts("web") == ["a"]


async def test_a_profile_picked_on_the_page_applies_now_and_after_a_restart(task_api, monkeypatch):
    _, client = task_api
    names = ("profile", "quick_tasks", "solo_tasks", "acceptance", "review_easy_steps", "preflight_cache_minutes",
             "resume_after_restart", "chat_tools", "chat_action_tools")
    for name in names:
        monkeypatch.setitem(settings.__dict__, name, getattr(settings, name))
    # Other tests' monkeypatching counts as given alone; here only chat_tools is.
    given = set(settings.model_fields_set)
    object.__setattr__(settings, "__pydantic_fields_set__", (given - set(names)) | {"chat_tools"})
    try:
        await profiles_on_the_page(client)
    finally:
        object.__setattr__(settings, "__pydantic_fields_set__", given)


async def profiles_on_the_page(client):
    settings.__dict__["chat_tools"] = False  # given on its own: the profile leaves it
    picked = await client.put("/api/settings/profile", json={"profile": "fast"}, headers=ORIGIN)
    assert picked.status_code == 200 and picked.json()["profile"] == "fast"
    assert "chat_tools" in picked.json()["given_alone"]["fast"]
    assert settings.quick_tasks and settings.solo_tasks and not settings.chat_tools
    # Another profile: the first one's settings go back to their defaults.
    await client.put("/api/settings/profile", json={"profile": "careful"}, headers=ORIGIN)
    assert settings.acceptance and not settings.solo_tasks and not settings.resume_after_restart
    await client.put("/api/settings/profile", json={"profile": ""}, headers=ORIGIN)
    assert not settings.acceptance and not settings.quick_tasks
    # Saved: a restart picks it up again.
    await client.put("/api/settings/profile", json={"profile": "balanced"}, headers=ORIGIN)
    settings.use_profile("")
    settings.load_saved_profile()
    assert settings.profile == "balanced" and settings.quick_tasks
    assert (await client.put("/api/settings/profile", json={"profile": "turbo"}, headers=ORIGIN)).status_code == 422


def test_web_chats_get_the_memory_tools(monkeypatch, tmp_path):
    from super_partner.models import ExecutionRun, RunStatus, TaskPlan
    monkeypatch.setattr(settings, "chat_tools", True)
    monkeypatch.setattr(settings, "workspace_root", tmp_path)
    monkeypatch.setattr(settings, "chat_action_tools", True)
    monkeypatch.setattr(settings, "user_memory", True)
    web = ExecutionRun(id="c", prompt="p", kind="chat", status=RunStatus.DRAFT, budget_usd=1, plan=TaskPlan(summary="s", nodes=[]))
    assert supervisor.chat_tools(web)["actions"] == ["CallEngineer", "Remember", "Forget"]
