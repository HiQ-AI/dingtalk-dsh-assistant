# UAT 登录、页面验收与调查顺序补强结果

SG2 已在两个现有 skill 中落地。最终 21 个行为回归全部通过，两张本地 Edge 夹具实际读图完成；本机请求证明只读 POST 可访问而业务写 POST 未到达服务。状态总表为 [matrix.csv](matrix.csv)，最终轮次为 [round-3.md](round-3.md)。测试证明 helper 的行为及脱敏边界，不代表本轮重新登录了线上 UAT。

## 修改前后

| 范围 | 原问题 | 本次改变 |
| --- | --- | --- |
| 账号 skill | 主要是旧临时改密案例，正常受管凭据流程缺具体复用入口 | 正常路径置前，明确无现有浏览器/响应 Authorization 不等于无路径；本轮 context、同身份 current、同组头 logout 后拒绝分别核验 |
| 正常登录 helper | 原任务脚本自行读取凭据、绑定专属页面，失败路径曾漏清理 | 提取不读凭据/不发起登录的 `HiqUatSession`；从登录就进入 finally，页面失败也清理，未知不重试；原请求异常在 helper 边界脱敏 |
| 业务调查 | 网关/登录阻塞了可独立完成的源码调查 | 先核目标环境分支/SHA、调用链与能力变更历史；静态结论和线上缺证分别报告，外围条件只阻塞依赖它的步骤 |
| 页面断言 | 只读账号误要求添加可见，只留通用 AssertionError | 权限未读取与已确认无权限分开；固定 stage/assertionId 加布尔/整数 expected/actual，外部异常固定标识；定位器误判先检查真实渲染 |
| 只读 POST | 按方法全部阻断造成 Network Error | 根据本版本源码确认精确 method/path，同 origin 放行必要查询，保留被拦方法/路径且去掉 query；认证生命周期独立处理 |
| 截图结果 | JSON PASS 可与实际错误图冲突 | 自动结果待实际读图，SHA256 绑定全部待交付截图；真实错误、换图、缺原自动断言或前轮失败均不能被复核“洗成” PASS |

修改路径（均在现有 skill 目录）：

- `D:/dsh_home/skills/baibu-uat-account-verify/SKILL.md`
- `D:/dsh_home/skills/baibu-uat-account-verify/references/verified-flow.md`
- `D:/dsh_home/skills/baibu-uat-account-verify/scripts/hiq_uat_session.py`（新复用脚本）
- `D:/dsh_home/skills/business-development/SKILL.md`
- `D:/dsh_home/skills/business-development/references/procedure.md`
- `D:/dsh_home/skills/business-development/references/page-verification.md`（新条件参考）
- `D:/dsh_home/skills/business-development/scripts/page_acceptance.py`（新复用脚本）

创建两个 helper 的理由是原流程每次重写都会丢失登录 finally、同身份核验与视觉结果边界；现有两个 skill 原先没有可复用脚本。页面接入细节放单独 reference，避免所有开发任务都加载浏览器要求。不修改既有临时改密授权边界，不引入新 skill 或全局 UI 测试门槛。

## 复现

在 `D:/codex/worktrees/task-resource-lease/dingtalk-dsh-assistant` 使用 PowerShell 7；需要本机 Python 的 Playwright 包及 Edge：

```powershell
python -X utf8 -B 'docs/acceptance/unified-reply-validation/skill-validation/test_skill_helpers.py' --skills-root 'D:/dsh_home/skills' --output 'docs/acceptance/unified-reply-validation/skill-validation/round-4/results.json' --browser 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
python -X utf8 -B 'D:/codex-home/skills/.system/skill-creator/scripts/quick_validate.py' 'D:/dsh_home/skills/baibu-uat-account-verify'
python -X utf8 -B 'D:/codex-home/skills/.system/skill-creator/scripts/quick_validate.py' 'D:/dsh_home/skills/business-development'
```

重跑用新 round 路径，不覆盖已有证据。测试自动生成错误/干净 PNG 和待复核 JSON；实际读图后按 [页面接入说明](D:/dsh_home/skills/business-development/references/page-verification.md) 调用 `finalize_visual_reviews`。`visible_errors` 不能填固定 0 绕过读图。本次 round-2、round-3 已真实读图且保存补充结果。

## 边界

认证测试使用内存服务替身，页面使用专用 Edge 与本机临时服务；没有读取凭据，没有实际 UAT 登录、消息发送或业务写入。正常登录具体协议仍需在真实任务确认当前前后端版本；helper 不提供免确认的任意入口/账号访问。当前身份明确不匹配时，保留未知并避免注销另一身份；本地浏览器关闭不冒充服务端注销。

视觉复核依赖执行者实际看图，helper 能阻止缺检查/缺复核/换图和已知失败变 PASS，不能机械证明执行者确实看过图或评估所有布局语义。调查顺序指导的实际统筹行为由 SG3 独立场景评测覆盖。此子任务未编辑插件源文件或 goal.md，也未提交、推送或部署；由父会话集成。
