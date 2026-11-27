# The 模型 page

## 目标

The page answered "what is in the catalog and how was it scored": its first screen was the
catalog's sync with nine providers and the benchmark source, then a list saying only 已停用 /
已就绪, then a radar most of whose axes were empty. What one comes to it for is which models work
for them, what they cost, which could be switched on, and which need a key.

## 改动

- **Groups** (`model-profiles.tsx`): 在用 (configured and on, busiest first), 已配好，没启用, and
  缺密钥或没安装 (an API provider's models in one row with 配置密钥; a CLI not found on this machine).
  Retired models are not listed. Each row: name, 会员 CLI or API, price, context, whether it sees
  images, its calls (and spend, for an API model) over the last 30 days, and its switch.
- **Details** beside the list (under it on a narrow screen, scrolled to when a row is picked): what
  the scheduler gives it most, a CLI's membership usage, price, context and 30-day totals, its seven
  scheduling scores as bars, what it supports, the tasks and chats it worked on most. The radar,
  the benchmark results and the catalog facts are folded; so are the catalog's sync (目录与评分来源)
  and the comparison of every model.
- **Usage** (`GET /api/models/usage?days=30`): per model, from the recorded model calls (`calls.py`,
  `Database.model_calls_since`): calls, cost, the number of tasks and chats, and the three it worked
  on most with their names. A call that only handed its work to another is counted as that one's.
  Read-only; nothing else changes.

## 测试

`test_chat.py`: the usage endpoint's totals, the window, delegated calls. `mission-actions.test.mjs`:
the groups, their order and totals, the details, switching, a model without a key, filtering.

## 风险

- A deleted task's model calls are deleted with it, so they leave the totals.
- A CLI's cost is what FluidForm records for it (a membership's estimate), so a CLI row shows
  calls only.

## 清理旧界面的遗留（2026-11-27）

### 为什么

模型调研只剩 Artificial Analysis，而且厂商都做成了包。可模型页上还留着旧界面的东西：
- 写死的 9 家厂商名单（`PROVIDER_NAMES`）：关掉的厂商也照样列出；
- 多个榜单的切换框架（`benchmark-sources.ts`、`source` 参数、"其余榜单仅供参考"）；
- 详情里有两张雷达图，其中一张调度分雷达图和上面的分数条重复；
- 一条要求设置环境变量并重启的提示；
- 只认识 Codex、Claude、Gemini 的头像缩写表；
- `model-profiles.css` 里一半是旧版"模型画像卡片"的样式。

### 改动

- **厂商名改由服务器给**：
  - `/api/models` 的每个模型带上 `provider_name`，取自厂商包；
  - 模型调研的同步状态只列开着的厂商，每家带 `name`（`catalog-sync.status`）。
- **`catalog-status.tsx`**：卡片按服务器给的厂商逐个列出，再列一行 Artificial Analysis。去掉了环境变量的提示和几段长说明，只留一句来源说明。
- **`public-benchmarks.tsx`**：只处理 Artificial Analysis 一个来源。删除 `benchmark-sources.ts`，以及给 SuperCLUE、BFCL 留的汇总字段。说明只留一句。
- **`model-profiles.tsx`**：
  - 详情里的折叠区改名为"Artificial Analysis 成绩"，不再重复画调度分雷达图。`Radar` 组件保留，任务图里还在用。
  - 头像缩写改为取 CLI 名或厂商名的前两个字。
- **`model-profiles.css`**：删掉没有组件再用的 50 个类名、140 个选择器（192 行 → 87 行）。清理时核对过：组件还在用的类，一个都没少。

### 测试

- 前端 `mission-actions`："the 模型 page's sources list the providers in use, by the server's names, and Artificial Analysis only"：只列服务器给的厂商；不提 SuperCLUE、BFCL、环境变量或重启；详情里没有第二张雷达图。
- 模型列表测试的数据补上了 `provider_name`，和服务器现在的返回一致。
- 后端：
  - `catalog-sync.test.ts`：同步状态带厂商名，关掉的厂商不列出；
  - `api-more.test.ts`：`/api/models` 带 `provider_name`。
