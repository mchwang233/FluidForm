from __future__ import annotations

from pathlib import Path
from typing import Literal, Optional

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Settings that go together, chosen with one name (SUPER_PARTNER_PROFILE); a setting given on
# its own still wins. Empty: every setting keeps its own default.
PROFILES: dict[str, dict] = {
    # Small things done at once: one-step and one-model tasks without the lead's planning, easy
    # steps on their own result, a passed check reused, tasks going on after a restart, chats
    # doing small jobs themselves.
    "fast": {"quick_tasks": True, "solo_tasks": True, "review_easy_steps": False, "preflight_cache_minutes": 60,
             "resume_after_restart": True, "chat_tools": True, "chat_action_tools": True},
    # Small tasks fast, everything else planned and reviewed as usual.
    "balanced": {"quick_tasks": True, "preflight_cache_minutes": 30, "resume_after_restart": True,
                 "chat_tools": True, "chat_action_tools": True},
    # Every task planned, every step's result accepted by another model.
    "careful": {"quick_tasks": False, "solo_tasks": False, "acceptance": True, "review_easy_steps": True,
                "preflight_cache_minutes": 0},
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SUPER_PARTNER_", env_file=".env")
    # A set of settings by name (PROFILES): fast, balanced or careful; "" for none.
    profile: Literal["", "fast", "balanced", "careful"] = ""

    data_dir: Path = Path(".super-partner")
    database_path: Optional[Path] = None
    workspace_root: Path = Path("workspaces")
    # Existing project directories a task may target; CLI agents edit files there in place.
    project_roots: list[Path] = [Path.home()]
    allow_host_shell: bool = False
    default_budget_usd: float = 2.0
    # Steps of one task running at once; 0: no limit, every step whose inputs are ready starts
    # (steps changing the same files still take turns, scopes.py).
    max_parallel_nodes: int = Field(default=0, ge=0)
    # A step whose inputs are not ready yet starts early on what does not need them (a testbench from
    # the interface contract, its own files), for at most head_start_minutes, then waits for them.
    # Only steps whose files or folders are known: an unscoped one would hold the whole folder. Off by default.
    head_start: bool = False
    head_start_minutes: float = Field(default=30, gt=0)
    # New projects form a durable team before planning. Existing records keep their workflow.
    employee_teams: bool = False
    # New plans contain executable tasks immediately, with no subsequent part refinement.
    direct_task_planning: bool = False
    team_max_employees: int = Field(default=8, ge=1, le=12)
    team_max_delegation_depth: int = Field(default=3, ge=1, le=5)
    team_max_delegations: int = Field(default=6, ge=1, le=20)
    # A hard step takes the strongest model, unless a cheaper one scores within this many points:
    # a point or two is not worth a model many times slower and dearer (GLM 5.3 against DeepSeek
    # Flash, 2026-10-21: 93.9 against 92.3 for coding, about 8 times slower and 20 times dearer).
    hard_score_margin: float = Field(default=2.0, ge=0)
    # A step others wait for is put to the lead once it has run this many times its expected
    # minutes (its expected turns at minutes_per_turn): go on, or stop for a faster model.
    minutes_per_turn: float = Field(default=0.5, gt=0)
    critical_overrun_factor: float = Field(default=2.0, gt=0)
    # Before a task's first step, check the step sandbox, the tools and licenses the plan needs,
    # the internet (if allowed) and the models (preflight.py).
    preflight: bool = True
    preflight_command_timeout: float = Field(default=120, gt=0)
    # Before the first step, write this machine's skill for each tool the task needs that has none
    # yet, by trying it in a step's sandbox (preflight.py, skills.py); at most this long each.
    preflight_skills: bool = True
    # Opt in to reusing general/local skills, then public discovery (only for tasks allowing
    # network), before bounded generation. Existing installations retain their old policy.
    skill_reuse_first: bool = False
    # When a task succeeds, ask its lead whether it built a reusable capability (a tool, an
    # automation) for the user to solidify (capabilities.py). Off by default: one more lead call.
    capability_proposals: bool = False
    # Capability packages (capability_packages.py, docs/design/capability-packages.md): uploading
    # them, and running automation packages in the background. Off: nothing is uploaded or run.
    capability_packages: bool = False
    # What an automation may spend a day deciding and answering, unless changed on its card.
    capability_daily_budget_usd: float = Field(default=2.0, ge=0, le=1000)
    skill_generation_max_turns: int = Field(default=6, ge=1, le=30)
    # Optional post-task learning; the UI can persist overrides. Its budget is separate and shown.
    learning_enabled: bool = False
    learning_budget_usd: float = Field(default=0.5, ge=0, le=100)
    skill_preparation_timeout: float = Field(default=900, gt=0)
    # A public address that shows the internet can be reached from a step's sandbox.
    preflight_network_url: str = "https://pypi.org/simple/"
    # Steps of one task running on one API provider at once; a step past it goes to another
    # provider's model if one can do it for at most spread_cost_factor times the cost. Off (0) by
    # default: steps one after another on one provider are fine (a failing one switches model
    # anyway), and spreading would hand everyday steps to weaker models.
    max_steps_per_provider: int = Field(default=0, ge=0)
    spread_cost_factor: float = Field(default=3.0, ge=1.0)
    # API models work on files and run sandboxed commands through tools (agent.py); off, they
    # only return text and cannot be routed to nodes that change a project.
    api_agent: bool = True
    # Turns of tool calls per attempt of an API model; 0 means no limit. Long attempts are not cut
    # off but checked (progress_check_minutes).
    api_agent_max_turns: int = Field(default=0, ge=0, le=1000)
    # Per provider: concurrency, rpm, tpm. Zero/absent means unconfigured; never guess API quotas.
    provider_limits: dict[str, dict[str, int]] = Field(default_factory=dict)
    # Membership CLIs priced by their subscription, e.g. {"cli:codex": {"monthly_usd": 200}}: each call
    # costs its share of the quota (cli_quota.py) and counts against task budgets. Empty: CLIs cost nothing.
    cli_plans: dict[str, dict[str, float]] = Field(default_factory=dict)
    # Membership CLIs cost nothing against any budget (tasks, the lead, the platform engineer), a
    # plan in cli_plans still reading and guarding their quota. Off: priced by cli_plans as above.
    cli_free: bool = False
    # Chats do quick jobs themselves (supervisor.chat_tools): an API model answering a chat without a
    # project folder gets the steps' tools in a scratch folder of its own, at most
    # chat_tool_turns tool calls and chat_tool_seconds per message; bigger work is still a task.
    chat_tools: bool = False
    # Its commands reach the internet (never this machine's services), as a task allowed to.
    chat_tools_network: bool = False
    chat_tool_seconds: int = Field(default=120, ge=10, le=1800)
    chat_tool_turns: int = Field(default=20, ge=1, le=200)
    # Image models API models may make pictures with (images.py, the GenerateImage tool), first choice
    # first, e.g. ["glm:cogview-4", "minimax:image-01"]; each uses its provider's key. Empty: none.
    image_models: list[str] = Field(default_factory=list)
    # Share of a priced CLI's quota window used from which it no longer goes first in routing, and
    # from which it takes no new work until the window resets.
    cli_quota_soft_percent: float = Field(default=70, ge=0, le=100)
    cli_quota_stop_percent: float = Field(default=90, ge=0, le=100)
    # Compatibility mode records an explicit warning; strict mode rejects effort downgrades.
    reasoning_fallback: Literal["report", "strict"] = "report"
    # Configured tools receive one JSON argv argument inside the ordinary task sandbox.
    api_tool_extensions: dict[str, dict] = Field(default_factory=dict)
    # MCP servers whose tools the API models' steps and chats get (mcp.py): {name: {"command":
    # [argv], "secrets": [VARIABLE], "timeout": seconds}}. Each runs in the step's sandbox.
    mcp_servers: dict[str, dict] = Field(default_factory=dict)
    # Search services for the WebSearch tool, first choice first (web.py), e.g. ["glm:search_std"];
    # empty: no such tool. Offered only to steps and chats allowed the internet.
    web_search_models: list[str] = Field(default_factory=list)
    # The WebFetch tool: a public page as text, for steps and chats allowed the internet.
    web_fetch: bool = False
    # before_tool / after_tool argv commands receive one JSON event. Empty: no hooks.
    api_tool_hooks: dict[str, list[list[str]]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def apply_profile(self):
        """The profile's settings, except those given on their own. Written past __setattr__, so
        model_fields_set still says which were given."""
        for name, value in PROFILES.get(self.profile, {}).items():
            if name not in self.model_fields_set:
                self.__dict__[name] = value
        return self

    def given_alone(self, profile: str) -> list[str]:
        """The settings of ``profile`` given on their own, which it does not change."""
        return [name for name in PROFILES.get(profile, {}) if name in self.model_fields_set]

    def use_profile(self, profile: str) -> None:
        """Switch to another profile while running (the 设置 menu; api.set_profile): the old one's
        settings go back to their defaults, the new one's apply; those given alone stay."""
        if profile not in PROFILES and profile != "":
            raise ValueError(f"unknown profile {profile}")
        for name in PROFILES.get(self.profile, {}):
            if name not in self.model_fields_set:
                self.__dict__[name] = type(self).model_fields[name].get_default(call_default_factory=True)
        self.__dict__["profile"] = profile
        self.apply_profile()

    @property
    def profile_path(self) -> Path:
        # The profile picked on the page, which outlasts a restart and wins over SUPER_PARTNER_PROFILE.
        return self.data_dir / "profile.json"

    def load_saved_profile(self) -> None:
        import json

        try:
            saved = json.loads(self.profile_path.read_text()).get("profile")
        except (OSError, ValueError, AttributeError):
            return
        if saved in PROFILES or saved == "":
            self.use_profile(saved)

    @field_validator("provider_limits")
    @classmethod
    def valid_provider_limits(cls, value):
        for limits in value.values():
            if set(limits) - {"concurrency", "rpm", "tpm"} or any(v < 0 for v in limits.values()):
                raise ValueError("provider limits accept only nonnegative concurrency, rpm and tpm")
        return value

    @field_validator("api_tool_hooks")
    @classmethod
    def valid_hook_events(cls, value):
        if set(value) - {"before_tool", "after_tool"}:
            raise ValueError("tool hooks accept before_tool and after_tool only")
        return value
    # Minutes of an attempt after which, and then every so often, another model checks whether it
    # is still making progress; only a stuck attempt is stopped. CLIs are checked the same way
    # instead of being killed at a fixed timeout.
    progress_check_minutes: float = Field(default=10, gt=0)
    # A lead's conversation call through Codex (splitting a part, a decision) runs while Codex
    # keeps printing its work, and is stopped after this long without any output, at most
    # lead_call_max_minutes in all (also the limit for Claude Code, which answers only at the end).
    lead_idle_minutes: float = Field(default=10, gt=0)
    lead_call_max_minutes: float = Field(default=60, gt=0)
    # A failed attempt goes to the task's lead to decide what next (supervisor.py), instead of a
    # new diagnosis each time. Past these many decisions for one step, or for the whole task, the
    # task pauses for the user.
    lead_decisions: bool = True
    max_node_decisions: int = Field(default=5, ge=1, le=50)
    max_run_decisions: int = Field(default=25, ge=1, le=500)
    # Output tokens per request for a model whose own ceiling the catalog does not give; a known
    # ceiling is used as is. Reasoning models spend their thinking from this too, so a small cap
    # can end a turn before it writes anything. A model that rejects the cap is retried with a
    # smaller one; the task budget can lower it further.
    api_agent_max_output_tokens: int = Field(default=32768, ge=1024, le=262144)
    # How hard DeepSeek's reasoning models think (its `reasoning_effort`); "none" turns thinking
    # off. Higher is slower and spends more output tokens, and gets harder problems right.
    # A project brief (briefing.py) written by a cheap model for the lead to plan from.
    project_brief: bool = True
    # Models used only for helper work (the project brief, reviews, progress checks), never to
    # run a task's steps or lead it: glm-5.3-flash leaves tool-calling requests unanswered.
    helper_only_models: list[str] = Field(default_factory=lambda: ["glm:glm-5.3-flash"])
    deepseek_reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"] = "max"
    # A step's reasoning effort by its difficulty: thinking hard on every turn of an easy step only
    # makes it slower. Calls outside steps (reviews, summaries) use deepseek_reasoning_effort.
    reasoning_by_difficulty: dict[str, str] = Field(default_factory=lambda: {"easy": "low", "normal": "medium", "hard": "max"})
    # The task's lead plans and decides for the whole task: it thinks hardest. Diagnoses a step below.
    lead_reasoning_effort: str = "max"
    # Initial staffing and outline generation can use their own effort, without changing the
    # retained lead, refinement or retrospective. Empty/zero preserve the existing policy.
    # "auto": staffing at the planning effort for the request's difficulty (planner.PLANNING_EFFORT).
    team_reasoning_effort: Literal["", "auto", "low", "medium", "high", "max"] = "auto"
    # "auto": the lead first judges how hard the request is to plan (one quick call at medium effort)
    # and plans it at the effort for that difficulty (planner.PLANNING_EFFORT).
    planning_reasoning_effort: Literal["", "auto", "low", "medium", "high", "max"] = "auto"
    # Seconds a planning call may take at low or medium effort; longer at high and max
    # (planner.PLANNING_TIME). 0: no limit.
    planning_call_timeout: float = Field(default=0, ge=0)
    # Let the lead's per-part difficulty/effort assessment control refinement conversations.
    adaptive_refinement: bool = False
    diagnosis_reasoning_effort: str = "high"
    # A diagnosis, environment repair or platform repair call may run this long. A long
    # regression or a tool install can outlast half an hour, and the call must still finish.
    repair_call_minutes: float = Field(default=60, gt=0)
    # Codex's service tier for the lead ("fast", "flex", ...); empty keeps the user's Codex config.
    codex_lead_service_tier: str = ""
    # Codex as the platform runs it leaves out the user's plugins, apps and MCP servers, which its
    # leads and steps do not use and which slow every start.
    codex_without_extras: bool = True
    # Where the leads' conversations keep their folders (a CLI conversation is tied to one); outside
    # any project, so a CLI does not take a project's instructions (AGENTS.md, CLAUDE.md) for its own.
    # Empty: <XDG cache>/super-partner/leads.
    lead_root: Optional[Path] = None
    # Seconds to wait for one API response; long outputs take minutes to generate.
    api_request_timeout: float = Field(default=600, ge=30)
    # A response not complete after this many seconds, even if data keeps arriving, fails at
    # once without a retry: its model counts as unavailable for a while, and another takes over.
    api_reply_deadline: float = Field(default=300, ge=30)
    # Local TCP ports that API models' sandboxed commands may still reach, such as an EDA
    # license server's lmgrd port; its vendor daemons' ports (snpslmd, ...) are found and added at
    # each command (environment.license_daemon_ports; for a root lmgrd by tracing lmutil lmstat,
    # needs strace). All other network access stays blocked.
    # Needs socat.
    sandbox_host_ports: list[int] = []
    # Shell scripts every step command sources first, e.g. an EDA tool setup that puts vcs on PATH
    # and sets license variables. A machine's own scripts can also be recorded in
    # .super-partner/tools/sandbox.json as "profiles" (environment.profiles).
    sandbox_profiles: list[str] = []
    # Host environment variables copied into that sandbox, e.g. VCS_HOME or
    # SNPSLMD_LICENSE_FILE. Listing PATH replaces the sandbox's minimal PATH with the host's.
    sandbox_env: list[str] = []
    # Subtasks (and their reviews) go to API models; a membership CLI only takes a subtask no
    # API model can do. Planning may still use a CLI.
    subtasks_prefer_api: bool = True
    # Handle a failed attempt instead of only retrying it: the task's lead decides (lead_decisions),
    # or, without a lead able to, a diagnosis looks for what blocks it.
    auto_diagnose: bool = True
    # When a task ends, the cheapest API model names its problems by what they are about, so one
    # cause recorded under several names is counted as one (retrospect.name_problems).
    problem_naming: bool = True
    # Diagnose and repair this application's source, separately from task workspaces.
    platform_self_repair: bool = True
    platform_root: Optional[Path] = None
    platform_repair_attempts: int = Field(default=2, ge=1, le=3)
    # Spending cap of a platform engineer job the user starts (engineer.py); membership CLIs cost
    # nothing extra. Repairs started from a task are charged to that task instead.
    engineer_budget_usd: float = Field(default=2.0, ge=0)
    # Commit an applied platform change to the source checkout's current branch (never pushed).
    engineer_commit: bool = True
    # Have another model check each node's result against its acceptance criteria.
    review_nodes: bool = True
    # Steps marked easy are reviewed by another model too; off: they are accepted on their own
    # result (verification steps and a step's check command still apply).
    review_easy_steps: bool = True
    # A task one model can do in one go (triage.quick) gets a one-step plan, without the lead's
    # planning; its step is easy (see review_easy_steps). Off: every task is planned.
    quick_tasks: bool = False
    # A task one strong model can carry through alone with its tools (triage.SHAPE_PROMPT "solo"),
    # in a project too, gets a one-step hard plan without the lead's planning. Off: planned.
    solo_tasks: bool = False
    # A passed check before a task's first step stands this long for the next task with the same
    # tools, network, models and recorded environment (preflight.py). 0: every task is checked.
    preflight_cache_minutes: int = Field(default=0, ge=0, le=1440)
    # A task cut off by a service restart goes on by itself from its finished steps when it works
    # in no project and waits for nobody (api.resumes_by_itself). Off: it waits for the user.
    resume_after_restart: bool = False
    # A chat with tools asks FluidForm to start a task, send a file or call the platform engineer
    # through tool calls (chat_actions.py) besides the lines it can write. Off: lines only.
    chat_action_tools: bool = False
    # An automation's chat keeps lasting facts people tell it (REMEMBER lines; remembering.py) by
    # conversation, and a new chat there is told them. Off: nothing is kept.
    user_memory: bool = False
    # Accepting each step's result: off, a step that finishes has passed. No reviewer, no declared
    # check or artifact acceptance command, no verification steps sending work back. The lead's
    # final check of the whole result stays (leading._final_review). A step saying it cannot do
    # its work (UNABLE/BLOCKED) still fails, and progress checks, artifact contracts' turn and
    # cost limits and the budget still apply.
    acceptance: bool = False
    # Contract steps get at least contracts.MIN_TOOL_CALLS tool calls by difficulty, whatever
    # tighter limit the lead declared.
    contract_call_floors: bool = True
    # Without a lead deciding (the fallback): runs per node (first try plus retries) before it
    # fails, retries going to the strongest model, and times verification nodes may send work back
    # within one task. With a lead, max_node_decisions and max_run_decisions bound it instead.
    max_node_attempts: int = Field(default=3, ge=1, le=10)
    max_rework_rounds: int = Field(default=2, ge=0, le=10)
    # Upstream results longer than this reach downstream nodes as a summary.
    handoff_max_chars: int = Field(default=4000, ge=500)
    api_base_url: str = "http://127.0.0.1:8000"
    # Host names the API answers to; any other Host header is refused to block DNS rebinding.
    allowed_hosts: list[str] = ["127.0.0.1", "localhost", "::1"]
    # Browser origins that may call the API; other origins cannot change state.
    allowed_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    catalog_auto_sync: bool = True
    catalog_sync_interval_hours: float = Field(default=24, ge=1, le=720)
    artificial_analysis_api_key: Optional[SecretStr] = Field(default=None, repr=False)

    @property
    def db_path(self) -> Path:
        return self.database_path or self.data_dir / "super-partner.db"

    def prepare(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)


settings = Settings()
