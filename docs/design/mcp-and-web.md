# MCP 工具，搜索和读网页

## 为什么

- 每种新能力（数据库、GitHub、浏览器等）都要自己写一个工具。社区里已经有大量 MCP 服务器可以直接用。
- 查天气、查资料只能靠模型自己拼 curl 命令，结果不稳定，网页也不好读。

## 改动

- **`mcp.py`**（新），设置 `mcp_servers`，默认空：
  - 格式是 `{名字: {"command": [argv], "secrets": [变量名], "timeout": 秒}}`。
  - 每个服务器的工具列表只问一次，存在内存里。列不出来的，5 分钟内不再试。
  - 工具以 `mcp__<服务器>__<工具>` 的名字给能动手的 API 模型（不是验收者，也不是主机修复）。
  - 每次调用都在这一步自己的沙箱里启动服务器：同一个文件夹，联网与否跟这一步一样，看不到用户的 home。调用完就停掉。
  - 用的是真正的管道：uvloop 下的管道其实是 socket，会被 pasta 丢掉。
  - 密钥从 keyring 的 `capability/mcp-<服务器>/<变量>` 读出，作为环境变量传进去，不放在命令行里。
  - 只支持服务器的 `ping` 请求；其他请求（比如 sampling）一律回答不支持。
- **`web.py`**（新）：
  - `WebSearch`：设置 `web_search_models`，比如 `["glm:search_std"]`，默认空。
    - 用的是智谱的 `web_search` 接口和它聊天模型的那把密钥。
    - 按次记账（`PRICES`），预算不够就不搜。
  - `WebFetch`：设置 `web_fetch`，默认关。读一个公网 http(s) 页面，转成文字：去掉脚本和样式，最长 4 万字符。
    - 每一次跳转之后都检查一遍，地址必须是公网地址：本机、内网、链路本地和保留地址都不行。
    - 带用户名或密码的地址不读。
  - 这两个工具由 FluidForm 自己发请求，所以只给本来就允许联网的步骤和聊天（`Workspace.network`），沙箱的边界不变。

## 测试

- `test_mcp.py`：
  - 列出工具、调用、报错和密钥传递，用一个假服务器把协议走完；
  - 验收者拿不到这些工具；
  - 坏掉的服务器会被跳过；
  - 有 bwrap 时在真沙箱里跑一遍。
- `test_web.py`：
  - 搜索的请求格式和密钥；
  - 只有联网的步骤能用这两个工具，搜索会记账，预算不够时不搜；
  - 网页转成文字；
  - 本机和内网地址被拒，跳转到本机也被拒。

## 风险

- **DNS 重绑定**：检查地址和真正连接之间，DNS 的结果可能变了。只读，不带任何凭据，影响有限。
- **MCP 服务器是用户自己配的程序**：它在沙箱里跑，但拿得到自己的密钥。另外，每次调用都要重新启动，慢的服务器会拖慢步骤。
- **价格**：`PRICES` 是写下时的价格，可能会变。

## 改成官方 MCP 服务（2026-11）

### 为什么

画图、联网搜索、读网页原来是平台自己写的工具（`images.ts`、`web.ts`），写死了几家服务商的接口和价格。
这几样各家都有官方的 MCP 服务，按"先用现成方案"的规则，平台不再自己实现，改成接入它们。

### 改动

- 删掉 `images.ts`、`web.ts` 和内置的 `GenerateImage`、`WebSearch`、`WebFetch` 工具；设置 `image_models`、
  `web_search_models`、`web_fetch` 不再有，旧 `.env` 里写着照样能启动（`config.ts` 的 `RETIRED`）。
