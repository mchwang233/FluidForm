# 模型包：新的会员 CLI 作为一个能力接入

## 为什么

接入 agy（Antigravity CLI）时，要改的地方散落在 `cli-channels.ts` 的 `CLI_SPECS`、`catalog.ts` 的种子表，以及各处 `if (modelId === "cli:…")` 的分支里。没有开关，加一个 CLI 就要改核心源码。用户希望模型也像其他能力一样，可以装、可以开关；核心只保留 DeepSeek 作为保底。

第 1 步定下"模型包"的格式和核心的接口，agy 是第一个模型包。第 2 步把 DeepSeek 以外的 API 厂商都做成了包（见"API 厂商包"）。Codex、Claude、Gemini、Qwen 后面再一个一个搬（见"后续"）。

## 分工

| 包里（`server/packages/<id>`） | 核心里（`server/src/model-channels.ts`） |
|---|---|
| `capability.json`：`kind: "extension"`、`provides: ["model:cli:<名字>"]`、`models`（目录条目） | 读清单里的 `models`，给目录播种（`catalog.builtinModels`） |
| `src/index.ts` 导出 `channel: ModelChannel` 并 `register` 它：参数、stdin、怎么读输出、额度报错、登录目录（`state`）、模型域名（`hosts`） | 每次调用的沙箱（`withSandbox`）、网络、超时、记账、额度标记 |
| 不运行任何命令 | 包停用时它的模型不出现在模型页，不被调度，也不能当负责人 |

能力页上的开关就是扩展的开关。打开或关上会立即生效，不用重启：`CliChannelRegistry.statuses` 发现在用的通道变了，就重新探测一遍。新装一个随附的模型包仍然要重启，因为它的代码只在启动时从 `server/packages` 读入。

## 沙箱：边界在核心

agy 1.5.18 实测（逐项结果见下）说明，CLI 自己的沙箱靠不住：

- 非交互模式下 agy 总会打开自己的终端沙箱，`enableTerminalSandbox: false` 不起作用。
- 这个沙箱没有网络，也连不到本机端口，所以拿不到许可证。
- 没有办法把命令留在里面：Auto 模式的审查会放命令出去；Default 模式配 `proceed-in-sandbox` 时，命令一律被拒；放行 `command(*)` 后，命令全在沙箱外跑。个人账户会忽略 `unsandboxed(...)` 规则。

所以核心用自己的 bwrap 把整个 CLI 包起来（`withSandbox`）。CLI 和它跑的命令，无论在不在它自己的沙箱里，都出不了这一层：

- **文件**：
  - 整个磁盘只读。
  - 家目录隐藏，只有 CLI 自己的 `state` 目录可写。
  - FluidForm 的数据和别的任务都隐藏（`Workspace.platformData`）。
  - 步骤的工作目录可写，负责人的工作目录只读。
  - 工具目录只读，附件目录只读。
  - /tmp 是私有的。
  - 可执行文件单独只读挂进来。
- **联网的步骤**：`ownNetwork`，和 Codex 步骤一样。能上网，能走用户的代理和记下的本机端口，连不到别的本机服务（包括 FluidForm API）。没有 pasta 时，会退回主机网络，这一点和 Codex 一样。
- **不联网的步骤和负责人**：`--unshare-net`。
  - 记下的本机端口（许可证）经 Unix 套接字桥进来（`portBridge`、`listenScript`）。负责人不桥接端口。
  - CLI 经 `DomainProxy` 访问自己的模型。代理只放行包里声明的 `hosts`，并沿用用户自己的上游代理。
  - 环境里的代理变量指向这个代理。
- **没有 bwrap 就不运行**：不会退回到无沙箱。
- **修复环境（repair）**：和其他 CLI 一样，用 `repairCommand` 离开沙箱。

agy 用 Default 模式（`agentMode: ""`）并放行 `command(*)`：不需要审查，没有命令会卡在等人批准。步骤额外加 `--mode accept-edits`。提示词从 stdin 传入（`--print=` 配 `--input-format stream-json`），因为单个命令行参数最多 128 KiB。负责人用 `--conversation <id>` 接着对话。

## agy 实测（1.5.18，Gemini 3.8 Flash 跑探测，正式用 Gemini 4 Neon High）

