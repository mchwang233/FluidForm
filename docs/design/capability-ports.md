# 能力的端口：核心定义接口，能力只做决定（2026-11-28 开始）

## 为什么

`task-capabilities.md` 把规划、负责人、平台工程师、经验搬进了 `server/packages/<id>`，但只约束了一个方向：
核心不直接引用包。包仍然作为执行器（`this`）运行，用得到核心的一切。2026-11-28 量的结果：

| 量 | 数 |
|---|---|
| `extension-api.ts` 交给包的 | 14 个整模块（约 320 个名字）+ 199 个单独的名字，出自核心约一半的文件 |
| 以执行器为 `this` 的包函数 | 21 个；负责人、平台工程师、经验分别用到执行器的 23、33、19 个成员，其中 `db` 35 处，还有 `save`、`locked`、`emit` |
| 核心把执行器交给包的转发 | 43 处 `.call(this, …)`，每处把参数重抄一遍（漏传 `edit` 的缺陷就出在这里） |
| 核心按名字问能力 | 47 处 `uses.X()` / `available("X")`，“没有这个能力时”的做法散在这些分支里 |
| 属于某个能力、却由核心定义的数据 | 任务记录上 16 个字段（负责人 7、平台工程师 5、经验 3、聊天 1），数据库 16 张表里的 11 张 |

所以包能改任务的任何状态、自己加锁、互相通过执行器调用（负责人用 `this.repair` 请平台工程师），核心保证不了任务状态的
一致，也换不掉其中一个能力而不碰其他部分。模型包（codex、claude-code、agy……）不是这样：它们只实现 `ModelChannel`，
拼出命令，由核心经 `Runner` 运行。这里要把任务能力也做成这样。

## 规则

1. **任务状态只由核心改。** 包拿到的是任务的快照和一个窄的宿主接口（问模型、记进度），返回数据：计划、决定、
   验收结论、提示词。核心在一个地方、在任务锁里把结果写进任务。包不碰 `db`、`save`、`locked`；要记进度，经宿主接口。
2. **端口由核心定义。** 每个能力一个端口（`server/src/ports/<能力>.ts`）：核心问它什么、它回答什么，以及它需要的宿主接口。
3. **没有这个能力时的做法是端口的默认实现。** 现在散在 `uses.X()` 分支里的“排一步”“固定规则重试”“暂停等你”
   成为默认实现，放在核心里。核心只问 `ports.<能力>()`，得到包的实现或默认实现；不再按名字分支。负责人和平台工程师
   没有时，流程本身不同（固定规则重试、暂停等你），这由核心的流程决定：负责人的默认实现说“没有负责人”（`leads: false`），
   平台工程师则由 `features.ts` 的 `stuckWaits` 挡在问它之前。
4. **能力之间不直接调用。** 负责人要平台工程师修，就返回“请平台工程师”这个决定，由核心转给平台工程师的端口；
   依赖写进 `capability.json`（`requires`）。
5. **契约在编译时检查。** 每个包的入口写 `export type Contract = Implements<端口, typeof import("./index.js")>`：
   导出和端口对不上就编译不过（`extensions.ts`）。
6. **只许变好。** `server/tests/capability-coupling.test.ts` 记着上表前四项的数，只能减少；减少了就把数改小。

## 各能力怎么分

| 能力 | 留在包里（怎么想） | 回到核心（怎么改任务） |
|---|---|---|
| 规划 | 排计划、快速/单人判断、项目简介、改计划和委派要怎么改 | 要不要排计划、把计划写进任务、路由和估价 |
| 负责人 | 提示词、读出决定、验收、超时检查、提议能力 | 决策次数上限、执行决定（`applyDecision`）、没有决定时的固定规则、预算用完时暂停 |
| 平台工程师 | 怎么查、怎么修、怎么改 FluidForm 时问模型的话 | 问哪些模型、按什么顺序换；各轮流程（检查没过就带着结果再改）；诊断记录和它怎么改任务、工作记录、复制源码、检查、应用、重启 |
| 经验 | 复盘怎么分析、给问题起名、开工前检查什么、找和写技能 | 什么时候复盘和检查、结果写进记录 |
| 模型调研 | 目录、价格、榜单怎么查，怎么打分 | 何时开始和停止；它的表由核心定义，包只拿到读写它们的几个方法（`ResearchStore`） |

宿主接口按需要给，不给执行器：规划的宿主只有问模型（`PlanningHost`）；准备技能的宿主记进度、读是否允许联网、查工具、
写技能（`SkillHost`）；负责人和平台工程师的包只给措辞和读回复，问模型由核心做，不需要宿主。只读的东西（模型目录、
设置）作为快照或参数传进去。

