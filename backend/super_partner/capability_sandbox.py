"""How a capability's commands run (docs/design/capability-packages.md).

As the steps' sandbox does, it hides the home folder and Super Partner's data. On top of that:
- its folder is read-only, and its data folder is the only place it writes, besides its own /tmp;
- it has no network of its own: the only way out is ``DomainProxy``, a proxy in this process,
  bridged in on a Unix socket, which lets a connection through only to a host the capability
  declared;
- it gets only its own secrets, as environment variables.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import signal
import sys
import tempfile
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlsplit

from . import environment
from .config import settings

# The proxy's port inside the sandbox, which has a network of its own (only loopback).
PROXY_PORT = 8118
ALLOWED_PORTS = {80, 443}
# Package indexes pip may reach when it builds a capability's environment.
PACKAGE_INDEXES = ("pypi.org", "files.pythonhosted.org")
HEAD_LIMIT = 16 * 1024
UPSTREAM_TIMEOUT = 20


def missing() -> str:
    """Why capabilities' commands cannot run on this machine, or "" when they can."""
    lacking = [name for name in ("bwrap", "socat") if not shutil.which(name)]
    return f"这台机器缺少 {'、'.join(lacking)}，能力的环境和自动化运行不了。" if lacking else ""


def allowed(host: str, domains: list[str]) -> bool:
    """Whether ``host`` is one of ``domains`` (``*.example.com`` also covers its subdomains)."""
    host = host.lower().strip().rstrip(".")
    for item in domains:
        item = item.lower().strip().rstrip(".")
        base = item.removeprefix("*.")
        if base and (host == base or (item.startswith("*.") and host.endswith("." + base))):
            return True
    return False


def index_hosts() -> list[str]:
    """Where pip finds packages: PyPI, and any index this machine set for the sandbox."""
    hosts = list(PACKAGE_INDEXES)
    for name in ("PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL"):
        for url in os.environ.get(name, "").split():
            with contextlib.suppress(ValueError):
                if host := urlsplit(url).hostname:
                    hosts.append(host)
    return hosts


def _user_proxy(host: str) -> Optional[tuple[str, int]]:
    """The user's own HTTPS proxy, which connections go through when this machine has one."""
    if any(allowed(host, [item.strip(), "*." + item.strip().lstrip(".")]) for item in
           (os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or "").split(",") if item.strip()):
        return None
    value = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""
    if not value:
        return None
    try:
        url = urlsplit(value if "://" in value else f"http://{value}")
        return (url.hostname, url.port or 80) if url.hostname and url.scheme == "http" else None
    except ValueError:
        return None


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (OSError, asyncio.IncompleteReadError):
        pass
    finally:
        with contextlib.suppress(Exception):
            writer.close()


