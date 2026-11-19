"""Capability packages (capability_packages.py, capability_sandbox.py, capability_runner.py,
docs/design/capability-packages.md): uploaded and uninstalled on their own, run in a sandbox that
reaches only declared hosts, and automations that ask Super Partner and hear how tasks ended."""
import asyncio
import contextlib
import io
import json
import os
import shlex
import sys
import time
import zipfile
from pathlib import Path

import pytest
from super_partner import (
    capabilities,
    capability_packages,
    capability_runner,
    capability_sandbox,
    remembering,
    supervisor,
)
from super_partner import secrets as secret_store
from super_partner.config import settings
from super_partner.models import Capability, LeadMessage, RunStatus
from super_partner.providers import ProviderError, ProviderResult
from super_partner.supervisor import CHAT_ROLE, MAX_CHAT_HANDOVER_CHARS
from test_chat import BEST, ORIGIN, OTHER, triaging

# A fake automation: asks what asks.json lists, one at a time, and writes what it hears.
FAKE = r'''
import base64, json, os, sys
data = os.environ["SP_DATA_DIR"]
def note(name, value):
    with open(os.path.join(data, name), "a") as out:
        out.write(json.dumps(value, ensure_ascii=False) + "\n")
note("env.jsonl", {"token": os.environ.get("TOKEN"), "proxy": os.environ.get("HTTPS_PROXY")})
print(json.dumps({"op": "status", "text": "就绪"}), flush=True)
print("plain output goes to the log", flush=True)
asks = json.load(open("asks.json"))
for n, ask in enumerate(asks):
    # Files sent along: written to its data folder, then named in the message (as feishu-bot does).
    for name, content in ask.get("files", {}).items():
        os.makedirs(os.path.dirname(os.path.join(data, name)), exist_ok=True)
        with open(os.path.join(data, name), "wb") as out:
            out.write(base64.b64decode(content))
    message = {"op": "message", "id": str(n), "conversation": ask["conversation"], "text": ask["text"],
               "origin": {"message_id": "om_%d" % n}}
    if "files" in ask or "refs" in ask:
        message["attachments"] = list(ask.get("files", {})) + ask.get("refs", [])
    for key in ("addressed", "sender"):
        if key in ask:
            message[key] = ask[key]
    print(json.dumps(message), flush=True)
    while True:
        heard = json.loads(sys.stdin.readline())
        if heard.get("re") == str(n):
            note("replies.jsonl", heard)
            break
        note("events.jsonl", heard)
for line in sys.stdin:
    note("events.jsonl", json.loads(line))
'''


def package(asks=(), *, manifest=None, extra=None, top="pkg/"):
    """A package zip; ``extra`` maps more paths to contents (or ZipInfo-level tweaks via tuples)."""
    body = {"id": "fake-bot", "name": "假机器人", "kind": "automation", "version": "1.0", "summary": "测试用",
            "entry": "python3 fake.py", "secrets": ["TOKEN"], "domains": ["*.example.com"], **(manifest or {})}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(top + "capability.json", json.dumps(body))
        archive.writestr(top + "fake.py", FAKE)
        archive.writestr(top + "asks.json", json.dumps(list(asks), ensure_ascii=False))
        for name, content in (extra or {}).items():
            if isinstance(content, zipfile.ZipInfo):
                archive.writestr(content, b"x")
            else:
                archive.writestr(name, content)
    return buffer.getvalue()


@pytest.fixture
def unsandboxed(monkeypatch):
    """Run packages' commands directly (tests never need bwrap), with the environment the sandbox gives."""
    monkeypatch.setattr(capability_sandbox, "missing", lambda: "")

    def wrap(folder, data, command, env, proxy_dir, writable=False):
        variables = {**env, "PATH": f"{Path(sys.executable).parent}:{os.environ['PATH']}"}
        return ["env", "-i", *[f"{name}={value}" for name, value in variables.items()],
                "/bin/bash", "-c", f"cd {shlex.quote(str(folder))} && {command}"]
    monkeypatch.setattr(capability_sandbox, "wrap", wrap)


@pytest.fixture
def keyring(monkeypatch):
    """A keyring in memory: the real one is never read or written in a test."""
    kept = {}
    monkeypatch.setattr(secret_store, "_session_secrets", kept)
    monkeypatch.setattr(secret_store, "_keyring_write", lambda action, name, value=None:
                        kept.update({name: value}) if action == "set" else kept.pop(name, None))

    class Nothing:
        returncode, stdout = 0, '{"value": null}'
    monkeypatch.setattr(secret_store.subprocess, "run", lambda *_args, **_kwargs: Nothing())
    return kept


@pytest.fixture
async def packages(task_api, monkeypatch, unsandboxed, keyring):
    api, client = task_api
    monkeypatch.setattr(settings, "capability_packages", True)
    runner = capability_runner.Runner(api.automation_message)
    monkeypatch.setattr(api, "runner", runner)
    api.executor.end_listeners.append(api.automation_task_ended)
    yield api, client, runner, keyring
    await runner.stop_all()


async def upload(client, data):
    return await client.post("/api/capabilities/upload", content=data, headers=ORIGIN)


