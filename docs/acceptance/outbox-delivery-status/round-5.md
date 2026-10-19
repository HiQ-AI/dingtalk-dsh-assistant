# 第五轮：统一状态映射、四维筛选和短名称

源码最终 5f69c00（状态梳理 20e108b + 用户短名称调整）；只更新 Observer，Assistant 复用 33c8030 受信包。现行 notificationState 决定发送状态；旧字段集中适配无现行状态的历史记录。已停止原因单列，未知不猜待发送；仅旧发送记录没有回读 ID 显示已发送，原因注明缺证。撤回/替代事实不覆盖主状态。发送状态选项由同一映射生成，名称最多四字；替代与撤回也使用短标签，长解释留原因/提示。

node --test test/observer-client.test.js test/observer-archive-interaction.test.js test/task-message-projections.test.js test/task-notification-delivery.test.js test/task-notification-readback.test.js：76/76 通过；node --check、git diff --check 和 strict UI audit 无问题。回归覆盖现行全状态与旧字段冲突，未知/送达+替代+撤回并存，历史无证据，四维交集及空结果、提示计时器、通知不重发、时间真实性和持久投影。

Observer 2.0.0 SHA256 1b9ed598567f65579ee7a5600b5a2ad7b7ae751bc7e3dafcd5db8be3184c6b0c；Assistant SHA256 19e33f20ef505cd35a940aaac70299bb3ef4f37d54d135fb2f838f7104b1a139。原生 Check 零写零信号，33 会话回合已结束，无未知操作；正式 SIGINT 排空旧 PID 64816 后安装，新 PID 21008 同时持有3080/18998。安装源码 SHA 一致，profile 原摘要、计划任务启用状态保持，无历史备份。

健康 inboundProcessing=true、dwsBridge.healthy=true；原有1条未知通知告警仍保留，整体 health=degraded。64条通知的ID、发送状态、通知状态、投递ID、回读时间、替代指针、撤回状态更新前后 changed=0。

Chrome 重载后独立列及四个筛选均存在。原问题通知显示“已送达 / — / 已替代 / 无记录”。组合“已送达+无异常+已替代+无记录”有37条且包括原样本，刷新保持。组合待核对+无异常为空，改为需要核验后准确得到1条未知记录，仍有替代关系且未误报送达。状态菜单均为短名称，无旧群撤回重试承诺。768px下沿既有宿主及表格横向滚动查看，viewport已恢复；最终全部筛选64条，刷新保持。

截图、UI审计和控制/安装/启动回读证据在 docs/tmp/outbox-model-5f69c00*，含业务内容不提交。未发送新测试通知，未撤回任何消息；私聊撤回调度未改，历史虚拟边界由组件测试覆盖。
