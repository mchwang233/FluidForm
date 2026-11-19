"""What FluidForm does without any setting (docs/design/fewer-settings.md): small things at once,
tasks going on after a restart, chats doing small jobs, remembering and reading the web, every repair
the platform engineer's; pictures and searches with whatever keys this machine has."""
from super_partner import images, web
from super_partner.config import Settings, settings


def test_without_any_setting_the_features_are_on(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)  # no .env
    plain = Settings()
    assert all([plain.quick_tasks, plain.solo_tasks, plain.resume_after_restart, plain.chat_tools,
                plain.chat_tools_network, plain.chat_action_tools, plain.user_memory, plain.web_fetch,
                plain.engineer_repairs])
    assert (plain.preflight_cache_minutes, plain.chat_tool_seconds, plain.chat_tool_turns) == (60, 300, 50)
    assert plain.image_models is None and plain.web_search_models is None and not plain.acceptance
    # Still switched off on purpose: they widen the sandbox, or cost money nobody asked for.
    assert not plain.allow_host_shell


def test_pictures_and_searches_use_the_keys_there_are(monkeypatch):
    monkeypatch.setattr(images, "PROVIDER_ENV", {"glm": "GLM_API_KEY", "minimax": "MINIMAX_API_KEY"})
    monkeypatch.setattr(web, "PROVIDER_ENV", {"glm": "GLM_API_KEY"})
    monkeypatch.setenv("GLM_API_KEY", "g")
    monkeypatch.delenv("MINIMAX_API_KEY", raising=False)
    monkeypatch.setitem(settings.__dict__, "image_models", None)
    monkeypatch.setitem(settings.__dict__, "web_search_models", None)
    assert images.available() == ["glm:cogview-4"] and web.search_services() == ["glm:search_std"]
    monkeypatch.setenv("MINIMAX_API_KEY", "m")
    assert images.available() == ["minimax:image-01", "glm:cogview-4"]
    # [] still means none.
    monkeypatch.setitem(settings.__dict__, "image_models", [])
    monkeypatch.setitem(settings.__dict__, "web_search_models", [])
    assert images.available() == [] and web.search_services() == []
    monkeypatch.delenv("GLM_API_KEY")
    monkeypatch.setitem(settings.__dict__, "web_search_models", None)
    assert web.search_services() == []


def test_the_former_profiles_read_as_the_defaults(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    for name in ("fast", "balanced"):
        assert Settings(profile=name).profile == ""
    careful = Settings(profile="careful")
    assert careful.acceptance and not careful.quick_tasks and not careful.solo_tasks


def test_an_old_env_naming_removed_settings_still_loads(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("SUPER_PARTNER_DIRECT_TASK_PLANNING=true\nSUPER_PARTNER_ADAPTIVE_REFINEMENT=true\n")
    monkeypatch.setenv("SUPER_PARTNER_DIRECT_TASK_PLANNING", "false")
    loaded = Settings()
    assert loaded.employee_teams and loaded.head_start and loaded.capability_packages
    assert not hasattr(loaded, "direct_task_planning")


async def test_an_old_plan_with_parts_never_split_ends_with_the_reason(tmp_path):
    from super_partner.db import Database
    from super_partner.executor import UNSPLIT_PARTS, Executor
    from super_partner.models import ExecutionRun, PlanPart, RunStatus, TaskPlan
    db = Database(tmp_path / "t.db")
    plan = TaskPlan(summary="s", nodes=[], parts=[PlanPart(id="p", title="后端", status="planned")])
    db.save_run(ExecutionRun(id="r", prompt="p", status=RunStatus.QUEUED, budget_usd=1, plan=plan))
    await Executor(db, None, {}).execute("r")
    run = db.get_run("r")
    assert run.status == RunStatus.FAILED and run.error == UNSPLIT_PARTS and run.plan.parts[0].title == "后端"
