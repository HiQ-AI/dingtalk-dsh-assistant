# 第一轮：复盘修复与组合回复能力边界

2026-10-22，所有业务外发与线上部署均未执行。本轮是在已有附加工作树中新建 `worktree-unified-reply-validation`，基于 `origin/main` 的 `a04abb9`，原工作区及原 `docs/tmp/` 保留。

## 已落地的技能修改

直接更新实际技能目录 `D:/dsh_home/skills` 的两个现有 skill，没有新增 skill，也没有把个人技能复制为插件实现：

- `baibu-uat-account-verify`：将正常受管凭据流程置前，提供不读凭据、不发起登录的会话 helper。缺少登录响应 Authorization 不再被当成失败；本轮身份、同身份注销和本地关闭分别核验。登录开始即处于 finally 清理范围，未知不重登，明确身份不匹配不注销另一身份。
- `business-development`：先核实目标环境代码、调用链及删除历史，外围条件只阻塞依赖它的步骤。页面 helper 按实际权限断言，精确放行已证明只读的请求，保存固定阶段与断言；截图在自动检查后仍待实际读图，复核绑定全部文件 SHA256。
- 前轮已更新 `group-file-delivery` 的同条引用交付规范，本轮重新结构校验通过；该规则更新不等于组合消息能力已经实现。

最终技能回归 **21/21 通过**，包含本地 Edge 实际页面、localhost 查询成功/业务写入未到达服务、认证替身成功与失败清理。两个新 helper 的原始认证异常外泄、无自动断言也可被视觉复核提升为 PASS 两个反例，均经独立审查发现、修复并重跑原反例。详见 [技能结果](skill-validation/report.md)、[独立审查](skill-validation/independent-review.md)、[最终用例结果](skill-validation/round-3/results.json)。

主代理另以 `view_image` 独立打开第一轮 error.png 与 clean.png，确认前者红色 Network Error、后者无该提示；最终第三轮两图由实施者重新实际读图并绑定当前 SHA256。没有以 JSON PASS 代替读图，也没有把本地夹具称为真实 UAT。

三个相关 skill 的 `quick_validate.py` 在 Python UTF-8 模式下通过。7 个当前修改文件的字节数和摘要在 [skill-hashes.json](skill-validation/skill-hashes.json)；运行中旧会话是否重新加载技能未单独验证。

## 统筹与决定留存

现有生产提示词已经要求首次发现偏离时反馈，并核实反馈之后的实际行为。本轮先测现有实现，没有为制造改动叠加同义规则。

- 原生巡检及决定存储定向回归 **101/101 通过，0 跳过**，见 [原始输出](coordination/native-tests.log)。
- 增强两轮巡检原生用例，逐字回读两次不同 summary、evidence、limitations，确认更新最新决定不会覆盖旧解释；修改后的该文件 **5/5 通过，0 跳过**，见 [复验输出](coordination/native-retention-tests-fixed.log)。该计数与前述 101 有重叠，不合并成 106 个独立用例。
- 实际模型情境与原生工具调用证据由 `coordination/` 保存。评测把错误人工申请/取消接到合成出口，记录第一次选择；原生工具错误、跳过或超时不计通过，不能靠禁止错误动作后让模型自纠正制造通过。
- 旧评测夹具缺 `resources`，以及只读合成内容引用被过严禁止，均属于本轮评测设施问题，已修正并保留失败。新场景采用合成业务材料，外部业务工具仍不可调用。
- 旧脚本使用 sol/medium，与原任务和当前配置 astra/low 不一致；两类结果必须分别记录。实际配置关键情境补测完成后更新总表，不以旧配置结果冒充原任务配置证明。

## 尚未完成的组合引用回复

已独立核实安装 DWS v1.0.63 的两种个人引用入口，以及上游 main `8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6`：没有原生引用、正文与多件图片/文档的完整组合发送入口。普通本地图文与文字样式渲染是局部能力，不能外推完整协议。当前身份的服务目录发现被权限拒绝，官方 chat 市场 ID 也未核实；底层是否另有协议仍未收敛。

因此未写猜测传输、未把文件链接或拆条发送算成修复，未改现有文本通知的发送/恢复合同。SG4 保持受阻，真实组合消息功能与群内呈现未验收。已准备 [具体上游技术问题稿](transport/upstream-protocol-question.md)；是否对外提交由用户决定，本轮不擅自外发。完整来源及反证见 [协议核实](transport/protocol-review.md)。

## 交付边界

本轮可交付的是已修改的个人 skill、实际行为验证、评测设施修复、决定留存回归和运行指引。没有重新登录 UAT、发布 Dataset、重发旧截图、发送测试消息、升级 DWS、部署插件或触发普通分支 CI。总体目标尚未全部完成，因此不生成全绿 `report.md`；状态以 [matrix.csv](matrix.csv) 与 [goal.md](goal.md) 为准。
