# 钉钉机器人能力包

## 为什么

此前的钉钉接入在应用时回滚，源码中没有留下机器人包。只改一个能力包及其测试、
文档的安装路径已经存在（platform-engineer.md），本次沿用它补齐接入，不改本体。

## 现成方案

采用钉钉官方 [Stream 协议](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/)，
订阅机器人消息回调；发送使用官方会话回复及应用发送接口。
检查了官方 [Python SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-python) 和
[Node SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)，均为 MIT 许可，
但会新增依赖。当前能力包安装器只为 Python 依赖构建环境；本次也没有新增依赖的授权。
因此实现仅需的文本协议适配，用 Python 标准库的 TLS、HTTP CONNECT 和有限的
WebSocket 帧支持，不复制 SDK 代码，不引入另一套模型或任务处理逻辑。

## 改动

- `server/packages/dingtalk-bot/capability.json`：自动化包、聊天能力依赖、两个密钥环变量、
  三个钉钉域名、运行入口及离线安装检查。
- `bot.py`：Stream 注册、确认回调、心跳和断线重连；单聊/群聊的身份与会话隔离；
  消息通过 JSON 行交给现有 runner，对话、停止、新对话和任务确认均由平台处理。
  回调按会话和消息编号去重，有数量与时限上限；待回复队列也有上限。
  会话标识以完整企业、类型、会话编号的摘要生成，避免宿主截断长编号导致串话。
  常规回复可用内存中的会话地址，过期或明确被拒绝时改用应用 API；任务结束按
  origin 中的会话类型、会话编号或员工编号发送，机器人重启后也不依赖旧会话地址。
- `transport.py`：HTTPS 和 WSS 均遵守能力代理；验证 TLS 和 WebSocket 握手，支持
  消息分片和 ping/pong；限制帧、消息和响应长度。拒绝非清单域名、端口、跳转和协议。
  不将异常正文、访问令牌、连接票据或会话回复地址写入宿主日志、origin 或文件。
- `SKILL.md`、`CHAT.md`：配置说明和聊天约定，明确仅支持文字，文件在网页查看。

## 测试

`server/tests/dingtalk-bot.test.ts` 检查真实包安装和离线自检，并使用假的钉钉网络、
假的模型，经过实际 Bridge、runner 和聊天/任务 API 完成消息往返：连续对话、
新对话、停止、拒绝他人确认群聊任务、请求者确认和完成通知。

包内 `check.py` 禁止真实网络连接，验证协议字段、重复回调、群聊身份、无密钥的
origin、过期会话通知、中文长文本分段、代理、握手、消息分片、pong、非法地址与大小限制。
回归还会在移除新增包后运行，确认缺少包时失败。

## 风险与范围

真实企业应用仍需用户配置凭据、发布范围、Stream 模式和发消息权限后联调。
只支持企业内部机器人文字消息；不支持附件上传下载及卡片。发送网络超时后不自动
重复 POST，避免实际已发送的消息重复；失败在能力状态中提示。进程内去重可处理
断线重投，进程重启会清空去重记录；不保证跨重启的恰好一次投递。

没有新增依赖、全局设置或本机路径，没有扩大任务沙箱权限。只有此能力包可通过现有代理
访问 `api.dingtalk.com`、`oapi.dingtalk.com` 和 `wss-open-connection.dingtalk.com`。
密钥通过能力页面保存至系统密钥环；源码与任务记录均不保存。
