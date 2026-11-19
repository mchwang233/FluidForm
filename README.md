# FluidForm 的能力包

这个分支只放能力包，和 FluidForm 本身的代码（`main` 分支）分开：每个能力包单独开发、单独上传、单独卸载。
包的格式和运行方式见 FluidForm 仓库的 `docs/design/capability-packages.md`。

| 能力包 | 类型 | 说明 |
|---|---|---|
| `feishu-bot/` | 自动化 | 飞书机器人：私聊或群里 @ 它，问题直接回答，要动手的事排成任务等主人确认，做完把结果发回飞书 |

## 打包和上传

```bash
zip -r feishu-bot.zip feishu-bot -x '*/__pycache__/*'
```

在 FluidForm 的 平台工程师 → 能力 → 上传能力包 里选这个 zip（本机需要 `SUPER_PARTNER_CAPABILITY_PACKAGES=true`）。
同一个 id 再上传就是升级，密钥和状态保留；卸载会删掉它的文件、数据、状态和密钥。

## 检查

每个包的 `capability.json` 里有 `check` 命令，安装时 FluidForm 在沙箱里（不联网）跑它，例如：

```bash
cd feishu-bot && python bot.py --check
```
