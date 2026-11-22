# 后端迁移到 TypeScript

## 为什么

用户决定整个后端从 Python 换成 TypeScript：前后端一种语言、类型共用，编译时就能发现字段写错；
飞书等平台的官方示例和插件以 TS 为主；Node 天生异步，适合机器人和 Agent 这类等网络的程序。

## 规模

- 后端 `backend/super_partner`：66 个模块，约 2.4 万行。
- 测试 `tests/`：约 1.75 万行，1058 个用例。
- 飞书包 `feishu-bot/bot.py`（`capabilities` 分支）：约 900 行。
- 前端已是 TS（约 4800 行），不动。

## 原则

1. **Python 一直在线，直到切换那天。** TS 后端在 `server/` 里并行写，Python 服务照常跑任务，
   用户感觉不到迁移。
2. **测试跟着模块走。** 每迁一个模块，它的 Python 测试一起改写成 TS，用例一个不少；测试不过不算迁完。
3. **旧记录必须能读。** 同一个 SQLite 文件、同样的 JSON 内容；模型字段的默认值和 Pydantic 一致。
4. **对拍。** 切换前，在数据库副本上同时起 Python 和 TS 两个服务，所有 GET 接口逐个比对返回，
   不一致的都要解释或修掉。
5. **不加规则以外的东西。** 不顺手改行为；发现的老问题记下来，迁完再修。

## 技术选型

| 用途 | Python 现在 | TS 选择 | 说明 |
|---|---|---|---|
| 运行时 | Python 3.9+ | Node 22（本机已有 22.23） | 设置要求 Node ≥ 22 |
| HTTP | FastAPI + uvicorn | Fastify | 成熟、快，路由和现在一一对应 |
| 数据结构 | Pydantic | zod | 由 Pydantic 的 JSON Schema 生成初版，之后手工维护；前端直接引用类型 |
| 数据库 | sqlite3 | `node:sqlite`（内置） | 不引入原生依赖 |
| 密钥 | keyring（Secret Service） | `@napi-rs/keyring` | 第 0 阶段先验证能读出 Python 写入的条目；读不出就不往下做 |
| 加密 | cryptography | `node:crypto`（内置） | |
| Excel | openpyxl | 自己读（`xlsx.ts`，在 `zip.ts` 上） | 只有 benchmarks 用；安装包本来就要读 zip，读 xlsx 只多一百多行，省掉 exceljs 和它带来的一百多个包 |
| HTTP 客户端 | httpx | 内置 fetch | |
| 命令行 | typer | 内置 `util.parseArgs` | `fluidform` 命令保留 |
| 测试 | pytest | `node:test`（内置，和前端一样） | |
| 检查 | ruff | `tsc --noEmit`（strict） | |
| 运行 TS | — | tsx（开发）、tsc 编译（运行） | |

新依赖（需要你同意）：fastify、zod、@napi-rs/keyring、typescript、tsx。（原计划还有 exceljs，第 4 阶段改为自己读 xlsx，没有用它。）

## 阶段

每个阶段单独提交、测试全过，Python 服务不受影响。

| 阶段 | 内容 | 主要模块 |
|---|---|---|
| 0 基础 | `server/` 骨架、配置（`FLUIDFORM_*` 不变）、数据库层、全部数据模型、密钥读写验证、对拍工具 | config, db, models, secrets |
| 1 纯逻辑 | 不碰外部的规则和文字 | contracts, quality, supervisor, routing, catalog, team, remembering, triage … |
| 2 对外调用 | API 模型、会员 CLI、沙箱和工具、环境检查 | providers, cli_channels, agent, environment, preflight, mcp, cli_quota |
| 3 编排核心 | 计划、执行、负责人、诊断、学习 | planner, task_planning, executor, leading, replan, review, diagnosis, learning, retrospect |
| 4 接口与外围 | 所有路由、自动化包、平台工程师、平台修复 | api, capability_runner, capability_sandbox, engineer, platform_repair, conversation, benchmarks … |
| 5 切换 | 对拍通过后，8000 端口换成 TS；Python 留一周可回退 | 服务启动命令、AGENTS.md、skills、ARCHITECTURE.md、README |
| 6 收尾 | 删除 Python 后端和测试；飞书包改写成 TS | backend/, tests/, feishu-bot/ |

## 切换时要一起改的

- `AGENTS.md`、`skills/platform-repair`、`skills/platform-engineer`、`skills/platform-rules`：
  测试和检查命令、代码位置都改成 TS。平台工程师和平台修复的模型照这些文件干活，必须同时改。
