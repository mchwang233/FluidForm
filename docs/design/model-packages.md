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

## 后续

Codex、Claude、Gemini、Qwen 逐个搬成包，每个都先过一遍 `skills/model-channel/SKILL.md` 的实测。Gemini 和 Qwen 现在没有沙箱，搬过来以后就会套上核心的沙箱。