async def eventually(check, seconds=10.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if value := check():
            return value
        await asyncio.sleep(0.05)
    raise AssertionError("timed out")


def lines(name, capability_id="fake-bot"):
    path = capability_packages.data_folder(capability_id) / name
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


async def enable(client, keyring_values=None):
    await client.put("/api/capabilities/fake-bot/secrets", json={"values": keyring_values or {"TOKEN": "t0ken-value"}},
                     headers=ORIGIN)
    return await client.patch("/api/capabilities/fake-bot", json={"enabled": True, "confirmed": True}, headers=ORIGIN)


# ---- the package ----

@pytest.mark.parametrize(("data", "reason"), [
    (b"not a zip", "不是 zip"),
    (package(extra={"pkg/../evil.py": "x"}), "不安全的路径"),
    (package(extra={"elsewhere/x.py": "x"}), "不在能力的文件夹里"),
    (package(extra={"pkg/.venv/bin/python": "x"}), ".venv"),
    (package(manifest={"id": "Bad Id"}), "id 只能"),
    (package(manifest={"entry": ""}), "entry"),
    (package(manifest={"secrets": ["PATH"]}), "密钥名不能用"),
    (package(manifest={"domains": ["http://x.com/a"]}), "domains"),
])
def test_a_package_that_could_reach_outside_its_folder_or_is_unclear_is_refused(data, reason):
    with pytest.raises(capability_packages.PackageError, match=reason):
        capability_packages.read(data)


def test_a_package_with_a_link_is_refused():
    link = zipfile.ZipInfo("pkg/link")
    link.external_attr = 0o120777 << 16
    with pytest.raises(capability_packages.PackageError, match="链接"):
        capability_packages.read(package(extra={"pkg/link": link}))


async def test_uploaded_it_is_installed_switched_off_and_a_new_version_keeps_its_secrets(packages):
    _, client, _, keyring = packages
    # Without the machine's setting nothing is uploaded.
    settings.capability_packages = False
    assert (await upload(client, package())).status_code == 409
    settings.capability_packages = True
    response = await upload(client, package())
    assert response.status_code == 201, response.text
    item = response.json()
    assert (item["id"], item["status"], item["source"], item["version"]) == ("fake-bot", "disabled", "upload", "1.0")
    folder = capabilities.root() / "fake-bot"
    assert (folder / "fake.py").is_file() and "假机器人" in (folder / "SKILL.md").read_text()
    # Enabling needs the user's confirmation, then its secrets.
    assert (await client.patch("/api/capabilities/fake-bot", json={"enabled": True}, headers=ORIGIN)).status_code == 409
    refused = await client.patch("/api/capabilities/fake-bot", json={"enabled": True, "confirmed": True}, headers=ORIGIN)
    assert refused.status_code == 409 and "TOKEN" in refused.json()["detail"]
    assert (await client.put("/api/capabilities/fake-bot/secrets", json={"values": {"OTHER": "x"}},
                             headers=ORIGIN)).status_code == 422
    await client.put("/api/capabilities/fake-bot/secrets", json={"values": {"TOKEN": "t0ken-value"}}, headers=ORIGIN)
    assert keyring == {"capability/fake-bot/TOKEN": "t0ken-value"}
    # Never in a file, nor in Super Partner's environment.
    assert not any("t0ken-value" in path.read_text(errors="ignore") for path in Path(settings.data_dir).rglob("*")
                   if path.is_file())
    assert "t0ken-value" not in os.environ.values()
    # A new version replaces the code, keeps the secrets, and is off until enabled again.
    second = await upload(client, package(manifest={"version": "2.0"}))
    assert second.json()["version"] == "2.0" and keyring == {"capability/fake-bot/TOKEN": "t0ken-value"}
    runtime = (await client.get("/api/capabilities/runtime")).json()
    assert runtime["capabilities"]["fake-bot"]["secrets"] == {"TOKEN": True} and runtime["available"] is True


async def test_uninstalled_it_leaves_nothing_behind(packages, monkeypatch):
    api, client, runner, keyring = packages
    await upload(client, package([{"conversation": "c1", "text": "在吗"}]))
    triaging(api, monkeypatch, '{"kind": "chat"}')
    assert (await enable(client)).status_code == 200
    await eventually(lambda: lines("replies.jsonl"))
    assert capability_runner.state_path("fake-bot").is_file()
    assert (await client.delete("/api/capabilities/fake-bot", headers=ORIGIN)).status_code == 204
    assert not runner.running("fake-bot") and not (capabilities.root() / "fake-bot").exists()
    assert not capability_packages.data_folder("fake-bot").exists() and not capability_runner.state_path("fake-bot").exists()
    assert keyring == {} and capabilities.library() == []


# A chat's answer asking for work (supervisor.AUTOMATION_WORK).
ASK_FOR_WORK = '好，我让 FluidForm 排个计划。\nTASK: {"request": "给商品接口加 Redis 缓存：缓存商品详情 5 分钟，改价时清掉"}'

# ---- running ----

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


def b64(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode()


async def test_an_image_sent_to_an_automation_reaches_its_chat_and_leaves_its_data_folder(packages, monkeypatch, tmp_path):
    api, client, runner, _ = packages
    sent, _ = triaging(api, monkeypatch, '{"kind": "chat"}')
    outside = tmp_path / "outside.txt"
    outside.write_text("not its file")
    await upload(client, package([
        {"conversation": "c1", "text": "这张图里是什么？", "files": {"img/shot.png": b64(PNG)}, "refs": [str(outside), "../x"]},
        {"conversation": "c1", "text": "", "files": {"img/only.png": b64(PNG)}},
    ]))
    assert (await enable(client)).status_code == 200
    replies = await eventually(lambda: len(lines("replies.jsonl")) == 2 and lines("replies.jsonl"))
    assert all(item["reply"] for item in replies)
    # The images went to the model with the messages; nothing else did.
    assert sent.attached == [["shot.png"], ["only.png"]]
    chat = api.db.get_run(runner.get("fake-bot").state["chats"]["c1"])
    assert [item.name for item in chat.attachments] == ["shot.png", "only.png"]
    assert [m.text for m in chat.lead_messages if m.role == "user"] == ["这张图里是什么？", "（见附件）"]
    # Taken out of its data folder; what was outside it stays, and is logged as refused.
    assert not list((capability_packages.data_folder("fake-bot") / "img").iterdir())
    assert outside.read_text() == "not its file"
    log = "\n".join(runner.get("fake-bot").log)
    assert "outside.txt 没收下" in log and "../x 没收下" in log


async def test_a_picture_sent_alone_is_answered_in_the_chat_not_planned_as_work(packages, monkeypatch):
    # Regression: with no words, the classifier saw only "（见附件）" and planned a task.
    api, client, _, _ = packages
    sent, classified = triaging(api, monkeypatch, '{"kind": "task"}')
    await upload(client, package([{"conversation": "c1", "text": "", "files": {"shot.png": b64(PNG)}}]))
    await enable(client)
    [reply] = await eventually(lambda: lines("replies.jsonl"))
    assert reply["reply"] == "好的。" and not classified
    assert not [run for run in api.db.list_runs() if run.kind == "task"]
    assert sent.attached == [["shot.png"]]


async def test_an_answer_being_written_reaches_the_automation_before_it_is_done(packages, monkeypatch):
    from super_partner import streaming
    api, client, _, _ = packages
    triaging(api, monkeypatch, '{"kind": "chat"}')
    monkeypatch.setattr(capability_runner, "PROGRESS_SECONDS", 0)

    async def converse(session, prompt, **_kwargs):
        hear = streaming.listener.get()
        for text in ("**WAL**", "**WAL** 是预写日志。"):
            hear(text)
            await asyncio.sleep(0.05)
        session.calls += 1
        return ProviderResult("**WAL** 是预写日志。", 10, 10)

    monkeypatch.setattr(api.providers, "converse", converse)
    await upload(client, package([{"conversation": "c1", "text": "WAL 是什么？"}]))
    await enable(client)
    [reply] = await eventually(lambda: lines("replies.jsonl"))
    assert reply["reply"] == "**WAL** 是预写日志。"
    # Heard as it was written, before the answer itself.
    progress = [line for line in lines("events.jsonl") if "progress" in line]
    assert progress == [{"progress": "0", "text": "**WAL**"}, {"progress": "0", "text": "**WAL** 是预写日志。"}]
    assert streaming.listener.get() is None


async def test_in_a_group_it_answers_only_what_is_meant_for_it_knowing_what_was_said_before(packages, monkeypatch):
    api, client, runner, _ = packages
    sent, _ = triaging(api, monkeypatch, '{"kind": "chat"}')
    judged = []

    async def complete(model_id, prompt, *_args, **_kwargs):
        if prompt.startswith("You are 假机器人, an assistant in a group chat"):
            judged.append(prompt)
            return ProviderResult('{"reply": true}' if "助手" in prompt.split("New message:")[-1] else '{"reply": false}', 100, 5)
        return ProviderResult('{"kind": "chat"}', 100, 5)

    monkeypatch.setattr(api.providers, "complete", complete)
    await upload(client, package([
        {"conversation": "g1", "text": "今天三点开会，记得带电脑", "addressed": False, "sender": "成员1"},
        {"conversation": "g1", "text": "好的", "addressed": False, "sender": "成员2"},
        {"conversation": "g1", "text": "助手，几点开会？", "addressed": False, "sender": "成员2"},
        {"conversation": "g1", "text": "谢谢", "addressed": True},
    ]))
    await enable(client)
    replies = await eventually(lambda: len(lines("replies.jsonl")) == 4 and lines("replies.jsonl"))
    # Talk among members is not answered; what is meant for it is, and @ it always is.
    assert [item["reply"] for item in replies] == [None, None, "好的。", "嗯。"]
    assert len(judged) == 3 and "成员1：今天三点开会" in judged[1]
    # The model answering is told what the group said before.
    assert "群里此前的消息" in sent[0][2] and "成员1：今天三点开会，记得带电脑" in sent[0][2] and "成员2：助手，几点开会？" in sent[0][2]
    assert sent[1][2] == "谢谢"
    state = runner.get("fake-bot").state
    assert state["heard"] == {} and state["spent"]


async def test_past_its_budget_it_stays_quiet_where_it_was_not_called_on(packages, monkeypatch):
    api, client, runner, _ = packages
    triaging(api, monkeypatch, '{"kind": "chat"}')
    await upload(client, package([{"conversation": "g1", "text": "随便聊聊", "addressed": False}]))
    await client.put("/api/capabilities/fake-bot/budget", json={"daily_budget_usd": 0}, headers=ORIGIN)
    await enable(client)
    [reply] = await eventually(lambda: lines("replies.jsonl"))
    assert reply["reply"] is None and runner.get("fake-bot").state.get("notified") != capability_runner.today()


async def test_a_picture_sent_in_a_group_without_at_is_seen_when_it_is_asked_about(packages, monkeypatch):
    # Regression: a picture cannot @ the bot, and the question about it, asked next, came without it.
    api, client, runner, _ = packages
    sent, _ = triaging(api, monkeypatch, '{"kind": "chat"}')

    async def complete(model_id, prompt, *_args, **_kwargs):
        if prompt.startswith("You are 假机器人, an assistant in a group chat"):
            return ProviderResult('{"reply": false}', 100, 5)
        return ProviderResult('{"kind": "chat"}', 100, 5)

    monkeypatch.setattr(api.providers, "complete", complete)
    await upload(client, package([
        {"conversation": "g1", "text": "", "files": {"cat.png": b64(PNG)}, "addressed": False, "sender": "成员1"},
        {"conversation": "g1", "text": "这是什么猫？", "sender": "成员1"},
    ]))
    await enable(client)
    replies = await eventually(lambda: len(lines("replies.jsonl")) == 2 and lines("replies.jsonl"))
    assert [item["reply"] for item in replies] == [None, "好的。"]
    # The picture came with the question, and the model was told it was sent before.
    assert sent.attached == [["cat.png"]] and "成员1：（见附件）（附 1 张图片）" in sent[0][2] and "cat.png" not in sent[0][2]
    state = runner.get("fake-bot").state
    assert state["heard_files"] == {} and any("记作上下文" in line for line in runner.get("fake-bot").log)


async def test_only_at_it_answers_what_the_group_said_before(packages, monkeypatch):
    # Regression: a message that only @-ed it was dropped, so it never answered.
    api, client, _, _ = packages
    sent, _ = triaging(api, monkeypatch, '{"kind": "task"}')
    classified = []

    async def complete(model_id, prompt, *_args, **_kwargs):
        if prompt.startswith("You are 假机器人, an assistant in a group chat"):
            return ProviderResult('{"reply": false}', 100, 5)
        classified.append(prompt)
        return ProviderResult('{"kind": "task"}', 100, 5)

    monkeypatch.setattr(api.providers, "complete", complete)
    await upload(client, package([
        {"conversation": "g1", "text": "周五团建去哪儿好？", "addressed": False, "sender": "成员1"},
        {"conversation": "g1", "text": "", "sender": "成员2"},
    ]))
    await enable(client)
    replies = await eventually(lambda: len(lines("replies.jsonl")) == 2 and lines("replies.jsonl"))
    assert [item["reply"] for item in replies] == [None, "好的。"]
    # Answered in the chat, never planned as work, knowing what the group asked.
    assert not classified and not [run for run in api.db.list_runs() if run.kind == "task"]
    assert "成员1：周五团建去哪儿好？" in sent[0][2] and capability_runner.CALLED_ONLY in sent[0][2]


async def test_its_chats_are_told_how_to_talk_there_and_whether_it_is_a_group(model_bot):
    api, client, runner, sent, _ = model_bot
    guide = "话没说完时，只回一句「嗯，你说」。"
    await upload(client, package(extra={"pkg/CHAT.md": guide}))
    for conversation, kind in (("g1", "group"), ("p1", "p2p")):
        await api.automation_message(capabilities.load("fake-bot"), capability_runner.Asked(
            conversation=conversation, text="我想问下", origin={"chat_type": kind}), runner.get("fake-bot"))
    group, private = sent[-2][2], sent[-1][2]
    assert guide in group and "This is a group chat" in group
    assert guide in private and "This is a private chat" in private and "group chat" not in private
    # A chat started before it said where it is learns it with its next message.
    chat = api.db.get_run(runner.get("fake-bot").state["chats"]["g1"])
    chat.origin = {"capability": "fake-bot"}
    api.db.save_run(chat)
    await api.automation_message(capabilities.load("fake-bot"), capability_runner.Asked(
        conversation="g1", text="在吗", origin={"chat_type": "group"}), runner.get("fake-bot"))
    assert api.db.get_run(chat.id).origin == {"capability": "fake-bot", "chat_type": "group"}
    # Chats it did not bring, and packages without the file, are told nothing of it.
    assert capability_packages.chat_guide("other") == "" and capability_packages.chat_guide("../x") == ""


async def test_a_chat_sends_the_pictures_it_made_and_only_from_its_own_folder(packages, monkeypatch, tmp_path):
    api, client, runner, _ = packages
    triaging(api, monkeypatch, '{"kind": "chat"}')
    monkeypatch.setattr(settings, "chat_tools", True)
    outside = tmp_path / "secret.txt"
    outside.write_text("not for them")
    prompts = []

    async def converse(session, prompt, timeout=None, spend_ok=None, attachments=(), tools=None):
        prompts.append(prompt)
        (tools["folder"] / "cat.png").write_bytes(PNG)
        session.calls += 1
        return ProviderResult(f"画好了，给你。\nSEND: cat.png\nSEND: {outside}\nSEND: ../x", 10, 10)

    monkeypatch.setattr(api.providers, "converse", converse)
    await upload(client, package([{"conversation": "c1", "text": "画一只猫给我"}]))
    await enable(client)
    [reply] = await eventually(lambda: lines("replies.jsonl"))
    # The answer, without its SEND lines, and the picture, in its data folder for it to send.
    assert reply["reply"] == "画好了，给你。\n\n（发了：cat.png）"
    [path] = reply["files"]
    assert path.startswith("outbox/") and (capability_packages.data_folder("fake-bot") / path).read_bytes() == PNG
    assert "SEND: <its name in your folder>" in prompts[0]
    # What is outside the chat's folder is not sent, and the log says so.
    log = "\n".join(runner.get("fake-bot").log)
    assert "secret.txt" in log and "没发出" in log and "../x" in log
    chat = api.db.get_run(runner.get("fake-bot").state["chats"]["c1"])
    assert chat.lead_messages[-1].text == reply["reply"]


def test_what_the_group_said_is_kept_bounded():
    kept = capability_runner.keep_heard([f"成员：{n}" * 100 for n in range(50)])
    assert len(kept) <= capability_runner.MAX_HEARD_LINES and sum(map(len, kept)) <= capability_runner.MAX_HEARD_CHARS
    assert kept[-1].startswith("成员：49")


async def test_work_sent_with_an_image_is_planned_with_it(packages, monkeypatch):
    api, client, _, _ = packages
    triaging(api, monkeypatch, '{"kind": "chat"}', ['好的。\nTASK: {"request": "照附件里的设计图改首页"}'])
    await upload(client, package([{"conversation": "c1", "text": "照这张图改首页", "files": {"design.png": b64(PNG)}}]))
    await enable(client)
    await eventually(lambda: lines("replies.jsonl"))
    [task] = [run for run in api.db.list_runs() if run.kind == "task"]
    assert [item.name for item in task.attachments] == ["design.png"]


async def test_an_image_goes_to_a_model_that_can_see_it_when_the_chosen_one_cannot(model_bot, monkeypatch):
    from super_partner import attachments as files
    api, client, runner, sent, _ = model_bot
    blind = api.models[OTHER.id].model_copy(update={"supports_vision": False})
    monkeypatch.setitem(api.models, OTHER.id, blind)
    assert (await choose_model(client, OTHER.id)).status_code == 200
    image = files.save("shot.png", PNG)
    reply, _, _ = await api.automation_message(capabilities.load("fake-bot"), capability_runner.Asked(
        conversation="c1", text="看看这个", attachments=[image]), runner.get("fake-bot"))
    assert sent[-1][0] != OTHER.id and sent.attached[-1] == ["shot.png"]
    # The owner reads of the switch in the log; the people chatting are not told.
    assert "本次由" not in reply and any("本次由" in line for line in runner.get("fake-bot").log)
    # Words alone go back to the chosen model.
    await bot_message(api, runner, "谢谢")
    assert sent[-1][0] == OTHER.id


def test_files_outside_its_data_folder_links_and_oversized_ones_are_refused(packages, monkeypatch, tmp_path):
    from super_partner import attachments as files
    item = capability_runner.Automation("fake-bot")
    folder = capability_packages.data_folder("fake-bot")
    (folder / "in").mkdir(parents=True)
    secret = tmp_path / "secret.png"
    secret.write_bytes(PNG)
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "elsewhere" / "far.png").write_bytes(PNG)
    (folder / "in" / "ok.png").write_bytes(PNG)
    (folder / "in" / "link.png").symlink_to(secret)
    (folder / "dirlink").symlink_to(tmp_path / "elsewhere")
    (folder / "in" / "big.png").write_bytes(PNG + b"\0" * 100)
    monkeypatch.setattr(files, "MAX_ATTACHMENT_BYTES", 80)
    taken = capability_runner.take_files(item, "fake-bot",
                                         ["in/ok.png", "in/link.png", "dirlink/far.png", "in/big.png", str(secret), "in/none.png"])
    assert [attachment.name for attachment in taken] == ["ok.png"]
    assert files.path(taken[0]).read_bytes() == PNG
    # Its own files are gone; nothing outside its folder was touched.
    assert sorted(path.name for path in (folder / "in").iterdir()) == []
    assert secret.read_bytes() == PNG and (tmp_path / "elsewhere" / "far.png").exists()
    assert len([line for line in item.log if "没收下" in line]) == 5
    assert capability_runner.take_files(item, "fake-bot", "in/ok.png") == []

@pytest.fixture
async def model_bot(packages, monkeypatch):
    """Real routing and chat lifecycle, with fake API and membership conversations."""
    api, client, runner, _ = packages
    sent, classified = triaging(api, monkeypatch, '{"kind": "chat"}')
    cli = BEST.model_copy(update={"id": "cli:codex", "display_name": "Codex CLI", "channel": "cli"})
    monkeypatch.setitem(api.models, cli.id, cli)
    await upload(client, package())
    return api, client, runner, sent, classified


async def choose_model(client, model_id, capability_id="fake-bot"):
    return await client.put(f"/api/capabilities/{capability_id}/model", json={"model_id": model_id}, headers=ORIGIN)


async def bot_message(api, runner, text, conversation="c1", capability_id="fake-bot"):
    reply, cost, _ = await api.automation_message(capabilities.load(capability_id),
                                                  capability_runner.Asked(conversation=conversation, text=text),
                                                  runner.get(capability_id))
    return reply, cost


async def test_automation_model_setting_survives_reload_upgrade_and_is_scoped_to_its_capability(model_bot):
    api, client, runner, _, _ = model_bot
    await upload(client, package(manifest={"id": "other-bot"}))
    # A host state from before model settings existed still loads, with its budget and chats.
    path = capability_runner.state_path("fake-bot")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"daily_budget_usd": 3, "chats": {"old": "old-chat"}, "handled": 7}))
    old = runner.get("fake-bot")
    assert old.public()["model_id"] is None
    saved = await choose_model(client, OTHER.id)
    assert saved.status_code == 200, saved.text
    assert saved.json()["model_id"] == OTHER.id
    runtime = (await client.get("/api/capabilities/runtime")).json()["capabilities"]
    assert runtime["fake-bot"]["model_id"] == OTHER.id and runtime["other-bot"]["model_id"] is None
    await upload(client, package(manifest={"version": "2.0"}))
    reloaded = capability_runner.Runner(api.automation_message).get("fake-bot")
    assert reloaded.public()["model_id"] == OTHER.id
    assert reloaded.state["chats"] == {"old": "old-chat"}
    assert reloaded.public()["daily_budget_usd"] == 3 and reloaded.public()["handled"] == 7
    assert (await choose_model(client, None)).json()["model_id"] is None
    assert capability_runner.Automation("fake-bot").public()["model_id"] is None


