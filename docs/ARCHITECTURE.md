# FluidForm architecture map

A short map for finding code fast. Read this first, then open only the lines you need.
Keep it current: a change that moves a responsibility updates this file in the same patch.

## Life of a task

```
POST /api/tasks (Api.newTask) ── planner.autonomousPlan ── team.form (employee_teams: before task planning)
                                         ├─ task-planning.planTasks (the lead: executable tasks, employees,
                                         │      dependencies and acceptance in one go)
                                         └─ routing.routeNode        (plan, pick a model per step)
POST /api/tasks/{id}/confirm ── Executor.execute ── preflight                     (check sandbox, tools, internet, models first:
                                         │                                preflight.ts; repair once, else pause)
                                         └─ dispatch                    (run ready steps in parallel)
  executeNode ── work ── complete ── providers.complete             (one attempt of one step)
                                          ├─ cli-channels  (membership CLIs: claude, codex, ...)
                                          └─ agent.Workspace (API models' tools, bwrap sandbox)
  check   (verification steps: VERDICT line; others: a reviewer model, quality.reviewPrompt)
  finish  (record the NodeAttempt, then: passed / send back / diagnose / retry / unable)
  decide ── askLead ── applyDecision                                (the task's lead decides, leading.ts)
     ├─ retry / switch_model / accept / unable / ask_user / rework / replan (replan.ts)
     ├─ repair_environment / repair_platform ── repair (diagnosis with the lead's brief)
     └─ request_component ── engineerForLead (task waits; the platform engineer's job, engineer.ts)
  repair ── diagnoseWith ── repairDone                             (fallback: no lead decides)
     └─ STATUS: PLATFORM_REPAIR ── fixPlatform ── platform-repair     (fix FluidForm itself)
  all steps done ── finalReview (the lead: done / rework / replan) ── succeeded
  run ends: succeeded / failed / incomplete (endIncomplete) / paused
  naturally finished run ── retrospect.record ── Learning.finishLearning (when enabled; excludes manual cancellation)
    └─ learn: conclusion + improvement items ── independent validation ── active skill/rule
       └─ platform item ── engineer (copy, tests, activation; automatic when configured, even after source-task cancellation)
    next task: selected / attach ── planning and step instructions ── observe (before/after)
```

Retrospective analysis and lesson validation use `learning.strongestModel`: highest overall
capability, then planning and reliability; a different validator only among equally strong models.
Calls use separate empty conversations and diagnosis reasoning effort, with the existing budget,
availability, context and task CLI-permission checks.

Initial lead planning (`planner.planAsLead`) retains a validated employee roster when an
task list fails and another lead takes over. Optional `team_reasoning_effort` and
`planning_reasoning_effort` apply only during their respective calls; the persistent lead's
policy is restored afterwards. `planning_reasoning_effort="auto"` (the default) first asks the
lead, at `DIFFICULTY_EFFORT` (medium) and in a conversation of its own, how hard the request is
to plan (`planningDifficulty`), and plans at `PLANNING_EFFORT` for it (easy low … exceptional
max; hard when the answer is unusable); the plan's note says which. `team_reasoning_effort="auto"`
(the default) staffs the team at that same effort. `planning_call_timeout` bounds each such
call, times `PLANNING_TIME` for its effort (high twice, max three times), including API
queueing/retries and CLI execution, and finishes cancellation before trying another lead.
Empty effort settings and a zero deadline preserve the legacy call policy. These controls do
not alter retrospective model/effort selection.

A lead's conversation call (`cli_channels.converse` without a `timeout`: splitting a part, a
decision) through Codex runs while Codex keeps printing its JSON events and is stopped after
`lead_idle_minutes` without output (`streamed`, `_until_quiet`), at most `lead_call_max_minutes`;
Claude Code, which answers only at the end, gets `lead_call_max_minutes`. Planning passes its own
deadline (`planning_call_timeout`), which stays hard.

Codex continuation options belong to the `exec resume` subcommand: `cli_channels.converse`
places effort, service tier and disabled extras after `resume`, alongside the read-only sandbox
setting. Options attached to the outer `exec` may be ignored by the resume parser. Regression
tests check the receiving option scope, not just the presence of requested flags.

Employee handoffs (`team.context`) bound file inventories across the project and retain counts,
sample paths and declared evidence paths; results, summaries and feedback remain verbatim, including
blocked work and pending decisions. `team.compactContext` can rebuild only those inventories in an
assembled prompt. Codex steps and lead conversations share `cli_channels.runInput`: the final
UTF-8 input is capped at 1 MiB less 64 KiB of envelope reserve, with character/byte counts recorded
in call warnings. An explicit `input_too_large` rejection permits at most one smaller-inventory
retry. If requirements still cannot fit, `InputTooLarge` follows the existing blocked-work path;
`providers` preserves it without quota classification or API fallback.

The lead plans with `server/packages/planning/src/task-planning.ts`: complete work items once, through the ordinary DAG,
assignment and artifact-contract validators. Plans contain nodes and no parts. (Planning in major
parts split while the task ran, `outline.py` and `refining.py`, was removed: docs/design/fewer-settings.md.
A stored plan with parts never split is no longer split; its parts still load and show.) One task is valid; there
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
`skipCancelledLearning`; source checks reject late model replies. `restoreLearning` skips
cancelled automatic reviews instead of treating recovery as a new manual request. Completed
history, active lessons and already submitted independent platform jobs remain intact.

## Who owns what

