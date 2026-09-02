# Round 1

## 结论

功能测试通过，但本地部署失败，本轮整体不通过。

## 通过证据

- Task 创建、补充和重开均能持久化消息及发送人时间线。
- 同一 Decision 可把不同消息子集关联到不同 Task，也允许一条消息同时关联多个 Task。
- Task 通知可由模型从完整历史选择引用目标和多个参与人，Runtime 会拒绝历史之外的消息或人员。
- 当轮全量 `pnpm test`：158/158 通过。

## 失败证据

初版把 storage domain 从版本 6 升为 7。部署到已有本地 profile 后，现存 JSON 存储无法自动迁移，启动报错：

```text
StorageError: unit 'dingtalk_dsh_assistant': stored version 6 != expected 7
```

这说明新增可选字段不应触发 domain 版本升级；否则旧实例在重启时会被版本检查阻断。

## 修正

- `messageHistory` 保持可选字段。
- storage domain 继续使用版本 6。
- 增加“旧 Task 无该字段仍可解析”的版本兼容回归测试。
