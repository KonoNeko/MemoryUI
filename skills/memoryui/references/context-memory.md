# 对话与项目工作流

每次任务先选择需要请求的内容，沿用绑定客户端的既有个人读取授权。

| 场景 | include | 必填范围 |
| --- | --- | --- |
| 个性化回答 | personal | query 与实际所需 scope 字段 |
| 续接一段对话 | conversations | conversationId，属于项目时同时传 projectId |
| 继续项目 | project、conversations | 稳定 projectId |
| 项目与本人偏好一起使用 | personal、project、conversations | projectId 与个人 scope |

`memory_request` 示例

```json
{"query":"继续记忆面板的设计，查找已决定事项和下一步","include":["project","conversations"],"projectId":"memoryui","budget":6000,"limit":8}
```

压缩使用 `memory_conversation_compress`。只提交用户本次同意保存的可见内容。平台原消息 ID 可用时沿用，否则为每条消息分配稳定 ID 并在后续追加中复用。messages 最多 200 条一批，单条最多 16000 字符。相同 ID 内容发生变化会被拒绝。重试保持同一对话编号和输入。

```json
{"consent":true,"conversationId":"memoryui-design-1","projectId":"memoryui","messages":[{"id":"u1","role":"user","content":"这个项目需要支持离线查看。"},{"id":"a1","role":"assistant","content":"可以先缓存本机记录，联网后核对版本。"}]}
```

默认摘录保留完整消息和作者，最多 4000 字符，回执显示 totalMessages、coveredMessages、omittedMessages 与 rawPreserved。它会优先保留与请求相关的消息；较长消息无法完整放入时可能没有摘录，原文仍在所有者库中。不要声称摘要涵盖全部原文。

宿主可提交 summary，字段为 overview、decisions、constraints、openQuestions、nextActions、sourceMessageIds。每个列表最多 30 项，每项最多 1000 字符，总摘要最多 12000 字符。用 sourceMessageIds 列出真实依据，缺失的内容保留空列表。更新既有摘要先读取当前 revision，再提供 expectedRevision。助手猜测保留在 openQuestions 或明确标为建议，不能当用户事实。

用 `memory_project_save` 保存一项项目记忆

```json
{"consent":true,"projectId":"memoryui","kind":"constraint","content":"需要支持离线查看。","source":{"conversationId":"memoryui-design-1","messageIds":["u1"]}}
```

kind 支持 goal、decision、constraint、progress、next_action。项目记录保持参考级别。修改时携带 id 和 expectedRevision；冲突时读最新记录后核对。源消息必须属于同一客户端、同一项目。

绑定 runner 的等效命令为 request-context、compress-conversation、save-project-memory，均使用 `--input-file <absolute-json-path>`。输入不含 client，身份由 runtime 绑定。工具响应 UPGRADE_REQUIRED 时，运行中的服务需要升级，不能删除范围参数降级。

ChatGPT 手动交接时，在本机面板选择 ChatGPT 后保存可见对话，再按本次问题请求结果并复制或下载。新聊天只需粘贴压缩结果。WorkBuddy 调用相同本地工具，但两者的项目和对话库各自隔离。个人资料按用户在 AI 访问页选定的范围共享。
