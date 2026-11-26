# CLI 步骤的网络

## 为什么

查一次 VCS 拿不到许可证的问题时发现，三种沙箱对本机端口的处理各不相同：

| 谁跑步骤 | 沙箱 | 本机端口（许可证服务） | 其他本机服务（FluidForm 的 API） |
|---|---|---|---|
| API 模型 | FluidForm 的 bwrap（`agent.ts`） | 只放行 `host_ports` | 连不到 |
| Codex，任务不联网 | Codex 自己的（seccomp） | 连不到：不许建 TCP socket | 连不到 |
| Codex，任务允许联网 | Codex 自己的，`network = { enabled = true }` | 全部能连 | **能连，`/api/tasks` 返回 200** |
| Claude Code | Claude 自己的，只通过代理按域名放行 | 连不到 | 连不到（禁了 localhost） |

允许联网的 Codex 步骤和主机共用网络：FluidForm 的 API 和本机其他服务它都能访问。API 模型的沙箱早就用 pasta 挡住了这些（`networkPrefix`，`--no-map-gw`），Codex 这条路漏掉了。

Codex 自己没有"只放行某几个端口"这一档：不联网就禁 TCP，联网就全通。实验性的 `network_proxy` 加 limited 模式会给命令一个独立的回环，但要从里面连到主机，就得打开 `dangerously_allow_all_unix_sockets`（Linux 上按路径放行的配置不生效），这样步骤就能连上所有 Unix socket，比如用户会话的 dbus，所以不用。

## 改动

- **`agent.ownNetwork`**：给自带沙箱的 CLI 套上一层自己的网络命名空间。pasta 加 `--no-map-gw`，只转发代理端口和 `environment.hostPorts()`（`host_ports` 设置，加上这台机器 `sandbox.json` 里记的端口）。再用 bwrap 把 pasta 里的 root 映射回用户本人，否则 Codex 自己的沙箱起不来（`Failed to start command or shell: Permission denied`）。没有 pasta、或者映射不回用户时，命令原样返回，和以前一样。
- **真正的管道**：pasta 会把是 socket 的 stdin/stdout/stderr 换成 `/dev/null`，而 Node 给子进程的"管道"就是 socket。所以前面套一层 bash（`REAL_PIPES`），由它建真正的管道，把数据和退出码传回来。喂 stdin 的进程在命令结束后就停掉，调用方不关 stdin 也不会挂住。
- **`cli-channels.ts`**：允许联网的 Codex 步骤（`completeIn`）和启动前检查用的联网 `sandboxRun` 都经过 `deps.ownNetwork`，所以检查看到的网络和步骤一样。不联网的 Codex、Codex 负责人、Claude、Gemini、Qwen 都不变。

改完之后，允许联网的 Codex 步骤：互联网和代理照常可用，`host_ports` 里的端口能连（比如许可证服务），**其他本机服务都连不到**。不联网的 Codex 步骤和以前一样，什么 TCP 都连不了。

## 测试

- `tests/sandbox.test.ts`
  - 「a CLI allowed the network runs in its own」：真实的 pasta 和 bwrap。列出的端口能连，没列的本机端口连不上；里面是用户本人而不是 root；通过 Node 的管道，stdin、stdout、stderr 和退出码都能传过去。没有 pasta 时跳过。
  - 「a CLI's network is unchanged without pasta」：没有 pasta、或映射不回用户时，命令原样返回。
- `tests/cli-channels.test.ts`
  - 「only a Codex step allowed the internet runs in a network of its own」：只有允许联网的 Codex 步骤经过 `ownNetwork`。
  - 「a networked check in Codex's sandbox runs in the network a step gets」：联网的 `sandboxRun` 也经过它。

## 风险

- 用到的系统程序和 API 模型的沙箱一样（pasta、bwrap、bash），没有新依赖。
- 用户代理以外的本机服务，现在联网的 Codex 步骤连不到了。以前依赖这一点的步骤，要把端口记进 `host_ports`。
- Claude Code 步骤还是连不到本机服务（它的沙箱只通过代理），需要许可证工具的步骤要交给 API 模型或 Codex（联网）去跑。

## 顺带：Codex 失败时报出真正的原因

验证时 Codex 额度用完了，FluidForm 报的却是 stderr 上的一条警告（"Untrusted project-local configuration is disabled"），真正的原因在 stdout 的 `turn.failed` 事件里，被盖住了。现在 `failureDetail` 先看 JSON 输出里最后一个 `turn.failed` 或 `error` 事件，有就用它；没有的话还是用 stderr。这样额度用完的原因也能被 `quota.ts`、`diagnosing.ts` 认出来。测试：`tests/cli-channels.test.ts`「a Codex failure reports its failed turn, not a warning on stderr」。

## Claude Code 步骤也能连记下的本机端口

Claude Code 在 Linux 上给每条沙箱命令一个私有网络，直连本机一律失败；它自己的代理只放行 `allowedDomains` 里写明的 `host:port`（只写主机会打开所有端口，`"*"` 不包括本机地址）。FlexLM 不走代理，所以之前 claude 步骤里的 VCS 一直签不出许可证。

- `cli-channels.withHostPorts`：有记下的端口时，设置里放行 `127.0.0.1:<端口>`，打开 `allowLocalBinding`。联网时把 `127.0.0.1` 从禁止名单拿掉（禁止优先，否则会盖过放行的端口），`localhost`、`::1` 仍禁止。
- `agent.proxyListenScript` 和 `cli-channels.withClaudeBridge`：生成一个 `CLAUDE_ENV_FILE`（Claude Code 在每条沙箱命令前加载它），在命令的私有网络里为每个端口起 socat，经沙箱代理（HTTP CONNECT，带它的认证）转出去。用户自己的 `CLAUDE_ENV_FILE` 先加载。调用结束就删掉。没有 socat 或没有代理时什么都不做。
- 只给步骤（`completeIn`，不含修复）。负责人的会话不变。

实测（Claude Code 2.1.332，真实 `complete("cli:claude")`）：不联网、联网两种情况都 `snpslmd: UP`，`vcs -full64` 编译返回 0、`simv` 输出正常；FluidForm 的 API 直连、走代理、写 `localhost` 都连不上，其他本机端口也连不上。

测试：`tests/cli-channels.test.ts`「Claude Code's sandbox opens only the recorded host ports, never every local service」「a Claude Code step gets the bridge to the host ports while it runs」「the bridge goes out through the sandbox's proxy, with its credentials」。