@pytest.mark.parametrize("unavailable", ["unknown", "disabled", "unconfigured", "unscored", "helper", "no_session"])
async def test_automation_model_setting_rejects_unusable_models_without_losing_the_saved_choice(model_bot, monkeypatch, unavailable):
    api, client, runner, _, _ = model_bot
    assert (await choose_model(client, OTHER.id)).status_code == 200
    model = BEST.model_copy(update={"id": "x:invalid"})
    if unavailable == "disabled":
        model.enabled = False
    elif unavailable == "unscored":
        model.scores = None
    elif unavailable == "helper":
        monkeypatch.setattr(settings, "helper_only_models", [model.id])
    elif unavailable == "no_session":
        model.id, model.channel = "cli:no-session", "cli"
    if unavailable != "unknown":
        monkeypatch.setitem(api.models, model.id, model)
    if unavailable == "unconfigured":
        monkeypatch.setattr(api.providers, "configured_models", lambda _ids: set(api.models) - {model.id})
    response = await choose_model(client, model.id)
    assert response.status_code == 422 and "模型" in response.json()["detail"]
    assert runner.get("fake-bot").public()["model_id"] == OTHER.id
    assert capability_runner.Automation("fake-bot").public()["model_id"] == OTHER.id


async def test_automation_model_setting_requires_an_uploaded_automation(model_bot):
    _, client, runner, _, _ = model_bot
    assert (await choose_model(client, OTHER.id, "missing")).status_code == 404
    await upload(client, package(manifest={"id": "tool", "kind": "tool", "entry": ""}))
    assert (await choose_model(client, OTHER.id, "tool")).status_code == 422
    capability = capabilities.load("fake-bot")
    capability.source = "task"
    capabilities.save(capability)
    assert (await choose_model(client, OTHER.id)).status_code == 422
    assert not runner.automations


