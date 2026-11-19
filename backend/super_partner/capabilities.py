"""Capabilities: what a finished task leaves the platform able to do (docs/design/capabilities.md).

A task's lead proposes them when it succeeds (``ask``); the user solidifies one (``solidify``):
its files are copied into ``<tools_dir>/capabilities/<id>/`` with a ``capability.json``, and its
check runs in a step's sandbox. Active tools are told to every later step and planner
(``section``); ``tools_dir`` is readable from the steps' sandbox."""
from __future__ import annotations

import json
import logging
import re
import shutil
from pathlib import Path
from typing import Optional

from . import environment, folders
from .models import Capability, CapabilityCard, CapabilityProposal, ExecutionRun

log = logging.getLogger(__name__)

KINDS = {"tool", "automation"}
MAX_PROPOSALS = 3
# What one capability may copy from its task's folder.
MAX_CAPABILITY_BYTES = 20 * 1024 * 1024
CHECK_SECONDS = 60
# Characters of a capability's manual.
MAX_GUIDE = 6000
MANUAL = "SKILL.md"
# Characters of a check's output kept with the capability.
MAX_CHECK_OUTPUT = 4000

PROMPT = (
    "The task is finished. Did it build something reusable beyond this task: a tool that later "
    "tasks or chats could run (a command-line program, a script, a client for a service), or an "
    "automation that should keep running (replying to messages, a scheduled job)? Only something "
    "that works on its own and would be useful again, not the task's product itself (a report, a "
    "web page, a design). Most tasks build none.\n"
    "Reply with JSON only, no fences: {\"capabilities\": []} or\n"
    "{\"capabilities\": [{\"name\": \"short name in the user's language\", \"kind\": \"tool | automation\", "
    "\"summary\": \"what it does, one sentence\", \"usage\": \"how to run it from its folder: the command "
    "and its arguments\", \"guide\": \"its manual for whoever uses it next, a few short Markdown lines: inputs, "
    "outputs, limits, common mistakes\", \"files\": [\"paths relative to the task's folder that make it up: its "
    "code and what the code needs\"], "
    "\"check\": \"a command, run in its folder, that shows it works without side effects or network\", "
    "\"secrets\": [\"environment variables it needs\"], \"domains\": [\"hosts it must reach\"]}]}\n"
    f"At most {MAX_PROPOSALS}."
)


def root() -> Path:
    return environment.tools_dir() / "capabilities"


def read_cards(text: str) -> list[CapabilityProposal]:
    """The lead's cards, cleaned; [] for anything unreadable."""
    start, end = (text or "").find("{"), (text or "").rfind("}")
    try:
        payload = json.loads(text[start:end + 1]) if start >= 0 < end else {}
    except ValueError:
        return []
    cards = []
    for item in (payload.get("capabilities") if isinstance(payload, dict) else None) or []:
        if not isinstance(item, dict) or not str(item.get("name") or "").strip():
            continue
        files = [str(path).strip() for path in item.get("files") or [] if str(path).strip()]
        if not files:
            continue
        kind = str(item.get("kind") or "tool").split("|")[0].strip()
        cards.append(CapabilityProposal(
            name=str(item["name"]).strip()[:60], kind=kind if kind in KINDS else "tool",
            summary=str(item.get("summary") or "").strip()[:500], usage=str(item.get("usage") or "").strip()[:2000],
            guide=str(item.get("guide") or "").strip()[:MAX_GUIDE],
            files=files[:50], check=str(item.get("check") or "").strip()[:500],
            secrets=[str(name).strip()[:80] for name in item.get("secrets") or [] if str(name).strip()][:10],
            domains=[str(host).strip()[:200] for host in item.get("domains") or [] if str(host).strip()][:10]))
    return cards[:MAX_PROPOSALS]


def task_folder(run: ExecutionRun) -> Path:
    from .config import settings
    return Path(run.project_dir) if run.project_dir else settings.workspace_root / run.folder_id


def _sources(folder: Path, files: list[str]) -> list[tuple[Path, Path]]:
    """(source, relative path) of each listed file or folder, all inside ``folder``."""
    base, found, size = folder.resolve(), [], 0
    for name in files:
        source = (base / name).resolve()
        if not source.is_relative_to(base) or source == base or not source.exists():
            raise ValueError(f"不在任务目录里或不存在：{name}")
        for item in [source] if source.is_file() else [p for p in source.rglob("*") if p.is_file()]:
            size += item.stat().st_size
            if size > MAX_CAPABILITY_BYTES:
                raise ValueError(f"文件太大：超过 {MAX_CAPABILITY_BYTES // 1024 // 1024} MB")
        found.append((source, source.relative_to(base)))
    return found