| 情况 | 结果 |
|---|---|
| 只套 agy 自己的沙箱 | 看不到 `/projects`、工具目录和 `/workspace/eda`；不能联网；许可证连不上 |
| 加 `read_file(/workspace/eda)` 或 `--add-dir` | 能读到，是只读的 |
| 沙箱里的命令自己监听一个端口来桥接许可证 | 不行：沙箱不许绑定端口 |
| `toolPermission: "proceed-in-sandbox"` 配 Default 模式 | 命令全被拒（`denied_actions`） |
| Auto 模式（默认） | 先在沙箱里跑；失败后审查放它出去，出去就能联网、能连许可证 |
| `command(*)` 配 Default 模式 | 命令全在 agy 沙箱外跑，没有用 BypassSandbox |
| 外层断网，只开 `DomainProxy` | agy 能正常回答。它连的域名：`aicode`、`daily-cloudcode-pa`、`www.googleapis.com`；`play.googleapis.com`（遥测）和 `lh3.googleusercontent.com`（头像）被拦也不影响 |
| 经 `CliChannelRegistry.complete` 跑不联网的步骤 | 许可证 UP；`example.com` 被代理拦下；家目录里只看得到 agy 自己的目录；文件写进了工作目录 |
| 经 `CliChannelRegistry.complete` 跑联网的步骤 | 许可证 UP；`example.com` 200 |
| 经 `converse` 跑两轮负责人对话 | 第二轮记得第一轮说过的话；读得到文件；写文件报 read-only |

额度报错原文是 "You have exhausted your quota on this model."。包把它标成额度问题，核心再转成 "usage limit reached: …"，`failureKind` 认出是 `quota`。

## 测试

`server/tests/model-channels.test.ts`：

- agy 的参数：提示词走 stdin（30 万字符也不放进命令行参数）；Default 模式放行 `command(*)`；步骤用 `accept-edits`，负责人不用；负责人用 `--conversation` 接着对话。
- agy 的输出：正确读出文本、用量和会话 id；失败时给出错误；额度报错被认作 quota。
- 目录：`builtinModels` 里有 `cli:agy`，核心自带的 `ownModels` 里没有；包的清单写的是 `model:cli:agy`。
- 开关：关掉后没有状态、没有规格、不能当负责人；不用重启就能看出变化。
- 沙箱（假 CLI）：
  - 没有 bwrap 就拒绝运行。
  - 联网的步骤走 `ownNetwork`，负责人不联网而且只读。
  - 用真 bwrap 时：只读得到自己的 `state`，读不到家目录里的密钥、FluidForm 数据和别的任务；写只落在工作目录。
  - 不联网时：记下的端口连得上，别的本机端口连不上；代理不放行没声明的域名（403）。

`tests/task-core.test.ts` 里列出的随附扩展加上了 agy。

## 风险

- agy 跑的命令能连到它自己的模型域名（不联网的任务也一样）。这和 Claude Code 的沙箱放行 Anthropic API 是同一个道理。
- `hosts` 是实测出来的。agy 升级后如果换了域名，不联网的调用会失败，日志里会写"拦下了访问 …"。到时把新域名加进包里。
- agy 的用量里，`input_tokens` 是否包含缓存命中不清楚。现在按"不包含"记：缓存单独记，不加进输入。

## API 厂商包（第 2 步）

### 为什么

每个 API 厂商的知识原来散在 8 处：
- `secret-names` 的密钥变量名；
- `app.ts` 的显示名；
- `catalog-sync` 的公开目录名和官方目录 URL；
- `providers.ts` 的检查 URL、对话 URL、推理参数特例、输出上限字段名；
- `benchmarks` 的厂商别名；
- `quota` 的厂商名单；
- `catalog.ts` 的种子模型。

加一个厂商，这 8 处都要改，也没有开关。

### 改动

- **`server/src/api-providers.ts`**：厂商注册表。
  - `CORE` 是 DeepSeek，核心自带，关不掉。
  - 其他厂商都来自随附包的 `capability.json` 里的 `provider` 字段。
  - `declared` 是全部厂商（包关着也算），`active()` / `inUse()` / `ofModel()` 只算开着的。
  - `KEY_ENV` 是全部厂商的密钥变量名。
