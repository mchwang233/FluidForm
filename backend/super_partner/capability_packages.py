"""Capability packages: uploaded, installed and uninstalled on their own
(docs/design/capability-packages.md).

A package is a zip of one folder with a ``capability.json`` (its manifest), its code, optionally a
``SKILL.md`` and a ``requirements.txt``. Installing unpacks it into
``<tools_dir>/capabilities/<id>/``, builds its Python environment there and runs its check, both in
the capabilities' sandbox (capability_sandbox.py); uninstalling removes it with its data, state and
secrets. Super Partner's source knows nothing of any one package.
"""
from __future__ import annotations

import io
import json
import os
import re
import shlex
import shutil
import sys
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from . import capabilities, capability_sandbox
from . import secrets as secret_store
from .config import settings
from .models import Capability

MANIFEST = "capability.json"
REQUIREMENTS = "requirements.txt"
VENV = ".venv"
MAX_PACKAGE_FILES = 2000
ENV_SECONDS = 900
ID = re.compile(r"[a-z0-9][a-z0-9-]{1,40}")
VARIABLE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,80}")
# Variables the sandbox sets itself; a package cannot ask for them as secrets.
RESERVED = {"PATH", "HOME", "TMPDIR", "LANG", "PYTHONUNBUFFERED", "PYTHONPATH", "PYTHONHOME"}
IGNORED = ("__MACOSX/", ".DS_Store")


class PackageError(ValueError):
    """A package that cannot be installed, and why (shown to the user)."""


def data_folder(capability_id: str) -> Path:
    """The only folder a capability writes, kept out of the steps' sight with Super Partner's data."""
    return Path(settings.data_dir) / "capability-data" / capability_id


def secret_name(capability_id: str, variable: str) -> str:
    return f"capability/{capability_id}/{variable}"


def _members(archive: zipfile.ZipFile) -> tuple[str, list[tuple[zipfile.ZipInfo, PurePosixPath]]]:
    """The folder prefix holding the manifest, and each file under it with its path inside."""
    files = [item for item in archive.infolist()
             if not item.is_dir() and not any(part in item.filename for part in IGNORED)]
    names = {item.filename for item in files}
    prefix = "" if MANIFEST in names else next(
        (name[:-len(MANIFEST)] for name in sorted(names) if name.endswith("/" + MANIFEST) and name.count("/") == 1), None)
    if prefix is None:
        raise PackageError(f"包里没有 {MANIFEST}（放在包的最外层，或唯一的文件夹里）。")
    if len(files) > MAX_PACKAGE_FILES:
        raise PackageError(f"文件太多：超过 {MAX_PACKAGE_FILES} 个。")
    found, size = [], 0
    for item in files:
        if not item.filename.startswith(prefix):
            raise PackageError(f"{item.filename} 不在能力的文件夹里。")
        path = PurePosixPath(item.filename[len(prefix):])
        if "\\" in item.filename or path.is_absolute() or ".." in path.parts or not path.parts:
            raise PackageError(f"不安全的路径：{item.filename}")
        if (item.external_attr >> 16) & 0o170000 == 0o120000:
            raise PackageError(f"包里不能有链接：{item.filename}")
        if path.parts[0] == VENV:
            raise PackageError(f"包里不能带 {VENV}：环境在安装时建。")
        size += item.file_size
        if size > capabilities.MAX_CAPABILITY_BYTES:
            raise PackageError(f"解开后超过 {capabilities.MAX_CAPABILITY_BYTES // 1024 // 1024} MB。")
        found.append((item, path))
    return prefix, found


