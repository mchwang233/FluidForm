# 钉钉机器人

在钉钉与 FluidForm 连续对话，在群里 @ 机器人提问。需要执行工作时，FluidForm
会先排计划，原请求者回复「开始」才开工；回复「取消」取消待确认的任务。
任务完成后，文字结果回到原来的会话。

## 配置

1. 在[钉钉开放平台](https://open.dingtalk.com/)创建企业内部应用，添加机器人能力，
   选择 **Stream 模式**接收消息。无需公网回调地址。
2. 发布应用版本，并设置允许使用的成员范围；群聊时将该机器人添加到群里。
3. 在应用的凭证页面取得 **Client ID（AppKey）**、**Client Secret（AppSecret）**。
   在 FluidForm 的 **平台 → 能力 → 钉钉机器人**中填写：
   - `DINGTALK_CLIENT_ID`：Client ID。
   - `DINGTALK_CLIENT_SECRET`：Client Secret。
   通过能力页面保存到系统密钥环，不要粘贴进对话、代码或配置文件。
4. 为应用开通机器人发送单聊和群聊消息的权限。普通回复使用会话回复地址；
   回复地址过期及任务完成通知使用应用发送接口，需要这些权限和已发布的应用。
5. 能力显示「钉钉已连接」后，先单聊发送「你好」，再在群中 @ 机器人测试。
   聊天模型可以在同一张能力卡片中选择。

## 使用

- `/new` 或「新对话」：重新开始对话。
- `/stop` 或「停止」：停止当前回复，不会取消已开始执行的任务。
- `/status`：查看当前回复状态。
- 「开始」或「取消」：决定本会话中自己提出的待确认任务；已经开始的任务在网页中管理。

当前只收发文字。图片、语音和文件请改用文字描述或在 FluidForm 网页中处理；
生成的文件在网页查看。长文字会分段发送。机器人不会逐字刷屏。

## 连接与检查

使用 FluidForm 已有的能力沙箱，只能通过其代理访问清单中的钉钉域名。
使用 Python 3 标准库，没有新依赖，也不需要打开本机监听端口。装包和更新包无需重启 FluidForm。
断线后自动重新申请连接凭据并重连；同一进程内的重复回调会去重。

离线检查：在包目录运行 `python3 -B check.py`。检查不连接钉钉。
无法连接时检查应用凭证和 Stream 配置；发送失败时检查应用发布范围、权限和限流。
真实收发需要配置企业应用后联调；离线自检通过不代表企业应用已配置成功。

参考：[Stream 协议](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/)、
[单聊发送接口](https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches)、
[群聊发送接口](https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message)。