| Area | Module | Key names |
|---|---|---|
| HTTP API, task lifecycle endpoints | `app.ts` (routes), `api.ts` (what they share) | `Api.newTask`, `Api.makePlan`, `/followup`, `/resume`, `reopenNode`, `/diagnoses/{id}/reply`, `/network` |
| Records and statuses | `models.ts` | `RunStatus`, `NodeStatus`, `Outcome` (attempt outcomes), `DiagnosisStatus`, `FINISHED`, `TaskNode`, `NodeAttempt`, `Diagnosis`, `ExecutionRun` |
| Declared artifact handoffs and stop limits | `contracts.ts`, `models.ts` | Optional `TaskNode.artifact_contract` (`ArtifactContract`: stage, external/dependency inputs, file/directory outputs, acceptance commands, blocking conditions, total turns/cost); `planProblems`, `prepare`, `deliverySnapshot`, `accepted`; `ArtifactEvidence`, persistent `contract_turns/contract_tool_calls/contract_cost_usd` |
| Contract limits: tool calls at least `MIN_TOOL_CALLS` by difficulty (`settings.contract_call_floors`); at a limit the step goes to the lead (`Leading.decide` with `supervisor.limitNote`), and its retry, switch_model or replan grants more (`contracts.extend`, event `node.limit_extended`); without a decision it stops as before. Membership CLIs may run contract steps, bounded by time instead of counted calls (`Executor.timedWatch`, `CLI_MINUTES_PER_TOOL_CALL`). The contract prompt asks for the declared outputs first | `contracts.ts`, `executor.ts`, `leading.ts`, `supervisor.ts` | `declarations`, `extension`, `extend`, `prompt`; tests `server/tests/activity.test.ts`, `server/tests/leading.test.ts`, `server/tests/executor.test.ts` |
| A blocked step (missing evidence, a target not reached, a platform rule) goes to the lead like a limit stop: `supervisor.blockedNote`, and rework may send back the finished steps it builds on (`Leading.upstream`, `reopen`, event `run.rework`); without a decision it stops as before | `executor.ts`, `leading.ts`, `supervisor.ts` | `finish` (`limited`), `decide`, `applyDecision`; tests `server/tests/leading.test.ts` |
| Planning: the lead also names the task shortly for lists (`TaskPlan.title`, `lead_planning.planTitle`; older plans show the first clause of their summary, `frontend/mission-history.tsx` `taskName`); independent deliverables get their own lines of tasks (`planner.INDEPENDENT_RULE`); open scope decisions that change the work a lot are listed (`CHOICES_RULE`, `TaskPlan.choices`, `PlanChoice`) and picked by the user before confirming (`frontend/plan-choices.tsx`); an answer other than the lead's plans the task again in place (`POST /api/tasks/{id}/choices`, `POST /api/tasks/{id}/choices` in `app.ts`, `decidedChoices`, `makePlan`, event `plan.replanned`); employees are named by their job, one per module or area of responsibility rather than the fewest (`team.form`) | `server/packages/planning/src/planner.ts`, `server/packages/planning/src/task-planning.ts`, `team.ts`, `models.ts` | `planChoices`; tests `server/tests/planning.test.ts` |
| What a running step is doing, live: an API model's tool log as it goes, and a Codex step's commands, file changes and messages parsed from its JSON output (kept as the attempt's tool calls afterwards); served to the step's progress panel | `activity.ts`, `cli-channels.ts`, `api.ts`, `frontend/plan-graph.tsx` | `recording`, `paused` (progress checks and lead calls are not the step's work), `noteLine`, `codexEntry`; `GET /api/tasks/{id}/nodes/{node}/activity`; `NodeProgress` 正在做 |
| Storage (SQLite, JSON bodies) | `db.ts` | `Database.saveRun`, `getRun`, events, `saveRetrospective`; `conversations`, `conversation_archives`, `model_calls` (task deletion removes all three; it keeps `retrospectives`, `learning_reviews`, `improvements`, `improvement_effects`) |
| Skills for the steps: SKILL.md files with the `tools` they cover, general in `skills/steps/` (`synopsys-vcs`; `github-reference`: finding, scoring (upkeep, stars, tests/CI, OpenSSF Scorecard) and pinning GitHub projects to use as reference, reused code or skill material, read-only, with a `REFERENCE:` line per project; needs the task's network), this machine's in `<data_dir>/skills/` (first), public references in `<data_dir>/skills-discovered/` (`discovered`, never in `library`); a step is given those whose tools it names, never a public one. Public references retain origin, immutable blob revision and content hash, and are only shown, marked unchecked, to the model writing this machine's skill | `skills.ts` | `library`, `forStep` (`quality.nodePrompt`), `section`, `saveMachine`, `saveDiscovered` |
| Optional reuse-first skill preparation: local machine or general skill → otherwise bounded sandbox generation, given a public reference when one is cached or found by a bounded GitHub repository/tree/blob search (only when the task permits network; `Preflighting.publicReference`). No remote install scripts run. Discovery is at most 30 seconds and 12 requests; generation uses `skill_preparation_timeout` and `skill_generation_max_turns`. Failures remain advisory | `server/packages/learning/src/skill-discovery.ts`, `server/packages/learning/src/preflight.ts` | `discover`, `Discovery`, `prepareSkills`; `skill_reuse_first` (off by default); events `run.skill_searching`, `run.skill_selected`, `run.skill_generating` |
| The check before a task's first step, in a real step sandbox with the task's settings: the sandbox's output and exit code, the tools the lead listed (`TaskPlan.requires`, from `OUTLINE_PROMPT`) and, as warnings, the programs the steps' checks call, the internet, each API model; the same tool and internet checks in Codex's own sandbox, under the steps' permission profile, when Codex may run the task's steps, and a warning if it can read the platform's database or Codex's login (`cliChecks` → `CliChannelRegistry.sandboxRun`, `codex sandbox`, no model); one environment repair, then a pause with what is missing (going on runs anyway); then this machine's skill for each special tool the task needs, written by a model trying it in a step's sandbox and kept for later tasks (`prepareSkills`, `neededTools`, `toolGroups`, `skillPrompt`; setting `preflight_skills`); bash's complaints about the hidden home's startup files (`SHELL_NOISE`) are not a failure; FluidForm's own sandbox checks still failing after the repair go to the platform engineer (`preflightEngineer`, via `engineerJoin`, once) | `server/packages/learning/src/preflight.ts` (mixed into `Executor`) | `Preflighting.preflight`, `allChecks`, `sandboxChecks`, `cliChecks`, `toolCommands`, `modelChecks`, `preflightRepair`, `repairPrompt`; `ExecutionRun.preflight`, settings `preflight`, `preflight_command_timeout`, `preflight_network_url` |
| Looking back on naturally finished tasks: each step's estimate against its cost and turns, its problems named by kind and key, counted across tasks, marked when they come back after a repair; a diagnosis is told the same problem's earlier cases. When a task ends the cheapest configured API model names each problem by its cause, reusing names already given (`nameProblems`, setting `problem_naming`; kept when recorded again); `topics` groups problems across tasks by those names and `similar` lists a topic holding any of a failing step's names first; the 常见故障 page (`frontend/problems.tsx`) shows them. Automatic records and backfill exclude manual cancellation; saved history remains readable | `retrospect.ts` | `record` (on `END_EVENTS` in `Executor.emit`), `Executor.nameProblems`, `nameProblems`, `topics`, `AUTOMATIC`, `review`, `repairedAreas`, `program`, `recurring`, `similar` (`prompts.repairPrompt` `history`); `calibration`, `calibratedCost` in the pricing package, asked through `pricing.calibrated` (each model's past overrun and the cost outside steps, shown only as `CostEstimate.calibrated_usd` by `GET /api/tasks` and `GET /api/tasks/{id}`; budget checks keep the planned estimate); API `/api/retrospectives/recurring`, `/api/retrospectives/topics`, `/api/tasks/{id}/retrospective` |
| Turning retrospectives into verified improvements: separate bounded budget, recorded evidence, sandbox checks for skills, independent review for skills/advisory rules, platform engineer jobs for source/platform rules (each waits for the user's approval of its plan and of its result); a checked skill lesson is written into this machine's skill for its tools (`skills.addLesson`, newest first, taken out on disable by `skills.removeLesson`) and then not repeated as a separate lesson; immutable lesson snapshots in later plans and steps, comparisons only with the same model/difficulty mix | `learning.ts` (mixed into `Executor`) | `Learning.finishLearning`, `startLearning`, `learn`, `validateLesson`, `learningEngineer`, `restoreLearning`, `syncImprovements`; `selected`, `attach`, `instruction`, `observe`; `LearningSettings`, `LearningReview`, `Improvement`, `ExecutionRun.improvement_uses`; tables `learning_reviews`, `improvements`, `improvement_effects`, `learning_settings`; API `/api/tasks/{id}/learning`, `/api/improvements`, `/api/improvements/settings`, `/api/improvements/{id}/disable`; `docs/design/continuous-improvement.md` |
| Project employees and delegation | `team.ts`, `models.ts`, `executor.ts` | `employee_teams` (on by default): `form` chooses staff/models/capabilities/Skills before the tasks are planned; `Employee`, `PlanPart.employee_id`, `TaskNode.employee_id`; `route` preserves the chosen model, `context` supplies shared requirements/interfaces and delivery history, `refreshSkills` snapshots assigned instructions. `DELEGATE_TASKS` requests become validated child nodes in the same run; `delegateResult` atomically saves the child graph and yielded parent, which resumes only after accepted children. One active task per employee, provider-aware admission, inherited contract costs/turns via `governors`. `frontend/team.tsx` shows staff, tasks, delegation and shared agreements. See `docs/design/project-team.md`. |
| Planning | `server/packages/planning/src/planner.ts` | `autonomousPlan` (by the lead when one is available: `planAsLead`), `validatePlan` (flat plan, when no lead plans), `taskNode`, `WORK_RULES`; project work as small packages (`TaskNode.files/reads/provides/check`, `package`, `scopeProblems` sends broad steps back to the lead) |
| Executable task planning | `server/packages/planning/src/task-planning.ts`, `server/packages/planning/src/lead-planning.ts`, `server/packages/planning/src/planner.ts`, `api.ts` | `planTasks` returns complete task matters, owners, dependencies and acceptance in one go; `lead_planning` holds what the lead's planning conversations share (`ask`, `planTitle`, `MAX_TASKS`, `INTERNET_NOTE`). Reuses task parsing, contract gates and employee routing. See `docs/design/direct-task-planning.md`. |
| Chats: only a conversation with one model, no plan or steps (`ExecutionRun.kind == "chat"`, kept as `draft`, so nothing schedules it; only chats among drafts can be deleted, `Database.deleteRun(chat=True)`). Its messages are the lead conversation's (`startLeadChat`, `supervisor.chatOpening`); what its model is told (`CHAT_ROLE`, a lost conversation handed over with the transcript) and which model it talks with come from the chat package (`chat.ts`, `server/packages/chat/chat.mjs`); without it no chat is started or continued (409 `chat.NOT_ENABLED`), `POST /api/start` makes a task, and old chats can be read. With a project the conversation runs there (`supervisor.chatFolder`): a CLI lead's read-only profile; API models see no files. A chat's attachments (`ExecutionRun.attachments`) go to the lead with the first call that has not had them (`askLead`, `ExecutionRun.lead_seen_attachments`; `providers.converse(attachments=)`): an API model gets text inline and images as images (only models not known blind are offered, `chatModels(needsVision=)`); a CLI is given their paths and may read just those folders (`codexStepPermissions(readable=)`, Claude `--add-dir`), Codex also `--image`. They go with the task it becomes. Turning it into a task plans it in place with the conversation as its background (`promote_chat`, `makePlan(context=)`). Left to FluidForm (the composer's 自动, the default), the cheapest API model tells a chat from a task (`triage.classify`, told the attachments' names; failure or no such model mean a task) and the record is marked `auto_routed`; a task waiting for confirmation can become a chat (`task_to_chat`) | `api.ts`, `supervisor.ts`, `leading.ts`, `triage.ts`, `frontend/chat.tsx` | `create_chat`, `start` (`POST /api/start`), `task_to_chat` (`POST /api/tasks/{id}/as-chat`), `chatModels` (`GET /api/chats/models`), `promote_chat` (`POST /api/tasks/{id}/promote`); tests `server/tests/api-chats.test.ts` |
| Faster small tasks (docs/design/faster-tasks.md): with `quick_tasks` a task the cheapest model judges one model can do in one go (`server/packages/planning/src/quick.ts`) gets a one-step easy plan without the lead (`api.quickPlan`); with `review_easy_steps` off easy steps stand on their own result (`review.ts`); with `preflight_cache_minutes` a passed preflight stands for the next task alike (`preflight.cacheKey`, `passedBefore`) | `triage.ts`, `api.ts`, `review.ts`, `server/packages/learning/src/preflight.ts` | tests `server/tests/api-platform.test.ts` |
| Quick jobs in chats (docs/design/chat-tools.md): with `chat_tools` (off by default) an API model answering a chat without a project gets the steps' tools in the chat's own folder (`<workspace_root>/<folderId>`), the internet with `chat_tools_network`, at most `chat_tool_turns` calls and `chat_tool_seconds` per message; bigger work is a task (TASK line in automation chats) | `supervisor.ts`, `providers.ts`, `config.ts` | `chat_tools`, `chatTools`, the package's `toolsNote`, `toolSkills`, `ProviderRegistry.converse(tools=)`; tests `server/tests/api-chats.test.ts` |
| Pictures (docs/design/image-generation.md): with `image_models` (empty by default) API models that may write get the `GenerateImage` tool, which makes a picture with the first image model that does (`images.generate`: MiniMax, Zhipu CogView, each with its chat key), saves it in the working directory and charges it by the picture to the call's budget; steps marked `needs_images` go only to API models | `images.ts`, `agent.ts`, `providers.ts`, `budget.ts`, `routing.ts`, `server/packages/planning/src/planner.ts` | `generate`, `available`, `IMAGE_TOOL`, `Workspace.generateImage`, `RequestBudget.canSpend`/`recordUsd`, `TaskNode.needs_images`; tests `server/tests/images-gates-attachments.test.ts` |
| One model carrying a task through (docs/design/faster-tasks.md): with `solo_tasks` the cheapest model also judges whether one strong model can do the work alone with its tools (`quick.ts's shape prompt` "solo"), in a project too; such a task gets one hard step, without the lead | `triage.ts`, `api.ts` | `quick(solo=, project=)`, `quickPlan`; tests `server/tests/api-platform.test.ts` |
| Going on after a restart (docs/design/faster-tasks.md): with `resume_after_restart` a task cut off by a restart, in no project and waiting for nobody, is queued again at startup; finished steps keep their results | `api.ts` | `resumesByItself`, `lifespan`, event `run.restart_resumed`; tests `server/tests/api-more.test.ts` |
| Profiles (docs/design/faster-tasks.md): `profile` (fast, balanced, careful) sets a group of settings, each still overridden when given on its own; picked in 设置 → 工作方式 (`GET/PUT /api/settings/profile`), applied at once and saved in `<data_dir>/profile.json` | `config.ts`, `api.ts`, `frontend/memory.tsx` | `PROFILES`, `Settings.applyProfile`/`useProfile`/`loadSavedProfile`, `ProfilePicker`; tests `server/tests/config.test.ts`, `server/tests/api-more.test.ts` |
| Chat actions as tools (docs/design/chat-actions.md): with `chat_action_tools` a chat with tools calls StartTask, SendFile, CallEngineer (and Remember, Forget) instead of writing lines; each call is noted as its line at the end of the answer, read as before; the chat package gives the tools and what each call stands for | `chat-actions.ts`, `providers.ts`, `agent.ts`, `server/packages/chat/chat.mjs` | `pending`, `offered`, `run`, `withActions`, the package's `TOOLS`, `action`, `actionNames`; tests `server/tests/supervisor.test.ts` |
| Remembering people (docs/design/chat-actions.md): with `user_memory` chats keep REMEMBER facts (no secrets, at most 30 per place) in the chat package's data folder (`memory.json`; FluidForm's old `<data_dir>/memory.json` is moved there when the package is first installed, `bundled.CARRIED`), by place (`web` for the owner's chats, `<capability>:<conversation>` for an automation's), and every new chat there is told them; 设置 → 记住的事 lists and deletes them (`GET /api/memory`, `POST /api/memory/forget`) | `server/packages/chat/chat.mjs` (`Memory`), `chat.ts`, `app.ts`, `leading.ts`, `frontend/memory.tsx` | the package's `splitMemory`, `Memory.take`, `told`, `chat.remember`, `chat.memory`, `chat.forget`, `CapabilityAutomations.remember`, `MemoryPage`; tests `server/tests/api-more.test.ts`, `server/tests/api-packages.test.ts` |
| Interfaces (docs/design/capability-packages.md): FluidForm's core is the API and the command line (`fluidform`: plan and run tasks with models chosen between membership CLIs and API models, or kept to `--only-cli`/`--only-api`/`--model`; list, pause, resume, cancel; keys, models, capability packages); every other interface is a capability. An interface package (`kind: "interface"`, a `site` folder) is a web page FluidForm serves at `/<id>/`; the web console is one (`server/packages/web`, built by `npm run package` in `frontend`, shipped and enabled, reinstalled when its build changes), and `/` leads to it | `interfaces.ts`, `app.ts` (`/`, `/:id/*`, own-origin writes), `bundled.ts`, `cli.ts`, `model-choice.ts` (`chosenFor`: `only_models`, `cli_only`), `scripts/service.sh`, `frontend/attachments.tsx` (`API_BASE`) | `file`, `home`, `chosenFor`; tests `server/tests/interfaces.test.ts`, `server/tests/cli.test.ts`, `server/tests/api-tasks.test.ts` |
| Chat (docs/design/chat-and-pricing-packages.md): how FluidForm chats is the chat service package's, shipped and enabled at first start: which model a chat talks with, what it is told, what its answer's lines for FluidForm say (TASK, SEND, ENGINEER, REMEMBER, FORGET), what it remembers about people, whether a group message is for it. FluidForm asks it at each of these points and keeps the pipes (the chats, the model calls with its keys, the tools, the files, the tasks); without it there are no chats | `chat.ts`, `server/packages/chat/` (`chat.mjs`, `service.mjs`), `supervisor.ts` (`chatOpening`, `chatTools`), `automations.ts`, `leading.ts`, `frontend/provided.ts` | `chat.ask`, `chat.order`, `chat.context`, `chat.remember`, `chat.actionLines`; tests `server/tests/chat-package.test.ts`, `tests/helpers/chat.ts`, `tests/helpers/chat-package.ts` |
| A chat's context (docs/design/chat-context.md): an API model is sent a chat built each turn from its records (the rules as system prompt, the latest turns as messages, older ones summarised, attachments by name), an automation's conversation starts afresh after two idle hours, at 4:00, or on `/new` | `server/packages/chat/chat.mjs` (policy), `server/src/supervisor.ts`, `chat.ts`, `providers.ts`, `automations.ts`, `leading.ts` | `dialogue`, `compaction`, `session`, `chat.history`, `Dialogue`; tests `server/tests/chat-context.test.ts` |
| A chat app's pace (docs/design/chat-context.md, 节奏): a person's messages are turns: sent again before anything is seen, the two are answered as one; after, the next waits; `/stop` `/new` `/status` at once; little thinking for talk | `server/src/chat-turns.ts`, `capability-runner.ts`, `automations.ts`, `server/packages/chat/chat.mjs` (`effortFor`) | `Turns`, `Turn`, `STOP_COMMAND`; tests `server/tests/api-packages.test.ts` |
| Pricing (docs/design/chat-and-pricing-packages.md): every price, estimate, budget check and charge is a request to the pricing service package, shipped with FluidForm and enabled at first start; FluidForm keeps the budget's state and the quota readings; without it nothing is priced or limited and models are chosen by score; one that does not answer stops spending (`PricingUnavailable`) | `pricing.ts`, `server/packages/pricing/` (`pricing.mjs`, `service.mjs`), `bundled.ts`, `budget.ts` (`RequestBudget`), `routing.ts` (`costsFor`), `cli-quota.ts` (quota reading) | `charge`, `costs`, `rates`, `estimate`, `admit`, `cliPrice`, `calibrated`; tests `server/tests/pricing.test.ts`, `server/tests/budget.test.ts`, `tests/helpers/pricing.ts` |
| Service packages (docs/design/chat-and-pricing-packages.md): a package with `kind: "service"` gives FluidForm itself a capability (`provides`: chat, pricing); any package's `requires` must be there before it is enabled, and a provider others need stays on; FluidForm provides one itself until its package exists (`builtIn`); the service runs in the capabilities' sandbox and talks JSON-RPC 2.0 both ways over stdio, so FluidForm does what needs a key | `services.ts`, `service-names.ts`, `capability-packages.ts` (manifest), `app.ts` (enable checks, `/api/capabilities/provided`), `frontend/capabilities.tsx` | `ServiceHost`, `request`, `handle`, `enableProblem`, `disableProblem`, `providers`; tests `server/tests/services.test.ts` |
| Task capabilities (docs/design/task-capabilities.md): planning and team, the lead and review, the platform engineer and diagnosis, learning with preflight and skills are extensions shipped with FluidForm (`server/packages/{planning,lead,engineer,learning}`, `kind: "extension"`): in its process, switched on and off, never uploaded or removed; without them a task is one step, retried by fixed rules | `server/packages/lead/src` (the lead's decisions and prompts, acceptance, overruns; asked through `server/src/lead.ts`), `server/packages/planning/src` (asked through `server/src/planning.ts`), `server/packages/engineer/src` (how it looks, repairs and changes FluidForm; asked through `server/src/engineering.ts`; copying, applying and restarting stay in `server/src`), `server/packages/learning/src` (learning, preflight, preparing skills; asked through `server/src/experience.ts`), `server/src/extensions.ts`, `provided.ts`, `features.ts` | `uses` (ask here whether a part is in use), `providerOf`, `extensions.on`; tests `server/tests/task-core.test.ts` |
| MCP tools (docs/design/mcp-and-web.md): `mcp_servers` lists MCP servers: a command (argv, keyring secrets or a key FluidForm keeps, `env`), started for each call in the step's own sandbox over real pipes (by path under pasta), or a remote one (`url`, Streamable HTTP, `headers` with `${VARIABLE}`) asked by FluidForm, offered only to work allowed the internet; `tools` limits what is offered, `price_usd` is charged per call, `makes_images` marks the server that draws (pictures, web search and page reading come from official MCP servers: no built-in tools); their tools are listed once and offered to API models that may act as `mcp__<server>__<tool>` | `mcp.ts`, `agent.ts`, `providers.ts`, `routing.ts` (`needs_images`), `api.ts` (a picture task is allowed the internet) | `definitions`, `call`, `Session`, `RemoteSession`, `headersFor`, `imageServers`, `LISTED`; tests `server/tests/tools-online.test.ts` |
| Web search and reading (docs/design/mcp-and-web.md): with `web_search_models` (e.g. `glm:search_std`) the `WebSearch` tool, charged by the search; with `web_fetch` the `WebFetch` tool, public addresses only (checked after every redirect); both only for steps and chats allowed the internet | `web.ts`, `agent.ts`, `providers.ts` | `toolsFor`, `search`, `fetch`, `Workspace.web_search`/`web_fetch`; tests `server/tests/tools-online.test.ts` |
| One platform engineer (docs/design/one-engineer.md): with `engineer_repairs` the lead asks for any repair or component with `call_engineer` (kind repair or component) instead of repair_environment / repair_platform / request_component, which still parse; the repair session (`diagnosing.repair`, the code still says diagnosis) is the platform engineer and finds whether the machine or FluidForm is at fault (`diagnosis.ENGINEER_CALLED`, `PLATFORM_REPAIR`); the lead is told what it found and did on a step (`supervisor.engineerLooks`); the UI calls every diagnosis 平台工程师 | `supervisor.ts`, `leading.ts`, `diagnosis.ts`, `frontend/diagnosis.tsx` | `offeredActions`, `SEPARATE_REPAIRS`, `engineerLooks`, `ENGINEER`; tests `server/tests/leading.test.ts` |
| Defaults (docs/design/fewer-settings.md): the features above are on without any setting; image and search models default to every known one whose provider has a key (`images.AUTO`, `web.AUTO`); the only profile is careful (`fast`/`balanced` read as none); tests run with the former defaults (`conftest.ON_BY_DEFAULT`) and turn on what they test | `config.ts`, `images.ts`, `web.ts` | `PROFILES`, `FORMER_PROFILES`; tests `server/tests/config.test.ts` |
| Applying a checked change sooner, strong models only, the job's budget kept (docs/design/platform-engineer.md): before the restart only what must not be cut off is waited for (requests, repairs, the lead's answers, steps of tasks in a project), other steps at most `APPLY_WAIT_SECONDS`; FluidForm's source is changed only by `routing.engineers` (CLIs, API models within `ENGINEER_SCORE_MARGIN` of the best coder); a job out of budget asks to go on (`MORE_BUDGET`, `STOP`) | `self-repair.ts`, `routing.ts`, `engineer.ts`, `diagnosing.ts` | `waitToApply`, `cutOffSafely`, `engineers`, `engineerCharged`; tests `server/tests/platform-repair.test.ts`, `server/tests/engineer-run.test.ts` |
| Retrospective changes, repairs of the machine on the platform page, going on after a restart (docs/design/platform-engineer.md): a retrospective's platform change goes to the engineer only once its problem came up in `retrospect.PLATFORM_MIN_RUNS` tasks (`learning.notForEngineer`, `retrospect.runsWith`; else `deferred`); `GET /api/engineer` lists the engineer's looks at tasks that changed no source (`environment`, `engineer.environmentRepairs`), shown as 修环境 in 全部记录; an edit a restart cut off goes on in the same copy (`platform_repair.edited`); a repair that stops says why (`self_repair.whyStopped`) | `learning.ts`, `retrospect.ts`, `engineer.ts`, `platform-repair.ts`, `self-repair.ts`, `frontend/engineer.tsx` | tests `server/tests/learning.test.ts`, `server/tests/engineer-run.test.ts` |
| Chatting in chat apps (docs/design/chat-app-manners.md): a group reply to the question it just asked needs no @ (the chat package's `hear`, `FOLLOW_UP_SECONDS`; state `answered`), and the judge sees its last answer (its prompt and reading are the package's, `addressedPrompt`, `judged`; FluidForm makes the call, `triage.addressed`); groups get short answers (the package's `chatGuide`); a bare @ with nothing new gets 在呢 without a model; pictures are counted, not named (`attachedNote`); the chat keeps what was said (`startLeadChat(shown=)`); a question about a picture waits briefly for it (`capability_runner.PICTURE_WAIT_SECONDS`); automation chats try API models first (the package's `order`, `automationModel`) | `api.ts`, `automations.ts`, `chat.ts`, `server/packages/chat/chat.mjs`, `capability-runner.ts`, `leading.ts` | tests `server/tests/api-packages.test.ts` |
| Checks, results and the bar (docs/design/plan-checks-and-results.md): in a fresh folder a plan whose check runs a script no step before it writes goes back to the lead (`contracts.unwrittenScripts`, at planning and replanning); the lead's `summary` when it ends the task is the task's result (`Decision.summary`, `Executor.finalResult`); the request and the lead's criteria are the bar, not requirements a step wrote itself (`quality.OWN_BAR`, `supervisor.BEYOND_THE_BAR`) | `contracts.ts`, `server/packages/planning/src/task-planning.ts`, `server/packages/planning/src/replan.ts`, `supervisor.ts`, `leading.ts`, `executor.ts`, `quality.ts` | tests `server/tests/planning.test.ts`, `server/tests/replan-run.test.ts`, `server/tests/leading.test.ts` |
| What the console polls: `GET /api/tasks?brief=true` leaves out what only an opened task shows (`api.brief`); `GET /api/tasks/{id}` leaves out tool output (read by `.../attempts/{i}/calls/{j}/output`), changed files past 50 and the lead's model history; `GET /api/engineer` leaves out diffs (`/api/engineer/jobs/{id}/diff`); all three carry an ETag and answer 304 when unchanged (`unchangedOr` in `app.ts`). The page reads the list brief and the opened task in full, each only when changed, and does not poll while hidden | `api.ts`, `frontend/src.tsx`, `frontend/plan-graph.tsx`, `frontend/engineer.tsx` | tests `server/tests/api-tasks.test.ts`, `frontend/tests/mission-actions.test.mjs` |
| Evals (docs/design/evals.md): `fluidform eval [suite]` runs the cases of `evals/basic.json` on the live service through its API, judges them, and compares with an earlier report | `evals.ts`, `cli.ts`, `evals/` | `runSuite`, `judge`, `compare`; tests `server/tests/evals.test.ts` |
| Files in every box (docs/design/message-attachments.md): each text box takes pasted or dropped files and has a paperclip (`attachments.tsx`: `takesFiles`, `ClipButton`, `SentFiles`). Sent to a task (a message to its lead, an answer to its question) they join its attachments (`attachments.attach`, at most `MAX_TASK_ATTACHMENTS`), so its later steps see them and the lead is given them with its next call; kept on the message (`LeadMessage`/`DiagnosisMessage.attachments`). Sent to the platform engineer they are the job's (`EngineerJob.attachments`, each `EngineerMessage`'s), given to its model with each call. 需求变更 and 转成任务 take files for the new task | `api.ts`, `attachments.ts`, `leading.ts`, `executor.ts`, `engineer.ts`, `frontend/attachments.tsx` | `askLead` (`POST /api/tasks/{id}/lead`), `reply_to_diagnosis`, `engineerRequest`/`engineerReply`/`engineerJoin`, `promote_chat`, `follow_up_task`; tests `server/tests/api-chats.test.ts`, `server/tests/engineer-run.test.ts`, `mission-actions.test.mjs` |
| Capability packages (docs/design/capability-packages.md): a capability uploaded as a zip (`capability.json`, code, optional `SKILL.md`, `requirements.txt`) and uninstalled on its own, with its data, state and keyring secrets (`capability/<id>/<VAR>`). Its environment is built and its check run in the capabilities' sandbox: home and data hidden, its folder read-only, only `<data_dir>/capability-data/<id>/` writable, no network but `DomainProxy` (CONNECT only to declared hosts, bridged in by socat). Uploaded ones start disabled; enabling needs `confirmed`. Enabled automations run as their `entry` under `capability_runner.Runner` (JSON lines on stdin/stdout, restarts, log, daily budget, state in `<data_dir>/capability-host/<id>.json`); what someone asks becomes a chat answer or a task waiting for confirmation (`CapabilityAutomations.message` in `automations.ts`, triage as 新建's 自动), with files it sends from its data folder taken in as attachments (`capability_runner.takeFiles`), and `ExecutionRun.origin` + `Executor.endListeners` (`CapabilityAutomations.taskEnded`) tell the automation how the task ended. Off unless `settings.capability_packages`. The Feishu bot is a package, kept on the `capabilities` branch apart from this source | `capability-packages.ts`, `capability-sandbox.ts`, `capability-runner.ts`, `api.ts`, `secrets.ts`, `frontend/capabilities.tsx` | `POST /api/capabilities/upload`, `GET /api/capabilities/runtime`, `PUT/DELETE /api/capabilities/{id}/secrets`, `PUT /api/capabilities/{id}/budget`; tests `server/tests/api-packages.test.ts`, `mission-actions.test.mjs` |
| Capabilities: what a finished task left the platform able to do (docs/design/capabilities.md). With `capability_proposals` (off by default), a succeeded task's lead is asked in the background for up to three cards (`ExecutionRun.capability_proposals`); the user solidifies one from the result page: its files, only from inside the task's folder and bounded, are copied to `<tools_dir>/capabilities/<id>/capability.json` and its check runs in a step's sandbox without network (failed ones stay, marked, and cannot be enabled). Active tools are told to every step (`quality.nodePrompt`) and planner (`makePlan`). Listed and switched on the platform engineer page (`frontend/capabilities.tsx` `CapabilityShelf`); automations wait for a runner | `capabilities.ts`, `leading.ts`, `api.ts`, `models.ts` | `readCards`, `solidify`, `check`, `library`, `section`; `startCapabilityProposals`; API `/api/capabilities`, `/api/tasks/{id}/capabilities/{n}/solidify|dismiss`; tests `server/tests/api-platform.test.ts` |
| The task's lead: one conversation from planning to the end (docs/design/supervisor.md) | `supervisor.ts` | `candidates`, `ask`, `handover`, `trim`; `Executor.askLead`, `ProviderRegistry.converse`, `CliChannelRegistry.converse`, `ExecutionRun.supervisor` |
| Model choice | `routing.ts` | `routeNode` (first pick; a hard step takes the cheapest within `hard_score_margin` of the best, `closeToBest`), `strongestFor` (retry), `strongerThan` (escalation), `spreadTo` (a step past its provider's share of the running steps, `Executor.spread`, settings `max_steps_per_provider` (off by default), `spread_cost_factor`), `pickReviewer` (the cheapest model no weaker overall than the one checked, `CapabilityScore.overall`), `diagnosers`; `nodeCost` (an API model's tool loop turn by turn, cached input at the cache price: `LOOP_*`), `reestimate` (after splitting or replanning) |
| Scheduling, attempts, step outcomes | `executor.ts` | `Executor`; see "Executor" below |
| Step acceptance is off by default (`settings.acceptance`): a step that finishes has passed (`Reviewing.checkResult` returns at once; a step's own UNABLE/BLOCKED still fails it), declared checks and artifact acceptance commands are not run, `contracts.accepted` revalidates nothing, a verification step's FAIL sends nothing back, and plans are asked for without verification steps (`planner.NO_ACCEPTANCE_NOTE`). The lead's final check of the whole result (`Leading.finalReview`) stays, as do progress checks, contract turn/cost limits and the budget. With it on, everything below applies | `config.ts`, `review.ts`, `contracts.ts`, `server/packages/planning/src/planner.ts` | `acceptance`; tests `server/tests/engineer-safety-runtime.test.ts` (the other tests run with it on, `server/tests/helpers/conftest.ts`) |
| Reviewing a result. An API reviewer reads with Read/Glob/Grep/LS and, where bwrap exists, runs commands (`agent.REVIEW_TOOLS`): the workspace mounted read-only, its credentials hidden (`quality.privatePaths`), no network or local services, its own /tmp writable to rerun a check on a copy | `review.ts` (mixed into `Executor`), `agent.ts` | `check`, `reviewer`, `MAX_BACKUPS`; `Workspace(read_only=True)`, `REVIEW_COMMANDS`, `private` |
| The lead's decisions after a failed attempt, and its questions to the user; while it decides, `ExecutionRun.lead_thinking` (`thinking`); a repair it asks for (`Diagnosis.trigger == "lead_repair"`, `decision_id`) comes back to it (`afterRepair`) before the step runs again | `leading.ts` (mixed into `Executor`) | `decide`, `askForDecision`, `applyDecision`, `afterRepair`, `decisionsLeft`, `startLeadAnswer`, `startLeadChat`; prompts in `prompts.failureMessage`, `repairMessage`, `parseDecision` |
| Diagnosing failures and acting on them (when no lead decides; repairs the lead asks for) | `diagnosing.ts` (mixed into `Executor`) | `repair`, `diagnoseWith`, `repairDone`, `beginDiagnosis`, `runDiagnosis` |
| Repairing FluidForm itself (flow) | `self-repair.ts` (mixed into `Executor`) | `fixPlatform`, `activatePlatform`, `holdForPlatform`, `restorePlatform`, `finishPlatform` (a repair the lead asked for goes back to it: `platformToLead`) |
| The platform engineer: repairs and components the user (or a lead) asks for, as jobs; plan → approve → build in a copy → check → approve → apply → git commit (docs/design/platform-engineer.md); while it works, its model's commands, file changes and messages and the platform's checks show on its page (`Executor.engineerLogs`, `GET /api/engineer/jobs/{id}/activity`, `JobActivity` reusing `ToolLog`) | `engineer.ts` (mixed into `Executor`) | `EngineerJob`, `engineerRequest`, `engineerJoin` (into a task's conversation with its lead: by the user, the lead's chat `supervisor.splitEngineer`, or any decision's `engineer` field; the lead hears progress, `engineerNews`/`engineerUpdates`), `engineerReply`, `engineerApprove`, `engineerReject`, `engineerRun`, `engineerApply`, `engineerFinished`, `engineerToLead`, `commit`; API `/api/engineer`; prompts `planPrompt`, `editPrompt`; guide `skills/platform-engineer/SKILL.md` |
| Changing a running task's plan at the lead's decision | `server/packages/planning/src/replan.ts` | `changePlan`, `PlanError` |
| What happens after a failure without a lead (fallback: retry model, meaning of a diagnosis) | `recovery.ts` | `retryModel`, `failedModels`, `afterDiagnosis`, `turnsFor`, `MODEL_FAILURES` |
| Prompts for steps and reviews, verdict parsing | `quality.ts` | `nodePrompt`, `continuePrompt`, `attemptNotes`, `reviewPrompt`, `parseReview`, `UNABLE_RULE`, `unableClaim`, `retryFeedback` |
| Diagnosis prompts and parsing | `diagnosis.ts` | `prompt`, `repairPrompt` (with the skills of the tools the failure names, `skills.forStep`), `platformInstructions`, `parse`, `STATUS` |
| API model calls, output caps, tool loop | `providers.ts` | `ProviderRegistry.complete`, `send`, `outputCeiling`, `loop`, `answer`, `cachePoint`, `reasoningFields`; rejected effort is visibly recorded, or rejected outright with `reasoning_fallback=strict`; complete tool traces remain in `NodeAttempt.trace` |
| Durable conversations and structured memory | `conversation.ts`, `providers.ts`, `executor.ts` | `Conversation`, `flush`, `reopen`, `handoff`, `compactContext`, `Executor.conversation`; OpenAI-compatible/Anthropic/Gemini checkpoints at tool intent and each completion; generation/dependency/request fences; original archives accessible only through task-step-scoped `RecallHistory` |
| API keys: saved in the OS keyring, read at startup by a killable child process; a keyring that is locked, missing or slow is marked unavailable and read again every 30 s until it answers, then those providers' quota marks are cleared; `/api/providers` reports `keyring_locked`, the provider card shows 密钥环未解锁 | `secrets.ts`, `api.ts` (lifespan) | `hydrateProviderKeys`, `keepLoadingKeys`, `keyring_unavailable`, `setProviderKey`, `deleteProviderKey`; `/health` `keyring_unavailable` |
| Membership CLIs priced by their subscription (`cli_plans`, e.g. Codex $200/month): Codex's quota from its session files (`$CODEX_HOME/sessions`, `token_count` rate limits), the platform's own Codex calls from a ledger kept apart from tasks (`<data_dir>/cli_usage.jsonl`, written by `calls.usage`; sessions in the leads' folders are left out as already counted); from a baseline reading, tokens over quota used give the price (until then the plan's optional `input_per_million`/`output_per_million`, also used when usage cannot be read), set as the CLI's catalog price so charging, budgets, routing and team choice use it, never above the provider's dearest API model still offered (`apiCeiling`: quota used where its tokens cannot be seen, another machine or the web, would otherwise price it far too high; the note says so); from `cli_quota_soft_percent` it loses first place in routing and the lead is told, from `cli_quota_stop_percent` it is marked out of quota until the window resets; refreshed every minute. The session files go quiet once Codex is stopped, and a window can reset early, so a reading older than `STALE_MINUTES` is replaced by Codex's app server (`askCodex`, `account/rateLimits/read`, no model call), asked at most every `ASK_MINUTES`. With `cli_free` (off by default) the quota is still read and guarded, but every CLI is priced at 0, so it counts against no budget and its note leaves out the price | `cli-quota.ts`, `calls.ts`, `api.ts` (lifespan), `team.ts` | `CodexReader.read`, `askCodex`, `record`, `recorded`, `pricePerMillion`, `apiCeiling`, `startingPrice`, `apply`, `keepApplying`; `ModelProfile.usage_note`; `QuotaTracker.mark(until=)` |
| Call telemetry and admission | `calls.ts`, `call-control.ts` | `observed`, `ProviderGate`; request/retry counts, requested/sent effort, observed tokens/cache writes/reads, unknown usage, duration and queue time; configured provider-wide concurrency/RPM/TPM, shared Retry-After cooldown; `/api/tasks/{id}/calls` |
| Historical delivery cost | `routing-feedback.ts`, `routing.ts` | `collect`, `expectedCost`; minimum eight distinct steps per model/capability/difficulty, smoothed success probability and observed rework cost, bounded latency weight; applied before an automatically routed step's first attempt |
| Streamed replies (server-sent events) put back together into the provider's non-streamed reply; a request stops only when nothing arrives for `api_reply_deadline` (`ProviderRegistry._post`, `stream`, `StreamSilent`) | `streaming.ts` | `openai`, `anthropic`, `gemini`, `events`, `StreamError` |
| Codex's sandbox for steps and leads: its own permission profiles (bubblewrap), passed with `-c` on every call. A step (`fluidform-step`, extends `:workspace`): this account's home, the platform's data and the tasks' folders denied entry by entry except its own folder, Codex's install and helper folder and the tools folder; the shared /tmp denied and a TMPDIR of its own per call; the internet when the task allows it. A lead (`fluidform-lead`, extends `:read-only`): the same, the tasks' folders readable | `cli-channels.ts` | `codexStepPermissions`, `denyExcept`, `private_tmp`, `codexHome`, `codexPackage`, `CODEX_STEP_PROFILE`, `CODEX_LEAD_PROFILE` |
| CLI model calls and their sandboxes | `cli-channels.ts` | `CliChannelRegistry.complete`, `withNetwork`, `repairCommand` (the real /dev), `codexSettings` (Codex runs with the platform's reasoning effort, the lead's service tier, and without the user's plugins, apps and MCP servers: `CODEX_EXTRAS`, `codexServers`); what a CLI step is told about its sandbox: `quality.cliEnvironment` |
| Readable folder names (`20261021-1441-async-fifo-uvm`) for tasks and leads; leads' folders outside any project. Tasks' folders are under `workspace_root`, which a machine sets in `.env` (`FLUIDFORM_WORKSPACE_ROOT`) to a folder outside the platform's repository, so CLI agents there do not read its AGENTS.md and CLAUDE.md; `scripts/service.sh` reads it from the environment or `.env` (`setting`), else uses the repository's `workspaces/` | `folders.ts` | `taskFolder` (`ExecutionRun.folder_name`, from the plan's `folder`), `leadFolder`, `lead_root` (setting `lead_root`) |
| Project brief for planning, written by `server/packages/planning/src/brief.ts` (file summaries by the cheapest API model, refreshed for changed files only), and the files a step is given: a package's own files in full, otherwise the file list and the files it names | `briefing.ts` | `planningBrief`, `refresh`, `render`, `attached_files`, `likelyFiles`; `Executor.withFiles`, `quality.scopeSection`, `routing.briefWriter` |
| A work package far past its expected turns goes to the lead (continue, or stop and then split) | `progress.ts`, `review.ts` | `expected_turns`, `OVERRUN_FACTOR`; `overrunCheck`, `supervisor.overrun_message` |
| Steps in one project at once: disjoint package files, or disjoint owned folders (`TaskNode.folders`, asked of the direct planner when files are not known yet; the step is told to write only there, `quality.foldersSection`), run together; unscoped steps alone. A step waiting for the folder shows as queued (`waiting_for_folder`, events `node.queued`/`node.dequeued`) and its time starts when it gets in. What a step actually changed is told to the steps still in the folder when it leaves (`Scope.changed`), and a step that changed a file a step alongside reads, when no one else there could have, does not pass (`Scope.intrusions`, `Executor.intrusions`) | `scopes.ts`, `executor.ts`, `server/packages/planning/src/task-planning.ts`, `server/packages/planning/src/planner.ts` | `FolderLock.hold`, `FolderLock.busy`, `Scope.clashes`, `Scope.own`, `Scope.intrusions`; `Executor.work`, `Executor.noteQueued`; `planner.package`; tests `server/tests/scopes-run.test.ts`, `server/tests/planning.test.ts` |
| Tools and sandbox for API models: Bash, Read, Write, Edit, MultiEdit, Glob, Grep, LS; Bash keeps its directory and the attempt's /tmp; platform data and other task folders stay hidden | `agent.ts` | `TOOLS`, `Workspace.run`, `run_all` (reads at once unless hooks are configured), `bash`, `sandboxArgs`, `networkPrefix`; structured compaction `providers.compactContext`; effort by difficulty `settings.reasoning_by_difficulty`, for leads `lead_reasoning_effort`, for diagnoses `diagnosis_reasoning_effort` |
| Checking long attempts by default; explicit artifact contracts have hard cumulative limits; a step others wait for far past its expected minutes goes to the lead (`Review.criticalCheck`, `supervisor.criticalOverrunMessage`) | `progress.ts` | `checkPrompt`, `parse`, `apiEvidence`, `cli_evidence`, `Stopped`, `limitReason`; the check itself is `Executor.progressWatch` (review.ts) |
| Per-request budget reservations, cost of a call | `budget.ts`, decided by the pricing package (`pricing.ts`) | `RequestBudget.reserve`, `pricing.charge` (cached input at the cache price: `tokenCost` in `server/packages/pricing/pricing.mjs`) |
| Quota / outage detection and cooldown | `quota.ts` | `QuotaTracker.classify`, `mark`, `exhausted` |
| Shared machine fixes (tools dir, env) | `environment.ts` | `tools_dir`, `commandEnv`, `profiles`, `shellSetup` (scripts each step command sources first: setting `sandbox_profiles` or `"profiles"` in `sandbox.json`), `hostPorts` (only the ports listed; a FlexLM vendor daemon is pinned in its license file and listed, `skills/steps/flexlm-license`) |
| Self-repair: isolated copy, checks, activation | `platform-repair.ts` | `PlatformRepairs.prepare`, `check`, `load`, `stale`, `diff`, `activate`, `SOURCE_DIRS` |
| Model catalog and benchmark scores | `catalog-sync.ts`, `benchmarks.ts`, `scoring.ts` | `publicModels`, `matchResults`, `rescore` |
| Results listing, ZIP, GitHub publish | `publish.ts` | `SKIP`, `resultMarkdown` |
| Settings (env `FLUIDFORM_*`) | `config.ts` | `settings` |

Automation chat preferences live in `capability_runner.Automation.state` (`model_id`, automatic
when absent/null, and `chat_preferences` for the last applied choice per chat), independently of
package code and secrets. `PUT /api/capabilities/{id}/model` validates uploaded automations against
`chatModels`; runtime exposes the saved choice to 平台 → 能力 → 聊天模型. `automation_message`
applies it before a reply starts, after any pending reply finishes. A changed model gets a fresh
session; the chat package hands over recent messages via the existing bounded transcript.
Restoring automatic chooses afresh, while unchanged automatic chats retain their conversation.
Unavailable selections/call failures use the normal fallback and disclose the actual replying
model; classification and task planning/execution keep their existing selection policies.

The DingTalk text bot is a shipped automation in `server/packages/dingtalk-bot/`
(`bot.py`, `transport.py`; `docs/design/dingtalk-bot.md`). It uses Stream callbacks and the
capability CONNECT proxy; the existing runner and chat API own conversations, commands and
task confirmation. Tokens/webhooks stay in memory; delayed results use nonsecret origin
routing and the official send APIs. Installing this package needs no platform restart.
Its offline check is `check.py`; integration tests are `server/tests/dingtalk-bot.test.ts`.

## Executor

`Executor` (`executor.ts`) mixes in `Reviewing` (`review.ts`), `Leading` (`leading.ts`), `Diagnosing`
(`diagnosing.ts`), `SelfRepair` (`self-repair.ts`) and `Engineering` (`engineer.ts`); they share its state (`db`, `locks`, `complete`, `save`, `emit`).

- `execute` / `dispatch`: the run loop; starts every ready node, or up to `max_parallel_nodes` when that is set (0, the default: no limit).
- `headStart` (setting `head_start`, off by default; `head_start_minutes`): with room left, `dispatch` starts a
  step whose dependencies are still to do or at work, once per generation and before its first attempt, if its
  model edits files, it has files or folders of its own and the folder would let it in now (`canHeadStart`; one that finds it in use stops, `FolderBusy`, and may start early later). `quality.headStartPrompt` asks
  for only what needs none of their results; no review, no attempt, no progress watch, cost charged as usual.
  `TaskNode.preparing`/`head_start`/`head_start_generation`; the report goes into the first attempt's prompt
  (`quality.HEAD_START_DONE`); events `node.head_start`, `node.head_started`; tests `server/tests/scopes-run.test.ts`.
- `admitToolChannel`: before dispatch and again after final model selection, checks declared
  tool-limit enforcement, authorization, routing eligibility and cumulative limits. A compatible
  replacement must also fit the remaining run/step budgets and other dispatched work's reservations.
- `executeNode`: one attempt; exceptions map to outcomes (`budget`, `error`, quota → `switchModel`).
- `check` (review.ts): review or verification verdict; `quality.Verdict(passed, reason, fix, unable, ...)`.
- `finish`: appends the `NodeAttempt` with an `Outcome`.
- After a failure (when `auto_diagnose`): the lead decides (`decide`, leading.ts): retry, switch
  model, accept, unable, ask the user, or a repair, which runs `repair` with its brief. Without a
  lead able to decide: `repair` then `repairDone` (diagnosing.ts), which carries out
  `recovery.afterDiagnosis(outcome, status)`: hold for a platform repair, ask the user, switch
  model, retry after an environment fix, mark unable (`markUnable`), pause, or retry.
- `retryOrFail`: counts the failure and fails the node or retries it on
  `recovery.retryModel` (a model that failed the node twice in a row gives way).
- A failed verification goes to the lead too (`supervisor.verificationMessage`): rework chosen
  steps with what to change (`sendBack(..., limited=False)`), accept, or rerun the verification.
  Without a lead, `sendBack` reopens all verified steps, capped by max_rework_rounds.
- `fixPlatform` → `platform_repair.check` → `activatePlatform` (self-repair.ts): self-repair,
  applied by restart.

Artifact work packages add gates without replacing the original acceptance criteria, task budget,
or sandbox permissions. Planning separates VDB collection, URG text reports and delivery audit
when these jobs are requested; it does not require all three for a report from an existing VDB,
a collection-only request, or unrelated coverage work. Flat planning, the lead's task planning and replanning
share `contracts` validation; an invalid contract cannot fall back to an unbounded plan. Dependency
inputs must name an ancestor's declared output; external inputs need no producer. Outputs are
allowed to be absent before the step runs. VDBs are directories; overlapping directory/file scopes
are serialized by `scopes.ts`.

`Executor.work` records the input fingerprints and the generation's output baseline before a
contracted step runs. `Reviewing.artifactCheck` checks nonempty, fresh files/directories and runs
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

`ProviderRegistry.toolLimitCapabilities` declares the platform-owned API loop's `tool_call`
counting unit and hard interception; CLI adapters declare these unsupported, regardless of their
reported provider turns. Missing declarations also fail closed. Admission can choose an authorized,
eligible compatible model without altering the contract, task permissions, sandbox, or acceptance
criteria. When no such channel fits, `node.blocked` records `started=false`, required and declared
capabilities, authorization/eligibility/budget checks, cumulative request/tool/cost counts and
affected dependency IDs. No `node.started` event or `NodeAttempt` is created for this rejection.
Stored counts have defaults for old records; existing request/cost totals are retained. Upstream
artifact acceptance is rechecked before a consumer starts and again in the ordinary input gate.
Missing prerequisites or an explicit `BLOCKED` result also block; a
limit without accepted delivery records `Outcome.STOPPED`. `stopContract` preserves the attempt,
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
| Team formation, assignments, delegation, recovery and shared budgets | `server/tests/team-run.test.ts` |
| Direct tasks without refinement; planning stage effort, deadlines and staffing reuse | `server/tests/planning.test.ts`, `server/tests/planning.test.ts` |
| Executor flow, retries | `server/tests/executor.test.ts`, `server/tests/recovery-and-diagnosis.test.ts`, `server/tests/recovery-regressions.test.ts`, `server/tests/turns.test.ts`, `server/tests/api-runs.test.ts` |
| Diagnosis | `server/tests/diagnosing.test.ts`, `server/tests/api-runs.test.ts` |
| Unable steps | `server/tests/unable-run.test.ts` |
| Network, sandbox, tools | `server/tests/api-runs.test.ts`, `server/tests/sandbox.test.ts`, `server/tests/contracts-skills-team.test.ts` |
| Providers, output caps | `server/tests/providers.test.ts`, `server/tests/streaming-calls.test.ts`, `server/tests/quota-run.test.ts` |
| Durable calls, memory, model handoff, telemetry, gates, hooks and history-based routing | `server/tests/call-runtime.test.ts`, `server/tests/call-runtime.test.ts` |
| Looking back on tasks | `server/tests/retrospect.test.ts` |
| Learning from finished tasks, validation, budget, reuse, effect comparisons | `server/tests/learning.test.ts`, `server/tests/engineer-run.test.ts` (a retrospective's platform change waits for both approvals) |
| Folder names | `server/tests/supervisor.test.ts` |
| Steps others wait for | `server/tests/executor-more.test.ts` |
| The check before the first step | `server/tests/preflight-run.test.ts` |
| Pictures by image models | `server/tests/images-gates-attachments.test.ts` |
| Skills | `server/tests/contracts-skills-team.test.ts` |
| Capabilities | `server/tests/api-platform.test.ts`, `server/tests/api-packages.test.ts` |
| API keys and the keyring | `server/tests/secrets.test.ts` |
| Membership CLI pricing and quota | `server/tests/cli-quota.test.ts` |
| Spreading steps over providers | `server/tests/executor-more.test.ts` |
| Progress checks | `server/tests/progress-calls.test.ts` |
| The lead's conversation | `server/tests/cli-channels.test.ts` |
| The lead's decisions | `server/tests/leading.test.ts`, `server/tests/replan-run.test.ts` (plan changes, final review) |
| Project work packages | `server/tests/packages.test.ts` |
| Artifact contracts, freshness, audit gates and cumulative limits (temporary files and fake models, no URG dependency) | `server/tests/packages.test.ts`, `server/tests/planning.test.ts`, `server/tests/replan-run.test.ts`, `server/tests/executor.test.ts`, `server/tests/turns.test.ts`, `server/tests/progress-calls.test.ts`, `server/tests/review-evidence.test.ts`, `server/tests/leading.test.ts`, `server/tests/contracts-skills-team.test.ts`; helpers in `server/tests/helpers/artifacts.ts` |
| Review prompts and evidence | `server/tests/review-run.test.ts`, `server/tests/review-evidence.test.ts` |
| Platform self-repair | `server/tests/platform-repair.test.ts` |
| The platform engineer | `server/tests/engineer-run.test.ts` |
| Catalog and benchmarks | `server/tests/catalog-sync.test.ts`, `server/tests/benchmarks.test.ts`, `server/tests/scoring.test.ts` |
| API-level flows | `server/tests/planner.test.ts`, `server/tests/api-runs.test.ts`, `server/tests/api-tasks.test.ts`, `server/tests/api-more.test.ts` |
| Web UI | `frontend/tests/mission-actions.test.mjs` |

Commands: `cd server && node --import tsx --import ./tests/helpers/tmp.ts --test tests/<area>.test.ts`
(one area), `npm run check` (types), `npm test` (all server tests, a few minutes), `cd frontend &&
npm test` and `npm run build` (only when the frontend changed).

Platform checks run the server tests in a sandbox with `FLUIDFORM_VALIDATION_ALLOW_NETWORK`
set to whether the task allows the internet.
`server/tests/platform-repair.test.ts` exercises these gates with simulated workspaces and both permissions;
it needs neither a real network namespace nor a TUN device.

## TypeScript server (`server/`)

The backend, moved from Python (docs/design/typescript-migration.md); the Python backend is gone,
its records still load. `src/model-schemas.ts` (the records) and
`src/config-fields.ts` (the settings) were first generated from the Python models; `model-hooks.ts` holds the validators,
`lax.ts` reads values as Pydantic does. `db.ts` (same SQLite file), `secrets.ts` (keyring in a
killable child, `keyring-worker.ts`). The API: `api.ts` (what the routes share: database, the one
model catalog, providers, executor, planning a task, starting a chat, the event stream; `api.deps`
for tests), `automations.ts` (what a message to an automation package becomes), `app.ts` (Fastify
routes, request checks as FastAPI makes them, the local-only guard); `main.ts` starts them, and `shutdown.ts` stops them in at most 10 s (closing waits for background work).
Modules are named as the Python ones were, with dashes (`cli_channels` → `src/cli-channels.ts`);
`py.ts` reproduces Python's behaviour where stored records and old outputs need it (regexes,
`round`, `json.dumps`, `shlex`, ContextVar). Model calls (`providers.ts`, `cli-channels.ts`) are
cancelled with an `AbortSignal` instead of task cancellation; modules expose a `deps` object for
tests to replace instead of monkeypatching. The executor's Python mixins are one class chain, a
file each: `executor-base.ts` (state, locks, budget, model calls; cross-layer calls declared abstract)
→ `reviewing.ts` → `leading.ts` → `diagnosing.ts` → `self-repair.ts` → `engineer.ts` →
`preflighting.ts` → `executor.ts`; background work is a cancellable `Task` (`tasks.ts`), cancelled
cooperatively. Tests: `tests/helpers/conftest.ts` gives each test what Python's conftest gives (and
finds no real membership CLI, only fakes a test makes in its own folder); `helpers/artifacts.ts`,
`helpers/lead-run.ts`, `helpers/providers.ts` are shared doubles. Platform repair (`platform-repair.ts`)
checks a copy in the TS layout (server/, frontend/) and hands it to `repair-worker.ts`, which uses
only Node's own modules and runs from a frozen copy: it installs the files, builds `server/dist`,
restarts the service and rolls back. `zip.ts` and `xlsx.ts` read and write archives and workbooks
(packages, downloads, SuperCLUE) with Node's zlib; `html-tables.ts` reads public leaderboard pages;
`fetching.ts` gets public data without following redirects. API tests use `helpers/task-api.ts`
(conftest's `task_api`) and `helpers/chatting.ts` (talking models, triage, a stub planner).
The cases in `tests/golden/` were recorded from the Python backend before it was removed; the TS
modules must still give the same.

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
