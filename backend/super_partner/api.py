from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import attachments as files
from . import (
    briefing,
    capabilities,
    capability_packages,
    capability_runner,
    capability_sandbox,
    cli_quota,
    folders,
    learning,
    publish,
    retrospect,
    skills,
    streaming,
    supervisor,
    team,
    triage,
)
from . import diagnosis as diagnosis_module
from . import secrets as secret_store
from .benchmarks import BenchmarkCatalog
from .catalog_sync import CatalogSync, seed_catalog
from .config import settings
from .contracts import ContractError
from .db import Database
from .executor import Executor
from .models import (
    FINISHED,
    Attachment,
    Capability,
    DiagnosisMessage,
    Event,
    ExecutionRun,
    LearningSettings,
    ModelProfile,
    NodeStatus,
    RunStatus,
    SupervisorSession,
    TaskPlan,
)
from .outline import INTERNET_NOTE
from .planner import autonomous_plan
from .projects import (
    NativePickerError,
    ProjectDirError,
    discover_projects,
    inspect_project,
    native_pick_directory,
    native_picker_status,
    project_context,
    resolve_project_dir,
)
from .providers import ProviderError, ProviderRegistry
from .routing import (
    NoEligibleModelError,
    brief_writer,
    eligible_for_node,
    estimate,
    fit_and_route,
    part_estimate,
    route_node,
)
from .scoring import AA_SOURCE, rescore
from .secrets import (
    PROVIDER_ENV,
    SECRET_ENV,
    configured_providers,
    delete_provider_key,
    hydrate_provider_keys,
    keep_loading_keys,
    keyring_unavailable,
    set_provider_key,
)


class CreateTask(BaseModel):
    prompt: str = Field(min_length=3)
    attachments: list[str] = Field(default_factory=list)
    budget_usd: float = Field(default=2, gt=0, le=10_000)
    use_cli: bool = True
    project_dir: Optional[str] = Field(default=None, max_length=4096)
    # Let the task's commands reach the internet (never this machine's local services).
    allow_network: bool = False


class NetworkAccess(BaseModel):
    allow: bool


class LeadQuestion(BaseModel):
    message: str = Field(default="", max_length=20_000)
    attachments: list[str] = Field(default_factory=list)


class ConfirmTask(BaseModel):
    budget_usd: Optional[float] = Field(default=None, gt=0, le=10_000)


class DiagnosisReply(BaseModel):
    text: str = Field(default="", max_length=6000)
    choice: Optional[str] = Field(default=None, max_length=300)
    attachments: list[str] = Field(default_factory=list)


class ProviderKey(BaseModel):
    api_key: str = Field(min_length=8)


class UpdateModel(BaseModel):
    enabled: bool


class UpdateModelById(UpdateModel):
    model_id: str


