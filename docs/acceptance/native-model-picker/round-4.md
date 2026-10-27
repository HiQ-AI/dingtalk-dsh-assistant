# 第四轮：注入修复与正式宿主验收通过

## 结论

实际认证宿主 http://127.0.0.1:3080/ 的“设置→内置插件→钉钉个人助理”已验证：三个模型字段的触发器样式、原生弹层样式及全部候选一致；与部署前实际 DSH composer 原生菜单基准也一致。不是隔离 fixture 结论。

## 修复与测试

客户端同时声明 remote 和 remote.session。真实 Cordis sibling provider 测试先复现缺父级声明时 cannot get property remote without inject，再证明修复后目录 ready。17 targeted、14 smoke 全部通过，均无跳过；原生模块导入也通过。源码/包固定于 2981e7c6，后续仅追加本轮证据。

## 部署与接续

先部署 main ebfc45a0 后出现第三轮UI错误。修复版首次 Check 通过，但 apply 前旧进程96492消失，DEPLOY_PROCESS_IDENTITY_CHANGED保护停止，未安装。计划任务结果3221225786对应Ctrl+C；退出来源未收敛，不把它归因为前端注入错误。

保留 control/failure；独立离线检查证明旧owner退出、81会话排空、未知操作/通知为0，双端口关闭且无并行Web/部署进程。原profile SHA与两包SHA稳定、计划任务未出现新一轮启动。原输入通过零写恢复Check后禁用自启，沿同一原生 plugin --profile web add 安装双包，比较源/包/安装全部文件，恢复原Enabled状态并仅启动一次。恢复脚本与原始收据留在本worktree docs/tmp/native-model-repair-build-20261027/，不伪造原脚本success，也不热改安装文件。

独立回读见 round-4/deployment-readback.json：新PID96580、health=ok、inboundProcessing=true、dwsHealthy=true、recoveryIssueCount=0；计划任务Enabled=true，旧PID已退出；包摘要/客户端bundle一致，三个模型配置与部署前完全相同。

## 三菜单现场逐项比较

逐一打开默认处理、统筹、协调菜单，通过DOM读取每项 text/provider/model 和顺序。每份均2个提供方、9模型，allThreeContentEqual=true；候选完整身份与部署前composer基准相同。证据：round-4/live-menu-comparison.json。

原生菜单统一class `_surface_ri079_1 _7KE1Ra_menu`，圆角16px、computed width240px、字色rgb(15,17,21)、材质rgba(248,249,250,0.58)；allThreeStylesEqual=true，matchesNativeComposer=true。菜单外框offset width248px包含padding，不与computed width混淆。三个触发器class及高度、字体、圆角、padding、前景/背景一致，见 live-trigger-comparison.json。

分别留存default-menu.png、task-menu.png、coordination-menu.png于本地docs/tmp/native-model-repair-build-20261027；未提交二进制。搜索GPT-6.1保留两个提供方的GPT-6.1 Sol与GPT-6.1-Sol；清除恢复9候选，唯一无匹配搜索显示“没有匹配的模型。”；Escape两次关闭回触发器。未选择模型、未点击保存、未外发消息。验证开始后的新增浏览器错误数0。截图逐一视觉核对原生圆角、分组、搜索框、高亮与勾选；原selected值各自保留，不要求三字段选同一模型。

窄屏仍不在本轮验证范围；本轮完成用户要求的实际桌面样式和候选一致性。没有触发CI，没有重放业务任务。
