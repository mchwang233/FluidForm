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
