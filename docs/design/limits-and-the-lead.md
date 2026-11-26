# 用满上限时由负责人判断

## 为什么

minimal-gpu 任务里的"汇编器与参考模型"一直卡着，后面 5 步也跟着卡住，用户点"继续"也没用。它在"跑的过程中"用满上限时，负责人本来会判断（`executor.ts` 的 `finish`：放宽、拆分、修复，或者放弃）。可这次负责人被绕开了两次：

1. **提前准备（`headStart`）用光了整步的额度。** 上游还没完成时，这一步先做不依赖上游的部分。提前准备和正式开始共用合同计数，5 分钟就用掉了全部 50 次工具调用。它不算一次尝试，所以没有记录，也没有通知负责人。结果就是界面上"尝试 0 次、计数 50/50"。
2. **正式开始前的检查直接停掉了它。** `admitToolChannel` 看到上限已满，就调用 `stopContract`，不问负责人。之后每次"继续"都走这条路，一开始就被停。

当天下午平台工程师先修了一处：用户点"继续"时，用满上限的步骤放宽一次（`app.ts` 的 `reopenNode`，`contracts.extend`）。这能救急，但仍然要用户来点。

## 改动

- **开始前就满了，也交给负责人**（`executor.ts`）。`admitToolChannel` 发现这一步自己的上限已满、并且有负责人（`canLead`）时，把它标为 `running`，记一次尝试（`stopped`，原因是"开始前已用完：…"），发出 `node.limit_reached`，然后返回 false。调用方在锁外调用 `leadAtLimit`，走的是和跑的过程中用满上限相同的 `decide(…, "stopped")`。派发循环把它当成一个在跑的任务，所以任务会等负责人的决定，不会先以"未完成"结束。`executeNode` 里的两处检查返回 `"lead"`，释放锁之后再交给负责人。只有上级（委派它的步骤）的上限满了，或者没有负责人时，才按原规则停下。
- **提前准备最多用三分之一**（`executor-base.ts`，`HEAD_START_SHARE`）。`preparing` 的步骤在 `useTurn` / `beginTool` 里，最多用到上限的三分之一，余下的留给正式开始。

## 测试

- `tests/leading.test.ts`
  - 「a step already at its limit before it starts goes to the lead, not straight to a stop」：负责人被问到（提示里有 declared limit），决定重跑后上限放宽，步骤真的跑了，任务没有以"未完成"结束，历史里有那次 `stopped`。
  - 「without a lead a step already at its limit stops as declared」：没有负责人时照旧停下，一次调用都不发。
- `tests/turns.test.ts`「a step started early uses at most a third of its calls, and keeps the rest for itself」：上限 6，提前准备只能用 2，正式开始后还能用 4。

两条测试在修复前都失败。

## 风险

- 负责人的决定次数用完时，`decide` 会暂停任务、等用户确认，这和跑的过程中用满上限时一样。
- 提前准备能做的事少了：大的步骤只能先准备一部分。