@pytest.mark.parametrize("model_id", [OTHER.id, "cli:codex"])
async def test_automation_uses_the_selected_api_or_cli_model_and_keeps_triage_independent(model_bot, model_id):
    api, client, runner, sent, classified = model_bot
    assert (await choose_model(client, model_id)).status_code == 200
    first, cost = await bot_message(api, runner, "WAL 是什么？")
    second, _ = await bot_message(api, runner, "检查点呢？")
    assert [item[0] for item in sent] == [model_id, model_id]
    assert first == "好的。" and second == "嗯。" and cost > 0
    assert classified == []  # every message goes to the chat; its model asks for work itself
    assert sent[0][2].startswith(CHAT_ROLE) and sent[1][2] == "检查点呢？"
    chat = api.db.get_run(runner.get("fake-bot").state["chats"]["c1"])
    assert chat.kind == "chat" and chat.plan.nodes == [] and chat.supervisor.model_id == model_id


@pytest.mark.parametrize(("first_model", "next_model"), [(OTHER.id, "cli:codex"), ("cli:codex", OTHER.id)])
async def test_automation_model_switch_waits_for_the_reply_and_hands_recent_context_to_a_fresh_session(model_bot, monkeypatch, first_model, next_model):
    api, client, runner, _, _ = model_bot
    assert (await choose_model(client, first_model)).status_code == 200
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def converse(session, prompt, **_kwargs):
        calls.append((session.model_copy(deep=True), prompt))
        if len(calls) == 1:
            entered.set()
            await release.wait()
        answer = "记住了，项目名是海棠。" if len(calls) == 1 else "接着聊海棠。"
        session.calls += 1
        session.session_id = f"native-{session.model_id}"
        session.history += [{"role": "user", "content": prompt}, {"role": "assistant", "content": answer}]
        return ProviderResult(answer, 10, 10)

    monkeypatch.setattr(api.providers, "converse", converse)
    first = asyncio.create_task(bot_message(api, runner, "项目名是海棠，请记住。"))
    second = None
    try:
        await asyncio.wait_for(entered.wait(), 2)
        # The next message is already queued when the owner saves a different model.
        second = asyncio.create_task(bot_message(api, runner, "它叫什么？"))
        await asyncio.sleep(0)
        saved = await asyncio.wait_for(choose_model(client, next_model), 2)
        assert saved.status_code == 200
        run_id = runner.get("fake-bot").state["chats"]["c1"]
        assert api.db.get_run(run_id).supervisor.model_id == first_model
        assert len(calls) == 1 and not first.done() and not second.done()
    finally:
        release.set()
        await asyncio.gather(first, *([second] if second else []))
    assert (await first)[0] == "记住了，项目名是海棠。"
    session, prompt = calls[1]
    assert session.model_id == next_model and session.session_id is None and session.calls == 0 and session.history == []
    assert session.previous == [first_model]
    assert prompt.startswith(CHAT_ROLE) and "项目名是海棠，请记住。" in prompt
    assert "记住了，项目名是海棠。" in prompt and "它叫什么？" in prompt
    await bot_message(api, runner, "再确认一次。")
    assert calls[2][0].session_id == f"native-{next_model}" and calls[2][1] == "再确认一次。"