class DomainProxy:
    """An HTTP CONNECT proxy on a Unix socket that reaches only ``domains``. Use with ``async with``;
    ``folder`` is then what to mount at the sandbox's ports folder."""

    def __init__(self, domains: list[str], log: Callable[[str], None]):
        self.domains, self.log = list(domains), log
        self.folder: Optional[str] = None
        self.server: Optional[asyncio.AbstractServer] = None

    async def __aenter__(self) -> DomainProxy:  # noqa: PYI034
        # Under /tmp, not a possibly long TMPDIR: Unix socket paths are limited to about 107 bytes.
        self.folder = tempfile.mkdtemp(prefix="sp-cap-", dir="/tmp" if os.path.isdir("/tmp") else None)
        path = f"{self.folder}/{PROXY_PORT}.sock"
        self.server = await asyncio.start_unix_server(self._serve, path=path)
        os.chmod(path, 0o600)
        return self

    async def __aexit__(self, *_exc) -> None:
        if self.server:
            self.server.close()
        if self.folder:
            shutil.rmtree(self.folder, ignore_errors=True)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        async def answer(status: str) -> None:
            writer.write(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
            with contextlib.suppress(Exception):
                await writer.drain()
                writer.close()
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), UPSTREAM_TIMEOUT)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, OSError):
            writer.close()
            return
        parts = head[:HEAD_LIMIT].split(b"\r\n", 1)[0].decode("latin-1").split()
        if len(parts) != 3 or parts[0].upper() != "CONNECT":
            await answer("405 Method Not Allowed")
            return
        host, _, port_text = parts[1].rpartition(":")
        host = host.strip("[]")
        port = int(port_text) if port_text.isdigit() else 0
        if port not in ALLOWED_PORTS or not allowed(host, self.domains):
            self.log(f"拦下了访问 {host}:{port}：不在它声明的域名里。")
            await answer("403 Forbidden")
            return
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(self._open(host, port), UPSTREAM_TIMEOUT)
        except (OSError, asyncio.TimeoutError, ConnectionError) as exc:
            self.log(f"连不上 {host}:{port}：{exc}")
            await answer("502 Bad Gateway")
            return
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        await asyncio.gather(_pipe(reader, upstream_writer), _pipe(upstream_reader, writer))

    @staticmethod
    async def _open(host: str, port: int):
        through = _user_proxy(host)
        if not through:
            return await asyncio.open_connection(host, port)
        reader, writer = await asyncio.open_connection(*through)
        writer.write(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
        await writer.drain()
        head = await reader.readuntil(b"\r\n\r\n")
        if b" 200" not in head.split(b"\r\n", 1)[0]:
            writer.close()
            raise ConnectionError(head.split(b"\r\n", 1)[0].decode("latin-1"))
        return reader, writer


def environment_for(folder: Path, data: Path, secrets: dict[str, str], proxied: bool) -> dict[str, str]:
    env = {"PATH": f"{folder}/.venv/bin:/usr/local/bin:/usr/bin:/bin"}
    env.update({name: os.environ[name] for name in settings.sandbox_env if name in os.environ})
    env = environment.command_env(env)
    env.update(HOME="/tmp", TMPDIR="/tmp", LANG="C.UTF-8", PYTHONUNBUFFERED="1",
               SP_CAPABILITY_DIR=str(folder), SP_DATA_DIR=str(data))
    if proxied:
        proxy = f"http://127.0.0.1:{PROXY_PORT}"
        env.update(HTTPS_PROXY=proxy, HTTP_PROXY=proxy, https_proxy=proxy, http_proxy=proxy,
                   ALL_PROXY=proxy, all_proxy=proxy, NO_PROXY="", no_proxy="")
    env.update(secrets)
    return env


def wrap(folder: Path, data: Path, command: str, env: dict[str, str], proxy_dir: Optional[str],
         writable: bool = False) -> list[str]:
    """The bwrap command running ``command`` in ``folder`` (writable only while it is installed)."""
    from .agent import SANDBOX_PORTS_DIR, Workspace, _listen_script, hide_homes

    outer, inner, masked = Workspace(folder)._platform_data()
    # The interpreter its environment was built from, even when it lives in the hidden home.
    python = Path(sys.base_prefix).resolve()
    keep_python = ["--ro-bind", str(python), str(python)] if python != Path("/") else []
    bridge = ["--bind", proxy_dir, SANDBOX_PORTS_DIR] if proxy_dir else []
    return [
        "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", *bridge,
        *hide_homes(), *outer, *keep_python,
        "--bind" if writable else "--ro-bind", str(folder), str(folder), *inner, *masked,
        "--bind", str(data), str(data),
        "--unshare-net", "--unshare-pid", "--die-with-parent", "--new-session",
        "--clearenv", *[arg for name, value in env.items() for arg in ("--setenv", name, value)],
        "--chdir", str(folder), "--", "/bin/bash", "-c",
        _listen_script([PROXY_PORT] if proxy_dir else []) + 'eval "$1"', "bash", command,
    ]


@contextlib.asynccontextmanager
async def launched(folder: Path, data: Path, command: str, *, secrets: Optional[dict[str, str]] = None,
                   domains: Optional[list[str]] = None, log: Callable[[str], None] = lambda _line: None,
                   writable: bool = False, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                   stderr=asyncio.subprocess.STDOUT):
    """Start ``command`` in the sandbox, reaching only ``domains``; yields the process, and stops it
    (all of it) on leaving."""
    data.mkdir(parents=True, exist_ok=True)
    proxy = DomainProxy(domains or [], log) if domains else None
    async with contextlib.AsyncExitStack() as stack:  # contextlib.nullcontext is not async before 3.10
        if proxy:
            await stack.enter_async_context(proxy)
        env = environment_for(folder, data, secrets or {}, bool(proxy))
        process = await asyncio.create_subprocess_exec(
            *wrap(folder, data, command, env, proxy.folder if proxy else None, writable),
            stdin=stdin, stdout=stdout, stderr=stderr, start_new_session=True, limit=1 << 20)
        try:
            yield process
        finally:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except asyncio.TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()


async def run(folder: Path, data: Path, command: str, timeout: float, *, domains: Optional[list[str]] = None,
              writable: bool = False, log: Callable[[str], None] = lambda _line: None) -> tuple[str, bool]:
    """Run a command to its end (building an environment, a check): its output, and whether it passed."""
    with tempfile.TemporaryFile() as captured:
        async with launched(folder, data, command, domains=domains, writable=writable, log=log,
                            stdout=captured, stderr=captured) as process:
            try:
                await asyncio.wait_for(process.wait(), timeout)
                timed_out = False
            except asyncio.TimeoutError:
                timed_out = True
        captured.seek(0)
        output = captured.read().decode(errors="replace").strip()
    if timed_out:
        return f"超过 {timeout:g} 秒没有结束，已停止。\n{output}", False
    return output, process.returncode == 0
