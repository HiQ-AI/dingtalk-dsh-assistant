# 第三轮：按用户决定允许分开发送

2026-10-22 用户在核实 DWS 能力后明确：“那就先不放在一条消息回复”。本轮只调整既有交付规范和当前任务范围：正文仍引用对应原消息，按文件名与用途说明本次产物；图片、文档及其他附件可作为独立消息发送，按精确消息/资源逐件核验后关联到任务清单。

运行技能 `D:/dsh_home/skills/group-file-delivery/` 的 `SKILL.md`、`references/procedure.md` 和 `references/source-map.json` 已同步。宿主最终文字回复与执行会话文件交付分工保持明确；每次发送保留原身份，未知先对账、已确认项不重发。若后续用户明确要求同条组合，再核实相应能力，本轮不等待该协议，也不提交上游问题稿。

本轮验证：

- `python -X utf8 D:/codex-home/skills/.system/skill-creator/scripts/quick_validate.py D:/dsh_home/skills/group-file-delivery` 返回 `Skill is valid!`。
- 独立读取 JSON、检查 9 个节点的唯一 ID、必需字段、程序章节与入口文件引用，全部通过。复读涉及同条发送的规则，均限定于未来用户再次明确要求的情形；当前正文/文件核验使用各自 messageId。
- `validate_long_goal.py --goal docs/acceptance/unified-reply-validation/goal.md`、PR 正文检查及 `git diff --check` 通过。
- 三个文件修改后两次独立 SHA-256 回读一致，具体摘要如下。

| 文件（相对运行技能目录） | SHA-256 |
| --- | --- |
| SKILL.md | c8ca4ec3ff7d7f995589cfd0ec6b61c27204dedfde198952d17c70a1f3dc2c5e |
| references/procedure.md | c6e8583fd43539b458c5f838dd576d2e77b98675ffbe599848a2d5c824729f3e |
| references/source-map.json | 93f23b232f602c077c08d74295db8cb3e32e64d5546d813756f03117e2ffd1e9 |

这是用户调整范围后的规范检查，没有新增消息协议或执行真实发送。旧轮次的同条能力 `BLOCKED` 保留，本轮在矩阵中记 `DEFERRED`，不能写成实现 `PASS`；真实消息回读仍为 `NOT_RUN`。旧模型场景中的同条要求是该场景的明确输入，仍有意义，不因本次偏好变化改写历史结果。

继续使用 [PR #246](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/246)。本轮编辑前独立回读为 `OPEN`、`mergedAt=null`、分支 `worktree-unified-reply-validation`、原远端头 `4e19558abe5fbe88ac1d7a466baf36cb562fc11a`；本轮修改仅含技能规范、README 与验收说明。此前代码和 helper 验证结果沿用第二轮证据，不累计测试数量，不将本轮结构检查当作模型或真实群内呈现验证。PR 尚未合并或部署。
