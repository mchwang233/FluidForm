"""Runs enabled automation packages in the background (docs/design/capability-packages.md).

Each automation is its package's ``entry`` command, run in the capabilities' sandbox
(capability_sandbox.py), speaking JSON lines:

- it writes ``{"op": "status", "text": ...}`` (how it is doing, shown to the user), and
  ``{"op": "message", "id": ..., "conversation": ..., "text": ..., "origin": {...}}`` when someone
  asks it something;
- it reads ``{"re": id, "reply": ...}``, the answer, and ``{"event": "task_ended", "origin": {...},
  "text": ...}`` when a task it asked for ends.

What a message becomes (a chat's answer, or a task waiting for the owner's confirmation) is decided
by ``handle`` (api.py). This module keeps each automation running (a crash is restarted, a few times),
its log, its daily budget and its state, which it keeps out of the automation's reach.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import deque
from collections.abc import Awaitable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from . import capabilities, capability_packages, capability_sandbox
from .config import settings
from .models import Capability

log = logging.getLogger(__name__)

# Restarted after a crash at most this many times in a row; running this long resets the count.
MAX_RESTARTS = 5
RESTART_PAUSE = 10.0
STABLE_SECONDS = 120.0
LOG_LINES = 200
MAX_TEXT = 20_000
# How long a line from an automation may be.
LINE_LIMIT = 1 << 20


def today() -> str:
    """The automation's day, on this machine's clock: its budget starts again at midnight."""
    return datetime.now().astimezone().date().isoformat()


def state_path(capability_id: str) -> Path:
    return Path(settings.data_dir) / "capability-host" / f"{capability_id}.json"


@dataclass
class Asked:
    """Something someone asked an automation."""
    conversation: str
    text: str
    origin: dict = field(default_factory=dict)


class Fatal(Exception):
    """Why an automation cannot run until the user changes something."""


class Automation:
    """One automation: its process, state, log and budget."""

    def __init__(self, capability_id: str):
        self.id = capability_id
        self.state = {"daily_budget_usd": settings.capability_daily_budget_usd, "spent": {}, "notified": "",
                      "chats": {}, "handled": 0}
        with contextlib.suppress(OSError, ValueError):
            self.state.update(json.loads(state_path(capability_id).read_text()))
        self.status, self.text, self.error = "off", "", ""
        self.log: deque[str] = deque(maxlen=LOG_LINES)
        self.task: Optional[asyncio.Task] = None
        self.process: Optional[asyncio.subprocess.Process] = None
        # Made on the service's loop when first needed (the API may create this in a worker thread).
        self._lock: Optional[asyncio.Lock] = None

    @property
    def lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def note(self, line: str) -> None:
        self.log.append(f"{time.strftime('%H:%M:%S')} {line.rstrip()[:2000]}")

    def save(self) -> None:
        state_path(self.id).parent.mkdir(parents=True, exist_ok=True)
        state_path(self.id).write_text(json.dumps(self.state, ensure_ascii=False, indent=1))

    def spent_today(self) -> float:
        return float(self.state["spent"].get(today(), 0.0))

    def spend(self, amount: float) -> None:
        if amount > 0:
            self.state["spent"] = {today(): round(self.spent_today() + amount, 6)}  # only today's is kept

    def remaining(self) -> float:
        return max(0.0, float(self.state["daily_budget_usd"]) - self.spent_today())

    def public(self) -> dict:
        return {"status": self.status, "text": self.text, "error": self.error, "log": list(self.log)[-80:],
                "daily_budget_usd": float(self.state["daily_budget_usd"]), "spent_today_usd": self.spent_today(),
                "handled": int(self.state.get("handled", 0)), "conversations": len(self.state["chats"])}


class Runner:
    def __init__(self, handle: Callable[[Capability, Asked, Automation], Awaitable[tuple[Optional[str], float]]]):
        self.handle = handle
        self.automations: dict[str, Automation] = {}

    def get(self, capability_id: str) -> Automation:
        if capability_id not in self.automations:
            self.automations[capability_id] = Automation(capability_id)
        return self.automations[capability_id]

    def running(self, capability_id: str) -> bool:
        item = self.automations.get(capability_id)
        return bool(item and item.task and not item.task.done())

    def start(self, capability: Capability) -> None:
        item = self.get(capability.id)
        if not self.running(capability.id):
            item.status, item.error = "starting", ""
            item.task = asyncio.get_running_loop().create_task(self._supervise(item, capability))

    async def stop(self, capability_id: str) -> None:
        item = self.automations.get(capability_id)
        if item and item.task and not item.task.done():
            item.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await item.task
        if item:
            item.status, item.text = "off", ""

    async def restart(self, capability: Capability) -> None:
        if self.running(capability.id):
            await self.stop(capability.id)
            self.start(capability)

    async def stop_all(self) -> None:
        for capability_id in list(self.automations):
            await self.stop(capability_id)

    def forget(self, capability_id: str) -> None:
        """Its state, when it is uninstalled (stop it first)."""
        self.automations.pop(capability_id, None)
        state_path(capability_id).unlink(missing_ok=True)

    def notify(self, capability_id: str, event: dict) -> None:
        if item := self.automations.get(capability_id):
            asyncio.get_running_loop().create_task(self._send(item, event))

    # ---- one automation's process ----
    async def _supervise(self, item: Automation, capability: Capability) -> None:
        loop, restarts = asyncio.get_running_loop(), 0
        while True:
            started = loop.time()
            try:
                await self._run_once(item, capability)
            except asyncio.CancelledError:
                item.status = "off"
                raise
            except Fatal as exc:
                item.status, item.error = "error", str(exc)
                item.note(str(exc))
                return
            except Exception as exc:
                log.exception("automation %s failed", capability.id)
                item.note(f"出错：{exc}")
            restarts = 0 if loop.time() - started > STABLE_SECONDS else restarts + 1
            if restarts >= MAX_RESTARTS:
                item.status = "error"
                item.error = f"连续退出了 {MAX_RESTARTS} 次，已停下，看看日志；改好后停用再启用。"
                return
            item.status = "restarting"
            await asyncio.sleep(RESTART_PAUSE)

    async def _run_once(self, item: Automation, capability: Capability) -> None:
        if reason := capability_sandbox.missing():
            raise Fatal(reason)
        secrets = capability_packages.secrets_for(capability)
        if lacking := [name for name in capability.secrets if name not in secrets]:
            raise Fatal(f"还没填：{'、'.join(lacking)}")
        folder = capabilities.root() / capability.id
        item.text = ""
        item.note("启动")
        async with capability_sandbox.launched(
                folder, capability_packages.data_folder(capability.id), capability.entry, secrets=secrets,
                domains=capability.domains, log=item.note, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE) as process:
            item.process, item.status, item.error = process, "running", ""
            try:
                await asyncio.gather(self._read(item, capability, process.stdout, True),
                                     self._read(item, capability, process.stderr, False), process.wait())
            finally:
                item.process = None
        item.note(f"进程退出了（返回 {process.returncode}）")
        item.status = "restarting"

    async def _read(self, item: Automation, capability: Capability, stream: asyncio.StreamReader, talks: bool) -> None:
        while True:
            try:
                line = await stream.readline()
            except ValueError:  # longer than LINE_LIMIT
                item.note("一行输出太长，丢掉了。")
                continue
            if not line:
                return
            text = line.decode(errors="replace").rstrip("\n")
            try:
                payload = json.loads(text) if talks and text.startswith("{") else None
            except ValueError:
                payload = None
            if not isinstance(payload, dict):
                if text.strip():
                    item.note(text)
                continue
            op = payload.get("op")
            if op == "status":
                item.text = str(payload.get("text") or "")[:200]
                item.note(f"状态：{item.text}")
            elif op == "message":
                asyncio.get_running_loop().create_task(self._ask(item, capability, payload))
            elif op == "log":
                item.note(str(payload.get("text") or ""))
            else:
                item.note(f"看不懂的消息：{text[:200]}")

    async def _ask(self, item: Automation, capability: Capability, payload: dict) -> None:
        request = payload.get("id")
        text = str(payload.get("text") or "").strip()[:MAX_TEXT]
        if not text:
            await self._send(item, {"re": request, "reply": None})
            return
        asked = Asked(conversation=str(payload.get("conversation") or "")[:200], text=text,
                      origin=payload.get("origin") if isinstance(payload.get("origin"), dict) else {})
        async with item.lock:
            if item.remaining() <= 0:
                notice = None
                if item.state.get("notified") != today():
                    item.state["notified"] = today()
                    item.save()
                    notice = (f"今天的额度（${float(item.state['daily_budget_usd']):g}）用完了，明天再来；"
                              "也可以请主人在若水里调高。")
                await self._send(item, {"re": request, "reply": notice, "over_budget": True})
                return
        try:
            reply, cost = await self.handle(capability, asked, item)
        except Exception as exc:
            log.exception("a message to %s failed", capability.id)
            reply, cost = f"这条没能处理：{str(exc)[:200]}", 0.0
        item.spend(cost)
        item.state["handled"] = int(item.state.get("handled", 0)) + 1
        item.save()
        await self._send(item, {"re": request, "reply": reply})

    @staticmethod
    async def _send(item: Automation, payload: dict) -> None:
        process = item.process
        if not process or not process.stdin or process.returncode is not None:
            item.note("它没在运行，一条消息没送到。")
            return
        try:
            process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())
            await process.stdin.drain()
        except (OSError, ConnectionError) as exc:
            item.note(f"送不到：{exc}")
