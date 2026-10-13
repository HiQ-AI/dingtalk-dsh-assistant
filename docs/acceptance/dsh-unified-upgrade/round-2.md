# 第2轮：完整隔离安装、部署提案与现场历史反证

- 最终11项直接依赖的隔离Web profile完成原生plugin add；独立manifest深比较通过，锁文件旧0.1.2/0.1.1引用0、安装compat/peer警告0。
- 隔离root的数据/工作区均位于docs/tmp；没有正式业务groups，DWS监听与写入关闭。首次因未创建独立workspace失败，补齐夹具目录后重新执行：Runtime health=ok、recovery=0、平台客户端与llm/tools/sessionPersistence均可用，stderr为空。两个隔离端口已由driver shutdown关闭。没有以首次失败为PASS。
- Host升级提案仅check，writes=0；保留正式manifest非依赖字段、bundle及原patchbytes，追加完整官方preset并沿用原instruction配置。部署hook13项回归通过，含CAS、旧override、实际市场包名与!!js原字节保留；全部本地tgz纳入输入SHA冻结。
- 现场只读副本81个session.jsonl，官方alpha2对v0 dingtalk/group-coordinator-session拒绝。官方中间rc2的write/flush同样拒绝，原v0保持。不能以先前V3样本PASS声称现场迁移PASS。
- 现场82条4种owned身份事件；全部ignorable且schema吻合。公共catalog不支持runtime第三方注册migration，公开API无安全删除回插seq映射契约。
- 正在以官方源码d743267388641bc76f17c45ce8b4c231aed1d32c为基线，仅修改0→1与1→2迁移边显式fixed schemas，沿原边内部emit与map保留数据/时序；其它unknown保持拒绝。需当前fixture/81copy全部通过才正式停机。

尚未通过：现场历史迁移、认证Web实际加载、正式部署与历史任务回读。正式DSH仍0.1.2-rc.1，无停机/安装动作。
