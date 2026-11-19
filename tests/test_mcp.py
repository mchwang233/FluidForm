"""Tools from MCP servers (mcp.py, settings.mcp_servers): listed once, offered as
mcp__<server>__<tool>, each call a server started in the step's sandbox."""
import sys

import pytest
from super_partner import agent, mcp
from super_partner.config import settings

SERVER = r'''
import json, os, sys
for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method, answer = message["method"], None
    if method == "initialize":
        print("not json on stdout", flush=True)
        answer = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "t"}}
    elif method == "tools/list":
        answer = {"tools": [{"name": "add", "description": "Adds", "inputSchema": {"type": "object",
                  "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}}}},
                  {"name": "secret", "inputSchema": "bad"}]}
    elif method == "tools/call":
        args = message["params"]["arguments"]
        if message["params"]["name"] == "secret":
            answer = {"content": [{"type": "text", "text": os.environ.get("TOKEN", "none")}]}
        elif "a" not in args:
            answer = {"content": [{"type": "text", "text": "a is missing"}], "isError": True}
        else:
            print(json.dumps({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}}), flush=True)
            answer = {"content": [{"type": "text", "text": str(args["a"] + args["b"])}]}
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": answer}), flush=True)
'''


@pytest.fixture
def server(tmp_path, monkeypatch):
    script = tmp_path / "server.py"
    script.write_text(SERVER)
    monkeypatch.setattr(settings, "mcp_servers", {"calc": {"command": [sys.executable, str(script)], "secrets": ["TOKEN"]}})
    monkeypatch.setattr(mcp, "LISTED", {})
    monkeypatch.setattr(mcp, "secrets_for", lambda server, spec: {"TOKEN": "s3cret"})
    workspace = agent.Workspace(tmp_path)
    # The protocol, without depending on bubblewrap here: the command as it is.
    monkeypatch.setattr(workspace, "sandbox_args", lambda command: ["/bin/sh", "-c", command])
    return workspace


async def test_a_servers_tools_are_listed_once_and_called(server):
    tools = await mcp.definitions(server)
    assert [tool["name"] for tool in tools] == ["mcp__calc__add", "mcp__calc__secret"]
    assert tools[0]["parameters"]["properties"]["a"] == {"type": "integer"}
    assert tools[1]["parameters"] == {"type": "object", "properties": {}}
    assert await server.run("mcp__calc__add", {"a": 2, "b": 3}) == ("5", True)
    output, ok = await server.run("mcp__calc__add", {"b": 3})
    assert not ok and "a is missing" in output
    # Its secrets reach it as its environment.
    assert await server.run("mcp__calc__secret", {}) == ("s3cret", True)
    assert len(mcp.LISTED) == 1


async def test_a_reviewer_gets_none_and_a_broken_server_is_skipped(server, monkeypatch, tmp_path):
    assert await mcp.definitions(agent.Workspace(tmp_path, read_only=True)) == []
    monkeypatch.setattr(settings, "mcp_servers", {"gone": {"command": ["false"]}, "Bad Name": {"command": ["x"]}})
    assert await mcp.definitions(server) == []
    assert next(iter(mcp.LISTED.values()))[1] is None
    output, ok = await server.run("mcp__gone__x", {})
    assert not ok and "unknown tool" in output


@pytest.mark.skipif(not agent.sandbox_available(), reason="bubblewrap is not installed")
async def test_a_server_runs_in_the_steps_sandbox(tmp_path, monkeypatch):
    script = tmp_path / "server.py"
    script.write_text(SERVER)
    monkeypatch.setattr(settings, "mcp_servers", {"calc": {"command": [sys.executable, str(script)]}})
    monkeypatch.setattr(mcp, "LISTED", {})
    workspace = agent.Workspace(tmp_path)
    assert (await mcp.definitions(workspace))[0]["name"] == "mcp__calc__add"
    assert await workspace.run("mcp__calc__add", {"a": 1, "b": 1}) == ("2", True)