- `docs/ARCHITECTURE.md`：模块路径。
- 服务启动命令：从 uvicorn 换成 `node server/dist/main.js`。
- 自动化包：`entry` 写 node 的包要在沙箱里能跑 Node（第 4 阶段验证）。Python 写的包照常能用。

## 风险

- **工作量大。** 按模块估计要几周；中途 Python 和 TS 两份代码并存，新功能和修复要两边都改，
  所以迁移期间尽量少加新功能。
- **行为细节丢失。** 很多修复只体现在细节里；靠逐个移植测试和对拍兜住。
- **密钥库兼容。** 如果 `@napi-rs/keyring` 读不出现有条目，要换方案，第 0 阶段就会知道。
- **切换那一刻有任务在跑。** 切换前确认没有任务在跑，和平时重启一样。
- **平台工程师和平台修复。** 它们按 skills 文件改代码、跑测试；切换后用新命令，切换前的旧任务记录不受影响。

## 测试

- 每个模块：对应 Python 测试改写成 TS，`node --test` 全过。
- 对拍：同一份数据库副本，Python 和 TS 两个服务的 GET 接口返回一致。
- 切换后：前端测试和构建全过；在网页上建一个小任务跑完；飞书群里问一句。

## 进度

### 第 6 阶段：收尾（完成）

按你的决定，不留一周回退，直接删掉了 Python 版本：

- 删除 `backend/`、`tests/`、`pyproject.toml`、本地的 `.venv`，以及只为迁移服务的工具（对拍、测试对照表
  `ported.json`、`golden.py`、`gen_entities.py`）。`tests/golden/` 里录下的 Python 结果留作回归数据。
- `./start.sh` 只启动 TS 服务，去掉了 `--python`；平台修复的源码范围不再包括 `backend/`、`tests/`。
- 源码注释里指向 Python 文件的说明去掉或改成对应的 TS 文件；测试文件开头"移植自哪个 Python 测试"的说明留着，
  在 git 历史里能查到原文。
- 只读 Python 写下的旧记录的兼容代码（时间格式、Pydantic 的宽松读法）都留着：旧数据照样能读。
- 用 Python 写的能力包（飞书机器人）照常能用：它们用系统的 `python3` 建自己的环境，和后端无关。
  原计划把飞书包改写成 TS，没有必要，没做。
- TS 测试 969 个、前端测试 115 个全部通过，类型检查、服务端和前端构建通过。

### 第 5 阶段：切换（代码已改好，服务还没启动）

- **启动**：`./start.sh` 先构建 `server/dist`，再用 `node server/dist/main.js` 起 8000 端口。Dockerfile 改成 Node 镜像。
- **AGENTS.md、三个平台 skills、ARCHITECTURE.md、README、guide**：命令、文件路径、函数名都换成 TS 的。
  平台修复和平台工程师从此改 `server/` 和 `frontend/`，`backend/`、`tests/` 不再改。
- **数据模型和设置的定义**从此直接在 TS 里改：`models.generated.ts` 改名 `model-schemas.ts`，
  `config.generated.ts` 改名 `config-fields.ts`，`gen_models.py` 和检查它的测试删掉。
- `fluidform` 命令由 `server/dist/cli.js` 提供（`npm link`）。
- 复盘按"修了哪个模块"归类时也认 `server/src/` 下的文件，模块名里的 `-` 换成 `_`，和以前的记录算同一类。
- 对拍又查出两个问题，已修：
  - **数据库被别的进程写着时，TS 立刻报"database is locked"**（node:sqlite 默认不等），Python 的 sqlite3 会等 5 秒。
    现在也等 5 秒；平台修复的备份、外部工具读库时不会再让请求失败。有回归测试。
  - 开发模式（tsx）下从仓库根目录启动时，读钥匙串的子进程找不到 tsx，判成钥匙串不可用。
    现在按 secrets.ts 自己的位置找 tsx。编译后的正式服务本来就不受影响。
- 对拍（两边都从仓库根目录启动、读同一个 .env）：162 个读取接口 159 个一致，其余 3 个只差时间写法。
- 还没做：停掉旧服务后启动 TS 服务；在网页上建一个小任务跑完；飞书群里问一句。

### 第 4 阶段：接口与外围（完成）