async def test_automation_restoring_auto_after_reload_switches_existing_chats_with_bounded_history(model_bot):
    api, client, runner, sent, _ = model_bot
    assert (await choose_model(client, OTHER.id)).status_code == 200
    await bot_message(api, runner, "项目名是海棠。")
    run_id = runner.get("fake-bot").state["chats"]["c1"]
    chat = api.db.get_run(run_id)
    chat.lead_messages.insert(0, LeadMessage(role="user", text="旧内容" * MAX_CHAT_HANDOVER_CHARS))
    api.db.save_run(chat)
    # Applied preferences survive a restart too; restoring automatic must not stay pinned.
    runner.automations.clear()
    assert (await choose_model(client, None)).status_code == 200
    await bot_message(api, runner, "项目名是什么？")
    assert sent[-1][0] == BEST.id  # chosen automatically: an API model first, people wait for answers
    assert "项目名是海棠。" in sent[-1][2] and "好的。" in sent[-1][2] and "旧内容" not in sent[-1][2]
    assert len(sent[-1][2]) < MAX_CHAT_HANDOVER_CHARS


@pytest.mark.parametrize("failure", ["call", "disabled", "removed"])
async def test_automation_fallback_reports_the_actual_model_and_retains_the_preference(model_bot, monkeypatch, failure):
    api, client, runner, sent, _ = model_bot
    assert (await choose_model(client, OTHER.id)).status_code == 200
    await bot_message(api, runner, "先聊一句。")
    converse = api.providers.converse

    async def failing(session, prompt, **kwargs):
        if session.model_id == OTHER.id:
            raise ProviderError("selected model unavailable")
        return await converse(session, prompt, **kwargs)

    if failure == "call":
        monkeypatch.setattr(api.providers, "converse", failing)
    elif failure == "disabled":
        monkeypatch.setitem(api.models, OTHER.id, OTHER.model_copy(update={"enabled": False}))
    else:
        monkeypatch.delitem(api.models, OTHER.id)
    reply, _ = await bot_message(api, runner, "继续聊。")
    # The next model is an API one (people wait for answers); the switch goes to the log only.
    assert sent[-1][0] == BEST.id and "先聊一句。" in sent[-1][2]
    assert "暂不可用" not in reply and any(BEST.display_name in line and "暂不可用" in line
                                          for line in runner.get("fake-bot").log)
    assert runner.get("fake-bot").public()["model_id"] == OTHER.id
    # A new conversation also falls back if the saved choice is no longer available.
    reply, _ = await bot_message(api, runner, "新话题。", conversation="c2")
    assert sent[-1][0] == BEST.id and "暂不可用" not in reply


async def test_automation_default_auto_keeps_its_existing_fallback_conversation(model_bot, monkeypatch):
    api, _, runner, sent, _ = model_bot
    converse = api.providers.converse

    async def failing(session, prompt, **kwargs):
        if session.model_id == "cli:codex":
            raise ProviderError("CLI unavailable")
        return await converse(session, prompt, **kwargs)

    monkeypatch.setattr(api.providers, "converse", failing)
    reply, _ = await bot_message(api, runner, "你好。")
    assert "暂不可用" not in reply
    await bot_message(api, runner, "接着说。")
    assert [item[0] for item in sent] == [BEST.id, BEST.id]
    assert sent[-1][2] == "接着说。"
    assert runner.get("fake-bot").public()["model_id"] is None


async def test_automation_model_selection_does_not_change_task_planning(model_bot, monkeypatch):
    api, client, runner, _, _ = model_bot
    assert (await choose_model(client, OTHER.id)).status_code == 200
    sent, _ = triaging(api, monkeypatch, '{"kind": "chat"}', [ASK_FOR_WORK])
    reply, _ = await bot_message(api, runner, "给商品接口加 Redis 缓存")
    assert "等主人确认后开工" in reply and [item[0] for item in sent] == [OTHER.id]
    [task] = [run for run in api.db.list_runs() if run.kind == "task"]
    assert task.status == RunStatus.AWAITING_CONFIRMATION