- **8 个厂商包**：`server/packages/{openai,anthropic,google,qwen,doubao,glm,minimax,kimi}`。
  - 每个包只有一个 `capability.json`，没有代码：`kind: "extension"`、`provides: ["model:api:<id>"]`，加上 `provider` 和 `models`。
  - `provider` 写明：显示名、密钥变量、协议（`openai` / `anthropic` / `gemini`）、对话 URL、模型列表 URL、是否读官方目录、公开目录名、别名、可选的推理档位（`efforts`）、输出上限字段名。
  - `extensions.load` 遇到没有代码的包就直接返回空对象。
- **协议留在核心**：OpenAI 兼容、Anthropic、Gemini 三种请求和流式代码都不动，按包声明的 `wire` 分派。Anthropic 和 Gemini 的请求 URL 仍写在协议代码里，所以每种协议只对应一个厂商。
- **各处表格改为由注册表推导**：
  - `PROVIDER_ENV` = `KEY_ENV`，包关着也保留，钥匙串照样读、照样存；
  - `PUBLIC_PROVIDERS` / `OFFICIAL_URLS`：目录同步只遍历开着的厂商；
  - 基准测试的 `PROVIDERS` 别名；
  - 额度判断里的 `request failed` 厂商名单；
  - 显示名；
  - `testProvider`；
  - `reasoningFields`：Anthropic 和 Gemini 按协议处理；DeepSeek 原样传；其他厂商取 `efforts` 里不低于所请求档位的第一档，没有就取最高档。
- **种子模型**：`catalog.SEED` 只留会员 CLI、DeepSeek 和演示模型，其余随包带来（`builtinModels` = `ownModels` 加上各包的 `models`）。
- **包关掉时**：
  - 它的模型不可用（`configuredModels`），调用会报"没有启用"；
  - 不出现在 `/api/providers` 和 `/api/models` 里；
  - 密钥保留，重新打开就能用。

### 测试

`server/tests/api-providers.test.ts`：
- DeepSeek 自带，其他厂商来自包；
- 密钥变量名和原来一样（已保存的密钥照样读得到）；
- 目录来源、官方 URL、排行榜别名和原来一样；
- 9 个厂商 × 9 种推理档位，结果和原来的函数逐一相同；
- 包关掉后模型不可用、调用被拒、密钥保留，DeepSeek 关不掉。

黄金测试改为按原 Python 后端的顺序比较 `builtinModels()`：搬到包里的种子模型逐字段相同。`task-core` 里列出的随附扩展加上了 8 个厂商包。

### 风险

- 能力页多了 8 张厂商卡片。
- 图片生成和网页搜索（MCP 服务器、`web_search_models`）的密钥不经过厂商包的开关：关掉 GLM 的包，只是不再调度它的对话模型。

## Gemini CLI 和 Qwen Code（第 3 步的前一半）

### 为什么

这两个 CLI 原来写在核心的 `CLI_SPECS` 里，而且完全不在沙箱里跑：步骤里的命令能读整个家目录，也能连本机所有服务，包括 FluidForm API。

### 改动

- **两个新包**：`server/packages/gemini-cli`（`model:cli:gemini`）和 `server/packages/qwen-code`（`model:cli:qwen`）。
  - 包 id 不能叫 `qwen`，因为 API 厂商包已经用了这个 id。
  - 调用方式和原来一样：提示词作为 `-p` 的参数，输出用 `--output-format json`，解析时取 `response`、`result` 或 `text`。
  - 两个都不当负责人。
- **核心**：
  - `CLI_SPECS` 和种子表里删掉这两项，`completeIn` 里删掉它们的分支。
  - `programFiles`：npm 装的 Node CLI 在家目录的 `node_modules/<包>/` 里，核心把整个包目录只读挂进沙箱，不只挂那个脚本文件。
  - 沙箱里用程序的真实路径启动，因为 `bin/` 下的符号链接所在目录被隐藏了。
- **网络**：现在和别的模型包一样。不联网的任务只能连到它们自己的模型服务和许可证端口；原来是什么都能连。

### 没有实测的地方

这台机器上没有装 gemini，也没有装 qwen，所以下面几项来自它们的文档，不是测出来的：
- 登录目录：`~/.gemini`、`~/.qwen`；
- 模型服务的域名；
- 额度用完时的报错原文。

