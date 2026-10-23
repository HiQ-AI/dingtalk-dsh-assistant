# R31 后端执行文档：续办职责提示刷新

## 结论与改动

Claude Code 2.1.309 的本机 `claude --help` 明确说明 `--system-prompt-snapshot` 默认 on：首次请求记录完整 system prompt（包括 append-system-prompt），之后 request/resume 即使传不同文本仍发送旧快照，直到 compact。本后端每轮 definition.prompt 使用 append-system-prompt，因此需要明确关闭快照才能保证续办更新职责。

最小修改为固定 `--system-prompt-snapshot off`，保留原 UUID、原生 resume、权限和结果/排空门禁。最低 CLI 提高至本机实际核验支持该参数的 2.1.309；未验证 2.1.295/308 是否支持，不对其作兼容声明。README 与运维说明同步。

## 现场证据

- 本机 `claude --version`：2.1.309 (Claude Code)。help 原文包括 “every later request and resume sends the record as-is, even when a later launch passes different text” 与 “off ... rendered fresh every request”。
- live-4 配置 UUID a62d9182-8ad3-41ec-aaff-cf94e73bd152 的原生 transcript 在 07:17:42.126Z 第二轮 human user 输入仅有模糊 objective 和 round2 执行文档路径，没有精确 PowerShell 命令；Host journal seq103 UserPromptSubmit 一致。
- 原生 JSONL 没暴露完整 system snapshot 正文；结论依据 CLI 明示参数语义和后端实际参数传递，不把模型自述作为输入证据。
- live-4 两轮最后通过仍保留为原始技术闭环证据，不能替代修复后不同职责提示续办验证；真实复测由统筹执行。

## 定向合同验证

测试增加首轮/续办 argv snapshot=off、续办 append-system-prompt 含不同本轮职责且不等于首轮，以及未达到明确支持版本时不启动 PTY。固定协议测试不声称真实 Claude 推理验证。输出见本目录 adapter-tests.log。

后端 SHA256：B3CC15E04AD5F66EAC66F17B4063033E3D49E8CCEA4CC07B4E8A1C47A541E3A1。

实跑结果：50/50 PASS，0 fail、0 skip，测试宿主自然退出 0，耗时 58197ms。
