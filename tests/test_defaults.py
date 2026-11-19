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