- `mcp.ts` 加了：
  - **远程服务**（`url`，只认 https，协议自带的 Streamable HTTP）：由 FluidForm 自己发请求，所以只给允许联网的步骤和对话，
    和原来的搜索一样。`headers` 里用 `${变量}` 写密钥。
  - **复用已存的 key**：密钥变量可以直接写 FluidForm 已经保管的 key 的名字（服务商的 API key，如 `ZHIPU_API_KEY`、
    `MINIMAX_API_KEY`，以及 `GITHUB_TOKEN`），不用再存一份；别的环境变量拿不到。
  - `env`：本地服务的普通设置（区域地址、出图目录），不是密钥。
  - `tools`：只放出这几个工具，比如 MiniMax 只放画图，不放收费的语音、视频。
  - `price_usd`：每次调用的价钱，从这次调用的预算里扣，预算不够就不调，和原来的画图、搜索一样。
  - `makes_images`：这个服务能画图。计划里要画图的步骤（`needs_images`）就派给能用它的 API 模型，
    任务也自动允许联网（画图服务在步骤的沙箱里，要连到它的服务商）。
- 顺带修了平台的一个缺陷：任务允许联网时，沙箱命令最前面是 pasta，`withoutEnvArgs` 把 pasta 的 `--`
  当成了 bwrap 的，于是 bwrap 的 `--clearenv` 和各个 `--setenv` 留在了命令行上。这有两个后果：代理地址这类值
  被本机所有用户看得到；MCP 服务的密钥和设置都被清空。现在以 bwrap 自己选项后面的那个 `--` 为界。
- 还有一个缺陷：联网时 pasta 会把命名管道的 stdin 换成 `/null`，本地 MCP 服务一启动就退出。现在联网时把管道所在的
  目录挂进沙箱，在沙箱里按路径重定向。

本机的配置（`.env` 的 `SUPER_PARTNER_MCP_SERVERS`）：

```json
{"minimax": {"command": ["node", "<tools>/node/node_modules/minimax-mcp-js/build/index.js"], "secrets": ["MINIMAX_API_KEY"],
             "env": {"MINIMAX_API_HOST": "https://api.minimax.io", "MINIMAX_RESOURCE_MODE": "local", "MINIMAX_MCP_BASE_PATH": "."},
             "tools": ["text_to_image"], "makes_images": true, "price_usd": 0.004, "timeout": 300},
 "web-search": {"url": "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp", "headers": {"Authorization": "Bearer ${ZHIPU_API_KEY}"}},
 "web-reader": {"url": "https://open.bigmodel.cn/api/mcp/web_reader/mcp", "headers": {"Authorization": "Bearer ${ZHIPU_API_KEY}"}}}
```

- MiniMax：官方的 JS 版 MCP（`minimax-mcp-js`，MIT），用 `npm install --prefix <tools>/node` 装在共享工具目录里。
  官方的 Python 版要 Python 3.10 以上，本机只有 3.9。
- 智谱：官方的远程搜索、网页读取 MCP，GLM Coding Plan 的套餐内容。官方的 fetch 服务要 Python 3.11.5 以上，所以读网页也用智谱的。
- GitHub：官方的远程 MCP（`https://api.githubcopilot.com/mcp/`，`Authorization: Bearer ${GITHUB_TOKEN}`）。等存好有效的
  GitHub 令牌再加。网页上的"上传到 GitHub"按钮保留。

### 测试

- `tools-online.test.ts`：
  - 远程服务：JSON 和事件流两种回答都能读；只给允许联网的工作；密钥只出现在请求头里；会话 id 每次都带上；按次扣钱，预算不够就不调。
  - 只认 https；key 没存时不去问。
  - 复用已存的 key 和普通设置；`tools` 白名单；`makes_images`。
- `sandbox.test.ts`：联网沙箱的命令行上不再有环境变量。
- `api-platform.test.ts`：要画图的任务，有画图服务时自动允许联网。
- `images-gates-attachments.test.ts`：要画图的步骤派给 API 模型。

### 风险

- 不联网的任务没有画图工具；要画图的任务会被自动打开联网（只在配了画图服务时）。
- MCP 服务只给 API 模型用；会员 CLI 用它们自己的搜索和工具。
