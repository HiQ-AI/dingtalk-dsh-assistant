# 第七轮：真实关联阻塞修复与续跑（进行中）

已有业务验收阻塞的根因及FAIL证据见round-6.md，原消息未重发。SQL只扩充终态排除，相关122/122定向通过、0skip，原始日志no-action-routing-regression.log；保留真正未归类消息屏障反例。

修复包仍版本0.5.15，唯一新tgz SHA256 c985f9f744f7f0b61b1ee3cb5f8c5e7035fdc94cf5764dc9c192b32a82216fa0，610299字节。复用受控部署，TaskDirectory显式D:/baibu-agent/tasks，不传已执行的迁移计划，避免重复迁移；部署前Check零写预检正在执行。

待新实例自动恢复派发，续跑同一真实源消息，核对新任务根及附件下载；实际生成后还需受控重启回读，不提前写全绿。

修复包Check通过：零写，99文件SHA匹配，D盘可用13523263488字节、所需2610967514字节；任务根纳入本次完整备份。已开始执行，无迁移计划参数。

实际修复包安装与恢复派发通过：新PID27508，99文件SHA匹配，健康ok/recoveryIssueCount=0，维护revision117 inactive。但原验收消息仍needs_attention，reason=MESSAGE_TOPIC_INTENT_FAILED:RUNTIME_MAINTENANCE_ACTIVE。事件账只读序列证明attention=15143，发生于封存15139后、解除维护15146前：启动/DWS补读可在维护期间触发topic领取；该正常暂停错误被误标永久失败。真实业务本轮仍FAIL，不能声明完成。