和负责人一样，平台工程师“各轮流程”（问、检查、没过就带着结果再问）原定留在包里，做的时候改为回到核心：这些流程
每一轮都要写工作记录和诊断记录、准备和检查源码副本，都是核心的事；包里真正属于平台工程师的只有问模型的话。

## 分几步做

每一步单独测试、单独提交；旧的任务记录照常能读、能继续；每一步结束时 FluidForm 都完整可用。

0. **护栏**（不改行为）：每个包的入口检查契约；`capability-coupling.test.ts` 记下现在的数。
1. **规划**：先做，它已经不用 `this`。端口加上类型化的宿主（代替 `providers: any`、`writer: any`）和默认实现（排一步）；
   核心排计划时不再按名字分支。
2. **负责人**：包只返回决定（`Decision | null`），`applyDecision` 和暂停、次数上限回到核心；`Leading` 不再把自己交给包。
3. **经验**：复盘和开工前检查返回结果，由核心写记录。
4. **平台工程师**：牵扯最多（33 个执行器成员），最后做。
5. **数据**：包不再拿到整个数据库和执行器内部的状态，只拿到自己那几张表的读写方法。表仍由核心定义：包停用以后，
   历史页面和删除功能照样要读写它们。任务记录上属于能力的那些字段，在第 2–4 步以后已经只由核心写入，所以留在任务记录上。
6. **收窄 extension-api**：包都不再用执行器以后，把执行器的类、`Database`、整模块的转出移走，只留端口、宿主、
   记录的类型和少量工具。

## 进度

- 第 0 步已完成（2026-11-28）：`extensions.Implements` 和五个包入口的 `Contract`；`capability-coupling.test.ts`。
- 第 1 步已完成（2026-11-28）：规划的端口是 `server/src/ports/planning.ts`（代替原来的 `planning.ts`）：
  - `PlanningPort`：`brief`、`quick`、`plan`、`changePlan`、`delegate`；宿主 `PlanningHost` 只有 `complete` 和 `converse`
    （代替 `providers: any`）；写简介和做判断的模型改为需要时才取，默认实现不会为它们去问计价。
  - `base` 是没有规划能力时的做法：`oneStep`（和 `QUICK_SCOPE`、`SOLO_SCOPE` 一起从 `api.ts` 搬来），不写简介、不做快速判断，
    改计划和委派照旧拒绝。`planning()` 给出包的代码或 `base`；`Api.makePlan` 不再按名字分支（按名字问能力 47 → 43）。
  - 包的 `port.ts` 把端口接到原来的函数上；排计划的入口从 `autonomousPlan(prompt, …)` 改为 `plan(input, host)`，
    测试改替换 `api.deps.plan`。快速、单人判断的结果仍由核心变成一步的计划（包返回判断，核心写计划）。
- 第 2 步已完成（2026-11-28）：负责人的端口是 `server/src/ports/lead.ts`（代替原来的 `lead.ts`）：
  - `LeadPort` 只有负责人的措辞和理解：失败、修完、你回答之后、全部做完时它被告知什么（`failureMessage` 等），
    怎么从回复里读出决定（`readDecision`）、怎么再提醒格式（`decisionFormat`），以及超时检查；`ReviewPort` 是验收。
    都不碰任务。`base` 没有负责人（`leads: false`），`noReview` 没有验收。
  - 问负责人（同一个对话里最多再问一次、改计划先在副本上试）、次数上限和暂停、预算用完时暂停、没有决定时的
    固定规则、执行决定（`applyDecision`）、提议能力，都回到核心的 `leading.ts`；包里的 `leading.ts` 删掉。
  - 读回复用开始问时取到的端口：负责人在回答时被停用，它已做的决定照样执行（`switching.test.ts`）。
  - 以执行器为 `this` 的包函数 21 → 14，`.call(this)` 转发 43 → 29，按名字问能力 43 → 36；`extension-api`
    不再交出 `Leading`。
- 第 3 步已完成（2026-11-28）：经验的端口是 `server/src/ports/learning.ts`（代替原来的 `experience.ts`）：
  - `LearningPort` 有复盘（`learn`）、给问题起名（`nameProblems`，库的类型从 `any` 改为 `Db`），以及开工前检查要知道的：
    检查什么（`environmentChecks`、`modelChecks`）、通过的检查记多久（`cacheKey`、`passedBefore`、`remember`）、
    结果怎么读和怎么说（`failures`、`describe`）、修环境和写技能的提示词、哪些工具在、每个工具用哪个技能（`prepareSkills`）。
  - 检查流程（检查、修一次、再检查、准备技能、把结果写进任务、没通过就暂停）、修环境（开诊断、写诊断记录）、
    让模型写技能，都回到核心的 `preflighting.ts`；包里不再有以执行器为 `this` 的函数。
  - 准备技能经 `SkillHost`（记进度、读任务现在是否允许联网、查工具、写技能）：查工具和写技能仍是执行器上的方法，
    测试照旧替换它们。检查已开始后用 `begun()` 取包的代码：中途停用，这次检查照常做完。
  - 以执行器为 `this` 的包函数 14 → 6，`.call(this)` 转发 29 → 13；`extension-api` 不再交出 `Preflighting`。