已迁：自动化包（capability_packages 的其余部分、capability_sandbox、capability_runner）、benchmarks、catalog_sync、
evals、cli、publish、platform_repair，以及全部接口路由（api.py）。

- **zip 和 xlsx 自己读写**（`zip.ts`、`xlsx.ts`，只用 Node 内置的 zlib）：安装包要读 zip，下载成果要写 zip，
  SuperCLUE 的评分是 xlsx。原计划的 exceljs 没有用上，已从依赖里去掉（node_modules 从 218 个包减到 51 个）。
- 网页表格（AA 的排行榜）用 `html-tables.ts` 读，只取表格和脚本文字，不执行。只认常见的几个具名字符引用，
  其余原样保留（Python 的 html.parser 认全部 HTML5 名称；这些页面用不到）。
- AA 网页数据里出现 `NaN`：Python 的 json 认它，然后判整个来源出错；JSON.parse 不认，这条记录被跳过。
  两边都不会用到坏数据；真实页面由 JS 生成，写不出 `NaN`。
- 取公开数据（`fetching.ts`）：不跟随跳转（跳转算错，凭据不会被带到别的主机），限大小、限时，
  错误分成状态码、超时、网络三类，和 httpx 一样。
- 命令行用 `node:util` 的 parseArgs，不加依赖。
- **平台修复按切换后的样子重写**：
  - 源码布局认 `server/` 和 `frontend/`；入口是 `server/package.json`、`server/src/main.ts`、`frontend/package.json`；
    回归测试要放在 `server/tests/` 或 `frontend/tests/`。`backend/`、`tests/` 在第 6 阶段删掉之前也算源码。
  - 检查依次是：TypeScript 类型检查、已有数据库记录兼容（用复制的真实数据库跑一个 TS 小脚本）、服务端测试、
    前端测试、前端构建。都在沙箱里跑，看不到真实数据、主目录和 API 密钥，任务允许联网时才联网。
  - 生效：服务跑的是编译后的 `server/dist`，所以生效的工作进程把文件放好后先 `npm run build`，再重启服务；
    回滚时同样先构建再重启。
  - 生效的工作进程是 `repair-worker.ts`，只用 Node 内置模块，Node 22 能直接运行 `.ts`（只去掉类型，不用编译）。
    它和任务一起复制一份，修复改不到正在应用它的那份代码。
  - 检查命令的输出写到文件里，不用管道：pasta 不把输出交给套接字（Node 的管道是套接字），这和 agent.ts 的做法一样。
  - 健康检查要 `/health` 返回 `{status, pid}`，TS 的接口路由迁过来时要带上。

- **接口路由**（`api.ts` 放接口用到的状态和规划逻辑，`automations.ts` 放自动化包收到消息后的处理，`app.ts` 是路由）：
  - 测试要替换的东西都在 `Api` 对象上（`api.models`、`api.executor`、`api.deps.autonomousPlan` 等），
    对应 Python 测试里的 monkeypatch。测试夹具 `tests/helpers/task-api.ts` 对应 conftest 的 `task_api`。
  - 模型表只有一份：目录同步、评分、Executor、ProviderRegistry 共用同一个对象（之前目录同步和评分用 Map，改成了 Record）。
  - 请求体和查询参数用 zod 按 FastAPI 的规则检查，出错时同样回 422 和 `{"detail": [...]}`；空的 JSON 请求体当作没有请求体。
  - 上传附件和能力包的路由直接读原始字节（不管 Content-Type），超过大小回 413，提示和 Python 一样。
  - 事件流（SSE）的生成器在 `Api.events`，客户端断开时停止。
  - `/health` 返回 `{status, pid, ...}`，平台修复的生效进程用它确认新版本起来了。
  - 能力包运行器的重启次数和进度间隔放进 `limits`，测试可以调小。
  - 自动化状态里旧的 `memory` 字段不再搬到共享记忆（`remembering.adopt` 已按你的决定删掉）。
- **对拍**：在真实数据的副本上，Python 和 TS 两个服务回答 162 个读取接口（全局的，加最近 25 个任务各自的页面），
  159 个完全一致。其余 3 个只差时间的写法：Python 在部分地方写 `+00:00`、TS 写 `Z`，`since` 的微秒位数不同，
  表示的是同一时刻，前端解析结果相同。对拍脚本现在也关掉平台自修复，免得副本里的平台工程师工作被重新启动。

到这里：Python 测试 828 个全部有 TS 对应（个别按删繁就简的决定去掉了部分断言）；TS 测试 970 个，全部通过。

