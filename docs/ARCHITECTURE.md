# Super Partner architecture map

A short map for finding code fast. Read this first, then open only the lines you need.
Keep it current: a change that moves a responsibility updates this file in the same patch.

## Life of a task

```
api.create_task ── planner.autonomous_plan ── team.form (employee_teams: before task planning)
                                         ├─ task_planning.plan_tasks (the lead: executable tasks, employees,
                                         │      dependencies and acceptance in one go)
                                         └─ routing.route_node        (plan, pick a model per step)
api.confirm_task ── Executor.execute ── _preflight                     (check sandbox, tools, internet, models first:
                                         │                                preflight.py; repair once, else pause)
                                         └─ _dispatch                    (run ready steps in parallel)
  _execute_node ── _work ── _complete ── providers.complete             (one attempt of one step)
                                          ├─ cli_channels  (membership CLIs: claude, codex, ...)
                                          └─ agent.Workspace (API models' tools, bwrap sandbox)
  _check   (verification steps: VERDICT line; others: a reviewer model, quality.review_prompt)
  _finish  (record the NodeAttempt, then: passed / send back / diagnose / retry / unable)
  _decide ── ask_lead ── _apply_decision                                (the task's lead decides, leading.py)
     ├─ retry / switch_model / accept / unable / ask_user / rework / replan (replan.py)
     ├─ repair_environment / repair_platform ── _repair (diagnosis with the lead's brief)
     └─ request_component ── _engineer_for_lead (task waits; the platform engineer's job, engineer.py)
  _repair ── _diagnose_with ── _repair_done                             (fallback: no lead decides)
     └─ STATUS: PLATFORM_REPAIR ── _fix_platform ── platform_repair     (fix Super Partner itself)
  all steps done ── _final_review (the lead: done / rework / replan) ── succeeded
  run ends: succeeded / failed / incomplete (_end_incomplete) / paused
  naturally finished run ── retrospect.record ── Learning.finish_learning (when enabled; excludes manual cancellation)
    └─ _learn: conclusion + improvement items ── independent validation ── active skill/rule
       └─ platform item ── engineer (copy, tests, activation; automatic when configured, even after source-task cancellation)
    next task: selected / attach ── planning and step instructions ── observe (before/after)
```

Retrospective analysis and lesson validation use `learning.strongest_model`: highest overall
capability, then planning and reliability; a different validator only among equally strong models.
Calls use separate empty conversations and diagnosis reasoning effort, with the existing budget,
availability, context and task CLI-permission checks.

Initial lead planning (`planner._plan_as_lead`) retains a validated employee roster when an
task list fails and another lead takes over. Optional `team_reasoning_effort` and
`planning_reasoning_effort` apply only during their respective calls; the persistent lead's
policy is restored afterwards. `planning_reasoning_effort="auto"` (the default) first asks the
lead, at `DIFFICULTY_EFFORT` (medium) and in a conversation of its own, how hard the request is
to plan (`planning_difficulty`), and plans at `PLANNING_EFFORT` for it (easy low … exceptional
max; hard when the answer is unusable); the plan's note says which. `team_reasoning_effort="auto"`
(the default) staffs the team at that same effort. `planning_call_timeout` bounds each such
call, times `PLANNING_TIME` for its effort (high twice, max three times), including API
queueing/retries and CLI execution, and finishes cancellation before trying another lead.
Empty effort settings and a zero deadline preserve the legacy call policy. These controls do
not alter retrospective model/effort selection.

A lead's conversation call (`cli_channels.converse` without a `timeout`: splitting a part, a
decision) through Codex runs while Codex keeps printing its JSON events and is stopped after
`lead_idle_minutes` without output (`_streamed`, `_until_quiet`), at most `lead_call_max_minutes`;
Claude Code, which answers only at the end, gets `lead_call_max_minutes`. Planning passes its own
deadline (`planning_call_timeout`), which stays hard.

Codex continuation options belong to the `exec resume` subcommand: `cli_channels.converse`
places effort, service tier and disabled extras after `resume`, alongside the read-only sandbox
setting. Options attached to the outer `exec` may be ignored by the resume parser. Regression
tests check the receiving option scope, not just the presence of requested flags.

Employee handoffs (`team.context`) bound file inventories across the project and retain counts,
sample paths and declared evidence paths; results, summaries and feedback remain verbatim, including
blocked work and pending decisions. `team.compact_context` can rebuild only those inventories in an
assembled prompt. Codex steps and lead conversations share `cli_channels._run_input`: the final
UTF-8 input is capped at 1 MiB less 64 KiB of envelope reserve, with character/byte counts recorded
in call warnings. An explicit `input_too_large` rejection permits at most one smaller-inventory
retry. If requirements still cannot fit, `InputTooLarge` follows the existing blocked-work path;
`providers` preserves it without quota classification or API fallback.

The lead plans with `task_planning.py`: complete work items once, through the ordinary DAG,
assignment and artifact-contract validators. Plans contain nodes and no parts. (Planning in major
parts split while the task ran, `outline.py` and `refining.py`, was removed: docs/design/fewer-settings.md.
A stored plan with parts never split fails at its start with `executor.UNSPLIT_PARTS`; its parts still
load and show.) One task is valid; there
is no compulsory file-count/turn-count subdivision. Unknown file scope uses the existing full
workspace lock. Employee model selection is retained at creation and confirmation. Explicit worker delegation remains available.
If a verification task names an existing transitive prerequisite, direct planning adds the
redundant direct dependency locally rather than regenerating the plan. Unknown or unrelated
targets still fail; artifact validation runs again after normalization.
The prompt's `PARALLEL_RULE` asks for concurrent work: verification built from the interface contract
alongside the implementation, and hard items over about an hour split by module, configuration, metric or
target family. A plan of three or more tasks with a hard one, all in a single line (`width` 1) and no
`serial_reason`, is sent back once in the existing correction round; the second answer is kept as is, so
planning never fails on it. `planning_note` states how many tasks can run at once, or the serial reason.

`LearningReview.automatic` distinguishes automatic work from an explicit manual request and
defaults to true for legacy records. Cancellation stops pending automatic work through
`skip_cancelled_learning`; source checks reject late model replies. `restore_learning` skips
cancelled automatic reviews instead of treating recovery as a new manual request. Completed
history, active lessons and already submitted independent platform jobs remain intact.

## Who owns what

