"""Tools from MCP servers (settings.mcp_servers), for the API models' Workspace.

Each server is a command speaking the Model Context Protocol over stdio (newline-delimited
JSON-RPC). It runs inside the step's own sandbox, as a Bash command would: the same folder, the
same network or none, nothing of the user's home. A server is started for each call and stopped
after it; what tools it has is asked once and kept (LISTED). Its secrets come from the keyring
as capability/mcp-<server>/<VARIABLE>, given as its environment, never on a command line.

A server's tool is offered as mcp__<server>__<tool>."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shlex
import signal
import time
from typing import Optional

from .config import settings

log = logging.getLogger(__name__)

PROTOCOL = "2025-06-18"
SERVER_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,30}")
PREFIX = "mcp__"
CALL_SECONDS = 120
LIST_SECONDS = 60
# A server whose tools could not be listed is not tried again for this long.
RETRY_SECONDS = 300
MAX_OUTPUT = 30_000
MAX_TOOLS = 40
# (server, its spec) -> (when, its tool definitions or None when listing failed).
LISTED: dict[tuple[str, str], tuple[float, Optional[list[dict]]]] = {}


class MCPError(Exception):
    pass


def servers() -> dict[str, dict]:
    """The configured servers that can run: a valid name and an argv command."""
    found = {}
    for name, spec in (settings.mcp_servers or {}).items():
        command = spec.get("command") if isinstance(spec, dict) else None
        if not SERVER_NAME.fullmatch(name) or not isinstance(command, list) or not command \
                or not all(isinstance(item, str) and item for item in command):
            log.warning("MCP server %r is not set up right: it needs a lowercase name and an argv command", name)
            continue
        found[name] = spec
    return found


def tool_name(server: str, tool: str) -> str:
    return (PREFIX + server.replace("-", "_") + "__" + re.sub(r"[^A-Za-z0-9_-]", "_", tool))[:64]


def secrets_for(server: str, spec: dict) -> dict[str, str]:
    from .secrets import get_secret

    found = {}
    for variable in spec.get("secrets") or []:
        if isinstance(variable, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", variable):
            value = get_secret(f"capability/mcp-{server}/{variable}")
            if value:
                found[variable] = value
    return found


class Session:
    """One running server in a workspace's sandbox, spoken to over real pipes (a pipe under
    uvloop is a socket, which pasta loses: see Workspace.bash)."""

    def __init__(self, workspace, server: str, spec: dict):
        self.workspace, self.server, self.spec = workspace, server, spec
        self.process = None
        self.next_id = 0

    async def __aenter__(self):
        from .agent import without_env_args

        command = shlex.join(self.spec["command"])
        args, env = without_env_args(self.workspace.sandbox_args(f"exec {command}"))
        env.update(secrets_for(self.server, self.spec))
        stdin_read, stdin_write = os.pipe()
        stdout_read, stdout_write = os.pipe()
        try:
            self.process = await asyncio.create_subprocess_exec(
                *args, env=env, stdin=stdin_read, stdout=stdout_write, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True)
        finally:
            os.close(stdin_read)
            os.close(stdout_write)
        loop = asyncio.get_running_loop()
        self.reader = asyncio.StreamReader(limit=16 * 1024 * 1024)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(self.reader), os.fdopen(stdout_read, "rb", 0))
        self.writer_file = os.fdopen(stdin_write, "wb", 0)
        await self.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                          "clientInfo": {"name": "FluidForm", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return self

    async def __aexit__(self, *_):
        with contextlib.suppress(OSError):
            self.writer_file.close()
        if self.process and self.process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGKILL)
            await self.process.wait()

    def send(self, message: dict) -> None:
        try:
            self.writer_file.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
        except OSError as exc:
            raise MCPError(f"the server stopped: {exc}") from exc

    async def request(self, method: str, params: dict):
        self.next_id += 1
        asked = self.next_id
        self.send({"jsonrpc": "2.0", "id": asked, "method": method, "params": params})
        while True:
            line = await self.reader.readline()
            if not line:
                raise MCPError("the server stopped before answering")
            try:
                message = json.loads(line)
            except ValueError:
                continue  # a server printing something else on stdout
            if not isinstance(message, dict):
                continue
            if "method" in message and "id" in message:
                # The server asking us something (ping, sampling...): only ping is answered.
                reply = {"result": {}} if message["method"] == "ping" else {
                    "error": {"code": -32601, "message": "not supported by FluidForm"}}
                self.send({"jsonrpc": "2.0", "id": message["id"], **reply})
                continue
            if message.get("id") != asked:
                continue  # a notification
            if "error" in message:
                error = message["error"]
                raise MCPError(str(error.get("message") if isinstance(error, dict) else error)[:500])
            return message.get("result") or {}


def _definition(server: str, tool: dict) -> Optional[dict]:
    name = tool.get("name") if isinstance(tool, dict) else None
    if not isinstance(name, str) or not name:
        return None
    schema = tool.get("inputSchema")
    if not isinstance(schema, dict) or schema.get("type") != "object":
        schema = {"type": "object", "properties": {}}
    return {"name": tool_name(server, name), "mcp_tool": name,
            "description": f"[{server}] " + str(tool.get("description") or name)[:1000], "parameters": schema}


async def definitions(workspace) -> list[dict]:
    """The servers' tools for a workspace that may act (not a reviewer, not a host repair)."""
    if workspace.read_only or workspace.host:
        return []
    found = []
    for server, spec in servers().items():
        key = (server, json.dumps(spec, sort_keys=True))
        when, tools = LISTED.get(key, (0.0, None))
        if not when or (tools is None and time.monotonic() - when > RETRY_SECONDS):
            try:
                async with Session(workspace, server, spec) as session:
                    listed = await asyncio.wait_for(session.request("tools/list", {}), LIST_SECONDS)
                tools = [item for item in (_definition(server, tool) for tool in listed.get("tools") or [])
                         if item][:MAX_TOOLS]
            except (MCPError, OSError, asyncio.TimeoutError) as exc:
                log.warning("listing MCP server %s's tools failed: %s", server, exc)
                tools = None
            LISTED[key] = (time.monotonic(), tools)
        found += [{key: value for key, value in tool.items() if key != "mcp_tool"} for tool in tools or []]
    return found


