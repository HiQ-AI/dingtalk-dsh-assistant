# 部署误判修正验证

## 实际改动

- 已安装 Registry 脚本仅增加 401 分类：`authentication_required`，有标准挑战时只输出已知协议名。无自动登录、额外请求、凭据交接或新参数。
- 当前 UAT skill / runbook 明确同候选有效证据可复用，只有镜像身份歧义时补读 Registry；status.image 展示差异不自动成为版本错误。
- 静态前端聚焦入口和必要自有主资源。空 CSS 本身不判失败，可选第三方统计不阻塞交付；主资源缺失/HTML 回落仍需处理。
- 没有新增运行态验证器、静态资源枚举器、固定字段清单或部署门禁。
- 定向复核相邻旧指引后，同步撤去正常部署必须逐项追查 UID/ReplicaSet/generation/Registry 的措辞；只在对象或版本异常时追查。未展开全文件治理，脚本未变，复用本轮四个用例结果。

## 实跑

在仓库根运行 `python docs/acceptance/upr-delivery-validation/deployment/verify-registry-errors.py --script D:/baibu-agent/scripts/read-registry-manifest.ps1 --output docs/acceptance/upr-delivery-validation/deployment/round-1.json`。仅在 localhost 提供响应，不读取实际凭据。

| 用例 | 修改前 | 修改后 |
| --- | --- | --- |
| 401 Bearer 挑战识别，敏感挑战参数/正文不输出，单次 GET | FAIL（笼统 http_status） | PASS |
| 401 无挑战仍识别为认证问题，不猜协议 | FAIL（笼统 http_status） | PASS |
| 正常 manifest 原始摘要及不同 configDigest | PASS | PASS |
| 真正摘要不符仍拒绝 | PASS | PASS |

完整结果保留在 baseline.json 和 round-1.json。4/4 通过只证明脚本行为，不声称真实 Registry 登录、部署或业务验收通过。

skill 格式检查首次因 Windows 默认 GBK 读取 UTF-8 失败；以 `python -X utf8 D:/codex-home/skills/.system/skill-creator/scripts/quick_validate.py D:/dsh_home/skills/uat-deployment` 实跑通过，没有修改验证器。

workspace.patch 和 skills.patch 已分别在原始 before 字节上执行 `git apply --check` 和实际回放，4 文件摘要与真实安装一致，见 installed-readback.json。before/after 为本机恢复材料，不提交完整个人运行指引副本。

## 边界

本轮只改脚本分类和操作指引；不部署、不访问线上 Registry、不重启或触发构建。镜像字段与静态资源的业务决策由主会话结合行为回归复核，未以文档文本匹配冒充行为验证。