| Area | Module | Key names |
|---|---|---|
| HTTP API, task lifecycle endpoints | `api.py` | `create_task`, `follow_up_task`, `resume_task`, `reopen_node`, `reply_to_diagnosis`, `set_network_access` |
| Records and statuses | `models.py` | `RunStatus`, `NodeStatus`, `Outcome` (attempt outcomes), `DiagnosisStatus`, `FINISHED`, `TaskNode`, `NodeAttempt`, `Diagnosis`, `ExecutionRun` |
| Declared artifact handoffs and stop limits | `contracts.py`, `models.py` | Optional `TaskNode.artifact_contract` (`ArtifactContract`: stage, external/dependency inputs, file/directory outputs, acceptance commands, blocking conditions, total turns/cost); `plan_problems`, `prepare`, `delivery_snapshot`, `accepted`; `ArtifactEvidence`, persistent `contract_turns/contract_tool_calls/contract_cost_usd` |
| Contract limits: tool calls at least `MIN_TOOL_CALLS` by difficulty (`settings.contract_call_floors`); at a limit the step goes to the lead (`Leading._decide` with `supervisor.limit_note`), and its retry, switch_model or replan grants more (`contracts.extend`, event `node.limit_extended`); without a decision it stops as before. Membership CLIs may run contract steps, bounded by time instead of counted calls (`Executor._timed_watch`, `CLI_MINUTES_PER_TOOL_CALL`). The contract prompt asks for the declared outputs first | `contracts.py`, `executor.py`, `leading.py`, `supervisor.py` | `declarations`, `extension`, `extend`, `prompt`; tests `test_activity.py`, `test_leading.py`, `test_executor.py` |
| A blocked step (missing evidence, a target not reached, a platform rule) goes to the lead like a limit stop: `supervisor.BLOCKED_NOTE`, and rework may send back the finished steps it builds on (`Leading._upstream`, `_reopen`, event `run.rework`); without a decision it stops as before | `executor.py`, `leading.py`, `supervisor.py` | `_finish` (`limited`), `_decide`, `_apply_decision`; tests `test_leading.py` |
| Planning: the lead also names the task shortly for lists (`TaskPlan.title`, `lead_planning.plan_title`; older plans show the first clause of their summary, `frontend/mission-history.tsx` `taskName`); independent deliverables get their own lines of tasks (`planner.INDEPENDENT_RULE`); open scope decisions that change the work a lot are listed (`CHOICES_RULE`, `TaskPlan.choices`, `PlanChoice`) and picked by the user before confirming (`frontend/plan-choices.tsx`); an answer other than the lead's plans the task again in place (`POST /api/tasks/{id}/choices`, `api.replan_with_choices`, `decided_choices`, `_make_plan`, event `plan.replanned`); employees are named by their job, one per module or area of responsibility rather than the fewest (`team.form`) | `planner.py`, `task_planning.py`, `outline.py`, `team.py`, `models.py` | `plan_choices`; tests `test_direct_planning.py` |
| What a running step is doing, live: an API model's tool log as it goes, and a Codex step's commands, file changes and messages parsed from its JSON output (kept as the attempt's tool calls afterwards); served to the step's progress panel | `activity.py`, `cli_channels.py`, `api.py`, `frontend/plan-graph.tsx` | `recording`, `paused` (progress checks and lead calls are not the step's work), `note_line`, `codex_entry`; `GET /api/tasks/{id}/nodes/{node}/activity`; `NodeProgress` 正在做 |
| Storage (SQLite, JSON bodies) | `db.py` | `Database.save_run`, `get_run`, events, `save_retrospective`; `conversations`, `conversation_archives`, `model_calls` (task deletion removes all three; it keeps `retrospectives`, `learning_reviews`, `improvements`, `improvement_effects`) |
| Skills for the steps: SKILL.md files with the `tools` they cover, general in `skills/steps/` (`synopsys-vcs`; `github-reference`: finding, scoring (upkeep, stars, tests/CI, OpenSSF Scorecard) and pinning GitHub projects to use as reference, reused code or skill material, read-only, with a `REFERENCE:` line per project; needs the task's network), this machine's in `<data_dir>/skills/` (first), public references in `<data_dir>/skills-discovered/` (`discovered`, never in `library`); a step is given those whose tools it names, never a public one. Public references retain origin, immutable blob revision and content hash, and are only shown, marked unchecked, to the model writing this machine's skill | `skills.py` | `library`, `for_step` (`quality.node_prompt`), `section`, `save_machine`, `save_discovered` |
| Optional reuse-first skill preparation: local machine or general skill → otherwise bounded sandbox generation, given a public reference when one is cached or found by a bounded GitHub repository/tree/blob search (only when the task permits network; `Preflighting._public_reference`). No remote install scripts run. Discovery is at most 30 seconds and 12 requests; generation uses `skill_preparation_timeout` and `skill_generation_max_turns`. Failures remain advisory | `skill_discovery.py`, `preflight.py` | `discover`, `Discovery`, `_prepare_skills`; `skill_reuse_first` (off by default); events `run.skill_searching`, `run.skill_selected`, `run.skill_generating` |
| The check before a task's first step, in a real step sandbox with the task's settings: the sandbox's output and exit code, the tools the lead listed (`TaskPlan.requires`, from `OUTLINE_PROMPT`) and, as warnings, the programs the steps' checks call, the internet, each API model; the same tool and internet checks in Codex's own sandbox, under the steps' permission profile, when Codex may run the task's steps, and a warning if it can read the platform's database or Codex's login (`cli_checks` → `CliChannelRegistry.sandbox_run`, `codex sandbox`, no model); one environment repair, then a pause with what is missing (going on runs anyway); then this machine's skill for each special tool the task needs, written by a model trying it in a step's sandbox and kept for later tasks (`_prepare_skills`, `needed_tools`, `tool_groups`, `skill_prompt`; setting `preflight_skills`); bash's complaints about the hidden home's startup files (`SHELL_NOISE`) are not a failure; FluidForm's own sandbox checks still failing after the repair go to the platform engineer (`_preflight_engineer`, via `engineer_join`, once) | `preflight.py` (mixed into `Executor`) | `Preflighting._preflight`, `_all_checks`, `sandbox_checks`, `cli_checks`, `tool_commands`, `_model_checks`, `_preflight_repair`, `repair_prompt`; `ExecutionRun.preflight`, settings `preflight`, `preflight_command_timeout`, `preflight_network_url` |
| Looking back on naturally finished tasks: each step's estimate against its cost and turns, its problems named by kind and key, counted across tasks, marked when they come back after a repair; a diagnosis is told the same problem's earlier cases. When a task ends the cheapest configured API model names each problem by its cause, reusing names already given (`name_problems`, setting `problem_naming`; kept when recorded again); `topics` groups problems across tasks by those names and `similar` lists a topic holding any of a failing step's names first; the 常见故障 page (`frontend/problems.tsx`) shows them. Automatic records and backfill exclude manual cancellation; saved history remains readable | `retrospect.py` | `record` (on `END_EVENTS` in `Executor.emit`), `Executor._name_problems`, `name_problems`, `topics`, `AUTOMATIC`, `review`, `repaired_areas`, `program`, `recurring`, `similar` (`diagnosis.repair_prompt` `history`); `calibration`, `calibrated_cost` (each model's past overrun and the cost outside steps, shown only as `CostEstimate.calibrated_usd` by `GET /api/tasks` and `GET /api/tasks/{id}`; budget checks keep the planned estimate); API `/api/retrospectives/recurring`, `/api/retrospectives/topics`, `/api/tasks/{id}/retrospective` |
| Turning retrospectives into verified improvements: separate bounded budget, recorded evidence, sandbox checks for skills, independent review for skills/advisory rules, platform engineer jobs for source/platform rules (each waits for the user's approval of its plan and of its result); a checked skill lesson is written into this machine's skill for its tools (`skills.add_lesson`, newest first, taken out on disable by `skills.remove_lesson`) and then not repeated as a separate lesson; immutable lesson snapshots in later plans and steps, comparisons only with the same model/difficulty mix | `learning.py` (mixed into `Executor`) | `Learning.finish_learning`, `start_learning`, `_learn`, `_validate_lesson`, `_learning_engineer`, `restore_learning`, `sync_improvements`; `selected`, `attach`, `instruction`, `observe`; `LearningSettings`, `LearningReview`, `Improvement`, `ExecutionRun.improvement_uses`; tables `learning_reviews`, `improvements`, `improvement_effects`, `learning_settings`; API `/api/tasks/{id}/learning`, `/api/improvements`, `/api/improvements/settings`, `/api/improvements/{id}/disable`; `docs/design/continuous-improvement.md` |
| Project employees and delegation | `team.py`, `models.py`, `executor.py` | `employee_teams` (on by default): `form` chooses staff/models/capabilities/Skills before the tasks are planned; `Employee`, `PlanPart.employee_id`, `TaskNode.employee_id`; `route` preserves the chosen model, `context` supplies shared requirements/interfaces and delivery history, `refresh_skills` snapshots assigned instructions. `DELEGATE_TASKS` requests become validated child nodes in the same run; `_delegate_result` atomically saves the child graph and yielded parent, which resumes only after accepted children. One active task per employee, provider-aware admission, inherited contract costs/turns via `governors`. `frontend/team.tsx` shows staff, tasks, delegation and shared agreements. See `docs/design/project-team.md`. |
| Planning | `planner.py` | `autonomous_plan` (by the lead when one is available: `_plan_as_lead`), `_validate_plan` (flat plan, when no lead plans), `task_node`, `WORK_RULES`; project work as small packages (`TaskNode.files/reads/provides/check`, `package`, `scope_problems` sends broad steps back to the lead) |
| Executable task planning | `task_planning.py`, `lead_planning.py`, `planner.py`, `api.py` | `plan_tasks` returns complete task matters, owners, dependencies and acceptance in one go; `lead_planning` holds what the lead's planning conversations share (`_ask`, `plan_title`, `MAX_TASKS`, `INTERNET_NOTE`). Reuses task parsing, contract gates and employee routing. See `docs/design/direct-task-planning.md`. |
| Chats: only a conversation with one model, no plan or steps (`ExecutionRun.kind == "chat"`, kept as `draft`, so nothing schedules it; only chats among drafts can be deleted, `Database.delete_run(chat=True)`). Its messages are the lead conversation's (`start_lead_chat`, `supervisor.chat_opening`/`CHAT_ROLE`; a lost conversation is handed over with `chat_transcript`). With a project the conversation runs there (`supervisor.chat_folder`): a CLI lead's read-only profile; API models see no files. A chat's attachments (`ExecutionRun.attachments`) go to the lead with the first call that has not had them (`ask_lead`, `ExecutionRun.lead_seen_attachments`; `providers.converse(attachments=)`): an API model gets text inline and images as images (only models not known blind are offered, `chat_models(needs_vision=)`); a CLI is given their paths and may read just those folders (`codex_step_permissions(readable=)`, Claude `--add-dir`), Codex also `--image`. They go with the task it becomes. Turning it into a task plans it in place with the conversation as its background (`promote_chat`, `_make_plan(context=)`). Left to Super Partner (the composer's 自动, the default), the cheapest API model tells a chat from a task (`triage.classify`, told the attachments' names; failure or no such model mean a task) and the record is marked `auto_routed`; a task waiting for confirmation can become a chat (`task_to_chat`) | `api.py`, `supervisor.py`, `leading.py`, `triage.py`, `frontend/chat.tsx` | `create_chat`, `start` (`POST /api/start`), `task_to_chat` (`POST /api/tasks/{id}/as-chat`), `chat_models` (`GET /api/chats/models`), `promote_chat` (`POST /api/tasks/{id}/promote`); tests `test_chat.py` |
| Faster small tasks (docs/design/faster-tasks.md): with `quick_tasks` a task the cheapest model judges one model can do in one go (`triage.quick`) gets a one-step easy plan without the lead (`api._quick_plan`); with `review_easy_steps` off easy steps stand on their own result (`review.py`); with `preflight_cache_minutes` a passed preflight stands for the next task alike (`preflight.cache_key`, `passed_before`) | `triage.py`, `api.py`, `review.py`, `preflight.py` | tests `test_quick.py` |
| Quick jobs in chats (docs/design/chat-tools.md): with `chat_tools` (off by default) an API model answering a chat without a project gets the steps' tools in the chat's own folder (`<workspace_root>/<folder_id>`), the internet with `chat_tools_network`, at most `chat_tool_turns` calls and `chat_tool_seconds` per message; bigger work is a task (TASK line in automation chats) | `supervisor.py`, `providers.py`, `config.py` | `chat_tools`, `chat_tools_note`, `tool_skills`, `ProviderRegistry.converse(tools=)`; tests `test_chat.py` |
| Pictures (docs/design/image-generation.md): with `image_models` (empty by default) API models that may write get the `GenerateImage` tool, which makes a picture with the first image model that does (`images.generate`: MiniMax, Zhipu CogView, each with its chat key), saves it in the working directory and charges it by the picture to the call's budget; steps marked `needs_images` go only to API models | `images.py`, `agent.py`, `providers.py`, `budget.py`, `routing.py`, `planner.py` | `generate`, `available`, `IMAGE_TOOL`, `Workspace.generate_image`, `RequestBudget.can_spend`/`record_usd`, `TaskNode.needs_images`; tests `test_images.py` |
| One model carrying a task through (docs/design/faster-tasks.md): with `solo_tasks` the cheapest model also judges whether one strong model can do the work alone with its tools (`triage.SHAPE_PROMPT` "solo"), in a project too; such a task gets one hard step, without the lead | `triage.py`, `api.py` | `quick(solo=, project=)`, `_quick_plan`; tests `test_quick.py` |
| Going on after a restart (docs/design/faster-tasks.md): with `resume_after_restart` a task cut off by a restart, in no project and waiting for nobody, is queued again at startup; finished steps keep their results | `api.py` | `resumes_by_itself`, `lifespan`, event `run.restart_resumed`; tests `test_durable.py` |
| Profiles (docs/design/faster-tasks.md): `profile` (fast, balanced, careful) sets a group of settings, each still overridden when given on its own; picked in 设置 → 工作方式 (`GET/PUT /api/settings/profile`), applied at once and saved in `<data_dir>/profile.json` | `config.py`, `api.py`, `frontend/memory.tsx` | `PROFILES`, `Settings.apply_profile`/`use_profile`/`load_saved_profile`, `ProfilePicker`; tests `test_profiles.py`, `test_memory.py` |
| Chat actions as tools (docs/design/chat-actions.md): with `chat_action_tools` a chat with tools calls StartTask, SendFile, CallEngineer (and Remember, Forget) instead of writing lines; each call is noted as its line at the end of the answer, read as before | `chat_actions.py`, `providers.py`, `agent.py`, `supervisor.py` | `pending`, `offered`, `run`, `with_actions`, `chat_action_names`; tests `test_chat_actions.py` |
| Remembering people (docs/design/chat-actions.md): with `user_memory` chats keep REMEMBER facts (no secrets, at most 30 per place) in `<data_dir>/memory.json`, by place (`web` for the owner's chats, `<capability>:<conversation>` for an automation's), and every new chat there is told them; 设置 → 记住的事 lists and deletes them (`GET /api/memory`, `POST /api/memory/forget`) | `remembering.py`, `api.py`, `leading.py`, `supervisor.py`, `frontend/memory.tsx` | `split`, `take`, `told`, `facts`, `delete`, `api._remember`, `MemoryPage`; tests `test_memory.py`, `test_capability_packages.py` |
| MCP tools (docs/design/mcp-and-web.md): `mcp_servers` lists MCP servers (argv, keyring secrets); their tools are listed once and offered to API models that may act as `mcp__<server>__<tool>`; every call starts the server in the step's own sandbox over real pipes | `mcp.py`, `agent.py`, `providers.py` | `definitions`, `call`, `Session`, `LISTED`; tests `test_mcp.py` |
| Web search and reading (docs/design/mcp-and-web.md): with `web_search_models` (e.g. `glm:search_std`) the `WebSearch` tool, charged by the search; with `web_fetch` the `WebFetch` tool, public addresses only (checked after every redirect); both only for steps and chats allowed the internet | `web.py`, `agent.py`, `providers.py` | `tools_for`, `search`, `fetch`, `Workspace.web_search`/`web_fetch`; tests `test_web.py` |
| One platform engineer (docs/design/one-engineer.md): with `engineer_repairs` the lead asks for any repair or component with `call_engineer` (kind repair or component) instead of repair_environment / repair_platform / request_component, which still parse; the repair session (`diagnosing._repair`, the code still says diagnosis) is the platform engineer and finds whether the machine or FluidForm is at fault (`diagnosis.ENGINEER_CALLED`, `PLATFORM_REPAIR`); the lead is told what it found and did on a step (`supervisor.engineer_looks`); the UI calls every diagnosis 平台工程师 | `supervisor.py`, `leading.py`, `diagnosis.py`, `frontend/diagnosis.tsx` | `offered_actions`, `SEPARATE_REPAIRS`, `engineer_looks`, `ENGINEER`; tests `test_leading.py` |
| Defaults (docs/design/fewer-settings.md): the features above are on without any setting; image and search models default to every known one whose provider has a key (`images.AUTO`, `web.AUTO`); the only profile is careful (`fast`/`balanced` read as none); tests run with the former defaults (`conftest.former_defaults`) and turn on what they test | `config.py`, `images.py`, `web.py` | `PROFILES`, `FORMER_PROFILES`; tests `test_defaults.py` |
| Evals (docs/design/evals.md): `super-partner eval [suite]` runs the cases of `evals/basic.json` on the live service through its API, judges them, and compares with an earlier report | `evals.py`, `cli.py`, `evals/` | `run_suite`, `judge`, `compare`; tests `test_evals.py` |
| Files in every box (docs/design/message-attachments.md): each text box takes pasted or dropped files and has a paperclip (`attachments.tsx`: `takesFiles`, `ClipButton`, `SentFiles`). Sent to a task (a message to its lead, an answer to its question) they join its attachments (`attachments.attach`, at most `MAX_TASK_ATTACHMENTS`), so its later steps see them and the lead is given them with its next call; kept on the message (`LeadMessage`/`DiagnosisMessage.attachments`). Sent to the platform engineer they are the job's (`EngineerJob.attachments`, each `EngineerMessage`'s), given to its model with each call. 需求变更 and 转成任务 take files for the new task | `api.py`, `attachments.py`, `leading.py`, `executor.py`, `engineer.py`, `frontend/attachments.tsx` | `ask_lead` (`POST /api/tasks/{id}/lead`), `reply_to_diagnosis`, `engineer_request`/`engineer_reply`/`engineer_join`, `promote_chat`, `follow_up_task`; tests `test_chat.py`, `test_engineer.py`, `mission-actions.test.mjs` |
| Capability packages (docs/design/capability-packages.md): a capability uploaded as a zip (`capability.json`, code, optional `SKILL.md`, `requirements.txt`) and uninstalled on its own, with its data, state and keyring secrets (`capability/<id>/<VAR>`). Its environment is built and its check run in the capabilities' sandbox: home and data hidden, its folder read-only, only `<data_dir>/capability-data/<id>/` writable, no network but `DomainProxy` (CONNECT only to declared hosts, bridged in by socat). Uploaded ones start disabled; enabling needs `confirmed`. Enabled automations run as their `entry` under `capability_runner.Runner` (JSON lines on stdin/stdout, restarts, log, daily budget, state in `<data_dir>/capability-host/<id>.json`); what someone asks becomes a chat answer or a task waiting for confirmation (`api.automation_message`, triage as 新建's 自动), with files it sends from its data folder taken in as attachments (`capability_runner.take_files`), and `ExecutionRun.origin` + `Executor.end_listeners` (`api.automation_task_ended`) tell the automation how the task ended. Off unless `settings.capability_packages`. The Feishu bot is a package, kept on the `capabilities` branch apart from this source | `capability_packages.py`, `capability_sandbox.py`, `capability_runner.py`, `api.py`, `secrets.py`, `frontend/capabilities.tsx` | `POST /api/capabilities/upload`, `GET /api/capabilities/runtime`, `PUT/DELETE /api/capabilities/{id}/secrets`, `PUT /api/capabilities/{id}/budget`; tests `test_capability_packages.py`, `mission-actions.test.mjs` |
| Capabilities: what a finished task left the platform able to do (docs/design/capabilities.md). With `capability_proposals` (off by default), a succeeded task's lead is asked in the background for up to three cards (`ExecutionRun.capability_proposals`); the user solidifies one from the result page: its files, only from inside the task's folder and bounded, are copied to `<tools_dir>/capabilities/<id>/capability.json` and its check runs in a step's sandbox without network (failed ones stay, marked, and cannot be enabled). Active tools are told to every step (`quality.node_prompt`) and planner (`_make_plan`). Listed and switched on the platform engineer page (`frontend/capabilities.tsx` `CapabilityShelf`); automations wait for a runner | `capabilities.py`, `leading.py`, `api.py`, `models.py` | `read_cards`, `solidify`, `check`, `library`, `section`; `start_capability_proposals`; API `/api/capabilities`, `/api/tasks/{id}/capabilities/{n}/solidify|dismiss`; tests `test_capabilities.py` |
| The task's lead: one conversation from planning to the end (docs/design/supervisor.md) | `supervisor.py` | `candidates`, `ask`, `handover`, `trim`; `Executor.ask_lead`, `ProviderRegistry.converse`, `CliChannelRegistry.converse`, `ExecutionRun.supervisor` |
| Model choice | `routing.py` | `route_node` (first pick; a hard step takes the cheapest within `hard_score_margin` of the best, `close_to_best`), `strongest_for` (retry), `stronger_than` (escalation), `spread_to` (a step past its provider's share of the running steps, `Executor._spread`, settings `max_steps_per_provider` (off by default), `spread_cost_factor`), `pick_reviewer` (the cheapest model no weaker overall than the one checked, `CapabilityScore.overall`), `diagnosers`; `node_cost` (an API model's tool loop turn by turn, cached input at the cache price: `LOOP_*`), `reestimate` (after splitting or replanning) |
| Scheduling, attempts, step outcomes | `executor.py` | `Executor`; see "Executor" below |
| Step acceptance is off by default (`settings.acceptance`): a step that finishes has passed (`Reviewing._check` returns at once; a step's own UNABLE/BLOCKED still fails it), declared checks and artifact acceptance commands are not run, `contracts.accepted` revalidates nothing, a verification step's FAIL sends nothing back, and plans are asked for without verification steps (`planner.NO_ACCEPTANCE_NOTE`). The lead's final check of the whole result (`Leading._final_review`) stays, as do progress checks, contract turn/cost limits and the budget. With it on, everything below applies | `config.py`, `review.py`, `contracts.py`, `planner.py` | `acceptance`; tests `test_acceptance_off.py` (the other tests run with it on, `tests/conftest.py`) |
| Reviewing a result. An API reviewer reads with Read/Glob/Grep/LS and, where bwrap exists, runs commands (`agent.REVIEW_TOOLS`): the workspace mounted read-only, its credentials hidden (`quality.private_paths`), no network or local services, its own /tmp writable to rerun a check on a copy | `review.py` (mixed into `Executor`), `agent.py` | `_check`, `_reviewer`, `MAX_BACKUPS`; `Workspace(read_only=True)`, `REVIEW_COMMANDS`, `_private` |
| The lead's decisions after a failed attempt, and its questions to the user; while it decides, `ExecutionRun.lead_thinking` (`_thinking`); a repair it asks for (`Diagnosis.trigger == "lead_repair"`, `decision_id`) comes back to it (`_after_repair`) before the step runs again | `leading.py` (mixed into `Executor`) | `_decide`, `_ask_for_decision`, `_apply_decision`, `_after_repair`, `_decisions_left`, `start_lead_answer`, `start_lead_chat`; prompts in `supervisor.failure_message`, `repair_message`, `parse_decision` |
| Diagnosing failures and acting on them (when no lead decides; repairs the lead asks for) | `diagnosing.py` (mixed into `Executor`) | `_repair`, `_diagnose_with`, `_repair_done`, `begin_diagnosis`, `_run_diagnosis` |
| Repairing Super Partner itself (flow) | `self_repair.py` (mixed into `Executor`) | `_fix_platform`, `_activate_platform`, `_hold_for_platform`, `restore_platform`, `_finish_platform` (a repair the lead asked for goes back to it: `_platform_to_lead`) |
| The platform engineer: repairs and components the user (or a lead) asks for, as jobs; plan → approve → build in a copy → check → approve → apply → git commit (docs/design/platform-engineer.md); while it works, its model's commands, file changes and messages and the platform's checks show on its page (`Executor.engineer_logs`, `GET /api/engineer/jobs/{id}/activity`, `JobActivity` reusing `ToolLog`) | `engineer.py` (mixed into `Executor`) | `EngineerJob`, `engineer_request`, `engineer_join` (into a task's conversation with its lead: by the user, the lead's chat `supervisor.split_engineer`, or any decision's `engineer` field; the lead hears progress, `_engineer_news`/`engineer_updates`), `engineer_reply`, `engineer_approve`, `engineer_reject`, `_engineer_run`, `_engineer_apply`, `_engineer_finished`, `_engineer_to_lead`, `commit`; API `/api/engineer`; prompts `plan_prompt`, `edit_prompt`; guide `skills/platform-engineer/SKILL.md` |
| Changing a running task's plan at the lead's decision | `replan.py` | `change_plan`, `PlanError` |
| What happens after a failure without a lead (fallback: retry model, meaning of a diagnosis) | `recovery.py` | `retry_model`, `failed_models`, `after_diagnosis`, `turns_for`, `MODEL_FAILURES` |
| Prompts for steps and reviews, verdict parsing | `quality.py` | `node_prompt`, `continue_prompt`, `attempt_notes`, `review_prompt`, `parse_review`, `UNABLE_RULE`, `unable_claim`, `retry_feedback` |
| Diagnosis prompts and parsing | `diagnosis.py` | `prompt`, `repair_prompt`, `platform_instructions`, `parse`, `STATUS` |
| API model calls, output caps, tool loop | `providers.py` | `ProviderRegistry.complete`, `_send`, `output_ceiling`, `_loop`, `_answer`, `_cache_point`, `reasoning_fields`; rejected effort is visibly recorded, or rejected outright with `reasoning_fallback=strict`; complete tool traces remain in `NodeAttempt.trace` |
| Durable conversations and structured memory | `conversation.py`, `providers.py`, `executor.py` | `Conversation`, `flush`, `reopen`, `handoff`, `_compact_context`, `Executor._conversation`; OpenAI-compatible/Anthropic/Gemini checkpoints at tool intent and each completion; generation/dependency/request fences; original archives accessible only through task-step-scoped `RecallHistory` |
| API keys: saved in the OS keyring, read at startup by a killable child process; a keyring that is locked, missing or slow is marked unavailable and read again every 30 s until it answers, then those providers' quota marks are cleared; `/api/providers` reports `keyring_locked`, the provider card shows 密钥环未解锁 | `secrets.py`, `api.py` (lifespan) | `hydrate_provider_keys`, `keep_loading_keys`, `keyring_unavailable`, `set_provider_key`, `delete_provider_key`; `/health` `keyring_unavailable` |
| Membership CLIs priced by their subscription (`cli_plans`, e.g. Codex $200/month): Codex's quota from its session files (`$CODEX_HOME/sessions`, `token_count` rate limits), the platform's own Codex calls from a ledger kept apart from tasks (`<data_dir>/cli_usage.jsonl`, written by `calls.usage`; sessions in the leads' folders are left out as already counted); from a baseline reading, tokens over quota used give the price (until then the plan's optional `input_per_million`/`output_per_million`, also used when usage cannot be read), set as the CLI's catalog price so charging, budgets, routing and team choice use it, never above the provider's dearest API model still offered (`api_ceiling`: quota used where its tokens cannot be seen, another machine or the web, would otherwise price it far too high; the note says so); from `cli_quota_soft_percent` it loses first place in routing and the lead is told, from `cli_quota_stop_percent` it is marked out of quota until the window resets; refreshed every minute. The session files go quiet once Codex is stopped, and a window can reset early, so a reading older than `STALE_MINUTES` is replaced by Codex's app server (`ask_codex`, `account/rateLimits/read`, no model call), asked at most every `ASK_MINUTES`. With `cli_free` (off by default) the quota is still read and guarded, but every CLI is priced at 0, so it counts against no budget and its note leaves out the price | `cli_quota.py`, `calls.py`, `api.py` (lifespan), `team.py` | `CodexReader.read`, `ask_codex`, `record`, `recorded`, `price_per_million`, `api_ceiling`, `starting_price`, `apply`, `keep_applying`; `ModelProfile.usage_note`; `QuotaTracker.mark(until=)` |
| Call telemetry and admission | `calls.py`, `call_control.py` | `observed`, `ProviderGate`; request/retry counts, requested/sent effort, observed tokens/cache writes/reads, unknown usage, duration and queue time; configured provider-wide concurrency/RPM/TPM, shared Retry-After cooldown; `/api/tasks/{id}/calls` |
| Historical delivery cost | `routing_feedback.py`, `routing.py` | `collect`, `expected_cost`; minimum eight distinct steps per model/capability/difficulty, smoothed success probability and observed rework cost, bounded latency weight; applied before an automatically routed step's first attempt |
| Optional tool extensions and hooks | `extensions.py`, `agent.py` | `api_tool_extensions`, `api_tool_hooks`: JSON-schema-checked command tools and before/after hooks through the existing Workspace sandbox; empty by default; excluded from read-only review and host repair modes |
| Streamed replies (server-sent events) put back together into the provider's non-streamed reply; a request stops only when nothing arrives for `api_reply_deadline` (`ProviderRegistry._post`, `_stream`, `StreamSilent`) | `streaming.py` | `openai`, `anthropic`, `gemini`, `events`, `StreamError` |
| Codex's sandbox for steps and leads: its own permission profiles (bubblewrap), passed with `-c` on every call. A step (`super-partner-step`, extends `:workspace`): this account's home, the platform's data and the tasks' folders denied entry by entry except its own folder, Codex's install and helper folder and the tools folder; the shared /tmp denied and a TMPDIR of its own per call; the internet when the task allows it. A lead (`super-partner-lead`, extends `:read-only`): the same, the tasks' folders readable | `cli_channels.py` | `codex_step_permissions`, `_deny_except`, `private_tmp`, `codex_home`, `codex_package`, `CODEX_STEP_PROFILE`, `CODEX_LEAD_PROFILE` |
| CLI model calls and their sandboxes | `cli_channels.py` | `CliChannelRegistry.complete`, `_with_network`, `repair_command` (the real /dev), `codex_settings` (Codex runs with the platform's reasoning effort, the lead's service tier, and without the user's plugins, apps and MCP servers: `CODEX_EXTRAS`, `codex_servers`); what a CLI step is told about its sandbox: `quality.cli_environment` |
| Readable folder names (`20261021-1441-async-fifo-uvm`) for tasks and leads; leads' folders outside any project. Tasks' folders are under `workspace_root`, which a machine sets in `.env` (`SUPER_PARTNER_WORKSPACE_ROOT`) to a folder outside the platform's repository, so CLI agents there do not read its AGENTS.md and CLAUDE.md; `scripts/service.sh` reads it from the environment or `.env` (`setting`), else uses the repository's `workspaces/` | `folders.py` | `task_folder` (`ExecutionRun.folder_name`, from the plan's `folder`), `lead_folder`, `lead_root` (setting `lead_root`) |
| Project brief for planning (file summaries by the cheapest API model, refreshed for changed files only), and the files a step is given: a package's own files in full, otherwise the file list and the files it names | `briefing.py` | `planning_brief`, `refresh`, `render`, `attached_files`, `likely_files`; `Executor._with_files`, `quality.scope_section`, `routing.brief_writer` |
| A work package far past its expected turns goes to the lead (continue, or stop and then split) | `progress.py`, `review.py` | `expected_turns`, `OVERRUN_FACTOR`; `_overrun_check`, `supervisor.overrun_message` |
| Steps in one project at once: disjoint package files, or disjoint owned folders (`TaskNode.folders`, asked of the direct planner when files are not known yet; the step is told to write only there, `quality.folders_section`), run together; unscoped steps alone. A step waiting for the folder shows as queued (`waiting_for_folder`, events `node.queued`/`node.dequeued`) and its time starts when it gets in. What a step actually changed is told to the steps still in the folder when it leaves (`Scope.changed`), and a step that changed a file a step alongside reads, when no one else there could have, does not pass (`Scope.intrusions`, `Executor.intrusions`) | `scopes.py`, `executor.py`, `task_planning.py`, `planner.py` | `FolderLock.hold`, `FolderLock.busy`, `Scope.clashes`, `Scope.own`, `Scope.intrusions`; `Executor._work`, `Executor._note_queued`; `planner.package`; tests `test_scopes.py`, `test_direct_planning.py` |
| Tools and sandbox for API models: Bash, Read, Write, Edit, MultiEdit, Glob, Grep, LS; Bash keeps its directory and the attempt's /tmp; platform data and other task folders stay hidden | `agent.py` | `TOOLS`, `Workspace.run`, `run_all` (reads at once unless hooks are configured), `bash`, `sandbox_args`, `network_prefix`; structured compaction `providers._compact_context`; effort by difficulty `settings.reasoning_by_difficulty`, for leads `lead_reasoning_effort`, for diagnoses `diagnosis_reasoning_effort` |
| Checking long attempts by default; explicit artifact contracts have hard cumulative limits; a step others wait for far past its expected minutes goes to the lead (`Review._critical_check`, `supervisor.critical_overrun_message`) | `progress.py` | `check_prompt`, `parse`, `api_evidence`, `cli_evidence`, `Stopped`, `limit_reason`; the check itself is `Executor._progress_watch` (review.py) |
| Per-request budget reservations, cost of a call | `budget.py` | `RequestBudget.reserve`, `token_cost` (cached input at the cache price; `providers.cached_tokens`) |
| Quota / outage detection and cooldown | `quota.py` | `QuotaTracker.classify`, `mark`, `exhausted` |
| Shared machine fixes (tools dir, env) | `environment.py` | `tools_dir`, `command_env`, `profiles`, `shell_setup` (scripts each step command sources first: setting `sandbox_profiles` or `"profiles"` in `sandbox.json`), `host_ports` (with `license_daemon_ports`: a license server's vendor daemons, from lmgrd's process tree in /proc, or for an lmgrd of another user by tracing `lmutil lmstat`: `_probe`, cached `PROBE_TTL`) |
| Self-repair: isolated copy, checks, activation | `platform_repair.py` | `PlatformRepairs.prepare`, `check`, `load`, `stale`, `diff`, `activate`, `SOURCE_DIRS` |
| Model catalog and benchmark scores | `catalog_sync.py`, `benchmarks.py`, `scoring.py` | `public_models`, `match_results`, `rescore` |
| Results listing, ZIP, GitHub publish | `publish.py` | `SKIP`, `result_markdown` |
| Settings (env `SUPER_PARTNER_*`) | `config.py` | `settings` |

Automation chat preferences live in `capability_runner.Automation.state` (`model_id`, automatic
when absent/null, and `chat_preferences` for the last applied choice per chat), independently of
package code and secrets. `PUT /api/capabilities/{id}/model` validates uploaded automations against
`chat_models`; runtime exposes the saved choice to 平台 → 能力 → 聊天模型. `automation_message`
applies it before a reply starts, after any pending reply finishes. A changed model gets a fresh
session; `supervisor.chat_opening` hands over recent messages via the existing bounded transcript.
Restoring automatic chooses afresh, while unchanged automatic chats retain their conversation.
Unavailable selections/call failures use the normal fallback and disclose the actual replying
model; classification and task planning/execution keep their existing selection policies.

## Executor

`Executor` (`executor.py`) mixes in `Reviewing` (`review.py`), `Leading` (`leading.py`), `Diagnosing`
(`diagnosing.py`), `SelfRepair` (`self_repair.py`) and `Engineering` (`engineer.py`); they share its state (`db`, `locks`, `_complete`, `_save`, `emit`).

- `execute` / `_dispatch`: the run loop; starts every ready node, or up to `max_parallel_nodes` when that is set (0, the default: no limit).
- `_head_start` (setting `head_start`, off by default; `head_start_minutes`): with room left, `_dispatch` starts a
  step whose dependencies are still to do or at work, once per generation and before its first attempt, if its
  model edits files, it has files or folders of its own and the folder would let it in now (`_can_head_start`; one that finds it in use stops, `FolderBusy`, and may start early later). `quality.head_start_prompt` asks
  for only what needs none of their results; no review, no attempt, no progress watch, cost charged as usual.
  `TaskNode.preparing`/`head_start`/`head_start_generation`; the report goes into the first attempt's prompt
  (`quality.HEAD_START_DONE`); events `node.head_start`, `node.head_started`; tests `test_scopes.py`.
- `_admit_tool_channel`: before dispatch and again after final model selection, checks declared
  tool-limit enforcement, authorization, routing eligibility and cumulative limits. A compatible
  replacement must also fit the remaining run/step budgets and other dispatched work's reservations.
- `_execute_node`: one attempt; exceptions map to outcomes (`budget`, `error`, quota → `_switch_model`).
- `_check` (review.py): review or verification verdict; `quality.Verdict(passed, reason, fix, unable, ...)`.
- `_finish`: appends the `NodeAttempt` with an `Outcome`.
- After a failure (when `auto_diagnose`): the lead decides (`_decide`, leading.py): retry, switch
  model, accept, unable, ask the user, or a repair, which runs `_repair` with its brief. Without a
  lead able to decide: `_repair` then `_repair_done` (diagnosing.py), which carries out
  `recovery.after_diagnosis(outcome, status)`: hold for a platform repair, ask the user, switch
  model, retry after an environment fix, mark unable (`_mark_unable`), pause, or retry.
- `_retry_or_fail`: counts the failure and fails the node or retries it on
  `recovery.retry_model` (a model that failed the node twice in a row gives way).
- A failed verification goes to the lead too (`supervisor.verification_message`): rework chosen
  steps with what to change (`_send_back(..., limited=False)`), accept, or rerun the verification.
  Without a lead, `_send_back` reopens all verified steps, capped by max_rework_rounds.
- `_fix_platform` → `platform_repair.check` → `_activate_platform` (self_repair.py): self-repair,
  applied by restart.

Artifact work packages add gates without replacing the original acceptance criteria, task budget,
or sandbox permissions. Planning separates VDB collection, URG text reports and delivery audit
when these jobs are requested; it does not require all three for a report from an existing VDB,
a collection-only request, or unrelated coverage work. Flat planning, the lead's task planning and replanning
share `contracts` validation; an invalid contract cannot fall back to an unbounded plan. Dependency
inputs must name an ancestor's declared output; external inputs need no producer. Outputs are
allowed to be absent before the step runs. VDBs are directories; overlapping directory/file scopes
are serialized by `scopes.py`.

`Executor._work` records the input fingerprints and the generation's output baseline before a
contracted step runs. `Reviewing._artifact_check` checks nonempty, fresh files/directories and runs
the declared commands through the ordinary `agent.Workspace` sandbox. Command results are saved in
the attempt trace and `ArtifactEvidence`, then the original review still applies. A consumer checks
the producer's accepted evidence and current fingerprints (including transitive inputs), so a changed
VDB invalidates its old report. Evidence paths reject traversal, symlinks and private files. A missing
audit output does not send already accepted upstream work back for rework.

`RequestBudget` preserves run-wide reservations and additionally caps a contracted step's calls,
including its reviews/progress checks. Calls for that step share reservations. Worker request turns
and all associated API charges are persisted at each request and survive retry, model switch,
rework and restart. In addition to the unchanged request cap, `max_turns` limits individual worker
tool invocations: each batch item, failed tool and history recall counts once. `contract_tool_calls`
is debited under the run lock before execution, against the step and every delegated ancestor;
parallel siblings share that allowance. Interrupted invocations remain counted because their side
effects may exist. Acceptance commands and reviewer/control calls retain their existing policy.
The tool loop refuses excess items before side effects and waits for admitted parallel reads to
settle before returning a rejection. Neither cap permits an extra paid summary request.

`ProviderRegistry.tool_limit_capabilities` declares the platform-owned API loop's `tool_call`
counting unit and hard interception; CLI adapters declare these unsupported, regardless of their
reported provider turns. Missing declarations also fail closed. Admission can choose an authorized,
eligible compatible model without altering the contract, task permissions, sandbox, or acceptance
criteria. When no such channel fits, `node.blocked` records `started=false`, required and declared
capabilities, authorization/eligibility/budget checks, cumulative request/tool/cost counts and
affected dependency IDs. No `node.started` event or `NodeAttempt` is created for this rejection.
Stored counts have defaults for old records; existing request/cost totals are retained. Upstream
artifact acceptance is rechecked before a consumer starts and again in the ordinary input gate.
Missing prerequisites or an explicit `BLOCKED` result also block; a
limit without accepted delivery records `Outcome.STOPPED`. `_stop_contract` preserves the attempt,
logs, charges and a deterministic task diagnosis, blocks consumers and ends incomplete without
automatic diagnosis/retry. Lead acceptance and replanning cannot erase these gates or limits.
Legacy records have no contract and retain their existing execution policy.

Artifact-stage inference distinguishes a report's input wording (such as "from VDB generate
URG report") from VDB production; declared VDB writes and genuinely combined production remain
separate-stage validation errors. Planning guidance and validation errors both state the existing
directory-kind and `.vdb` suffix requirement, avoiding needless whole-plan corrections.

Ordinary packages with a declared `check` now execute it in the task sandbox before model review.
A failed command cannot be overridden by the worker claiming success. Review selection treats
overall capability as a hard floor before API preference or independence; if only the producer
qualifies it is called in a fresh review conversation. With no qualified reviewer work remains
unverified. A progress check must explicitly return one valid CONTINUE; malformed conclusions stop
the attempt, and two successive failed progress checks cannot leave it running indefinitely.

API work conversations survive process loss, while startup still pauses interrupted tasks for
explicit resume. Checkpoints never replay an unrecorded tool completion automatically: its outcome
is unknown and must be inspected. Same-model continuations retain native tool history; model changes
receive a bounded handoff plus an archive reference. Near 65% of the context window, the same model
writes a six-field JSON memory. Only validated summaries replace history, original user instructions
remain verbatim, and originals remain task-scoped and retrievable. Summaries count against existing
request budgets and contracted turns. A failed summary preserves the checkpoint and stops the
attempt. See `docs/design/call-runtime.md` for configuration and limits.

CLI attempt evidence is appended to `NodeAttempt.trace` while stdout/stderr arrive (`cli_channels`):
`cli.stdout` / `cli.stderr` records contain base64 bytes, `cli.exit` records the process exit code,
`cli.interrupted` / `cli.error` retain interruption reasons, and `cli.result` stores the parsed answer.
`activity` merges item IDs across the entire attempt; display limits do not truncate event correlation.
`ToolCall` preserves unknown/incomplete status, item IDs and exit codes; missing historical `ok`
never implies success. `NodeAttempt.result/result_source` bind an answer to its attempt. The executor
snapshots logs and retains the returned answer until the attempt is saved, then releases them.
Diagnosis and the UI label unassociated legacy output explicitly. After a platform repair, failed
attempts retain their outcome and receive evidence-inspection instructions before continuation;
activation itself never accepts a task or fabricates missing historical answers.

## Tests

| Area | Tests |
|---|---|
| Team formation, assignments, delegation, recovery and shared budgets | `tests/test_team.py` |
| Direct tasks without refinement; planning stage effort, deadlines and staffing reuse | `tests/test_direct_planning.py`, `tests/test_planning_latency.py` |
| Executor flow, retries | `tests/test_executor.py`, `test_recovery.py`, `test_recovery_regressions.py`, `test_turns.py`, `test_resume.py` |
| Diagnosis | `test_diagnosis.py`, `test_diagnosis_interaction.py` |
| Unable steps | `test_unable.py` |
| Network, sandbox, tools | `test_network.py`, `test_agent.py`, `test_safety.py` |
| Providers, output caps | `test_providers.py`, `test_streaming.py`, `test_quota.py` |
| Durable calls, memory, model handoff, telemetry, gates, hooks and history-based routing | `test_call_runtime.py`, `test_continue.py` |
| Looking back on tasks | `test_retrospect.py` |
| Learning from finished tasks, validation, budget, reuse, effect comparisons | `test_learning.py`, `test_engineer.py` (a retrospective's platform change waits for both approvals) |
| Folder names | `test_folders.py` |
| Steps others wait for | `test_critical_path.py` |
| The check before the first step | `test_preflight.py` |
| Pictures by image models | `test_images.py` |
| Skills | `test_skills.py` |
| Capabilities | `test_capabilities.py`, `test_capability_packages.py` |
| API keys and the keyring | `test_secrets.py` |
| Membership CLI pricing and quota | `test_cli_quota.py` |
| Spreading steps over providers | `test_spread.py` |
| Progress checks | `test_progress.py` |
| The lead's conversation | `test_supervisor.py` |
| The lead's decisions | `test_leading.py`, `test_replan.py` (plan changes, final review) |
| Project work packages | `test_packages.py` |
| Artifact contracts, freshness, audit gates and cumulative limits (temporary files and fake models, no URG dependency) | `test_packages.py`, `test_direct_planning.py`, `test_replan.py`, `test_executor.py`, `test_turns.py`, `test_progress.py`, `test_review_evidence.py`, `test_leading.py`, `test_safety.py`; helpers in `artifact_helpers.py` |
| Review prompts and evidence | `test_quality.py`, `test_review_evidence.py` |
| Platform self-repair | `test_platform_repair.py` |
| The platform engineer | `test_engineer.py` |
| Catalog and benchmarks | `test_catalog_sync.py`, `test_benchmarks.py`, `test_scoring.py` |
| API-level flows | `test_core.py`, `test_followup.py`, `test_task_deletion.py`, `test_publish.py` |
| Web UI | `frontend/tests/mission-actions.test.mjs` |

Commands: `python -m pytest -q tests/test_x.py` (one area), `python -m pytest -q` (all backend,
about 35 s), `cd frontend && npm test` and `npm run build` (only when the frontend changed).

Live network sandbox tests use `tests/conftest.py`'s `network_enabled` fixture to honor the
validation controller's `SUPER_PARTNER_VALIDATION_ALLOW_NETWORK` setting. Tests with both offline
and online cases request it only for the online case, so offline command checks still run.
`test_platform_repair.py` exercises these gates with simulated workspaces and both permissions;
it needs neither a real network namespace nor a TUN device.

## Frontend (`frontend/`)

`src.tsx` (app shell, task creation, actions), `chat.tsx` (a chat's page and turning it into a task; the composer's 任务/对话 switch is in `src.tsx`), `lead.tsx` (the task's conversation, or a chat's, in its own "对话" tab that opens when it waits for you: the lead's decisions, questions and messages), `lead-engineer.tsx` (the platform engineer in that conversation: its jobs' lines and cards, @平台工程师, bringing it in), `platform.tsx` (the 平台 page: the platform engineer's conversation, centred like 新建; beside it 能力 and 技能, each 更多 opening its page (`CapabilityShelf`, `SkillsPage`), then the recent conversations with a search over their names, requests and results; a task's jobs are one conversation, what the user starts is its own (`EngineerJob.thread_id`, `engineer.thread_of`); the main column shows the open one, each job followed by its result line, and its box goes on in it: a reply to what waits, or new work told what came before (`thread_context`); new conversations and what waits for the user's nod, with its buttons, when none is open; jobs' plain `headline`/`plan_plain`/`plain` from `engineer.plain_lines`), `engineer-bubble.tsx` (the platform engineer's own chat; its corner bubble is hidden now that 平台工程师 is in the sidebar's foot, beside 模型 and 设置), `result-page.tsx` (results, requirement change),
`plan-parts.tsx` (the progress view: major parts as stages that open in place, `PlanView`), `plan-graph.tsx` (steps and attempts), `engineer.tsx` (the platform engineer's page), `diagnosis.tsx` (diagnosis chat), `mission-history.tsx`
(task list), `model-profiles.tsx` (the 模型 page: models grouped as in use, ready but off, and waiting for a key or not installed, with their calls and spend over 30 days from `GET /api/models/usage`; the chosen model's details beside them, its scores and catalog facts folded; docs/design/models-page.md), `style.css` (tokens and styles).

`retrospective.tsx` is the result page's “复盘与改进” tab: learning settings and budget, conclusions,
items and validation evidence, platform-job progress, lessons used, effect comparisons and disabling future use.
`team.tsx` is the project’s “员工” tab: employee roles/models/Skills, assignments and task details, delegation parents, waiting children, and shared project agreements. Legacy runs show their unassigned tasks without inventing employees.

`call-insights.tsx` is its “模型调用” tab: sent effort and downgrade warnings, reported input/output/cache
tokens, missing usage, requests/retries and elapsed/queued time. Historical calls before this change
cannot be reconstructed and are not shown as zero usage.
