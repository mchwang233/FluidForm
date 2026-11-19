"""Settings that go together, chosen by one name (config.PROFILES); a setting given on its own wins."""
import pytest
from super_partner.config import PROFILES, Settings


def test_a_profile_sets_its_settings_unless_one_is_given(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)  # no .env
    plain = Settings()
    assert (plain.profile, plain.quick_tasks, plain.acceptance) == ("", True, False)
    careful = Settings(profile="careful", preflight_cache_minutes=5)
    assert careful.acceptance and not careful.quick_tasks and careful.preflight_cache_minutes == 5
    monkeypatch.setenv("SUPER_PARTNER_PROFILE", "careful")
    monkeypatch.setenv("SUPER_PARTNER_QUICK_TASKS", "true")
    given = Settings()
    assert given.acceptance and given.quick_tasks and not given.solo_tasks


def test_every_profile_names_real_settings():
    for values in PROFILES.values():
        assert set(values) <= set(Settings.model_fields)
    with pytest.raises(ValueError):
        Settings(profile="turbo")
