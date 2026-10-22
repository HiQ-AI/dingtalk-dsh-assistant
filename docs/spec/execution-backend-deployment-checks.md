# 双执行后端部署排空检查

PR #248 合并前本地部署审查发现：现有 `inspect-quiescent-ledger.mjs` 对所有 `sessionBound` 执行都查 DSH 的 `.dsh/sessions`。Claude 后端使用独立 `outputs/<executionId>/claude-events.jsonl`，因此合法已排空的 CLI 历史会被误报原生日志缺失。当前现场 CLI 执行为零，不影响当前快照；但这是新增后端与既有部署/桌面重启入口的直接兼容缺口，纳入同 PR 修复。

修改既有独立 checker 及既有测试，不新增运行时状态或恢复动作。该脚本会复制到 `D:/dsh_home/launchers`，只能依赖 Node 标准库，不能 import 仓库适配器路径。DSH 原分支保持；CLI 分支只读账本和原始 journal，校验路径/链接、身份/provider UUID、序号、输入版本/digest/需求与控制版本、租约及末次 drained。未知后端、缺失或截断日志、身份或历史错配、未排空均拒绝，unknown 效果不清除、不重放。

新输入可能已通过 `execution.continue` 入账但尚未 claim；此时 inputVersion 前移、原输入进入 inputHistory，leaseEpoch 不变、drained=true。检查须用实际账本与同租约最后排空证据识别“原轮结束，新轮尚未启动”，不能因当前版本没有 CLI start 就伪造当前轮完成，也不能允许不同租约的旧排空记录通过。多次未开始续办及取消等相邻状态由实现与独立审阅按 Store 当前合同核对。

验收在既有 checker 测试加入混合后端、合法两轮/未开始续办、错误身份/历史/序号/租约/末记录、目录链接及硬链接反例；独立核对文件和账本字节未变。部署前先运行正式 `-Check`，更新 launchers 中同一 checker 后独立回读摘要；部署后复验默认 DSH、双包/进程/健康，不登录 Claude 或制造现场 CLI 样本。首次失败与修复证据保留在 task-collaboration-quality 的 R9/R10，不覆盖以前轮次。
