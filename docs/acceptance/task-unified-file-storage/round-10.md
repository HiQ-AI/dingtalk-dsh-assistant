# 第十轮：真实群文件交付与重启恢复

新唯一请求在用户授权的专用群经独立消息读取确认，真实 S/R/IB/create 成功，创建 task-bf67e52908fd266fa6108536ad88b5ab。任务目录具有 work/tmp/outputs，节点引用直接带逻辑任务归属。原始会话存储根保持 D:/dsh_home/sessions，新 Owner JSONL 由宿主正常写入其 cwd 命名目录，未迁移至任务根。

Owner 三次初始化同时安排写入和群交付，违反现有通用能力每轮单阶段约束，留下 TASK_OWNER_ADVANCE_CONFLICT。提示补清单阶段及核验后下一轮交付，存储合同不变，原生会话/Owner存储/文件集成33/33通过。Web上下文入口在尚无执行阶段时返回 WORKFLOW_TASK_NOT_FOUND；没有手改控制库。本轮从已授权验收群补充阶段约束，原生话题事实事件恢复同一任务并保留失败历史。

原任务普通文件生成及群交付两阶段成功。outputs中报告324字节，SHA256 b145ad56ad680d1193a6ed6fa7fae0e4d7352e722a1915b1f53ee8891778753e。真实file消息独立mget foundCount=1、complete=true，再下载至私有证据目录，大小与SHA一致。内容甲3/1、乙2/2、合计5/3、总8、62.5%及仅验收声明均独立读取符合。

实际任务完成门禁与重启后文件回读仍待完成。不能将前述群文件送达等同于任务已完成或重启验证通过。

Owner完成校验三次TASK_OWNER_COMPLETION_UNVERIFIED；三次都有完整complete候选及7项assessment。已确认复合条目跨领域但每个领域只有自身证据的合同矛盾，正在定向复现；领域模型校验结果未持久化，不能断言这是本次唯一触发点。实际文件不重发、不修改任务终态。
