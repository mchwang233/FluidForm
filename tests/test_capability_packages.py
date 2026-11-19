"""Capability packages (capability_packages.py, capability_sandbox.py, capability_runner.py,
docs/design/capability-packages.md): uploaded and uninstalled on their own, run in a sandbox that
reaches only declared hosts, and automations that ask Super Partner and hear how tasks ended."""
import asyncio
import io
import json
import os
import shlex
import sys
import time
import zipfile
from pathlib import Path

import pytest
from super_partner import capabilities, capability_packages, capability_runner, capability_sandbox
from super_partner import secrets as secret_store
from super_partner.config import settings
from super_partner.models import Capability, RunStatus
from test_chat import ORIGIN, triaging

# A fake automation: asks what asks.json lists, one at a time, and writes what it hears.
FAKE = r'''
import json, os, sys
data = os.environ["SP_DATA_DIR"]
def note(name, value):
    with open(os.path.join(data, name), "a") as out:
        out.write(json.dumps(value, ensure_ascii=False) + "\n")
note("env.jsonl", {"token": os.environ.get("TOKEN"), "proxy": os.environ.get("HTTPS_PROXY")})
print(json.dumps({"op": "status", "text": "就绪"}), flush=True)
print("plain output goes to the log", flush=True)
asks = json.load(open("asks.json"))
for n, ask in enumerate(asks):
    print(json.dumps({"op": "message", "id": str(n), "conversation": ask["conversation"], "text": ask["text"],
                      "origin": {"message_id": "om_%d" % n}}), flush=True)
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


# ---- running ----

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


async def test_work_waits_for_confirmation_and_the_automation_hears_how_it_ended(packages, monkeypatch):
    api, client, _, _ = packages
    triaging(api, monkeypatch, '{"kind": "task"}')
    await upload(client, package([{"conversation": "c1", "text": "给商品接口加 Redis 缓存"}]))
    await enable(client)
    [reply] = await eventually(lambda: lines("replies.jsonl"))
    assert "等主人确认后开工" in reply["reply"] and "加缓存" in reply["reply"]
    [task] = [run for run in api.db.list_runs() if run.kind == "task"]
    assert task.status == RunStatus.AWAITING_CONFIRMATION and task.origin == {"message_id": "om_0", "capability": "fake-bot"}
    task.status, task.final_result = RunStatus.SUCCEEDED, "缓存加好了，命中率 92%。"
    api.db.save_run(task)
    api.executor.emit(task.id, "run.succeeded")
    [event] = await eventually(lambda: lines("events.jsonl"))
    assert event["event"] == "task_ended" and event["origin"]["message_id"] == "om_0"
    assert event["text"] == "「加缓存」做完了。\n\n缓存加好了，命中率 92%。"


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