### 第 3 阶段：编排核心（完成）

已迁：briefing（项目简报）、projects（项目目录）、learning（复盘与经验）、supervisor（负责人：选人、对话、交接、
事件消息和决定）、review（验收和长时间尝试的检查）、planner、task_planning、lead_planning、replan、scopes，
以及 team 的组建团队和委派（放在 `team-planning.ts`：team.ts 被底层模块引用，和规划放在一起会形成循环引用）。
capability_packages 先迁了负责人要用的部分（聊天说明、数据目录、密钥名）。

- Python 混入执行器的类（Learning、Reviewing 等）在 TS 里是接收执行器的函数（`LearningHost`、`ReviewHost`）。
- 后台任务用 `tasks.ts` 的 `Task`（可取消的 Promise），对应 asyncio 的任务。
- 任务的修订号（复盘判断是否过期用）是 Python `json.dumps` 的哈希；Python 把 `1.0` 写成 `1.0`，JS 写成 `1`，
  所以 `py.pyModelDumps` 按模型的浮点字段照 Python 的写法输出，算出的修订号和 Python 记下的一致。
- 测试：`tests/helpers/conftest.ts` 照 Python 的 conftest 给每个测试平台默认值（不读本机 `.env`）、临时目录，
  以及现在默认开启的功能的旧默认值（测哪个功能就由那个测试打开）。
- platform_repair（平台改自己的源码并重启服务）和 Python 的目录结构、pytest、systemd 服务名绑在一起，切换后都会变，
  按计划在第 4 阶段重新设计；执行器通过接口使用它。

- 发现并改了一个 Codex 步骤的缺陷（Python 也有）：步骤的权限配置把 /tmp 里已有的条目逐个设为不可读，全写在一个
  `-c` 参数里；/tmp 条目多、名字长时，这个参数超过 Linux 单个参数 128 KiB 的上限，Codex 根本启动不了（E2BIG）。
  TS 里条目名字总长超过 64 KiB 时改为整个 /tmp 不可读（和超过 2000 个条目时一样）。Python 按用户决定不修，切换后随 TS 解决。
- TS 测试的临时文件现在放在每个测试进程自己的目录里，结束时删掉（`tests/helpers/tmp.ts`），不再堆在 /tmp。

执行器也迁完了：Python 的混入类在 TS 里是一条继承链，每层一个文件（`executor-base.ts` → `reviewing.ts` →
`leading.ts` → `diagnosing.ts` → `self-repair.ts` → `engineer.ts` → `preflighting.ts` → `executor.ts`），
跨层调用在 `ExecutorBase` 里声明。

- 取消是协作式的：`Task.cancel()` 发出信号，正在做的事要听这个信号才会停（Python 的 `await` 天然可取消）。
  测试里的替身也要听，否则取消会一直等。
- Python 测试靠替换模块函数（monkeypatch）的地方，TS 的 ES 模块换不了，改成可替换的对象：
  `learning.checks.skill`、`quality.files.state`、`skillDiscovery.deps.discover`、`selfRepair.limits.APPLY_WAIT_SECONDS`
  （和第 2 阶段的 `cliChannels.deps`、`limits` 一样）。
- 移植测试时发现并改了一处和 Python 不一致的地方：没有 providers 时 `configured` 应返回空集合（Python 用 `getattr`），TS 原来会直接报错。
- **测试曾调到真的会员 CLI。** 移植 test_quota 时，一个测试的负责人对话走到了本机真的 Claude Code，问了两次
  （用的是会员额度，只在测试临时目录里）。原因是这个测试的替身抛错方式不对，失败交给了负责人，而 TS 测试里没有任何东西挡住真 CLI。
  现在 `tests/helpers/conftest.ts` 让每个测试只找得到它自己在临时目录里放的假 CLI；唯一要用真 Codex 的测试
  （真沙箱能否挡住读密钥）显式调用 `allowRealClis()`，它只跑沙箱命令，不问模型。有一个测试确认这道拦截在。

到这里：Python 测试 828 个中 627 个已有 TS 对应；其余 201 个依赖第 4 阶段的模块（自动化包的运行和沙箱、平台修复、
评测、模型目录同步、接口路由）。TS 测试 732 个，全部通过。

### 第 2 阶段：对外调用（完成）

已迁：environment（含许可证端口追踪，异步）、quota、calls、web、mcp（用 FIFO 代替 socket 管道）、agent（沙箱与文件工具）、
cli_channels、cli_quota、providers、skill_discovery、retrospect（preflight 要用，提前迁），以及 preflight 里的检查、
提示词和缓存。

