# 少设开关

## 为什么

前几轮加的每个功能都放在一个默认关的开关后面，再在这台机器的 `.env` 里一个个打开：轻量任务、一个模型连续做完、重启后接着做、聊天里做小事、记忆、读网页、请平台工程师……最后有 20 个默认关的开关要人去设，换一台机器就得重新配一遍。用户的原话："开关太多了，这些需要人去设置的东西太麻烦了。"

原因是把平台规则里"没设开关的机器保持原样"这一条，用在了用户明确要的功能上。这条规则本来是给平台工程师顺手修问题时用的，不该用在产品方向上。

## 改动

- **用户要的功能直接是默认做法**（`config.py`）：
  - 轻量任务 `quick_tasks`、一个模型连续做完 `solo_tasks`、重启后接着做 `resume_after_restart`；
  - 聊天里做小事 `chat_tools` 并联网 `chat_tools_network`，每条消息 300 秒、50 次工具调用；聊天动作用工具调用 `chat_action_tools`；
  - 记忆 `user_memory`、读网页 `web_fetch`、修复都交给平台工程师 `engineer_repairs`；
  - 执行前检查缓存 60 分钟。
  - 设置项还在，可以单独关掉。
- **有密钥就用**（`images.AUTO`、`web.AUTO`）：`image_models`、`web_search_models` 没设时，FluidForm 认识的、这台机器有密钥的服务都会用上；设成 `[]` 表示不用。这是从机器上读出来的，不需要人填。
- **档位只留"稳妥"**（`config.PROFILES`）：每件事都排计划、每一步都验收。原来的 `fast`、`balanced` 读成默认（`FORMER_PROFILES`），旧的 `.env` 和 `profile.json` 照常能用。设置菜单里只剩"默认 / 稳妥"两个。
- **规则**（`skills/platform-rules` 第 5 条）：用户要的功能就是以后的做法。默认关的开关只用于三种情况：会扩大沙箱能访问的范围、会在没人要求时花钱、只适用于某些机器；第三种优先从机器上读出来，而不是让人填。修复是直接把行为改对，不加开关保留旧行为。
- **这台机器的 `.env`**：删掉了 15 行和默认值一样的设置，剩下 15 行：目录、会员套餐和计费，以及下面这些早先的实验开关。

## 测试

- `test_defaults.py`：
  - 什么都不设时，这些功能都开着；`allow_host_shell` 仍然关着；
  - 画图和搜索按有没有密钥自动决定用哪家，`[]` 表示不用；
  - 旧档位名读成默认。
- `test_profiles.py`、`test_memory.py`：只剩"稳妥"一个档位，单独设过的照旧优先。
- 其他测试测的不是这些功能，默认仍按原来的行为跑（`conftest.former_defaults`）；测某个功能的测试自己打开它。

## 早先的开关

用户逐个定了：

- 改成默认开：`capability_packages`（飞书机器人靠它）、`employee_teams`、`head_start`、`skill_reuse_first`、`capability_proposals`。测试里默认仍关（`conftest.former_defaults`、`isolated_environment`），测这些功能的测试自己打开。
- 删掉：`direct_task_planning` 和 `adaptive_refinement`，连同"先分大项、执行时再细化"的整套做法：`outline.py`、`refining.py`、执行器里的 `_split_parts` 和等待未细化大项的检查。负责人现在只用 `task_planning.py` 直接排出能执行的任务。
  - 它们共用的几样东西搬到了 `lead_planning.py`：`_ask`、`plan_title`、`MAX_TASKS`、`INTERNET_NOTE`、`MAX_REQUIRES`。
  - 负责人排不出计划时，退回到普通的单次规划；需要员工队伍时照旧报错。和以前不开直接排任务时一样。
  - 旧的 `.env` 里写着这两个设置名的，照常能读（`config.RETIRED`）。
  - 旧任务的计划里带着大项的，照常能读、能显示。还有大项没细化的旧任务，开始执行时会直接结束并说明原因（`executor.UNSPLIT_PARTS`），请用户用"需求变更"重新排计划，不会卡在等细化上。页面上这种大项标为"未细化"。
  - 少了的一项：细化时，太粗的工作包（没列文件的大步骤）会被退回给负责人重排。直接排任务时没有这一步。这台机器之前一直开着直接排任务，所以实际行为不变。
- 保留开关：自动复盘 `learning_enabled`。每个任务要花约 $0.50，而且页面上已经有开关。