装上以后，要按 `skills/model-channel/SKILL.md` 实测一遍。不联网的调用如果失败，日志里会写"拦下了访问 …"，把这个域名加进包里即可。另外，`~/.gemini` 整个目录可写，所以 Gemini CLI 也能看到同一目录下 agy 的登录信息（同一个 Google 账户）。

### 测试

`server/tests/model-channels.test.ts`：
- 两个包的参数和原来一样，不再内置在核心里；
- Gemini 的输出按原来的方式解析；
- npm 装的 CLI 会把整个包挂进沙箱；
- 用真 bwrap 跑一次：家目录被隐藏，脚本在沙箱里仍能加载同一个包里的其他模块。这项测试在修复前失败（找不到 `bin/` 下的链接）。

## Codex 和 Claude Code（第 3 步的后一半）

### 为什么

它们是主力 CLI，各自有一套实测过的沙箱：Codex 的权限配置，Claude 的设置加许可证端口桥（`docs/design/cli-step-network.md`）。用户选了"原样搬进包"：行为不变，能力页上多两个开关。

### 改动

- **模型包的第二种形态**（`model-channels.ts`）：`ModelChannel.own`，包含 `complete`、`converse`、`sandboxRun`。
  - 包用自己 CLI 的沙箱设置拼出命令，交给核心给的 `Runner` 去跑（`CliChannelRegistry.runner`）。
  - `Runner` 提供 `run`（进程组、超时、进度检查、实时活动、追踪）、`which`、`hostPorts`、`ownNetwork`、`repairCommand`。
  - 另一种形态（agy、Gemini、Qwen）仍由核心的 `withSandbox` 包起来。
- **`server/packages/codex`**：从 `cli-channels.ts` 原样搬来。
  - 搬来的内容：输入过长时缩减并只重试一次（`codexInput`、`runInput`）、输出解析、权限配置（`codexStepPermissions`、`denyExcept`、`sharedTmp`）、私有 TMPDIR、rm 规则（`withCodexRules`）、设置（`codexSettings`、`CODEX_EXTRAS`）、附件、负责人对话（`exec resume`）、`codex sandbox`（执行前检查用的 `sandboxRun`）。
  - 测试会替换的 `deps`（`codexSettings`、`codexStepPermissions`、`codexServers`）也在包里。
- **`server/packages/claude-code`**：同样原样搬来：沙箱、联网和修复三种设置，`withHostPorts`、`withClaudeBridge`、附件，负责人对话（`--session-id` / `--resume`）。
- **核心 `cli-channels.ts`** 只剩通用部分：
  - 报错类型、`failureDetail`、`repairCommand`、`cliUsage`、`trace`；
  - 运行（`run`）和状态探测（`probe`），探测的是所有开着的模型包；
  - 按通道分派（`complete`、`converse`、`sandboxRun`）。会话丢失的识别（`SESSION_MISSING`）对所有 CLI 统一处理。
  - `CLI_SPECS`、`SESSION_ARGS`、`REPAIR_ARGS` 都已删除。
- **种子表**：`cli:codex` 和 `cli:claude` 随包带来。核心自带的种子只剩 DeepSeek 和演示模型。
- **测试辅助**：`tests/helpers/conftest.ts` 加载所有 CLI 包，并拦截所有通道的可执行文件。原来只拦截 Codex 和 Claude，测试里有可能真的调到本机的 agy。

### 没搬的

- `cli-quota.ts` 的 Codex 额度读取：从会话文件和 app server 读，按额度计价。它属于计价和额度部分，仍留在核心。
- 核心里的 `codexHome`：额度读取和执行前检查都要用。
- 学习包的执行前检查仍然点名用 `cli:codex` 的 `sandboxRun`。

### 验证

- 测试：
  - `cli-channels.test.ts` 的 31 项、`converse`、`api-tasks`、`call-runtime`、`preflight-run` 全部通过。
  - 改的只是导入路径，以及替换点从 `cli.deps.codexX` 换成 `codex.deps.codexX`。
  - 原来调用注册表内部 `completeIn` / `runInput` 的 3 项，改为经 `runner()` 调包里的 `runInput`，断言不变。
