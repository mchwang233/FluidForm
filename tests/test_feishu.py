"""The Feishu bot (feishu.py, docs/design/feishu.md): which messages it answers, a question answered
by the conversation's chat, work planned as a task that waits for confirmation and reports back,
the daily budget, and the credentials kept out of files."""
import json
import time

import pytest
from super_partner import feishu
from super_partner import secrets as secret_store
from super_partner.config import settings
from super_partner.models import ExecutionRun, RunStatus
from test_chat import ORIGIN, triaging


def text(value, mentions=(), chat_type="p2p", message_type="text", sent=None):
    return feishu.wanted(message_type, chat_type, json.dumps({"text": value}, ensure_ascii=False), list(mentions),
                         int((sent or time.time()) * 1000), time.time())


def test_it_answers_private_and_mentioned_text_once_started():
    assert text("你好") == "你好"
    # In a group only when @-mentioned; the mention is taken out of what is asked.
    assert text("@_user_1 帮我看看", chat_type="group") is None
    assert text("@_user_1 帮我看看", mentions=["@_user_1"], chat_type="group") == "帮我看看"
    assert text("@_user_1", mentions=["@_user_1"], chat_type="group") is None
    # Text only; not the backlog from before it started.
    assert text("图", message_type="image") is None
    assert text("早上的消息", sent=time.time() - 3600) is None
    assert feishu.cut("长" * 5000).endswith(feishu.CUT_NOTE) and feishu.cut("短") == "短"


class Sent:
    def __init__(self):
        self.replies = []

    async def reply(self, message_id, value):
        self.replies.append((message_id, value))


@pytest.fixture
def bot(task_api, monkeypatch):
    api, client = task_api
    fresh = feishu.Bot(api.feishu_message)
    fresh.sender = Sent()
    monkeypatch.setattr(api, "feishu_bot", fresh)
    return api, client, fresh


def message(n, value, chat="oc_1"):
    return feishu.Message(message_id=f"om_{n}", chat_id=chat, chat_type="p2p", text=value)


async def test_a_question_is_answered_by_the_conversations_own_chat(bot, monkeypatch):
    api, _, fresh = bot
    sent, _ = triaging(api, monkeypatch, '{"kind": "chat"}')
    await fresh.receive(message(1, "WAL 是什么？"))
    await fresh.receive(message(2, "检查点呢？"))
    await fresh.receive(message(2, "检查点呢？"))  # delivered again: answered once
    assert [item[0] for item in fresh.sender.replies] == ["om_1", "om_2"]
    assert all(reply == "好的。" or reply == "嗯。" for _, reply in fresh.sender.replies)
    [chat_id] = fresh.state["chats"].values()
    chat = api.db.get_run(chat_id)
    # One chat for the Feishu conversation, named after it, with no project to read.
    assert chat.kind == "chat" and chat.plan.title.startswith("飞书 · WAL") and chat.project_dir is None
    assert [m.text for m in chat.lead_messages if m.role == "user"] == ["WAL 是什么？", "检查点呢？"]
    assert chat.origin["channel"] == "feishu" and len(sent) == 2
    assert fresh.spent_today() > 0 and fresh.state["handled"] == 2
    # Another Feishu conversation is another chat.
    await fresh.receive(message(3, "你好", chat="oc_2"))
    assert len(fresh.state["chats"]) == 2


async def test_work_is_planned_waits_for_confirmation_and_its_result_goes_back(bot, monkeypatch):
    api, _, fresh = bot
    triaging(api, monkeypatch, '{"kind": "task"}')
    await fresh.receive(message(1, "给商品接口加 Redis 缓存"))
    [(message_id, reply)] = fresh.sender.replies
    assert message_id == "om_1" and "等主人确认后开工" in reply and "加缓存" in reply
    [task] = [run for run in api.db.list_runs() if run.kind == "task"]
    assert task.status == RunStatus.AWAITING_CONFIRMATION and task.origin["message_id"] == "om_1"
    # It ends: Feishu hears how, under the message that asked.
    task.status, task.final_result = RunStatus.SUCCEEDED, "缓存加好了，命中率 92%。"
    api.db.save_run(task)
    api.executor.end_listeners.append(api.feishu_task_ended)
    api.executor.emit(task.id, "run.succeeded")
    import asyncio
    await asyncio.sleep(0)
    assert fresh.sender.replies[-1] == ("om_1", "「加缓存」做完了。\n\n缓存加好了，命中率 92%。")


async def test_past_the_days_budget_it_says_so_once_then_keeps_quiet(bot, monkeypatch):
    api, _, fresh = bot
    triaging(api, monkeypatch, '{"kind": "chat"}')
    fresh.state["daily_budget_usd"] = 0.5
    fresh.spend(0.5)
    await fresh.receive(message(1, "在吗"))
    await fresh.receive(message(2, "在吗？"))
    assert len(fresh.sender.replies) == 1 and "额度" in fresh.sender.replies[0][1]
    assert not [run for run in api.db.list_runs() if run.kind == "chat"]


async def test_the_api_keeps_the_credentials_in_the_keyring_and_switches_only_when_ready(bot, monkeypatch):
    _, client, fresh = bot
    kept = {}
    monkeypatch.setattr(secret_store, "_keyring_write", lambda action, name, value=None: kept.update({name: value}))
    monkeypatch.setattr(secret_store, "_session_secrets", {})

    class Nothing:  # the real keyring is never read in a test
        returncode, stdout = 0, '{"value": null}'
    monkeypatch.setattr(secret_store.subprocess, "run", lambda *_args, **_kwargs: Nothing())
    started = []
    monkeypatch.setattr(fresh, "start", lambda loop: started.append(loop) or True)
    # Without the machine's setting it cannot be switched on.
    monkeypatch.setattr(settings, "feishu_bot", False)
    assert (await client.put("/api/feishu", json={"enabled": True}, headers=ORIGIN)).status_code == 409
    monkeypatch.setattr(settings, "feishu_bot", True)
    monkeypatch.setattr(feishu, "installed", lambda: True)
    assert "App ID" in (await client.put("/api/feishu", json={"enabled": True}, headers=ORIGIN)).json()["detail"]
    response = await client.put("/api/feishu/credentials", json={"app_id": "cli_a1b2", "app_secret": "s3cr3t-value"}, headers=ORIGIN)
    assert response.status_code == 200 and response.json()["configured"] is True
    assert kept == {"feishu_app_id": "cli_a1b2", "feishu_app_secret": "s3cr3t-value"}
    # Never in a file, nor in the environment the steps' CLIs inherit.
    status = (await client.put("/api/feishu", json={"enabled": True, "daily_budget_usd": 3}, headers=ORIGIN)).json()
    assert status["enabled"] is True and status["daily_budget_usd"] == 3 and started
    assert "s3cr3t" not in feishu.state_path().read_text()
    import os
    assert "s3cr3t-value" not in os.environ.values()
    assert (await client.get("/api/feishu")).json()["available"] is True
    assert (await client.delete("/api/feishu/credentials", headers=ORIGIN)).status_code == 204
    assert feishu.configured() is False and fresh.state["enabled"] is False


def test_records_saved_before_the_bot_load():
    stored = {"id": "old", "prompt": "p", "status": "succeeded", "budget_usd": 1, "plan": {"summary": "s", "nodes": []}}
    assert ExecutionRun.model_validate(stored).origin is None


def test_without_the_setting_it_does_not_start(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "feishu_bot", False)

    async def handle(_message):
        return None, 0.0
    idle = feishu.Bot(handle)
    assert idle.start(None) is False and idle.thread is None and "SUPER_PARTNER_FEISHU_BOT" in idle.error
