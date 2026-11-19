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

## 还没定的

早先的 8 个实验开关：`employee_teams`、`direct_task_planning`、`head_start`、`skill_reuse_first`、`adaptive_refinement`、`capability_proposals`、`capability_packages`、`learning_enabled`。每个要么改成默认开，要么连代码一起删掉，由用户逐个决定。