## 风险

- **工作量大**：负责人和平台工程师那两步各要改几百行，测试里直接调用执行器方法的地方也要跟着改。
- **行为要完全一样**：这是重构，不是改功能。每一步都要跑全部测试，包括和 Python 后端的对照测试。
- **并发**：状态改动收回核心以后，在一个地方加锁；以前分散在包里的加锁顺序要逐一核对，不能引入新的死锁。
- 第 4 步已完成（2026-11-28）：平台工程师的端口是 `server/src/ports/engineer.ts`（代替原来的 `engineering.ts`）：
  - `EngineerPort` 只有问模型的话：查原因（`diagnosisPrompt`）、修步骤外的问题（`repairPrompt`）、修 FluidForm 自身
    （`platformRepairPrompt`）、写方案和改代码（`planPrompt`、`editPrompt`），以及续做和检查没过时的提示（`continueNote`、`checkFailed`）。
  - 修复（占诊断位、开诊断、修、取消和预算用完时的处理）、按顺序换模型（`diagnoseWith`）、手动诊断（`runDiagnosis`）
    回到核心的 `diagnosing.ts`；修 FluidForm 自身的各轮（`fixPlatform`）回到 `self-repair.ts`；平台工程师写方案、改代码的各轮
    （`engineerPlan`、`engineerEdit`）回到 `engineer.ts`。包里的 `diagnosing.ts` 删掉，`fixing.ts`、`jobs.ts` 只留提示词。
  - 包里不再有以执行器为 `this` 的函数（6 → 0），核心也不再把执行器交给包（转发 13 → 0；`agent.ts` 里的
    `mcp.call(this, …)` 是调用 MCP 工具，不算）。`extension-api` 不再交出任何执行器的类（`Diagnosing`、`Engineering`、
    `SelfRepair`），名字 199 → 196。
  - 下一步是第 5 步（数据）和第 6 步（收窄 `extension-api`）；按名字问能力还有 36 处，多是执行流程里“有没有负责人、
    有没有平台工程师”的判断。
- 第 5 步已完成（2026-11-28）：包不再拿到整个数据库，也碰不到执行器正在跑的任务：
  - 负责人的验收和超时检查拿 `LeadHost`：问模型、问负责人、记进度、读任务（`db` 只有 `getRun`）；不再有执行器的
    `toolLogs`、`toolTraces`。
  - 复盘拿 `LearningPortHost`：模型、`LearningRecords`（复盘、经验和效果、它们来自的任务和平台工程师工作）、`settled`
    （等任务自己的执行结束，代替直接看执行器的 `tasks`）；不再有 `learningTasks`、`tasks`、`closing`。取消后的收尾
    （`skipCancelledLearning` 会停掉执行器里的复盘任务）改由核心在复盘结束后做。给问题起名只拿 `NamingRecords`（复盘记录）。
  - 模型调研拿 `ResearchStore`：模型目录、目录同步状态、榜单缓存的读写。
  - 核心的 `learningSource`、`allocated` 的参数改为它们真正用到的那几个方法。
  - `extension-api` 不再交出 `Database`、`ReviewHost`、`LearningHost`、`skipCancelledLearning`；
    `capability-coupling.test.ts` 检查它不交出执行器的类、整个数据库和这些宿主。
- 第 6 步已完成（2026-11-28）：`extension-api` 收窄。
  - 搬回核心以后没有包再用的 20 个名字删掉（`parse`、`RepairError`、`DiagnosisSchema`、`Db`、`currentTask` 等），
    没人用的 `capabilities` 整模块不再转出。
  - 其余 13 个整模块改为各列一张清单（`server/src/package-api/<模块>.ts`，仍以 `quality`、`skills` 等名字交给包）：
    包写法不变，但只拿得到清单里的名字；包要更多就把名字加进清单，依赖一眼可见。
  - 包能拿到的名字从约 519 个（196 个单独的 + 14 个整模块约 320 个）减到 240 个；整模块转出 14 → 0。
    `capability-coupling.test.ts` 改为数包能拿到的全部名字。
  - 还没做的：按名字问能力还有 36 处，多是执行流程里“有没有负责人、有没有平台工程师”的判断；核心内部 8 层继承链
    没动（第 2–4 步把流程搬回核心后它更大了），是下一件事。