async def test_an_automation_asks_super_partner_and_a_conversation_goes_on_in_one_chat(packages, monkeypatch):
    api, client, runner, _ = packages
    triaging(api, monkeypatch, '{"kind": "chat"}')
    await upload(client, package([{"conversation": "c1", "text": "WAL 是什么？"}, {"conversation": "c1", "text": "检查点呢？"},
                                  {"conversation": "c2", "text": "你好"}]))
    assert (await enable(client)).status_code == 200
    replies = await eventually(lambda: len(lines("replies.jsonl")) == 3 and lines("replies.jsonl"))
    assert [item["re"] for item in replies] == ["0", "1", "2"] and all(item["reply"] in {"好的。", "嗯。"} for item in replies)
    # Its secret, and the proxy as its only way out.
    [env] = lines("env.jsonl")
    assert env == {"token": "t0ken-value", "proxy": f"http://127.0.0.1:{capability_sandbox.PROXY_PORT}"}
    state = runner.get("fake-bot")
    assert len(state.state["chats"]) == 2 and state.state["handled"] == 3 and state.spent_today() > 0
    chat = api.db.get_run(state.state["chats"]["c1"])
    assert chat.kind == "chat" and chat.plan.title.startswith("假机器人 · WAL") and chat.project_dir is None
    assert [m.text for m in chat.lead_messages if m.role == "user"] == ["WAL 是什么？", "检查点呢？"]
    assert chat.origin == {"message_id": "om_0", "capability": "fake-bot"}
    runtime = (await client.get("/api/capabilities/runtime")).json()["capabilities"]["fake-bot"]
    assert runtime["status"] == "running" and runtime["text"] == "就绪"
    assert any("plain output goes to the log" in line for line in runtime["log"])
    # Switched off, it stops.
    await client.patch("/api/capabilities/fake-bot", json={"enabled": False}, headers=ORIGIN)
    assert not runner.running("fake-bot")


async def test_work_is_asked_for_by_the_chat_with_the_whole_conversation_and_its_end_is_told_there(packages, monkeypatch):
    # Regression: a fragment ("关于戏剧的") was classified alone and planned as a task without what
    # was said before; the chat never knew of the task, nor of how it ended.
    api, client, runner, _ = packages
    sent, classified = triaging(api, monkeypatch, '{"kind": "task"}', ["哪类接口？", ASK_FOR_WORK, "好的。"])
    await upload(client, package([{"conversation": "c1", "text": "商品接口太慢了"},
                                  {"conversation": "c1", "text": "详情页那个，加个缓存"}]))
    await enable(client)
    replies = await eventually(lambda: len(lines("replies.jsonl")) == 2 and lines("replies.jsonl"))
    # A fragment is answered in the chat; work is asked for by the chat's model, said plainly.
    assert replies[0]["reply"] == "哪类接口？" and not classified
    assert replies[1]["reply"].startswith("好，我让 FluidForm 排个计划。") and "等主人确认后开工" in replies[1]["reply"]
    assert "TASK" not in replies[1]["reply"]
    [task] = [run for run in api.db.list_runs() if run.kind == "task"]
    assert task.prompt == "给商品接口加 Redis 缓存：缓存商品详情 5 分钟，改价时清掉"
    # The planner saw the conversation, not only the request.
    assert "商品接口太慢了" in sent.planned[0] and "新需求" in sent.planned[0]
    chat_id = runner.get("fake-bot").state["chats"]["c1"]
    assert task.origin == {"message_id": "om_1", "capability": "fake-bot", "conversation": "c1", "chat_run": chat_id}
    chat = api.db.get_run(chat_id)
    assert "排好了计划「加缓存」" in chat.lead_messages[-1].text and "TASK" not in chat.lead_messages[-1].text
    # Its end: the automation hears it, the chat shows it, its model is told with the next message.
    task.status, task.final_result = RunStatus.SUCCEEDED, "缓存加好了，命中率 92%。"
    api.db.save_run(task)
    api.executor.emit(task.id, "run.succeeded")
    [event] = await eventually(lambda: lines("events.jsonl"))
    assert event["event"] == "task_ended" and event["origin"]["message_id"] == "om_1"
    assert event["text"] == "「加缓存」做完了。\n\n缓存加好了，命中率 92%。"
    assert api.db.get_run(chat_id).lead_messages[-1].text == event["text"]
    assert runner.get("fake-bot").state["notes"] == {"c1": [event["text"]]}
    await api.automation_message(capabilities.load("fake-bot"), capability_runner.Asked(
        conversation="c1", text="命中率怎么样？"), runner.get("fake-bot"))
    assert "这之后发生了" in sent[-1][2] and "命中率 92%" in sent[-1][2] and runner.get("fake-bot").state["notes"] == {}


async def test_past_its_days_budget_it_is_told_once_then_nothing(packages, monkeypatch):
    api, client, _, _ = packages
    triaging(api, monkeypatch, '{"kind": "chat"}')
    await upload(client, package([{"conversation": "c1", "text": "在吗"}, {"conversation": "c1", "text": "在吗？"}]))
    assert (await client.put("/api/capabilities/fake-bot/budget", json={"daily_budget_usd": 0}, headers=ORIGIN)).status_code == 200
    await enable(client)
    first, second = await eventually(lambda: len(lines("replies.jsonl")) == 2 and lines("replies.jsonl"))
    assert "额度" in first["reply"] and first["over_budget"] and second["reply"] is None
    assert not [run for run in api.db.list_runs() if run.kind == "chat"]


async def test_a_crashing_automation_is_restarted_a_few_times_then_left_stopped(packages, monkeypatch):
    _, client, runner, _ = packages
    monkeypatch.setattr(capability_runner, "RESTART_PAUSE", 0.01)
    monkeypatch.setattr(capability_runner, "MAX_RESTARTS", 3)
    await upload(client, package(manifest={"entry": "echo 坏了 >&2; exit 3"}))
    await enable(client)
    item = runner.get("fake-bot")
    await eventually(lambda: item.status == "error")
    assert "连续退出了 3 次" in item.error and sum("坏了" in line for line in item.log) == 3


async def test_started_with_the_service_only_when_the_machine_allows_it(packages):
    api, client, runner, _ = packages
    await upload(client, package())
    await enable(client)
    await runner.stop_all()
    settings.capability_packages = False
    api.start_automations()
    assert not runner.running("fake-bot")
    settings.capability_packages = True
    api.start_automations()
    assert runner.running("fake-bot")


# ---- the sandbox ----