- preflight 里混进执行器的那部分（Python 的 `Preflighting`：开工前检查、修一次、准备技能）离不开执行器，
  和执行器一起在第 3 阶段迁。
- 取消：Python 用任务取消，TS 用 `AbortSignal`（`signal` 参数一路传到 fetch、子进程和排队）。会员 CLI 被取消时
  照旧杀掉整个进程组；请求被进度检查停下时，它的回复时限也一并清掉。
- 模型请求用内置 fetch；流式回复逐块读，任何一块超过 `api_reply_deadline` 没来就停，和 Python 一样。
- `cli_quota` 读 Codex 会话文件是同步的，Python 放在线程里跑；第 3 阶段和其它重活一起挪进 worker 线程。

到这里：Python 测试 828 个函数中 300 个已有 TS 对应（`server/tests/ported.json`），7 个等第 3 阶段
（team 的组建和委派），其余的依赖还没迁的模块；TS 测试 413 个，全部通过。

### 第 1 阶段：纯逻辑（完成）

第一批（完成）：activity、budget、chat_actions、conversation、streaming、catalog、extensions、
routing_feedback、scoring、remembering、folders。

第二批（完成）：progress、attachments、images、routing、recovery、diagnosis、call_control、triage。

第三批（完成）：skills、capabilities、contracts、quality、team（组建团队和委派依赖 planner，随第 3
阶段迁）、environment 里的工具目录（其余随第 2 阶段迁）。supervisor 依赖第 2 阶段的 cli_channels、quota
和第 4 阶段的 capability_packages，一半又是负责人的对话，改到第 3 阶段和 leading 一起迁。

文件系统部分（路径安全、文件摘录、私密文件、产物指纹）用同一份目录树清单在两边建出相同的树来比对：
产物指纹（含 VDB 目录里的内部链接、路径排序）与 Python 完全一致，Python 记下的验收证据切换后照样有效。

Python 里放到线程跑的重活（`quality.file_state`、`contracts.prepare` 的哈希）现在是同步实现；第 3 阶段
执行器要把它们放进 worker 线程，不能卡住 Node 的事件循环。

到这里：Python 测试 828 个函数中 119 个已有 TS 对应（`server/tests/ported.json`），6 个等第 3 阶段
（team 的组建和委派），其余的依赖还没迁的模块；TS 测试 211 个；标准答案约 3300 条。

为对上 Python 的细节，`src/py.ts` 补了：上下文变量（ContextVar，用 AsyncLocalStorage）、asyncio.Event、
`json.dumps` 的原样格式、Python 的 `round`（看精确的二进制值，恰好一半取偶数）和 `:g` 格式、`shlex`、
`str()`，以及 Python 正则到 JS 正则的翻译（`pyRegex`：只有 `\n` 算换行、`\w` `\d` `\b` `\s` 按 Python 的 Unicode
规则、`(?P<name>)`、行内标志）。标准答案共 2400 多条，含一批正则在 Python `re` 上的结果。

### 第 0 阶段：基础（完成）

`server/`：Node 22 + TypeScript（strict），`npm test`（node:test + tsx）、`npm run check`、`npm run build`。

- **数据模型**（`src/models.generated.ts`，由 `tools/gen_models.py` 从 `models.py` 生成，35 个模型、3 个枚举）：
  字段、默认值、约束（大于、范围、长度、正则、严格整数）都生成；读值方式照 Pydantic 的宽松模式
  （`src/lax.ts`：`"true"`、`1` 是真，`"5"` 是 5，时间写回成 Pydantic 的格式）。校验器手写在
  `src/model-hooks.ts`（0–1 旧分数、旧阈值推难度、旧工具调用的状态、保存的尝试里“进行中”的调用、
  合同不能有空行），方法在 `src/models.ts`。`gen_models.py --check` 在测试里跑：Python 那边改了字段而
  TS 没重新生成，测试就失败。
- **设置**（`src/config.ts`，字段同样生成）：`FLUIDFORM_*` 环境变量和 `.env`，优先级、JSON 列表、
  大小写、旧设置名、档位（careful）与 pydantic-settings 一致。
- **数据库**（`src/db.ts`，内置 `node:sqlite`）：同一个文件、同样的表和 JSON；排序列的时间照 Python 写成
  `+00:00`。
