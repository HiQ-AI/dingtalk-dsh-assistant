# 已封存工作流接入空测试群

本轮只扩展既有 cutover：原始 journal、群列表和 snapshot 保持原样；新增群以独立 enrollment 保存快照及 sealRef。封存先于原生 message.group.begin/activate，未完成的 enrollment 阻止启动及旧入口写入。

接入前必须通过既有 HTTP 订阅、正式维护并排空、停机和禁用自启。CLI 只接受完全空群，检查现有 seal、控制库身份、maintenance stopping、零活动工作与 profile CAS；execute 自己获得控制库独占锁。不得清理消息或直接改控制库。

profile 仅替换唯一匹配 instanceId/dbPath 的 workflow.groupIds 值；自定义 !!js 不执行，其他原文保持。journal 绑定 profile 的前后哈希，崩溃重跑只接受这两个精确版本。先持久封存、原生命令接管、CAS profile、最后激活 enrollment；中途失败保持 fail closed。旧群继续使用原始 sealRef。

定向验证覆盖零写 check、非空群拒绝、维护/身份/CAS/锁门禁、旧快照不变、每群独立 ref、崩溃续接和配置原文保持。真实新群发言与 answer 链由主任务另行验收。