def test_the_sandbox_hides_home_and_data_keeps_its_folder_read_only_and_has_no_network(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    folder, data = tmp_path / "data" / "tools" / "capabilities" / "x", tmp_path / "data" / "capability-data" / "x"
    folder.mkdir(parents=True)
    data.mkdir(parents=True)
    env = capability_sandbox.environment_for(folder, data, {"TOKEN": "v"}, True)
    args = capability_sandbox.wrap(folder, data, "python3 bot.py", env, "/tmp/sp-cap-x")
    joined = " ".join(args)
    # The home folder is hidden; Super Partner's data is too (here it is under /tmp, its own tmpfs).
    assert f"--tmpfs {Path.home().resolve()}" in joined and "--tmpfs /tmp " in joined
    assert f"--ro-bind {folder} {folder}" in joined and f"--bind {data} {data}" in joined
    assert "--unshare-net" in args and "--clearenv" in args and "--setenv TOKEN v" in joined
    assert f"socat TCP-LISTEN:{capability_sandbox.PROXY_PORT}" in joined
    assert f"--bind {folder} {folder}" in " ".join(capability_sandbox.wrap(folder, data, "x", env, None, writable=True))
    assert env["HTTPS_PROXY"].endswith(f":{capability_sandbox.PROXY_PORT}") and "socat" not in " ".join(
        capability_sandbox.wrap(folder, data, "x", env, None))


@pytest.mark.parametrize(("host", "ok"), [("open.feishu.cn", True), ("feishu.cn", True), ("evilfeishu.cn", False),
                                          ("api.example.org", True), ("x.api.example.org", False)])
def test_only_declared_hosts_are_allowed(host, ok):
    assert capability_sandbox.allowed(host, ["*.feishu.cn", "api.example.org"]) is ok


async def _echo_server():
    async def echo(reader, writer):
        writer.write(await reader.read(100))
        await writer.drain()
        writer.close()
    return await asyncio.start_server(echo, "127.0.0.1", 0)


async def _through(folder, target):
    reader, writer = await asyncio.open_unix_connection(f"{folder}/{capability_sandbox.PROXY_PORT}.sock")
    writer.write(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    await writer.drain()
    head = await reader.readuntil(b"\r\n\r\n")
    return head, reader, writer


async def test_the_proxy_lets_through_only_declared_hosts(monkeypatch):
    for name in ("HTTPS_PROXY", "https_proxy"):
        monkeypatch.delenv(name, raising=False)
    server = await _echo_server()
    port = server.sockets[0].getsockname()[1]
    monkeypatch.setattr(capability_sandbox, "ALLOWED_PORTS", {port})
    logged = []
    async with server, capability_sandbox.DomainProxy(["localhost"], logged.append) as proxy:
        head, reader, writer = await _through(proxy.folder, f"localhost:{port}")
        assert b" 200 " in head
        writer.write(b"ping")
        await writer.drain()
        assert await reader.read(100) == b"ping"
        writer.close()
        refused, _, other = await _through(proxy.folder, f"example.com:{port}")
        other.close()
        assert b" 403 " in refused and "example.com" in logged[-1]


@pytest.mark.skipif(bool(capability_sandbox.missing()), reason="needs bwrap and socat")
async def test_in_the_real_sandbox_it_writes_only_its_data_and_reaches_only_the_proxy(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    for name in ("HTTPS_PROXY", "https_proxy"):
        monkeypatch.delenv(name, raising=False)
    folder, data = tmp_path / "data" / "tools" / "capabilities" / "x", tmp_path / "data" / "capability-data" / "x"
    folder.mkdir(parents=True)
    server = await _echo_server()
    port = server.sockets[0].getsockname()[1]
    monkeypatch.setattr(capability_sandbox, "ALLOWED_PORTS", {port})
    python = shlex.quote(os.path.realpath(sys.executable))
    probe = (
        "import json, os, socket\n"
        "out = {}\n"
        "for name, path in (('folder', 'x.txt'), ('data', os.environ['SP_DATA_DIR'] + '/x.txt')):\n"
        "    try:\n        open(path, 'w').write('x'); out[name] = True\n"
        "    except OSError:\n        out[name] = False\n"
        f"try:\n    socket.create_connection(('127.0.0.1', {port}), 2); out['direct'] = True\n"
        "except OSError:\n    out['direct'] = False\n"
        f"s = socket.create_connection(('127.0.0.1', {capability_sandbox.PROXY_PORT}), 5)\n"
        f"s.sendall(b'CONNECT localhost:{port} HTTP/1.1\\r\\n\\r\\n'); head = s.recv(200)\n"
        "s.sendall(b'hi'); out['proxied'] = head.startswith(b'HTTP/1.1 200') and s.recv(10) == b'hi'\n"
        "print(json.dumps(out))\n")
    (folder / "probe.py").write_text(probe)
    async with server:
        output, ok = await capability_sandbox.run(folder, data, f"{python} probe.py", 30, domains=["localhost"])
    assert ok, output
    assert json.loads(output.splitlines()[-1]) == {"folder": False, "data": True, "direct": False, "proxied": True}


def test_the_environment_leaves_the_command_line():
    from super_partner.agent import without_env_args
    args = ["bwrap", "--ro-bind", "/", "/", "--clearenv", "--setenv", "TOKEN", "s3cret", "--setenv", "PATH", "/usr/bin",
            "--chdir", "/x", "--", "/bin/bash", "-c", "echo --setenv A b", "--clearenv"]
    kept, env = without_env_args(args)
    assert env == {"TOKEN": "s3cret", "PATH": "/usr/bin"}
    assert "s3cret" not in kept and "--clearenv" not in kept[:kept.index("--")]
    # The command itself is left as it was.
    assert kept[kept.index("--"):] == ["--", "/bin/bash", "-c", "echo --setenv A b", "--clearenv"]
    assert kept[0].endswith("bwrap")


@pytest.mark.skipif(bool(capability_sandbox.missing()), reason="needs bwrap and socat")
async def test_in_the_real_sandbox_its_secrets_are_in_its_environment_not_on_any_command_line(tmp_path, monkeypatch):
    # Regression: secrets were bwrap --setenv arguments, readable by every user in /proc/<pid>/cmdline.
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    folder, data = tmp_path / "data" / "tools" / "capabilities" / "x", tmp_path / "data" / "capability-data" / "x"
    folder.mkdir(parents=True)
    secret = "s3cret-" + os.urandom(6).hex()
    async with capability_sandbox.launched(folder, data, 'echo "inside=$TOKEN"; sleep 30',
                                           secrets={"TOKEN": secret}) as process:
        line = await asyncio.wait_for(process.stdout.readline(), 10)
        assert line.decode().strip() == f"inside={secret}"
        lines = []
        for pid in [process.pid, *[int(p) for p in Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text().split()]]:
            with contextlib.suppress(OSError):
                lines.append(Path(f"/proc/{pid}/cmdline").read_bytes())
        assert lines and not any(secret.encode() in item for item in lines)


async def test_a_command_reaching_no_host_runs_without_a_proxy(tmp_path, unsandboxed):
    folder = tmp_path / "x"
    folder.mkdir()
    output, ok = await capability_sandbox.run(folder, tmp_path / "data", 'echo "proxy=$HTTPS_PROXY"', 10)
    assert ok and output == "proxy="


async def test_its_environment_is_built_in_the_sandbox_reaching_only_the_package_index(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    monkeypatch.setattr(capability_sandbox, "missing", lambda: "")
    (capabilities.root() / "x").mkdir(parents=True)
    (capabilities.root() / "x" / "requirements.txt").write_text("lark-oapi\n")
    ran = []

    async def run(folder, data, command, timeout, **options):
        ran.append((command, options))
        return "", True
    monkeypatch.setattr(capability_sandbox, "run", run)
    assert await capability_packages.build(Capability(id="x", name="x")) == ("", True)
    [(command, options)] = ran
    assert "-m venv .venv" in command and "pip install" in command and options["writable"] is True
    assert "pypi.org" in options["domains"] and "files.pythonhosted.org" in options["domains"]


def test_records_saved_before_packages_load():
    old = Capability.model_validate({"id": "x", "name": "x", "status": "active"})
    assert (old.source, old.entry, old.version) == ("task", "", "")


async def test_an_automations_chat_remembers_what_people_tell_it_for_its_next_chats(packages, monkeypatch):
    api, client, runner, _ = packages
    monkeypatch.setattr(settings, "user_memory", True)
    sent, _ = triaging(api, monkeypatch, '{"kind": "chat"}', [
        "好，以后简短回答。\nREMEMBER: 成员1: 喜欢简短的回答\nREMEMBER: 成员1: 密码是 hunter2", "嗯。", "好的。\nFORGET: 简短"])
    await upload(client, package([{"conversation": "c1", "text": "以后回答短一点"}]))
    await enable(client)
    [reply] = await eventually(lambda: lines("replies.jsonl"))
    # The person sees the answer without its lines; the fact is kept, the secret is not.
    assert reply["reply"] == "好，以后简短回答。"
    state = runner.get("fake-bot")
    assert remembering.facts("fake-bot:c1") == ["成员1: 喜欢简短的回答"] and "memory" not in state.state
    assert api.db.get_run(state.state["chats"]["c1"]).lead_messages[-1].text == "好，以后简短回答。"
    assert "REMEMBER:" in sent[0][2] or "REMEMBER:" in supervisor.chat_guide(api.db.get_run(state.state["chats"]["c1"]))
    # A new chat of that conversation (another day, another model) is told it first.
    state.state["chats"].pop("c1")
    await api.automation_message(capabilities.load("fake-bot"), capability_runner.Asked(conversation="c1", text="你好"), state)
    assert "你记得的" in sent[-1][2] and "喜欢简短的回答" in sent[-1][2]
    await api.automation_message(capabilities.load("fake-bot"), capability_runner.Asked(conversation="c1", text="还是详细点吧"), state)
    assert remembering.facts("fake-bot:c1") == []
    # Facts kept the earlier way, in the automation's state, move to the shared place.
    state.state["memory"] = {"c9": ["成员2: 用 Go"]}
    await api.automation_message(capabilities.load("fake-bot"), capability_runner.Asked(conversation="c9", text="嗨"), state)
    assert remembering.facts("fake-bot:c9") == ["成员2: 用 Go"] and "memory" not in state.state


def test_memory_lines_are_read_and_kept_within_bounds():
    shown, remembered, forgotten = remembering.split("好的\nREMEMBER: a: 用 Python\nFORGET: Java")
    assert (shown, remembered, forgotten) == ("好的", ["a: 用 Python"], ["Java"])
    assert remembering.split("没有") == ("没有", [], [])
    facts = remembering.apply([f"f{i}" for i in range(remembering.MAX_FACTS)], ["new", "f3", "我的 API key 是 x"], ["f0"])
    assert len(facts) == remembering.MAX_FACTS and facts[-1] == "new" and "f0" not in facts and facts.count("f3") == 1
    assert remembering.told([]) == ""


async def test_in_a_group_a_reply_to_its_own_question_is_answered_without_an_at(packages, monkeypatch):
    # Regression: it asked "在广场哪一侧？", and "西侧" (no @) was taken as not meant for it; so were
    # other follow-ups, and the person had to @ it each time.
    api, client, runner, _ = packages
    sent, asked = triaging(api, monkeypatch, '{"kind": "chat"}', ["应该是国博。在广场哪一侧？", "那就是人民大会堂。", "好。"])
    await upload(client, package())
    bot, state = capabilities.load("fake-bot"), runner.get("fake-bot")
    group = {"chat_type": "group"}

    def say(text, sender="成员1", addressed=False):
        return api.automation_message(bot, capability_runner.Asked(conversation="g1", text=text, origin=group,
                                                                   addressed=addressed, sender=sender), state)

    await say("这是哪栋楼？", addressed=True)
    reply = (await say("西侧"))[0]
    assert reply == "那就是人民大会堂。" and "西侧" in sent[-1][2]
    # Someone else's aside is still judged, now knowing what it last said.
    reply = (await say("哈哈", sender="成员2"))[0]
    assert reply is None and "刚才回答 成员1：那就是人民大会堂。" in asked[-1][1]
    # What the chat keeps is what was said, not what the model was told around it.
    await say("继续说", addressed=True)
    chat = api.db.get_run(state.state["chats"]["g1"])
    assert chat.lead_messages[-2].text == "成员2：哈哈\n成员1：继续说"
    assert not any("群里此前的消息" in m.text for m in chat.lead_messages if m.role == "user")


async def test_only_an_at_with_nothing_new_gets_a_short_answer(packages, monkeypatch):
    # Regression: an @ alone made it describe every picture of the conversation again.
    api, client, runner, _ = packages
    sent, _ = triaging(api, monkeypatch, '{"kind": "chat"}')
    await upload(client, package())
    reply, cost = (await api.automation_message(capabilities.load("fake-bot"), capability_runner.Asked(
        conversation="g2", text=capability_runner.CALLED_ONLY, sender="成员1"), runner.get("fake-bot")))[:2]
    assert (reply, cost) == ("在呢，要我做什么？", 0.0) and not sent


def test_chats_in_chat_apps_are_short_and_answered_by_api_models_first():
    from super_partner.models import ExecutionRun, RunStatus, TaskPlan
    group = ExecutionRun(id="c", prompt="p", kind="chat", status=RunStatus.DRAFT, budget_usd=1, plan=TaskPlan(summary="s", nodes=[]),
                         origin={"capability": "fake-bot", "chat_type": "group"})
    assert "two or three sentences" in supervisor.chat_guide(group)
    cli = BEST.model_copy(update={"id": "cli:codex", "channel": "cli"})
    assert [m.id for m in supervisor.chat_order(group, [cli, BEST])] == [BEST.id, "cli:codex"]
    web = group.model_copy(update={"origin": {}})
    assert [m.id for m in supervisor.chat_order(web, [cli, BEST])] == ["cli:codex", BEST.id]


async def test_a_question_about_a_picture_waits_for_the_picture_sent_just_after(monkeypatch):
    # Regression: "这个图片的背景在哪里" came a moment before its picture: "我这边还没看到图片".
    import asyncio

    from super_partner import attachments as files
    monkeypatch.setattr(capability_runner, "PICTURE_WAIT_SECONDS", 2.0)
    seen, replies = [], []

    async def handle(capability, asked, automation):
        seen.append((asked.text, [item.name for item in asked.attachments]))
        return "答", 0.0

    runner = capability_runner.Runner(handle)
    item = runner.get("fake-bot")
    picture = files.save("bg.png", PNG)

    async def send(automation, payload):
        replies.append(payload)

    monkeypatch.setattr(runner, "_send", send)
    monkeypatch.setattr(capability_runner, "take_files", lambda item, cid, names: [picture] if names else [])
    bot = Capability(id="fake-bot", name="假机器人", kind="automation", summary="s")
    base = {"op": "message", "conversation": "g", "sender": "成员1"}
    question = asyncio.create_task(runner._ask(item, bot, {**base, "id": "1", "text": "这个图片的背景在哪里"}))
    await asyncio.sleep(0.2)
    await runner._ask(item, bot, {**base, "id": "2", "text": "", "attachments": ["bg.png"]})
    await asyncio.wait_for(question, 5)
    assert seen == [("这个图片的背景在哪里", ["bg.png"])]
    assert {"re": "2", "reply": None} in replies
    # A picture sent a moment before is the one meant: no waiting then.
    started = asyncio.get_running_loop().time()
    await runner._ask(item, bot, {**base, "id": "3", "text": "这张图里是谁"})
    assert asyncio.get_running_loop().time() - started < 1.0