settings.prepare()
db = Database(settings.db_path)
models = seed_catalog(db)
hydrate_provider_keys()
providers = ProviderRegistry(db, models)
executor = Executor(db, providers, models)
benchmarks = BenchmarkCatalog(db)
rescore(models, benchmarks, db)
catalog_sync = CatalogSync(
    db, models, auto_sync=settings.catalog_auto_sync,
    interval_hours=settings.catalog_sync_interval_hours,
    benchmarks=benchmarks,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.interrupt_model_calls()
    catalog_sync.start()
    for run in db.list_runs():
        # An interrupted run may have left a project half-edited; resume only once confirmed.
        if run.status in {RunStatus.QUEUED, RunStatus.RUNNING}:
            run.status = RunStatus.PAUSED
            db.save_run(run)
            db.add_event(Event(run_id=run.id, kind="approval.required", data={"reason": "interrupted"}))
        if run.lead_thinking:
            # The restart cut the lead off mid-decision.
            run.lead_thinking = None
            db.save_run(run)
        interrupted = [item for item in run.diagnoses if item.status == "running"]
        for item in interrupted:
            item.status, item.error = "failed", "服务重启打断了诊断。"
        if interrupted:
            db.save_run(run)
    executor.restore_platform()
    executor.restore_engineer()
    executor.restore_learning()
    # Automation packages, when switched on: tasks asked for through them hear how they ended.
    executor.end_listeners.append(automation_task_ended)
    start_automations()
    # Keys saved in a keyring that was locked at startup: load them once it is unlocked.
    keys = asyncio.create_task(keep_loading_keys(
        lambda loaded: [providers.quota.clear_provider(item) for item in loaded]))
    # Membership CLIs priced by their subscription: refresh their price and quota pressure.
    usage = asyncio.create_task(cli_quota.keep_applying(models, providers.quota))
    try:
        yield
    finally:
        keys.cancel()
        usage.cancel()
        await runner.stop_all()
        await executor.shutdown()
        await catalog_sync.close()
        await providers.client.aclose()


app = FastAPI(title="FluidForm", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=settings.allowed_origins,
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _host_name(host: str) -> str:
    if host.startswith("["):
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


@app.middleware("http")
async def local_only(request: Request, call_next):
    """Refuse rebinding hosts and cross-site writes; the API can drive agents on local files."""
    if _host_name(request.headers.get("host", "")).lower() not in settings.allowed_hosts:
        return JSONResponse({"detail": "Host not allowed"}, status_code=403)
    origin = request.headers.get("origin")
    if request.method not in SAFE_METHODS and origin and origin not in settings.allowed_origins:
        return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
    current_executor = executor
    mutation = request.method not in SAFE_METHODS
    if mutation and current_executor.platform_pending and not request.url.path.endswith(("/cancel", "/pause")):
        return JSONResponse({"detail": "FluidForm 正在应用已验证的修复，请稍后重试；现有任务会自动继续。"},
                            status_code=503, headers={"Retry-After": "2"})
    if mutation:
        current_executor.active_requests += 1
    try:
        return await call_next(request)
    finally:
        if mutation:
            current_executor.active_requests -= 1


@app.get("/health")
def health():
    return {
        "status": "ok", "pid": os.getpid(), "configured_providers": configured_providers() + ["mock"],
        "keyring_unavailable": keyring_unavailable(),
        "available_cli_channels": sorted(providers.cli.available_model_ids()),
        "exhausted_models": providers.quota.public(),
    }


@app.get("/api/models/quota")
def model_quota():
    """Models out of quota and when they come back; routing skips them until then."""
    return providers.quota.public()


@app.get("/api/recovery")
def shared_recovery():
    """Auditable shared recoveries reused by all projects, including after a restart."""
    return {"models": providers.quota.public(), "rules": providers.quota.rules,
            "shared_repairs": db.shared_repairs(),
            "platform_repair": {"enabled": settings.platform_self_repair,
                                "source_available": executor.platform.root is not None,
                                "pending": executor.platform_pending.get("id") if executor.platform_pending else None}}


@app.delete("/api/models/quota/{model_id}")
def reset_model_quota(model_id: str):
    """The user knows the quota is back (or topped up the account): use the model again."""
    providers.quota.clear(model_id)
    return providers.quota.public()


class EngineerRequest(BaseModel):
    request: str = Field(min_length=1, max_length=20_000)
    kind: str = Field(default="component", pattern="^(repair|component)$")
    budget_usd: Optional[float] = Field(default=None, ge=0, le=100)
    # Go on with this conversation (engineer.thread_of); a new one when empty.
    thread_id: Optional[str] = Field(default=None, max_length=200)
    attachments: list[str] = Field(default_factory=list)


class EngineerReply(BaseModel):
    text: str = Field(default="", max_length=20_000)
    choice: Optional[str] = Field(default=None, max_length=300)
    attachments: list[str] = Field(default_factory=list)


def _attached(ids: list[str]) -> list[Attachment]:
    """The files sent with a message, or 422 when one is gone or there are too many."""
    try:
        return files.resolve(ids)
    except files.AttachmentError as exc:
        raise HTTPException(422, str(exc)) from exc


def _engineer(action):
    from .engineer import EngineerError

    try:
        return action()
    except EngineerError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/engineer")
def engineer_overview(run_id: Optional[str] = None):
    """The platform engineer (engineer.py): its jobs, newest first, and what it is working on;
    with ``run_id``, only the jobs of that task."""
    return executor.engineer_overview(run_id=run_id)


@app.post("/api/tasks/{run_id}/engineer", status_code=201)
async def engineer_join(run_id: str, body: EngineerRequest):
    """The user brings the platform engineer into the task's conversation with its lead."""
    get_task(run_id)
    job, problem = executor.engineer_join(run_id, {"request": body.request, "kind": body.kind}, "user",
                                          attachments=_attached(body.attachments))
    if not job:
        raise HTTPException(409, problem)
    return job


@app.post("/api/engineer/jobs", status_code=201)
async def engineer_request(body: EngineerRequest):
    """Ask the platform engineer for a repair (applied once checked) or a component (planned
    first; applied once the user approves the checked change)."""
    attached = _attached(body.attachments)
    return _engineer(lambda: executor.engineer_request(body.request, body.kind, budget_usd=body.budget_usd,
                                                       thread_id=body.thread_id, attachments=attached))


@app.get("/api/engineer/jobs/{job_id}/activity")
def engineer_activity(job_id: str, limit: int = 200):
    """What the platform engineer's job is doing right now (activity.py, as a step's page shows):
    its model's commands, file changes and messages, and the platform's checks; empty when idle."""
    if not db.get_engineer_job(job_id):
        raise HTTPException(404, "找不到这项平台工程师工作。")
    calls = list(executor.engineer_logs.get(job_id) or [])
    return {"running": job_id in executor.engineer_logs, "total": len(calls), "calls": calls[-max(1, min(limit, 400)):]}


@app.post("/api/engineer/jobs/{job_id}/reply")
async def engineer_reply(job_id: str, body: EngineerReply):
    attached = _attached(body.attachments)
    return _engineer(lambda: executor.engineer_reply(job_id, body.text, body.choice, attached))


@app.post("/api/engineer/jobs/{job_id}/approve")
async def engineer_approve(job_id: str):
    """Approve the plan (the engineer then makes the change) or the checked change (applied)."""
    return _engineer(lambda: executor.engineer_approve(job_id))


@app.post("/api/engineer/jobs/{job_id}/reject")
async def engineer_reject(job_id: str):
    from .engineer import EngineerError

    try:
        return await executor.engineer_reject(job_id)
    except EngineerError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/channels/cli")
def list_cli_channels(refresh: bool = False):
    statuses = providers.cli.refresh() if refresh else providers.cli.statuses
    return [status.public() for status in statuses.values()]


# The 模型 page's totals: calls and spend per model over this many days.
USAGE_DAYS = 30
USAGE_RUNS = 3


@app.get("/api/models/usage")
def models_usage(days: int = USAGE_DAYS):
    """Per model, over the last ``days``: how many calls it took, what they cost, and the tasks
    and chats it worked on most (their names), from the recorded model calls (calls.py). A call
    that only handed work to another model is counted once, as that model's."""
    days = max(1, min(days, 366))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    totals: dict[str, dict] = {}
    for call in db.model_calls_since(since):
        if call.get("delegated") or not call.get("model_id"):
            continue
        entry = totals.setdefault(call["model_id"], {"calls": 0, "cost_usd": 0.0, "runs": {}})
        entry["calls"] += 1
        entry["cost_usd"] += float(call.get("cost_usd") or 0)
        if call.get("run_id"):
            entry["runs"][call["run_id"]] = entry["runs"].get(call["run_id"], 0) + 1
    names = {}
    for entry in totals.values():
        busiest = sorted(entry["runs"].items(), key=lambda item: -item[1])[:USAGE_RUNS]
        used_in = []
        for run_id, calls in busiest:
            if run_id not in names:
                run = db.get_run(run_id)
                names[run_id] = (run.plan.title or run.plan.summary, run.kind) if run else None
            if names[run_id]:
                used_in.append({"id": run_id, "title": names[run_id][0], "kind": names[run_id][1], "calls": calls})
        entry.update(cost_usd=round(entry["cost_usd"], 6), runs=used_in, run_count=len(entry["runs"]))
    return {"days": days, "since": since, "models": totals}


@app.get("/api/models")
async def list_models():
    # Only models with Artificial Analysis results (CLIs inherit them) are shown and routed.
    configured = providers.configured_models(list(models))
    benchmark_matches = benchmarks.match_models(list(models.values()))
    return [
        {
            **model.model_dump(), "configured": model.id in configured,
            "routing_ready": model.routing_ready,
            "benchmarks": benchmark_matches.get(model.id, []),
            "auth_type": (
                providers.cli.statuses[model.id].auth_type if model.channel == "cli" else "api_key"
            ),
        }
        for model in models.values() if model.scores_source == AA_SOURCE
    ]


@app.get("/api/models/sync")
async def catalog_status():
    return catalog_sync.status()


@app.post("/api/models/sync", status_code=202)
async def refresh_catalog():
    catalog_sync.trigger()
    return catalog_sync.status()


@app.patch("/api/models/{model_id}")
async def update_model(model_id: str, body: UpdateModel):
    model = models.get(model_id)
    if not model:
        raise HTTPException(404, "Model not found")
    if body.enabled and not model.routing_ready:
        raise HTTPException(422, "模型尚缺少调度所需的评分、规格或价格，或已被来源标记为不可用。")
    model.enabled = body.enabled
    db.save_models([model])
    return {"id": model.id, "enabled": model.enabled}


@app.patch("/api/models")
async def update_model_by_id(body: UpdateModelById):
    return await update_model(body.model_id, body)


@app.put("/api/providers/{provider}/key")
def store_provider_key(provider: str, body: ProviderKey):
    try:
        stored = set_provider_key(provider, body.api_key)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    providers.quota.clear_provider(provider)
    return {"stored": stored}


@app.get("/api/providers")
def list_providers():
    configured = set(configured_providers())
    locked = keyring_unavailable()
    labels = {
        "openai": "OpenAI", "anthropic": "Anthropic Claude", "google": "Google Gemini",
        "deepseek": "DeepSeek", "qwen": "通义千问", "doubao": "豆包",
        "glm": "智谱 GLM", "minimax": "MiniMax", "kimi": "Kimi（月之暗面）",
    }
    return [
        {"id": provider, "name": labels[provider], "configured": provider in configured,
         # Its key may be saved in the keyring, which is locked: it loads once unlocked.
         "keyring_locked": provider not in configured and locked}
        for provider in PROVIDER_ENV
    ]


@app.delete("/api/providers/{provider}/key")
def remove_provider_key(provider: str):
    try:
        removed = delete_provider_key(provider)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"removed": removed}


@app.post("/api/providers/{provider}/test")
async def test_provider(provider: str):
    try:
        message = await providers.test_provider(provider)
        return {"ok": True, "message": message}
    except ProviderError as exc:
        raise HTTPException(400, str(exc)) from exc


# Walking the home directory takes up to a few seconds, so reuse a recent scan.
DISCOVERY_TTL = 60.0
_discovery: dict = {"at": 0.0, "result": None}


@app.get("/api/projects/discover")
def discover_project_dirs(refresh: bool = False):
    now = time.monotonic()
    if refresh or _discovery["result"] is None or now - _discovery["at"] > DISCOVERY_TTL:
        _discovery.update(at=now, result=discover_projects())
    return _discovery["result"]


@app.get("/api/projects/inspect")
def inspect_project_dir(path: str):
    try:
        return inspect_project(path)
    except ProjectDirError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/projects/native-picker")
def native_picker():
    return native_picker_status()


@app.post("/api/projects/native-picker")
async def open_native_picker(start: Optional[str] = None):
    """Open the desktop folder dialog on the machine running this API."""
    try:
        path = await native_pick_directory(start)
    except NativePickerError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ProjectDirError as exc:
        raise HTTPException(400, str(exc)) from exc
    except asyncio.TimeoutError as exc:
        raise HTTPException(408, "The folder dialog timed out") from exc
    return {"path": str(path) if path else None}


@app.post("/api/attachments", response_model=Attachment, status_code=201)
async def upload_attachment(request: Request, name: str = "attachment"):
    """Raw file body; the name comes in the query so no multipart parser is needed."""
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > files.MAX_ATTACHMENT_BYTES:
            raise HTTPException(413, f"单个附件不能超过 {files.MAX_ATTACHMENT_BYTES // 1024 // 1024} MB。")
    try:
        return await asyncio.to_thread(files.save, name, bytes(data))
    except files.AttachmentError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/attachments/{attachment_id}/content")
def attachment_content(attachment_id: str):
    item = files.get(attachment_id)
    if not item:
        raise HTTPException(404, "附件不存在")
    # Only detected raster images are shown inline; everything else downloads as plain bytes.
    inline = item.kind == "image"
    return FileResponse(
        files.path(item), media_type=item.media_type if inline else "application/octet-stream",
        filename=item.name, content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"},
    )


@app.delete("/api/attachments/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: str):
    """Discard an upload removed from the composer before the task was created."""
    if any(item.id == attachment_id for run in db.list_runs() for item in run.attachments):
        raise HTTPException(409, "附件属于已创建的任务，随任务一起删除。")
    if any(item.id == attachment_id for job in db.engineer_jobs(1000) for item in job.attachments):
        raise HTTPException(409, "附件已发给平台工程师。")
    if not files.delete(attachment_id):
        raise HTTPException(404, "附件不存在")


@app.post("/api/tasks", response_model=ExecutionRun, status_code=201)
async def create_task(body: CreateTask):
    return await _new_task(body)


async def _new_task(body: CreateTask, parent: Optional[ExecutionRun] = None) -> ExecutionRun:
    """Plan, route and save a task awaiting confirmation. With ``parent`` it is a requirement
    change that continues that task in its folder (see follow_up_task)."""
    plan, session, attached, project_dir, background, lessons = await _make_plan(body, parent)
    run = ExecutionRun(
        id=str(uuid4()), prompt=body.prompt, status=RunStatus.AWAITING_CONFIRMATION,
        plan=plan, budget_usd=body.budget_usd, use_cli=body.use_cli, allow_network=body.allow_network,
        project_dir=str(project_dir) if project_dir else None, attachments=attached,
        actual_cost_usd=plan.planning_cost_usd, background=background,
        parent_run_id=parent.id if parent else None, workspace_id=parent.folder_id if parent else None,
        supervisor=session if session.model_id else None,
        improvement_uses=lessons,
    )
    if not parent and not project_dir:
        # A readable folder, not the task's id: 20261021-1441-async-fifo-uvm.
        run.folder_name = await asyncio.to_thread(folders.task_folder, plan.folder or plan.summary or body.prompt)
    db.save_run(run)
    db.add_event(Event(
        run_id=run.id, kind="plan.created",
        data={
            "estimate": plan.estimate.model_dump(), "use_cli": body.use_cli, "allow_network": body.allow_network,
            "project_dir": run.project_dir, "parent_run_id": run.parent_run_id,
            "planning_method": plan.planning_method,
            "planner_model_id": plan.planner_model_id,
            "planning_note": plan.planning_note,
        },
    ))
    return run


async def _make_plan(body: CreateTask, parent: Optional[ExecutionRun] = None, decided: str = "",
                     context: str = ""):
    """The routed and estimated plan of ``body`` (see _new_task), and what it was made with:
    (plan, lead session, attachments, project folder, background, lessons). ``decided``: the
    user's answers to an earlier plan's open choices (replan_with_choices). ``context``: the
    background when there is no parent, such as the conversation a task grew out of (promote_chat)."""
    configured = providers.configured_models(list(models))
    if not body.use_cli:
        configured = {model_id for model_id in configured if not model_id.startswith("cli:")}
    project_dir = None
    if body.project_dir and body.project_dir.strip():
        try:
            project_dir = resolve_project_dir(body.project_dir.strip())
        except ProjectDirError as exc:
            raise HTTPException(400, str(exc)) from exc
    try:
        attached = files.resolve(body.attachments)
    except files.AttachmentError as exc:
        raise HTTPException(400, str(exc)) from exc
    needs_vision = any(item.kind == "image" for item in attached)
    background = change_background(parent) if parent else (context or None)
    request = body.prompt + files.describe(attached, with_paths=False)
    if decided:
        request += "\n\n" + decided
    if body.allow_network:
        # The lead plans within what the steps' sandbox allows (planner.WORK_RULES).
        request += "\n\n" + INTERNET_NOTE
    executor.sync_improvements()
    lessons = learning.selected(db, request)
    if note := learning.instruction(lessons):
        request += "\n\n" + note
    # The planner knows the tools earlier tasks built, so it plans to use them (capabilities.py).
    if built := capabilities.section():
        request += "\n\n" + built
    # The lead plans from the project brief, so it can cut the work into scoped packages.
    root = Path(project_dir) if project_dir else settings.workspace_root / parent.folder_id if parent else None
    brief, brief_cost = None, 0.0
    if root and root.is_dir() and any(root.iterdir()):
        writer = brief_writer(list(models.values()), configured) if settings.project_brief else None
        brief, brief_cost = await briefing.planning_brief(root, settings.data_dir, providers, writer)
    try:
        plan = await autonomous_plan(
            f"{background}\n\n新需求：\n{request}" if background else request, list(models.values()), configured, providers,
            project_context=await asyncio.to_thread(project_context, project_dir) if project_dir else None,
            session=(session := SupervisorSession()), brief=brief,
        )
    except ContractError as exc:
        raise HTTPException(422, {"status": "blocked", "reason": str(exc)}) from exc
    plan.planning_cost_usd = round(plan.planning_cost_usd + brief_cost, 6)
    catalog = list(models.values())
    if parent:
        plan.in_project = True
    try:
        for node in plan.nodes:
            if parent:
                # Every step changes files the earlier task left, so it needs a model that can act.
                node.needs_workspace = True
            if plan.employees:
                team.route(node, plan, catalog, configured, needs_vision)
            elif note := fit_and_route(node, catalog, configured, needs_vision):
                plan.planning_note = f"{plan.planning_note}; {note}" if plan.planning_note else note
        for part in plan.parts:
            if part.status == "planned":
                assigned = next((e for e in plan.employees if e.id == part.employee_id), None)
                pool = [m for m in catalog if m.id == assigned.model_id] if assigned else catalog
                part.estimated_cost_usd = part_estimate(part, plan.in_project, pool, configured, needs_vision)
    except NoEligibleModelError as exc:
        raise HTTPException(422, str(exc)) from exc
    plan.estimate = estimate(plan.nodes, body.budget_usd, plan.planning_cost_usd, plan.unsplit_cost())
    return plan, session, attached, project_dir, background, lessons


class ChoiceAnswers(BaseModel):
    # One per choice of the plan, in order: "assumed", "alternative", or the user's own answer.
    picks: list[str] = Field(min_length=1, max_length=5)


# Tasks being planned again with the user's choices (one replanning at a time per task).
REPLANNING: set[str] = set()


def decided_choices(choices, picks: list[str]) -> str:
    """The user's answers to a plan's open choices, said to the lead; "" when every answer is
    what the lead had assumed (nothing to plan again)."""
    lines, changed = [], False
    for choice, pick in zip(choices, picks):
        pick = pick.strip()
        if pick == "alternative" and choice.alternative:
            answer, changed = choice.alternative, True
        elif pick and pick not in {"assumed", "alternative"}:
            answer, changed = pick[:1000], True
        else:
            answer = choice.assumed
        lines.append(f"- {choice.question} → {answer}")
    if not changed:
        return ""
    return ("The user has decided these scope questions; plan exactly by these answers and do not list "
            "them as choices again:\n" + "\n".join(lines))


@app.post("/api/tasks/{run_id}/choices", response_model=ExecutionRun)
async def replan_with_choices(run_id: str, body: ChoiceAnswers):
    """The user answered the plan's open choices (TaskPlan.choices) before confirming: when an
    answer differs from what the lead assumed, the task is planned again with the answers, in
    place. Its id, folder, budget and settings stay."""
    run = get_task(run_id)
    if run.status != RunStatus.AWAITING_CONFIRMATION:
        raise HTTPException(409, "只有待确认的任务可以按选择重新规划。")
    if len(body.picks) != len(run.plan.choices):
        raise HTTPException(422, "每条取舍都要有一个选择。")
    decided = decided_choices(run.plan.choices, body.picks)
    if not decided:
        return run
    if run_id in REPLANNING:
        raise HTTPException(409, "正在按你的选择重新规划，请稍候。")
    REPLANNING.add(run_id)
    try:
        parent = db.get_run(run.parent_run_id) if run.parent_run_id else None
        request = CreateTask(prompt=run.prompt, attachments=[item.id for item in run.attachments],
                             budget_usd=run.budget_usd, use_cli=run.use_cli, project_dir=run.project_dir,
                             allow_network=run.allow_network)
        plan, session, _, _, _, lessons = await _make_plan(request, parent, decided)
    finally:
        REPLANNING.discard(run_id)
    latest = get_task(run_id)
    if latest.status != RunStatus.AWAITING_CONFIRMATION:
        raise HTTPException(409, "任务在重新规划期间已改变状态，新计划未采用。")
    latest.plan, latest.improvement_uses = plan, lessons
    latest.supervisor = session if session.model_id else latest.supervisor
    latest.actual_cost_usd = round(latest.actual_cost_usd + plan.planning_cost_usd, 6)
    db.save_run(latest)
    db.add_event(Event(run_id=run_id, kind="plan.replanned",
                       data={"decided": decided, "estimate": plan.estimate.model_dump() if plan.estimate else None}))
    return latest


class FollowUp(BaseModel):
    prompt: str = Field(min_length=3)
    attachments: list[str] = Field(default_factory=list)
    budget_usd: Optional[float] = Field(default=None, gt=0, le=10_000)
    # Default to the earlier task's settings.
    allow_network: Optional[bool] = None
    use_cli: Optional[bool] = None


CHANGEABLE = FINISHED


@app.post("/api/tasks/{run_id}/followup", response_model=ExecutionRun, status_code=201)
async def follow_up_task(run_id: str, body: FollowUp):
    """需求变更: a new task that builds on this one's results instead of starting over. It works
    in the same project, or the same scratch folder, and is planned knowing what exists."""
    parent = get_task(run_id)
    if parent.status not in CHANGEABLE:
        raise HTTPException(409, "任务还在进行中，结束后才能提出需求变更。")
    return await _new_task(CreateTask(
        prompt=body.prompt, attachments=body.attachments, budget_usd=body.budget_usd or parent.budget_usd,
        use_cli=parent.use_cli if body.use_cli is None else body.use_cli, project_dir=parent.project_dir,
        allow_network=parent.allow_network if body.allow_network is None else body.allow_network,
    ), parent=parent)


def change_background(parent: ExecutionRun) -> str:
    """What a requirement change is told about the task it continues."""
    listing = publish.output_files(parent)
    names = [item["path"] for item in listing[:MAX_BACKGROUND_FILES]]
    more = f"\n…以及另外 {len(listing) - len(names)} 个文件" if len(listing) > len(names) else ""
    earlier = f"\n更早的背景：\n{parent.background[:MAX_EARLIER_BACKGROUND]}" if parent.background else ""
    result = (parent.final_result or "（没有最终结果）")[:MAX_BACKGROUND_RESULT]
    return (
        "这是对一个已有任务的需求变更：在它已有的结果上修改或新增，不要从头重做，也不要删掉与新需求无关的已有功能。\n"
        f"原任务需求：{parent.prompt}\n"
        f"原任务计划：{parent.plan.summary}；步骤：{'、'.join(node.title for node in parent.plan.nodes)}\n"
        f"原任务状态：{parent.status.value}\n"
        f"原任务结果（节选）：\n{result}\n"
        f"工作目录里已有的文件：\n" + ("\n".join(names) or "（无）") + more + earlier
    )


MAX_BACKGROUND_FILES = 150
MAX_BACKGROUND_RESULT = 3000
MAX_EARLIER_BACKGROUND = 1500


def _calibrated(runs: list[ExecutionRun]) -> list[ExecutionRun]:
    """Runs as read by the console, each estimate also given as past tasks suggest it will go.
    Only for display: these copies are never saved, and budget checks keep the planned estimate."""
    reviews = db.retrospectives()
    for run in runs:
        if run.plan.estimate:
            run.plan.estimate.calibrated_usd = retrospect.calibrated_cost(
                run, retrospect.calibration(reviews, exclude=run.id))
    return runs


@app.get("/api/tasks", response_model=list[ExecutionRun])
def list_tasks():
    return _calibrated(db.list_runs())


@app.get("/api/retrospectives/recurring")
async def recurring_problems(min_runs: int = 2):
    """Problems that came up in at least ``min_runs`` finished tasks, most frequent first."""
    return await asyncio.to_thread(retrospect.recurring, db, max(1, min_runs))


@app.get("/api/retrospectives/topics")
async def problem_topics(min_runs: int = 1):
    """Problems across tasks grouped by what they are about (retrospect.topics)."""
    return await asyncio.to_thread(retrospect.topics, db, max(1, min_runs))


@app.get("/api/tasks/{run_id}/retrospective")
async def task_retrospective(run_id: str):
    """A finished task's look back: each step's estimate against its cost and turns, and its problems."""
    body = db.retrospective(run_id) or await asyncio.to_thread(retrospect.record, db, run_id)
    if body is None:
        raise HTTPException(404, "Task not found or not finished")
    return body


@app.get("/api/tasks/{run_id}/calls")
async def task_model_calls(run_id: str):
    if not db.get_run(run_id):
        raise HTTPException(404, "Task not found")
    records = [item for item in db.model_calls(run_id) if not item.get("delegated")]
    return {"calls": records, "limit": 1000,
            "summary": {"calls": len(records), "requests": sum(item["requests"] for item in records),
                        "unknown_usage": sum(not item["usage_known"] for item in records),
                        "observed_cost_usd": sum(item["cost_usd"] for item in records),
                        "input_tokens": sum(item["input_tokens"] for item in records),
                        "output_tokens": sum(item["output_tokens"] for item in records),
                        "cached_input_tokens": sum(item["cached_input_tokens"] for item in records),
                        "retries": sum(item["retries"] for item in records)}}


@app.get("/api/improvements/settings", response_model=LearningSettings)
def learning_settings():
    return learning.preferences(db)


@app.put("/api/improvements/settings", response_model=LearningSettings)
def set_learning_settings(body: LearningSettings):
    db.save_learning_settings(body.model_dump())
    return body


def improvement_view(item):
    job = db.get_engineer_job(item.engineer_job_id) if item.engineer_job_id else None
    return {**item.model_dump(mode="json"), "effects": db.improvement_effects(item.id),
            "engineer_job": job.model_dump(mode="json") if job else None}


@app.get("/api/improvements")
def list_improvements():
    executor.sync_improvements()
    return [improvement_view(item) for item in db.improvements()]


@app.get("/api/tasks/{run_id}/learning")
def task_learning(run_id: str):
    run = get_task(run_id)
    executor.sync_improvements()
    return {"review": db.learning_review(run_id),
            "automatic_eligible": run.status in retrospect.AUTOMATIC,
            "automatic_skip_reason": "任务已手动取消，不自动复盘。" if run.status == RunStatus.CANCELLED else None,
            "retrospective": db.retrospective(run_id) or (
                retrospect.record(db, run_id) if run.status in retrospect.AUTOMATIC else None),
            "improvements": [improvement_view(item) for item in db.improvements(run_id)],
            "applied": [{"id": use["id"], "title": use["title"], "node_ids": use.get("node_ids", []),
                         "planning": use.get("planning", False), "source_run_id": use["run_id"]}
                        for use in run.improvement_uses]}


@app.post("/api/tasks/{run_id}/learning", status_code=202)
async def start_task_learning(run_id: str):
    get_task(run_id)
    try:
        return executor.start_learning(run_id, manual=True)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/improvements/{item_id}/disable")
def disable_improvement(item_id: str):
    item = db.improvement(item_id)
    if not item:
        raise HTTPException(404, "找不到改进项。")
    if item.kind == "platform":
        raise HTTPException(409, "已应用的平台改动需要通过平台工程师回退；未应用的工作可在工程师中放弃。")
    if item.status != "active":
        raise HTTPException(409, "只能停用已生效的 Skill 或执行规则。")
    item.status = "disabled"
    if item.kind == "skill":
        skills.remove_lesson(item.id)
    db.save_improvement(item)
    return item


def get_task(run_id: str):
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, "Task not found")
    return run


@app.get("/api/tasks/{run_id}", response_model=ExecutionRun)
def read_task(run_id: str):
    return _calibrated([get_task(run_id)])[0]


@app.delete("/api/tasks/{run_id}", status_code=204)
async def delete_task(run_id: str):
    if any(task and not task.done() for task in (executor.tasks.get(run_id), executor.diagnosing.get(run_id),
                                               executor.learning_tasks.get(run_id), executor.capability_tasks.get(run_id))):
        raise HTTPException(409, "任务仍在执行或结束处理中，请稍后再删除。")
    existing = db.get_run(run_id)
    if any(job.run_id == run_id and job.improvement_id and job.status not in {"applied", "failed", "rejected", "cancelled"}
           for job in db.engineer_jobs(1000)):
        raise HTTPException(409, "该任务的改进仍由平台工程师处理，请完成或放弃后再删除。")
    deleted_attachments = existing.attachments if existing else []
    try:
        # A chat is a draft that never runs; a draft task is not deleted (only finished ones are).
        deleted = db.delete_run(run_id, chat=bool(existing and existing.kind == "chat"))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if not deleted:
        raise HTTPException(404, "Task not found")
    shutil.rmtree(Path(settings.data_dir) / "traces" / run_id, ignore_errors=True)
    executor.tasks.pop(run_id, None)
    executor.learning_tasks.pop(run_id, None)
    executor.locks.pop(run_id, None)
    executor.reservations.pop(run_id, None)
    executor.budget_events.pop(run_id, None)
    for item in deleted_attachments:
        files.delete(item.id)


def reopen_node(run: ExecutionRun, node) -> None:
    """Give a failed or stopped node fresh attempts; the next one sees why the last one
    failed, and the latest diagnosis's advice."""
    if node.status == NodeStatus.UNABLE:
        node.feedback = f"上次这一步无法完成：{node.unable_reason}\n请先确认这个限制现在是否已经解除；仍然做不到时如实说明。"
        node.unable_reason = None
    elif node.status == NodeStatus.FAILED and node.attempts:
        node.feedback = node.feedback or node.attempts[-1].reason
        advice = next((item.advice for item in reversed(run.diagnoses)
                       if item.status == "done" and item.advice and item.node_id in {node.id, None}), None)
        if advice and advice not in node.feedback:
            node.feedback = f"{node.feedback}\n诊断建议：{advice}"
    node.status, node.failed_attempts, node.environment_fixes = NodeStatus.PENDING, 0, 0


@app.post("/api/tasks/{run_id}/confirm", response_model=ExecutionRun)
async def confirm_task(run_id: str, body: ConfirmTask):
    run = get_task(run_id)
    if run.waiting_diagnosis_id or run.maintenance_id:
        raise HTTPException(409, "请先回复诊断问题，或等待平台修复自动生效。")
    if run.engineer_job_id:
        raise HTTPException(409, "任务在等平台工程师添加组件：请在负责人对话里的平台工程师卡片上批准或放弃这项工作。")
    diagnosis = executor.diagnosing.get(run_id)
    if diagnosis and not diagnosis.done():
        raise HTTPException(409, "诊断或修复仍在进行，完成后会自动继续；也可以取消任务。")
    if run.status not in {RunStatus.AWAITING_CONFIRMATION, RunStatus.PAUSED}:
        raise HTTPException(409, f"Cannot confirm task in {run.status} status")
    budget = body.budget_usd if body.budget_usd is not None else run.budget_usd
    configured = providers.configured_models(list(models))
    if any(n.model_id and not n.model_id.startswith("mock:") for n in run.plan.nodes):
        configured = {mid for mid in configured if not mid.startswith("mock:")}
    if not run.use_cli:
        configured = {mid for mid in configured if not mid.startswith("cli:")}
    try:
        for node in run.plan.nodes:
            if node.status in {NodeStatus.SUCCEEDED, NodeStatus.RUNNING}:
                continue
            if run.plan.employees:
                team.route(node, run.plan, list(models.values()), configured, any(a.kind == "image" for a in run.attachments))
                continue
            available = eligible_for_node(node, list(models.values()), configured, any(a.kind == "image" for a in run.attachments))
            if not any(model.id == node.model_id for model in available):
                route_node(node, list(models.values()), configured, any(a.kind == "image" for a in run.attachments))
    except NoEligibleModelError as exc:
        raise HTTPException(422, str(exc)) from exc
    required = run.actual_cost_usd + run.plan.unsplit_cost() + sum(
        node.estimated_cost_usd for node in run.plan.nodes if node.status != NodeStatus.SUCCEEDED
    )
    if required > budget:
        raise HTTPException(
            409, f"Budget ${budget:.2f} is below the ${required:.4f} needed to finish this task",
        )
    run.budget_usd = budget
    if run.plan.estimate:
        run.plan.estimate.hard_limit_usd = budget
    # A task paused after a diagnosis continues with its failed steps run again.
    reopened = [node.id for node in run.plan.nodes if node.status == NodeStatus.FAILED]
    for node in run.plan.nodes:
        if node.id in reopened:
            reopen_node(run, node)
    if reopened:
        run.rework_rounds = 0
    # Whatever paused the task, the user has now seen it and continued: the message is done.
    run.error = None
    # The user said go on: the lead gets a fresh allowance of decisions.
    run.decisions_since = datetime.now(timezone.utc)
    # A task paused by the user may still be finishing its running steps; that loop goes on.
    task = executor.tasks.get(run.id)
    run.status = RunStatus.RUNNING if task and not task.done() else RunStatus.QUEUED
    db.save_run(run)
    db.add_event(Event(run_id=run.id, kind="run.confirmed", data={"budget_usd": run.budget_usd, "reopened": reopened}))
    executor.start(run.id)
    return run


@app.post("/api/tasks/{run_id}/pause", response_model=ExecutionRun)
async def pause_task(run_id: str):
    """Stop starting new steps; steps already running finish and keep their results."""
    run = get_task(run_id)
    if run.status not in {RunStatus.QUEUED, RunStatus.RUNNING} and not run.maintenance_id:
        raise HTTPException(409, f"Cannot pause task in {run.status} status")
    async with executor.locks.setdefault(run.id, asyncio.Lock()):
        run = get_task(run_id)
        run.status = RunStatus.PAUSED
        run.waiting_diagnosis_id = None
        run.maintenance_id = None
        run.error = None
        db.save_run(run)
    running = [node.id for node in run.plan.nodes if node.status == NodeStatus.RUNNING]
    db.add_event(Event(run_id=run.id, kind="approval.required", data={"reason": "user_paused", "running": running}))
    return run


@app.post("/api/tasks/{run_id}/diagnose", response_model=ExecutionRun)
async def diagnose_task(run_id: str):
    """Ask a strong model (a membership CLI when possible) why the task is stuck."""
    async with executor.locks.setdefault(run_id, asyncio.Lock()):
        if executor.platform_pending:
            raise HTTPException(409, "平台修复正在自动生效，请稍候再开始新的诊断。")
        run = get_task(run_id)
        failed = next((node.id for node in run.plan.nodes if node.status in {NodeStatus.FAILED, NodeStatus.UNABLE}), None)
        if failed is None:
            failed = next((node.id for node in run.plan.nodes if node.status == NodeStatus.PENDING and node.attempts), None)
        diagnosis_id = executor.begin_diagnosis(run, "manual", failed)
        if diagnosis_id is None and (not run.diagnoses or run.diagnoses[-1].status != "failed"):
            raise HTTPException(409, "诊断正在进行中，请稍候。")
        db.save_run(run)
    if diagnosis_id:
        executor.start_diagnosis(run.id, diagnosis_id)
    return run


@app.put("/api/tasks/{run_id}/network", response_model=ExecutionRun)
async def set_network_access(run_id: str, body: NetworkAccess):
    """Allow or forbid the internet for this task's commands, from its next model call on."""
    async with executor.locks.setdefault(run_id, asyncio.Lock()):
        run = get_task(run_id)
        if run.allow_network != body.allow:
            run.allow_network = body.allow
            db.save_run(run)
            executor.emit(run_id, "run.network_changed", allow=body.allow)
    return run


@app.post("/api/tasks/{run_id}/lead", response_model=ExecutionRun, status_code=202)
async def ask_lead(run_id: str, body: LeadQuestion):
    """Write to the task's lead, in the conversation it keeps for this task (supervisor.py). The
    message is saved at once; the lead's answer follows in ``lead_messages``."""
    get_task(run_id)
    attached = _attached(body.attachments)
    message = body.message.strip() or ("（见附件）" if attached else "")
    if not message:
        raise HTTPException(422, "请写下要说的话，或附上文件。")
    try:
        started = executor.start_lead_chat(run_id, message, attached)
    except files.AttachmentError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not started:
        raise HTTPException(409, "负责人还在回答上一条消息，请稍候。")
    return get_task(run_id)


class CreateChat(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    attachments: list[str] = Field(default_factory=list)
    budget_usd: float = Field(default=1, gt=0, le=10_000)
    use_cli: bool = True
    project_dir: Optional[str] = Field(default=None, max_length=4096)
    # A model that can hold a conversation (supervisor.candidates); the best one when empty.
    model_id: Optional[str] = Field(default=None, max_length=200)


# Characters of a chat's title, from its first message.
CHAT_TITLE_CHARS = 60


def chat_models(use_cli: bool = True, needs_vision: bool = False) -> list:
    """Models a chat can be held with, best first: those that can lead a task's conversation; with
    images attached, those that can see them (as for a step: a CLI, or an API model not known blind)."""
    configured = providers.configured_models(list(models))
    if not use_cli:
        configured = {model_id for model_id in configured if not model_id.startswith("cli:")}
    return [model for model in supervisor.candidates(list(models.values()), configured)
            if not needs_vision or model.channel == "cli" or model.supports_vision is not False]


@app.get("/api/chats/models")
def list_chat_models(use_cli: bool = True):
    return [{"id": model.id, "display_name": model.display_name, "channel": model.channel}
            for model in chat_models(use_cli)]


@app.post("/api/chats", response_model=ExecutionRun, status_code=201)
async def create_chat(body: CreateChat):
    """Only a conversation: no plan, no steps. The model may read the project folder, if one is
    given (a CLI's read-only lead conversation there); it edits nothing. The first message is
    answered in the background, as in a task's conversation with its lead."""
    return _start_chat(body.message, body.budget_usd, body.use_cli, body.project_dir, body.model_id, body.attachments)


def _start_chat(message: str, budget_usd: float, use_cli: bool, project_dir: Optional[str], model_id: Optional[str],
                attachment_ids: list[str] = (), auto_routed: bool = False, spent: float = 0.0) -> ExecutionRun:
    """Save a new chat and send its first message, with its attachments (create_chat, start)."""
    try:
        attached = files.resolve(list(attachment_ids))
    except files.AttachmentError as exc:
        raise HTTPException(400, str(exc)) from exc
    needs_vision = any(item.kind == "image" for item in attached)
    available = chat_models(use_cli, needs_vision)
    pick = next((model for model in available if model.id == model_id), None) if model_id else next(iter(available), None)
    if pick is None:
        raise HTTPException(422, ("这个模型看不了图片，请换一个模型。" if needs_vision else "这个模型不能用来对话。") if model_id
                            else "没有可用来对话的模型：请先配置会员 CLI 或 API 模型。")
    folder = None
    if project_dir and project_dir.strip():
        try:
            folder = str(resolve_project_dir(project_dir.strip()))
        except ProjectDirError as exc:
            raise HTTPException(400, str(exc)) from exc
    message = message.strip()
    run = ExecutionRun(
        id=str(uuid4()), prompt=message, kind="chat", status=RunStatus.DRAFT, plan=_chat_plan(message, folder),
        budget_usd=budget_usd, use_cli=use_cli, project_dir=folder, attachments=attached, auto_routed=auto_routed,
        actual_cost_usd=round(spent, 6),
        supervisor=supervisor.new_session(pick, folder=folder),
    )
    db.save_run(run)
    db.add_event(Event(run_id=run.id, kind="chat.created", data={"model_id": pick.id, "project_dir": folder, "auto_routed": auto_routed}))
    executor.start_lead_chat(run.id, message)
    return get_task(run.id)


def _chat_plan(message: str, project_dir: Optional[str]) -> TaskPlan:
    """A chat's plan: no steps, titled by its first line."""
    title = message.splitlines()[0][:CHAT_TITLE_CHARS] if message else "对话"
    return TaskPlan(summary=title, nodes=[], request=message, in_project=bool(project_dir))


class StartRequest(CreateTask):
    # The model to chat with, if it turns out to be a chat.
    model_id: Optional[str] = Field(default=None, max_length=200)


@app.post("/api/start", response_model=ExecutionRun, status_code=201)
async def start(body: StartRequest):
    """Start what the user typed as a chat or a task, decided by triage.classify (told the names of
    any attachments, which go with either). Deciding is billed to whichever it becomes."""
    try:
        attached = files.resolve(body.attachments)
    except files.AttachmentError as exc:
        raise HTTPException(400, str(exc)) from exc
    configured = providers.configured_models(list(models))
    kind, spent = await triage.classify(body.prompt + files.describe(attached, with_paths=False), providers,
                                        brief_writer(list(models.values()), configured))
    if kind == "chat":
        return _start_chat(body.prompt, body.budget_usd, body.use_cli, body.project_dir, body.model_id,
                           body.attachments, auto_routed=True, spent=spent)
    run = await _new_task(body)
    latest = get_task(run.id)
    latest.auto_routed = True
    latest.actual_cost_usd = round(latest.actual_cost_usd + spent, 6)
    db.save_run(latest)
    return latest


@app.post("/api/tasks/{run_id}/as-chat", response_model=ExecutionRun)
async def task_to_chat(run_id: str):
    """A task waiting for confirmation was only a question: keep it as a chat instead, answered
    by the best chat model from its request. Its plan is dropped; planning stays paid."""
    run = get_task(run_id)
    if run.kind != "task" or run.status != RunStatus.AWAITING_CONFIRMATION or run.parent_run_id:
        raise HTTPException(409, "只有待确认的新任务可以改成对话。")
    if run_id in REPLANNING:
        raise HTTPException(409, "正在重新规划，请稍候。")
    pick = next(iter(chat_models(run.use_cli, any(item.kind == "image" for item in run.attachments))), None)
    if pick is None:
        raise HTTPException(422, "没有可用来对话的模型：请先配置会员 CLI 或 API 模型。")
    run.kind, run.status, run.plan = "chat", RunStatus.DRAFT, _chat_plan(run.prompt, run.project_dir)
    run.supervisor = supervisor.new_session(pick, folder=run.project_dir)
    db.save_run(run)
    db.add_event(Event(run_id=run_id, kind="task.to_chat", data={"model_id": pick.id}))
    executor.start_lead_chat(run_id, run.prompt)
    return get_task(run_id)


class PromoteChat(BaseModel):
    # What the task is to do; the chat's first message when empty. The conversation goes with it.
    prompt: str = Field(default="", max_length=20_000)
    budget_usd: float = Field(default=2, gt=0, le=10_000)
    use_cli: Optional[bool] = None
    allow_network: bool = False
    # More files for the task, besides the chat's own.
    attachments: list[str] = Field(default_factory=list)


@app.post("/api/tasks/{run_id}/promote", response_model=ExecutionRun)
async def promote_chat(run_id: str, body: PromoteChat):
    """Turn a chat into a task, in place: it is planned with the conversation as its background
    and waits for confirmation like any new task. Its id and messages stay."""
    run = get_task(run_id)
    if run.kind != "chat" or run.status != RunStatus.DRAFT:
        raise HTTPException(409, "只有对话可以转成任务。")
    answering = executor.lead_tasks.get(run_id)
    if (answering and not answering.done()) or run_id in REPLANNING:
        raise HTTPException(409, "对方还在回复，请等它说完再转成任务。")
    prompt = body.prompt.strip() or run.prompt
    if len(prompt) < 3:
        raise HTTPException(422, "请写清要完成的工作。")
    use_cli = run.use_cli if body.use_cli is None else body.use_cli
    context = "这个任务来自用户和模型的一段对话，对话内容如下（供参考，以“新需求”为准）：\n" + supervisor.chat_transcript(run)
    # The chat's attachments go with it: the planner and the steps see them as a task's own.
    request = CreateTask(prompt=prompt, budget_usd=body.budget_usd, use_cli=use_cli, project_dir=run.project_dir,
                         allow_network=body.allow_network,
                         attachments=list(dict.fromkeys([item.id for item in run.attachments] + body.attachments)))
    REPLANNING.add(run_id)
    try:
        plan, session, _, _, background, lessons = await _make_plan(request, context=context)
    finally:
        REPLANNING.discard(run_id)
    latest = get_task(run_id)
    if latest.kind != "chat" or latest.status != RunStatus.DRAFT:
        raise HTTPException(409, "对话在规划期间已改变，新计划未采用。")
    latest.kind, latest.status, latest.prompt, latest.plan = "task", RunStatus.AWAITING_CONFIRMATION, prompt, plan
    latest.budget_usd, latest.use_cli, latest.allow_network = body.budget_usd, use_cli, body.allow_network
    latest.background, latest.improvement_uses = background, lessons
    # The planner leads the task from here; the chat's messages stay in its conversation.
    latest.supervisor = session if session.model_id else latest.supervisor
    latest.actual_cost_usd = round(latest.actual_cost_usd + plan.planning_cost_usd, 6)
    if not latest.project_dir:
        latest.folder_name = await asyncio.to_thread(folders.task_folder, plan.folder or plan.summary or prompt)
    db.save_run(latest)
    db.add_event(Event(run_id=run_id, kind="chat.promoted",
                       data={"estimate": plan.estimate.model_dump() if plan.estimate else None,
                             "planner_model_id": plan.planner_model_id}))
    return latest


@app.post("/api/tasks/{run_id}/diagnoses/{diagnosis_id}/reply", response_model=ExecutionRun)
async def reply_to_diagnosis(run_id: str, diagnosis_id: str, body: DiagnosisReply):
    """A choice and/or free text is persisted before starting the next diagnosis."""
    async with executor.locks.setdefault(run_id, asyncio.Lock()):
        run = get_task(run_id)
        previous = next((d for d in run.diagnoses if d.id == diagnosis_id), None)
        if not previous:
            raise HTTPException(404, "诊断记录不存在。")
        busy = executor.diagnosing.get(run_id)
        if (busy and not busy.done()) or executor.platform_pending:
            raise HTTPException(409, "当前诊断或平台修复仍在进行，请完成后提交补充。")
        text, choice = body.text.strip(), body.choice.strip() if body.choice else None
        attached = _attached(body.attachments)
        if choice and choice not in previous.choices:
            raise HTTPException(422, "所选方案不属于这次诊断，请重新选择。")
        if not text and not choice and not attached:
            raise HTTPException(422, "请选择一个方案或填写你的想法。")
        try:
            # The files join the task's: the lead is given them with its next call, the steps see them.
            files.attach(run, attached)
        except files.AttachmentError as exc:
            raise HTTPException(422, str(exc)) from exc
        previous.messages.append(DiagnosisMessage(text=text or ("（见附件）" if attached else ""), choice=choice, attachments=attached))
        if choice == diagnosis_module.NETWORK_CHOICE and not run.allow_network:
            # A diagnosis or the lead asked whether the task may use the internet; the answer applies at once.
            run.allow_network = True
            executor.emit(run_id, "run.network_changed", allow=True)
        if previous.trigger == "lead":
            # The task's lead asked: the answer goes back to it, in its conversation.
            if run.waiting_diagnosis_id == diagnosis_id:
                run.waiting_diagnosis_id = None
            db.save_run(run)
            executor.emit(run_id, "run.diagnosis_reply", diagnosis_id=diagnosis_id, choice=choice, text=text)
            executor.start_lead_answer(run_id, diagnosis_id)
            return run
        focus = previous.node_id or next((n.id for n in run.plan.nodes if n.status == NodeStatus.FAILED), None)
        following = executor.begin_diagnosis(run, "manual", focus)
        run.diagnoses[-1].reply_to = diagnosis_id
        if not following and run.waiting_diagnosis_id == diagnosis_id:
            run.waiting_diagnosis_id = None
        db.save_run(run)
        executor.emit(run_id, "run.diagnosis_reply", diagnosis_id=diagnosis_id,
                      next_diagnosis_id=following, choice=choice, text=text)
    if following:
        executor.start_diagnosis(run_id, following)
    return run


@app.post("/api/tasks/{run_id}/resume", response_model=ExecutionRun)
async def resume_task(run_id: str, body: ConfirmTask):
    """Continue a failed, cancelled or incomplete task from where it stopped: finished nodes
    keep their results; the others run again with fresh attempts and rework rounds."""
    run = get_task(run_id)
    if run.waiting_diagnosis_id or run.maintenance_id:
        raise HTTPException(409, "请先回复诊断问题，或等待平台修复自动生效。")
    if run.engineer_job_id:
        raise HTTPException(409, "任务在等平台工程师添加组件：请在负责人对话里的平台工程师卡片上批准或放弃这项工作。")
    diagnosis = executor.diagnosing.get(run_id)
    if diagnosis and not diagnosis.done():
        raise HTTPException(409, "诊断或修复仍在进行，完成后会自动继续；也可以取消任务。")
    if run.status not in {RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.INCOMPLETE}:
        raise HTTPException(409, f"Cannot resume task in {run.status} status")
    task = executor.tasks.get(run_id)
    if task and not task.done():
        raise HTTPException(409, "任务仍在结束处理中，请稍后再继续。")
    configured = providers.configured_models(list(models))
    if any(n.model_id and not n.model_id.startswith("mock:") for n in run.plan.nodes):
        configured = {mid for mid in configured if not mid.startswith("mock:")}
    if not run.use_cli:
        configured = {model_id for model_id in configured if not model_id.startswith("cli:")}
    needs_vision = any(item.kind == "image" for item in run.attachments)
    reopened = []
    try:
        for node in run.plan.nodes:
            if node.status == NodeStatus.SUCCEEDED:
                continue
            if node.status in {NodeStatus.FAILED, NodeStatus.CANCELLED, NodeStatus.RUNNING,
                               NodeStatus.UNABLE, NodeStatus.BLOCKED}:
                reopened.append(node.id)
                reopen_node(run, node)
            available = eligible_for_node(node, list(models.values()), configured, needs_vision)
            if not any(model.id == node.model_id for model in available):
                # Its model was disabled or lost its key since; pick again under current rules.
                route_node(node, list(models.values()), configured, needs_vision)
    except NoEligibleModelError as exc:
        raise HTTPException(422, str(exc)) from exc
    budget = body.budget_usd if body.budget_usd is not None else run.budget_usd
    required = run.actual_cost_usd + run.plan.unsplit_cost() + sum(
        node.estimated_cost_usd for node in run.plan.nodes if node.status != NodeStatus.SUCCEEDED
    )
    if required > budget:
        raise HTTPException(
            409, f"Budget ${budget:.2f} is below the ${required:.4f} needed to finish this task",
        )
    run.budget_usd, run.rework_rounds, run.error = budget, 0, None
    run.decisions_since = datetime.now(timezone.utc)
    if run.plan.estimate:
        run.plan.estimate.hard_limit_usd = budget
    run.status = RunStatus.QUEUED
    db.save_run(run)
    db.add_event(Event(run_id=run.id, kind="run.resumed", data={"budget_usd": budget, "reopened": reopened}))
    executor.start(run.id)
    return run


@app.post("/api/tasks/{run_id}/cancel", response_model=ExecutionRun)
async def cancel_task(run_id: str):
    run = get_task(run_id)
    diagnosis = executor.diagnosing.get(run_id)
    if run.status in FINISHED and not (diagnosis and not diagnosis.done()):
        raise HTTPException(409, "Task has already finished")
    run.status = RunStatus.CANCELLED
    run.waiting_diagnosis_id = None
    run.maintenance_id = None
    # A component the lead asked for stays with the platform engineer; the user decides on it there.
    run.engineer_job_id = None
    db.save_run(run)
    db.add_event(Event(run_id=run.id, kind="run.cancelled"))
    executor.cancel(run.id)
    return run


class GithubToken(BaseModel):
    token: str = Field(min_length=10, max_length=500)


@app.get("/api/skills")
def list_skills():
    """What the steps know how to use (skills.py): this machine's skills, then the platform's."""
    return [{"name": item.name, "description": item.description, "summary": item.summary, "tools": item.tools,
             "machine": item.machine}
            for item in skills.library()]


# ---- Automations: what someone asks an automation package (capability_runner.py) ----

# How a task asked for through an automation ended, as the automation is told.
TASK_ENDED = {"run.succeeded": "做完了", "run.incomplete": "只做完了一部分", "run.failed": "没能做完",
              "run.cancelled": "已取消"}


def _task_name(run: ExecutionRun) -> str:
    return run.plan.title or run.plan.summary[:40]


def _automation_chat_model(automation: capability_runner.Automation, run: Optional[ExecutionRun] = None,
                           needs_vision: bool = False) -> ModelProfile:
    """The saved choice, with the ordinary fallback if it has become unavailable (or cannot see the
    images sent). An unchanged automatic preference keeps its conversation; restoring automatic
    chooses afresh."""
    available = chat_models(needs_vision=needs_vision)
    wanted = automation.state["model_id"]
    if not wanted and run and not automation.state["chat_preferences"].get(run.id) and run.supervisor:
        wanted = run.supervisor.model_id
    pick = next((model for model in available if model.id == wanted), None) or next(iter(available), None)
    if pick is None:
        raise HTTPException(422, "没有可用来对话的模型：请先配置会员 CLI 或 API 模型。")
    return pick


async def automation_message(capability: Capability, asked: capability_runner.Asked,
                             automation: capability_runner.Automation) -> tuple[Optional[str], float]:
    """What a message to an automation becomes, decided as 新建's 自动 decides (triage.classify): a
    question is answered by the conversation's own chat; work is planned as a task that waits for
    the owner's confirmation. Returns the reply and what it cost."""
    configured = providers.configured_models(list(models))
    cheapest = brief_writer(list(models.values()), configured)
    # What was said where it was not called on (a group chat): kept, and told with the next
    # message it answers, so it knows what the group was talking about.
    heard = automation.state.setdefault("heard", {})
    heard_files = automation.state.setdefault("heard_files", {})
    earlier = list(heard.get(asked.conversation, [])) if asked.conversation else []
    files_before = [item for item in files.resolve_existing(heard_files.get(asked.conversation, []))] \
        if asked.conversation else []
    line = f"{asked.sender or '成员'}：{asked.text}"
    if asked.attachments:
        line += f"（附 {'、'.join(item.name for item in asked.attachments)}）"
    judged = 0.0
    if not asked.addressed:
        meant, judged = await triage.addressed(line, "\n".join(earlier), capability.name, providers, cheapest)
        if not meant:
            if asked.conversation:
                heard[asked.conversation] = capability_runner.keep_heard([*earlier, line])
                kept = [item.id for item in [*files_before, *asked.attachments]]
                heard_files[asked.conversation] = kept[-capability_runner.MAX_HEARD_FILES:]
            automation.note(f"群里没 @ 它的消息：不是问它的，记作上下文（{line[:60]}）")
            return None, judged
        automation.note(f"群里没 @ 它的消息：判断是在问它，回答（{line[:60]}）")
    said = asked.text
    if earlier:
        said = ("群里此前的消息（不是问你的，供参考）：\n" + "\n".join(earlier)
                + f"\n\n现在问你的：\n{line if asked.sender else asked.text}")
        heard.pop(asked.conversation, None)
    if files_before:
        # The pictures and files sent there before, the group's, come with this message.
        asked.attachments = [*files_before, *[item for item in asked.attachments if item.id not in
                                              {before.id for before in files_before}]][-files.MAX_ATTACHMENTS:]
        heard_files.pop(asked.conversation, None)
    if (asked.attachments and asked.text == capability_runner.FILES_ONLY) or asked.text == capability_runner.CALLED_ONLY:
        # Files with no words (a picture sent alone), or only an @: there is nothing to tell work
        # from; it is answered in the chat, as a person called on would answer.
        kind, spent = "chat", judged
    else:
        kind, spent = await triage.classify(asked.text, providers, cheapest)
        spent += judged
    origin = {**asked.origin, "capability": capability.id}
    attached = [item.id for item in asked.attachments]
    needs_vision = any(item.kind == "image" for item in asked.attachments)
    if kind == "task" and len(asked.text) >= 3:
        task = await _new_task(CreateTask(prompt=asked.text, attachments=attached))
        latest = get_task(task.id)
        latest.origin, latest.auto_routed = origin, True
        latest.actual_cost_usd = round(latest.actual_cost_usd + spent, 6)
        db.save_run(latest)
        estimate = latest.plan.estimate
        guess = f"，预计 ${estimate.low_usd:.2f}–${estimate.high_usd:.2f}" if estimate else ""
        reply = (f"这件事要动手做。我在 FluidForm 里排好了计划「{_task_name(latest)}」{guess}，"
                 "等主人确认后开工，做完在这里告诉你。")
        return reply, latest.actual_cost_usd
    # A question: the conversation goes on in one chat, which its first message started.
    while True:
        known = automation.state["chats"].get(asked.conversation) if asked.conversation else None
        run = db.get_run(known) if known else None
        if run is None or run.kind != "chat":
            requested, pick = automation.state["model_id"], _automation_chat_model(automation, needs_vision=needs_vision)
            # The answer's lead runs in a task started here, which takes this context along.
            heard = streaming.listener.set(asked.on_text)
            try:
                run = _start_chat(said, max(automation.remaining(), 0.01), True, None, pick.id, attached,
                                  auto_routed=True, spent=spent)
            finally:
                streaming.listener.reset(heard)
            latest = get_task(run.id)
            prefix = f"{capability.name} · "
            latest.plan.title = prefix + asked.text.splitlines()[0][:max(CHAT_TITLE_CHARS - len(prefix), 10)]
            latest.origin = origin
            db.save_run(latest)
            if asked.conversation:
                automation.state["chats"][asked.conversation] = run.id
            before, extra = 0.0, 0.0
            break
        active = executor.lead_tasks.get(run.id)
        if active and not active.done():
            with contextlib.suppress(Exception):
                await asyncio.shield(active)
            continue
        async with executor.locks.setdefault(run.id, asyncio.Lock()):
            # Someone may have started a reply while we were waiting for the run lock.
            active = executor.lead_tasks.get(run.id)
            if active and not active.done():
                continue
            latest = get_task(run.id)
            if latest.kind != "chat":
                continue
            requested, pick = automation.state["model_id"], _automation_chat_model(automation, latest, needs_vision)
            previous = latest.supervisor.model_id if latest.supervisor else None
            if previous != pick.id:
                latest.supervisor = supervisor.new_session(pick, latest.supervisor, supervisor.chat_folder(latest))
                latest.lead_seen_attachments = []
            # Where it is (private or a group), for a chat started before automations said so.
            if asked.origin.get("chat_type") and not (latest.origin or {}).get("chat_type"):
                latest.origin = {**(latest.origin or {}), "chat_type": asked.origin["chat_type"]}
            # The chat may spend what is left of the automation's day.
            latest.budget_usd = round(latest.actual_cost_usd + max(automation.remaining(), 0.01), 6)
            db.save_run(latest)
            if previous != pick.id:
                executor.emit(run.id, "run.lead_changed", model_id=pick.id, previous_model_id=previous)
            before, extra = latest.actual_cost_usd, spent
            heard = streaming.listener.set(asked.on_text)
            try:
                executor.start_lead_chat(run.id, said, asked.attachments)
            except files.AttachmentError as exc:
                automation.note(f"附件没带上：{exc}")
                executor.start_lead_chat(run.id, said)
            finally:
                streaming.listener.reset(heard)
            break
    # Remember the preference actually used for this turn, not a later change saved mid-reply.
    automation.state["chat_preferences"][run.id] = requested
    automation.save()
    reply_id = get_task(run.id).lead_messages[-1].id
    with contextlib.suppress(Exception):
        await asyncio.shield(executor.lead_tasks[run.id])
    latest = get_task(run.id)
    answer = next((item for item in latest.lead_messages if item.id == reply_id), None)
    text = answer.text if answer else None
    actual = latest.supervisor.model_id if latest.supervisor else None
    if answer and answer.status == "done" and actual and actual != (requested or pick.id):
        name = models[actual].display_name if actual in models else actual
        notice = f"（{'所选' if requested else '原'}模型暂不可用，本次由「{name}」回复。）"
        text = f"{text}\n\n{notice}"
        automation.note(notice)
    return text, round(latest.actual_cost_usd - before + extra, 6)


runner = capability_runner.Runner(automation_message)


def automation_task_ended(run_id: str, kind: str) -> None:
    """A task an automation asked for has ended: the automation hears how, with its origin."""
    run = db.get_run(run_id)
    if not run or run.kind == "chat" or not run.origin or not run.origin.get("capability"):
        return
    text = f"「{_task_name(run)}」{TASK_ENDED.get(kind, '结束了')}。"
    if body := (run.final_result or run.error or "").strip():
        text += "\n\n" + body
    with contextlib.suppress(RuntimeError):  # no loop: nothing to send from
        runner.notify(run.origin["capability"], {"event": "task_ended", "origin": run.origin, "outcome": kind,
                                                 "title": _task_name(run), "text": text})


def start_automations() -> None:
    """The enabled automation packages, when this machine allows them."""
    if not settings.capability_packages:
        return
    for item in capabilities.library():
        if item.kind == "automation" and item.source == "upload" and item.entry and item.status == "active":
            runner.start(item)


# ---- Capabilities: what finished tasks left the platform able to do (capabilities.py) ----

@app.get("/api/capabilities", response_model=list[Capability])
def list_capabilities():
    return capabilities.library()


class CapabilitySwitch(BaseModel):
    enabled: bool
    # An uploaded package is code from elsewhere: the user confirms what it may reach and gets.
    confirmed: bool = False


def _capability(capability_id: str) -> Capability:
    capability = capabilities.load(capability_id)
    if not capability:
        raise HTTPException(404, "没有这个能力。")
    return capability


def _packages_allowed() -> None:
    if not settings.capability_packages:
        raise HTTPException(409, "本机还没开启能力包：在 .env 里设 SUPER_PARTNER_CAPABILITY_PACKAGES=true 后重启。")


@app.patch("/api/capabilities/{capability_id}", response_model=Capability)
async def switch_capability(capability_id: str, body: CapabilitySwitch):
    """Use it again, or stop telling later work about it (an automation: start or stop it). A failed
    one stays failed until fixed."""
    capability = _capability(capability_id)
    if capability.status == "failed" and body.enabled:
        raise HTTPException(409, "这个能力的检查没有通过，修好之前不能启用。")
    runs = capability.kind == "automation" and capability.source == "upload"
    if body.enabled and capability.source == "upload":
        _packages_allowed()
        if not body.confirmed:
            raise HTTPException(409, "启用上传的能力要先确认它能访问的域名和拿到的密钥。")
        if lacking := [name for name, stored in capability_packages.secrets_set(capability).items() if not stored]:
            raise HTTPException(409, f"先填好：{'、'.join(lacking)}")
    capability.status = "active" if body.enabled else "disabled"
    capabilities.save(capability)
    if runs and body.enabled and capability.entry:
        runner.start(capability)
    elif runs:
        await runner.stop(capability.id)
    return capability


@app.delete("/api/capabilities/{capability_id}", status_code=204)
async def delete_capability(capability_id: str):
    """Remove it; a package is uninstalled with its data, state and secrets."""
    capability = _capability(capability_id)
    if capability.source == "upload":
        await runner.stop(capability.id)
        runner.forget(capability.id)
        capability_packages.uninstall(capability)
    elif not capabilities.remove(capability_id):
        raise HTTPException(404, "没有这个能力。")


@app.post("/api/capabilities/upload", response_model=Capability, status_code=201)
async def upload_capability(request: Request):
    """Install a capability package (raw zip body), switched off until the user enables it. A new
    version of an installed one replaces it, keeping its secrets and state."""
    _packages_allowed()
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > capabilities.MAX_CAPABILITY_BYTES:
            raise HTTPException(413, f"能力包不能超过 {capabilities.MAX_CAPABILITY_BYTES // 1024 // 1024} MB。")
    try:
        manifest = capability_packages.read(bytes(data))
        await runner.stop(manifest.id)
        return await capability_packages.install(bytes(data))
    except capability_packages.PackageError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/capabilities/runtime")
def capabilities_runtime():
    """Each package's secrets stored, and each automation's state, log and budget."""
    found = {}
    for item in capabilities.library():
        if item.source != "upload":
            continue
        entry = {"secrets": capability_packages.secrets_set(item)}
        if item.kind == "automation":
            entry.update(runner.get(item.id).public())
        found[item.id] = entry
    return {"available": settings.capability_packages, "missing": capability_sandbox.missing(), "capabilities": found}


class CapabilitySecrets(BaseModel):
    values: dict[str, str]


@app.put("/api/capabilities/{capability_id}/secrets")
async def capability_secrets(capability_id: str, body: CapabilitySecrets):
    """Keep its secrets in the keyring (never in a file); a running automation restarts with them."""
    capability = _capability(capability_id)
    unknown = set(body.values) - set(capability.secrets)
    if unknown:
        raise HTTPException(422, f"它没有声明这些密钥：{'、'.join(sorted(unknown))}")
    for name, value in body.values.items():
        if value.strip():
            secret_store.set_secret(capability_packages.secret_name(capability.id, name), value.strip())
    await runner.restart(capability)
    return {"secrets": capability_packages.secrets_set(capability)}


@app.delete("/api/capabilities/{capability_id}/secrets", status_code=204)
async def capability_forget_secrets(capability_id: str):
    capability = _capability(capability_id)
    await runner.stop(capability.id)
    if capability.status == "active" and capability.kind == "automation":
        capability.status = "disabled"
        capabilities.save(capability)
    for name in capability.secrets:
        secret_store.delete_secret(capability_packages.secret_name(capability.id, name))


class CapabilityBudget(BaseModel):
    daily_budget_usd: float = Field(ge=0, le=1000)


@app.put("/api/capabilities/{capability_id}/budget")
def capability_budget(capability_id: str, body: CapabilityBudget):
    """What an automation may spend a day deciding and answering."""
    capability = _capability(capability_id)
    item = runner.get(capability.id)
    item.state["daily_budget_usd"] = body.daily_budget_usd
    item.save()
    return item.public()


class CapabilityModel(BaseModel):
    model_id: Optional[str] = Field(default=None, max_length=200)


@app.put("/api/capabilities/{capability_id}/model")
async def capability_model(capability_id: str, body: CapabilityModel):
    """Save an automation's chat model. Each chat adopts it before its next reply, after any
    active reply finishes; classification and task planning retain their own model policies."""
    capability = _capability(capability_id)
    if capability.source != "upload" or capability.kind != "automation":
        raise HTTPException(422, "只有上传的自动化能力可以设置聊天模型。")
    model_id = body.model_id or None
    if model_id and model_id not in {model.id for model in chat_models()}:
        raise HTTPException(422, "这个模型暂不可用或不能用来对话，请重新选择。")
    item = runner.get(capability.id)
    previous = item.state["model_id"]
    item.state["model_id"] = model_id
    try:
        item.save()
    except OSError:
        item.state["model_id"] = previous
        raise
    return item.public()


def _proposal(run: ExecutionRun, index: int):
    if not 0 <= index < len(run.capability_proposals):
        raise HTTPException(404, "没有这条提议。")
    proposal = run.capability_proposals[index]
    if proposal.status != "proposed":
        raise HTTPException(409, "这条提议已经处理过。")
    return proposal


@app.post("/api/tasks/{run_id}/capabilities/{index}/solidify", response_model=ExecutionRun)
async def solidify_capability(run_id: str, index: int):
    """The user keeps what the task built: copied out of the task's folder and checked in a
    step's sandbox; later steps and planners are told about it (docs/design/capabilities.md)."""
    run = get_task(run_id)
    proposal = _proposal(run, index)
    try:
        capability = await capabilities.solidify(run, proposal)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    latest = get_task(run_id)
    latest.capability_proposals[index].status = "solidified"
    latest.capability_proposals[index].capability_id = capability.id
    db.save_run(latest)
    db.add_event(Event(run_id=run_id, kind="capability.solidified",
                       data={"capability_id": capability.id, "status": capability.status}))
    return latest


@app.post("/api/tasks/{run_id}/capabilities/{index}/dismiss", response_model=ExecutionRun)
def dismiss_capability(run_id: str, index: int):
    run = get_task(run_id)
    _proposal(run, index).status = "dismissed"
    db.save_run(run)
    return run


class PublishRequest(BaseModel):
    # Either create ``name`` with the saved token, or push to an existing empty ``remote``.
    name: Optional[str] = None
    private: bool = True
    description: str = ""
    remote: Optional[str] = None


@app.get("/api/github")
def github_status():
    return {"token": bool(os.getenv(SECRET_ENV["github"])), "git": shutil.which("git") is not None}


@app.put("/api/github/token")
def store_github_token(body: GithubToken):
    return {"stored": set_provider_key("github", body.token.strip())}


@app.delete("/api/github/token")
def remove_github_token():
    return {"removed": delete_provider_key("github")}


@app.get("/api/tasks/{run_id}/files")
def task_files(run_id: str):
    run = get_task(run_id)
    return {"root": str(publish.output_root(run)), "in_project": bool(run.project_dir),
            "files": publish.output_files(run), "github_url": run.github_url}


@app.get("/api/tasks/{run_id}/files/content")
def task_file_content(run_id: str, path: str):
    try:
        return {"path": path, "text": publish.read_output(get_task(run_id), path)}
    except publish.PublishError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/tasks/{run_id}/archive")
def task_archive(run_id: str):
    run = get_task(run_id)
    try:
        data = publish.archive(run)
    except publish.PublishError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(data, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{publish.slug(run)}.zip"',
    })


@app.post("/api/tasks/{run_id}/github")
async def publish_task(run_id: str, body: PublishRequest):
    """Commit the task's output to a new or empty GitHub repository."""
    run = get_task(run_id)
    if run.project_dir:
        raise HTTPException(409, "项目任务的改动在你自己的仓库里，请在项目中提交并推送。")
    if run.status != RunStatus.SUCCEEDED:
        raise HTTPException(409, "任务完成后才能上传。")
    token = os.getenv(SECRET_ENV["github"])
    try:
        if body.remote:
            remote, url = publish.check_remote(body.remote), None
            await asyncio.to_thread(publish.push_snapshot, run, remote)
            url = re.sub(r"\.git/?$", "", remote.replace("git@github.com:", "https://github.com/"))
        else:
            if not token:
                raise publish.PublishError("还没有保存 GitHub 令牌；可以先保存令牌，或填写已建好的空仓库地址。")
            name = (body.name or publish.slug(run)).strip()
            if not publish.REPO_NAME.match(name):
                raise publish.PublishError("仓库名只能包含字母、数字、点、横线和下划线")
            repo = await publish.create_repository(token, name, body.private, body.description or run.plan.summary, providers.client)
            await asyncio.to_thread(publish.push_snapshot, run, repo["clone_url"], token)
            url = repo["html_url"]
    except publish.PublishError as exc:
        raise HTTPException(400, str(exc)) from exc
    run.github_url = url
    db.save_run(run)
    db.add_event(Event(run_id=run.id, kind="run.published", data={"url": url}))
    return {"url": url}


@app.get("/api/tasks/{run_id}/timeline")
def task_timeline(run_id: str, after: int = 0):
    """All events of a task so far, oldest first, for the plan view's progress panel."""
    if not db.get_run(run_id):
        raise HTTPException(404, "Task not found")
    return [event.model_dump(mode="json") for event in db.events(run_id, after)]


@app.get("/api/tasks/{run_id}/nodes/{node_id}/activity")
def node_activity(run_id: str, node_id: str, limit: int = 200):
    """What a running step has done so far in this attempt (activity.py): an API model's tool
    calls, or a CLI's commands, file changes and messages; empty when it is not running."""
    run = db.get_run(run_id)
    if not run or not any(node.id == node_id for node in run.plan.nodes):
        raise HTTPException(404, "Step not found")
    calls = list(executor.tool_logs.get((run_id, node_id)) or [])
    return {"running": (run_id, node_id) in executor.tool_logs, "total": len(calls),
            "calls": calls[-max(1, min(limit, 400)):]}


@app.get("/api/tasks/{run_id}/events")
async def task_events(run_id: str, after: int = 0):
    if not db.get_run(run_id):
        raise HTTPException(404, "Task not found")

    async def stream():
        cursor = after
        idle = 0
        while idle < 300:
            events = db.events(run_id, cursor)
            if events:
                idle = 0
                for event in events:
                    cursor = event.id or cursor
                    yield f"id: {cursor}\nevent: {event.kind}\ndata: {json.dumps(event.data)}\n\n"
            else:
                idle += 1
                yield ": keepalive\n\n"
            run = db.get_run(run_id)
            if not run or (
                run.status in FINISHED
                and not events
            ):
                break
            await asyncio.sleep(1)

    return StreamingResponse(stream(), media_type="text/event-stream")