- 用真 CLI 经过包各跑了一次步骤，结果和搬之前一样：
  - Claude（不联网）：许可证 UP，外网 000。
  - Codex（不联网）：许可证连不上（"Operation not permitted"）。这是原来就有的：不联网的 Codex 会封掉所有网络套接字。
  - Codex（联网）：许可证 UP，外网 200。

## 模型调研

### 为什么

模型目录同步、排行榜抓取和调度评分原来都写在核心里（`catalog-sync.ts`、`benchmarks.ts`、`scoring.ts`）。用户希望"模型调研、模型评分、模型价格"也作为一个能力，叫做"模型调研"。

### 改动

- **`server/packages/research`**：扩展，提供 `research`。
  - `catalog-sync.ts`、`benchmarks.ts`、`scoring.ts`、`html-tables.ts`、`xlsx.ts` 用 `git mv` 原样搬进 `src/`，只改了导入路径。
  - 入口 `start(db, models)`：先按排行榜上次的结果重新评分，再开始定期同步，返回 `Research`（`status`、`trigger`、`close`、`matchModels`）。
- **核心 `research.ts`**：
  - `begin`：服务启动后、或在能力页打开时启动。数据库换了（测试里另一个 FluidForm），会先停掉旧的。
  - `end`：停用或关服务时停下。
  - `current`：给 `/api/models/sync` 和模型页的排行榜成绩用。
- **留在核心**：`catalog.seedCatalog`（给目录播种）和 `AA_SOURCE`（没有评分的模型不列出、不调度）。
- **停用时**：
  - 不再更新目录、价格和成绩，它们都保持最后一次的结果；
  - `GET /api/models/sync` 返回 `disabled`；
  - `POST` 返回 409，并说明要在能力里打开；
  - 模型页的"模型目录自动更新"显示"模型调研已停用"，不显示"立即更新"。
- `PROVIDABLE` 和标签里加上 `research`（模型调研），并加上 `uses.research()`。
- **计价**（`pricing` 服务包，算钱、估价、预算）没有变。"模型价格"指的是调研查到的各模型单价，它们写进目录，再由计价使用。

### 测试

- `server/tests/research.test.ts`：开着时同步状态正常；关掉后立即停下，接口返回 `disabled`，手动更新返回 409，各模型评分不变；重新打开后不用重启就恢复。
- 前端 `mission-actions`："with model research off, the 模型 page says …"。
- 原有的 `catalog-sync`、`benchmarks`、`scoring`、`golden` 测试只改了导入路径，全部通过。
- 原来有 3 处测试替换了 `api.catalogSync.start`，免得启动时联网；现在改为把 `catalog_auto_sync` 设为 false，效果相同。

### 风险

停用期间新出的模型没有评分，不会被调度。重新打开后，等下一次同步就会补上。

### 只留 Artificial Analysis

用户要求不要 SuperCLUE 和 BFCL。

- 删掉的代码：两者的抓取和解析（`parseSuperclue`、`parseBfcl`、`csvRows`、字段表、`superclue()`、`bfcl()`），连同只给 SuperCLUE 读表格用的 `xlsx.ts`。`html-tables.ts` 还要用的 `unescapeXml` 移进了它自己的文件。
- `SOURCE_NAMES` 现在只有 `artificial_analysis`。数据库里缓存的两个旧榜单的成绩，`results()` 和 `status()` 都不再读取：模型页不显示，比对也不用。
- 调度评分本来就只用 Artificial Analysis 的成绩，所以各模型的分数不变。
- 前端：`benchmark-sources.ts` 和 `public-benchmarks.tsx` 里删掉了这两个来源。
- 测试：`benchmarks.test.ts`
  - 删掉了这两个榜单的解析测试。
  - 模型比对的几项原来借用 BFCL 的数据，改为用 Artificial Analysis 的数据（`resultFor`），比对规则的断言不变。
  - 新增两项："只查 Artificial Analysis"，以及"缓存的旧榜单成绩不显示、不参与比对"。
  - 删掉了只给 SuperCLUE 测试用的 `tests/helpers/xlsx-writer.ts`。

## 后续

- ~~Codex 不联网时连不上许可证~~：已修，见 `docs/design/cli-step-network.md` 的"不联网的 Codex 也连得上许可证"。
- Codex 的额度读取搬进 Codex 包。