def _manifest(raw: bytes, files: list[str]) -> Capability:
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise PackageError(f"{MANIFEST} 不是有效的 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise PackageError(f"{MANIFEST} 应该是一个对象。")
    capability_id = str(data.get("id") or "")
    if not ID.fullmatch(capability_id):
        raise PackageError("id 只能用小写字母、数字和 -，2 到 41 个字符。")
    kind = str(data.get("kind") or "tool")
    if kind not in capabilities.KINDS:
        raise PackageError("kind 只能是 tool 或 automation。")
    entry = str(data.get("entry") or "").strip()
    if kind == "automation" and not entry:
        raise PackageError("自动化要写 entry：运行它的命令。")
    secrets = [str(item).strip() for item in data.get("secrets") or []]
    bad = [item for item in secrets if not VARIABLE.fullmatch(item) or item in RESERVED
           or item.startswith(("SP_", "LD_")) or "PROXY" in item.upper()]
    if bad:
        raise PackageError(f"这些密钥名不能用：{'、'.join(bad)}")
    domains = [str(item).strip().lower() for item in data.get("domains") or [] if str(item).strip()]
    if any(not re.fullmatch(r"(\*\.)?[a-z0-9.-]+", item) for item in domains):
        raise PackageError("domains 只能写主机名，或 *.example.com。")
    return Capability(
        id=capability_id, name=str(data.get("name") or capability_id)[:60], kind=kind,
        summary=str(data.get("summary") or "")[:500], usage=str(data.get("usage") or "")[:2000],
        guide=str(data.get("guide") or "")[:capabilities.MAX_GUIDE], check=str(data.get("check") or "")[:500],
        secrets=secrets[:20], domains=domains[:20], files=files[:50], entry=entry[:500],
        version=str(data.get("version") or "")[:40], source="upload", status="disabled")


def read(data: bytes) -> Capability:
    """The package's manifest, after checking the whole package."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise PackageError("不是 zip 文件。") from exc
    with archive:
        prefix, members = _members(archive)
        return _manifest(archive.read(prefix + MANIFEST), sorted({str(path.parts[0]) for _, path in members}))


async def install(data: bytes) -> Capability:
    """Unpack ``data`` as a capability, replacing an older version (its secrets, data and state
    stay), build its environment and check it. It is installed switched off; the caller stops an
    older version that runs."""
    capability = read(data)
    folder = capabilities.root() / capability.id
    if (old := capabilities.load(capability.id)) and old.source != "upload":
        raise PackageError(f"已经有一个叫 {capability.id} 的能力是任务固化的，先删掉它。")
    # Secrets the new version no longer asks for are forgotten.
    for name in set(old.secrets if old else []) - set(capability.secrets):
        secret_store.delete_secret(secret_name(capability.id, name))
    staging = capabilities.root() / f".{capability.id}.{uuid.uuid4().hex[:8]}"
    staging.mkdir(parents=True)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            _prefix, members = _members(archive)
            for item, path in members:
                target = staging.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(item))
        if folder.exists():
            shutil.rmtree(folder)
        staging.rename(folder)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    if not (folder / capabilities.MANUAL).is_file():
        (folder / capabilities.MANUAL).write_text(capabilities.manual(capability))
    capability.guide = capability.guide or (folder / capabilities.MANUAL).read_text()[:capabilities.MAX_GUIDE]
    # Saved before anything in the package runs, and again after: what it may do is decided here.
    capabilities.save(capability)
    output, ok = await build(capability)
    if ok:
        capability = await check(capability)
    else:
        capability.check_ok, capability.check_output = False, output[-capabilities.MAX_CHECK_OUTPUT:]
    capability.status = "failed" if capability.check_ok is False else "disabled"
    capabilities.save(capability)
    return capability


async def build(capability: Capability) -> tuple[str, bool]:
    """Its Python environment, from its requirements.txt, built in the sandbox reaching only the
    package index. Nothing to build without one."""
    folder = capabilities.root() / capability.id
    if not (folder / REQUIREMENTS).is_file():
        return "", True
    if reason := capability_sandbox.missing():
        return reason, False
    python = shlex.quote(os.path.realpath(sys.executable))
    command = (f"{python} -m venv {VENV} && {VENV}/bin/python -m pip install --disable-pip-version-check "
               f"--no-input -q -r {REQUIREMENTS}")
    output, ok = await capability_sandbox.run(folder, data_folder(capability.id), command, ENV_SECONDS,
                                              domains=capability_sandbox.index_hosts(), writable=True)
    return ("装依赖失败：\n" + output if not ok else output), ok


async def check(capability: Capability) -> Capability:
    """Its check, in its folder, without network."""
    if not capability.check:
        capability.check_ok, capability.check_output = None, "没有检查命令。"
        return capability
    if reason := capability_sandbox.missing():
        capability.check_ok, capability.check_output = False, reason
        return capability
    output, ok = await capability_sandbox.run(capabilities.root() / capability.id, data_folder(capability.id),
                                              capability.check, capabilities.CHECK_SECONDS)
    capability.check_ok, capability.check_output = ok, output[-capabilities.MAX_CHECK_OUTPUT:]
    return capability


def secrets_set(capability: Capability) -> dict[str, bool]:
    """Which of its secrets are stored."""
    return {name: bool(secret_store.get_secret(secret_name(capability.id, name))) for name in capability.secrets}


def secrets_for(capability: Capability) -> dict[str, str]:
    values = {name: secret_store.get_secret(secret_name(capability.id, name)) for name in capability.secrets}
    return {name: value for name, value in values.items() if value}


def uninstall(capability: Capability) -> None:
    """Remove it, its data and its secrets; the caller stops it first and forgets its state."""
    for name in capability.secrets:
        secret_store.delete_secret(secret_name(capability.id, name))
    shutil.rmtree(data_folder(capability.id), ignore_errors=True)
    capabilities.remove(capability.id)