def _unique_id(name: str) -> str:
    base = folders.slug(re.sub(r"[^\w\s-]", " ", name), "capability")
    candidate, number = base, 2
    while (root() / candidate).exists():
        candidate, number = f"{base}-{number}", number + 1
    return candidate


def save(capability: Capability) -> None:
    folder = root() / capability.id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "capability.json").write_text(capability.model_dump_json(indent=2))


def load(capability_id: str) -> Optional[Capability]:
    path = root() / capability_id / "capability.json"
    if not re.fullmatch(r"[\w-]+", capability_id or "") or not path.is_file():
        return None
    try:
        return Capability.model_validate_json(path.read_text())
    except ValueError:
        log.warning("unreadable capability %s", capability_id)
        return None


def library() -> list[Capability]:
    """Every capability on this machine, newest first."""
    if not root().is_dir():
        return []
    found = [item for path in root().iterdir() if path.is_dir() and (item := load(path.name))]
    return sorted(found, key=lambda item: item.created_at, reverse=True)


def remove(capability_id: str) -> bool:
    if not load(capability_id):
        return False
    shutil.rmtree(root() / capability_id)
    return True


async def check(capability: Capability) -> Capability:
    """Run its check in a step's sandbox, without network, in its folder."""
    from .agent import Workspace, sandbox_available
    if not capability.check:
        capability.check_ok, capability.check_output = None, "没有检查命令。"
        return capability
    if not sandbox_available():
        capability.check_ok, capability.check_output = False, "这台机器没有步骤沙箱（bwrap），检查没有运行。"
        return capability
    output, ok = await Workspace(root() / capability.id, network=False).run(
        "Bash", {"command": capability.check, "timeout": CHECK_SECONDS * 1000})  # the tool counts milliseconds
    capability.check_ok, capability.check_output = ok, output[-MAX_CHECK_OUTPUT:]
    return capability


async def solidify(run: ExecutionRun, card: CapabilityCard) -> Capability:
    """Copy ``card``'s files from ``run``'s folder into a capability of its own and check it.
    Raises ValueError for files outside the task's folder or too large."""
    sources = _sources(task_folder(run), card.files)
    capability = Capability(**card.model_dump(include=set(CapabilityCard.model_fields)), id=_unique_id(card.name),
                            source_run_id=run.id)
    folder = root() / capability.id
    folder.mkdir(parents=True)
    for source, relative in sources:
        target = folder / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True, symlinks=True)
        else:
            shutil.copy2(source, target)
    (folder / MANUAL).write_text(manual(capability))
    capability = await check(capability)
    capability.status = "failed" if capability.check_ok is False else "active"
    save(capability)
    return capability


def manual(capability: Capability) -> str:
    """Its SKILL.md: the code beside it, and how to use it, in the skills' own format (skills.py)."""
    def section(title: str, lines: list[str]) -> list[str]:
        return [f"## {title}", *lines, ""] if lines else []
    return "\n".join([
        "---", f"name: {capability.id}", f"description: {capability.summary or capability.name}", "---", "",
        f"# {capability.name}", "", capability.summary, "",
        *section("用法", [f"Run from this folder: `{capability.usage}`"] if capability.usage else []),
        *section("说明", [capability.guide] if capability.guide else []),
        *section("代码", [f"- `{name}`" for name in capability.files]),
        *section("检查", [f"`{capability.check}`"] if capability.check else []),
        *section("需要", [f"- 环境变量 `{name}`" for name in capability.secrets] + [f"- 访问 `{host}`" for host in capability.domains]),
    ]).rstrip() + "\n"


def section(capabilities: Optional[list[Capability]] = None) -> str:
    """What steps and planners are told: the active tools on this machine, and how to run them."""
    tools = [item for item in (library() if capabilities is None else capabilities)
             if item.kind == "tool" and item.status == "active"]
    if not tools:
        return ""
    lines = [("Tools on this machine that earlier tasks built; use one instead of building it again "
              "(run it from its folder; it is read-only, copy it to change it):")]
    for item in tools:
        needs = f" Needs environment variables: {', '.join(item.secrets)}." if item.secrets else ""
        if (root() / item.id / ".venv").is_dir():
            needs += f" Run its Python code with {root() / item.id / '.venv/bin/python'}, which has its packages."
        lines.append(f"- {item.name} ({root() / item.id}): {item.summary} Usage: {item.usage}{needs} "
                     f"Read its {MANUAL} there first.")
    return "\n".join(lines)