def owner(name: str) -> Optional[tuple[str, dict, str]]:
    """The server, its spec and its own tool name for an offered tool name."""
    for server, spec in servers().items():
        _, tools = LISTED.get((server, json.dumps(spec, sort_keys=True)), (0.0, None))
        for tool in tools or []:
            if tool["name"] == name:
                return server, spec, tool["mcp_tool"]
    return None


def _text(result: dict) -> str:
    parts = []
    for item in result.get("content") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text":
            parts.append(str(item.get("text") or ""))
        elif item.get("type") == "resource" and isinstance(item.get("resource"), dict):
            parts.append(str(item["resource"].get("text") or f"(resource {item['resource'].get('uri', '')})"))
        else:
            parts.append(f"({item.get('type', 'content')} not shown)")
    if not parts and result.get("structuredContent") is not None:
        parts.append(json.dumps(result["structuredContent"], ensure_ascii=False))
    text = "\n".join(parts).strip() or "(the tool returned nothing)"
    return text if len(text) <= MAX_OUTPUT else text[:MAX_OUTPUT] + "\n...(cut)"


async def call(workspace, name: str, args: dict) -> tuple[str, bool]:
    """Run one MCP tool in the workspace's sandbox: its output, and whether it went through."""
    found = owner(name)
    if not found:
        return f"Error: unknown tool {name}", False
    server, spec, tool = found
    seconds = spec.get("timeout") if isinstance(spec.get("timeout"), (int, float)) else CALL_SECONDS
    try:
        async with Session(workspace, server, spec) as session:
            result = await asyncio.wait_for(session.request("tools/call", {"name": tool, "arguments": args}),
                                            max(1, min(seconds, 600)))
    except asyncio.TimeoutError:
        return f"Error: {server} did not answer within {seconds}s", False
    except (MCPError, OSError) as exc:
        return f"Error: {server}: {exc}", False
    return _text(result), not result.get("isError")
