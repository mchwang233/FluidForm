# 生成图片

## 为什么

"做一张海边女孩的头像"这样的任务，FluidForm 原来做不了：机器上没有文生图模型，步骤的模型只能写代码手绘一张矢量图，效果很粗糙。
这台机器已有的智谱 GLM 和 MiniMax 密钥，各自都带文生图接口。

## 改动

- **`images.py`**（新）：
  - `generate(prompt, shape)`：按 `settings.image_models` 的顺序逐个试，第一个成功的出图，其余作备用。
    - 智谱 CogView：`/images/generations`，返回一个网址，再把图下载回来。
    - MiniMax image-01：`/v1/image_generation`，直接返回 base64。
  - 用的是各家聊天模型的那把密钥（`PROVIDER_ENV`）。
  - 返回的内容要确认真是图片，限大小。
  - 价格按张算（`PRICES`，美元）。
- **`settings.image_models`**：默认空，即没有这个工具。本机设为 `["minimax:image-01", "glm:cogview-4"]`：MiniMax 不加水印，智谱会在右下角打"AI生成"。
- **`GenerateImage` 工具**（`agent.IMAGE_TOOL`、`Workspace.generate_image`）：
  - 谁能用：步骤和聊天里能写文件的 API 模型（不是验收者，也不是主机修复），并且这台机器上有可用的画图模型（`providers._loop` 里判断）。
  - 怎么存：图存到工作目录，扩展名按实际格式定。
  - 怎么记账：画之前先看预算还够不够画一张（`RequestBudget.can_spend`），画完按张记账（`record_usd`）。
  - 怎么引导模型：工具说明里写明画出来的就是描述的样子，不必去看，不要用代码手绘去代替。
  - `Read` 一张图片时不报错，而是说明这是一张图片（格式、尺寸、大小），并告诉模型 `Read` 不显示图片。以前它只回一句 "is a binary file"，看不了图的模型就把已经画好的一步报成"无法完成"，白白多一次负责人决策和重做，耗时多了约 4 分钟（`agent.picture_note`，回归测试在 `test_images.py`）。
- **画图的步骤只给 API 模型**：
  - 负责人排计划时，给要画图的步骤标 `needs_images`（`planner.PROMPT`、`outline.TASK_SHAPE`、`task_node`）。
  - 调度时（`routing.eligible_for_node`），这类步骤在有画图模型的机器上不分给会员 CLI，因为 CLI 在自己的沙箱里拿不到这个工具，把密钥交进去也不安全。
  - 旧计划读出来这个标记是 false。
- **聊天**：开了 `chat_tools` 的 API 聊天同样拿到这个工具。飞书里画好的图用 `SEND:` 发出去（chat-tools.md）。

## 测试

`test_images.py`：
- 第一个模型失败时换下一个；两家的请求和返回格式；不是图片、没有密钥或没设置模型时都不出图。
- 工具按实际格式存图，并且记账；预算不够时不画；验收者不能用。
- 要画图的步骤只分给 API 模型；机器上没有画图模型时不受限制。
- 计划能解析这个标记，旧计划照常读出。

## 风险

- **价格**：`PRICES` 是写下时的价格，可能会变，没列出的模型按 `DEFAULT_PRICE` 记。
- **审核和水印**：出图要过服务商的内容审核，被拒了就换下一家。智谱出的图带"AI生成"水印。
- **调度**：要画图的步骤用不了会员 CLI，可能比原来花得多一点。