- **密钥**（`src/secrets.ts`、`src/keyring-worker.ts`，`@napi-rs/keyring`）：照旧只在可杀掉的子进程里碰
  密钥库，锁住时不卡服务，日志不带密钥；同一服务名 `fluidform`，与 Python 互相读写。
- **服务骨架**（`src/app.ts`、`src/main.ts`，Fastify）：只认本机 Host、别的网站不能改东西、修复应用中
  时改动等待；第一个路由 `GET/PUT /api/settings/profile`。
- **对拍工具**：`tools/parity-records.ts`（逐条记录比 Python 和 TS 读出的结果）、
  `tools/parity-servers.sh` + `tools/parity-api.ts`（数据目录副本上同时起两个服务比 GET；副本里自动化、
  目录同步、续跑任务、学习都关掉）。

验证：
- 密钥库：TS 读出 Python 存的全部密钥（只比长度），Python 读出 TS 写的；
- 记录：本机数据库和 8 个旧备份（最早 2026-10-10），共 2000 多条记录两边读出完全一致（旧记录里没有、
  按读取时间补上的字段除外）；
- 设置：本机 `.env` 加服务的环境变量，102 项设置两边一致；
- 接口：`/api/settings/profile` 两边一致；
- 测试：`server/` 43 个（密钥 12、设置 9、模型 10、数据库 8、接口 4），全过；`npm run build` 后
  `node dist/main.js` 能启动。

## 删繁就简

切换也是一次检查（用户要求）：迁每个模块时看哪些可以去掉或合并。

- **不改行为的**（没人调用的代码、重复的逻辑）：迁的时候直接不搬，记在下表。
- **改行为的**（去掉一项设置、一个功能、一种旧数据的兼容）：只记下来，附理由和证据，用户决定后再删。
  旧记录必须能读这条规则不变。

### 没搬的死代码（不改行为）

| Python | 情况 |
|---|---|
| `review.py` `_reviewer` | 没有任何调用 |
| `progress.py` `changed_since`、`cli_evidence` | 没有任何调用 |
| `team.py` `assign_parts` | 没有任何调用（旧的大项分配） |
| `models.py` `ApprovalRequest` | 没有任何地方用到，也不存进数据库 |
| `providers.py` `compact` | 没有调用；实际用的是 `_compact_context` |
| `db.py` `delete_models_except` | 只有测试用 |
| `agent.py` `Workspace.run_all` | 只有测试用 |
| `routing.route_node` 里"难"和"不难"两套排序键 | 两段代码一字不差，合成一段 |
| `providers.py` `_reopen` | 只是转调 `conversation.reopen`，直接用后者 |
| `cli_channels.py` `converse` 里逐行拼出的 `text` | 拼完没用，返回的是 `codex_output` |

迁移过程中，没有现成 Python 测试的模块用"标准答案"核对（`tools/golden.py` 把一批输入在 Python 上跑出结果，
存进 `server/tests/golden/`，`tests/golden.test.ts` 逐条比对）；这些文件不依赖 Python，删掉 Python 后照样能跑。
Python 测试的移植情况记在 `server/tests/ported.json`，`tools/test_map.py` 列出已移植、可以移植的。

### 用户决定删掉的（改行为）

2026-11-20 用户决定三项都删，TS 后端不再带上；Python 后端不改，第 6 阶段整体删除。

| 删掉的 | TS 里怎么做的 | 影响 |
|---|---|---|
| 自定义命令工具和工具钩子（`extensions.py`；设置 `api_tool_extensions`、`api_tool_hooks`） | 不迁 `extensions.py`；两项设置不再生成（`gen_models.py` 的 `SKIP_SETTINGS`），旧 `.env` 里写着它们照样能启动（`config.ts` 的 `RETIRED`）；只读工具调用总是并行 | 要给模型加工具，改用 MCP（`mcp_servers`）或技能 |
| 旧式计划的"大项"拆分和估算（`routing.part_estimate`、`unsplit_parts`/`unsplit_cost`，接口里重新估算未拆分大项，执行器遇到未拆分大项时结束任务） | 去掉这些函数；任务估算不再加未拆分大项的费用 | `PlanPart` 和旧记录照样能读、能显示；带未拆分大项的旧计划不会再按大项拆分 |
| 旧版"记住的事"的搬家（`remembering.adopt`，`api.automation_message` 里的调用） | 不迁 | 没升级过的旧自动化状态里的记忆不再搬进 `memory.json`（本机已没有） |
