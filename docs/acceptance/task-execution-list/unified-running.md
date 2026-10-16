> 用户已取消新增蓝色方案，当前由恢复原生配色补丁撤回。本文件仅保留先前验证记录。

# 运行颜色一致性补充

基于main 9fd1f858bf1703532272d4c4504a5ab036adf198，新分支fix/unify-task-running-color，补充PR197已认可UI。

共用taskRunningTag颜色/类名及一条限定observer-task-running子树的ongoing继承规则。任务详情顶部运行标签、执行会话列表运行标签和任务卡片active执行圆环统一，不复制三套颜色。只有running（卡片还要求未排空且非恢复）应用；其他状态、历史只读及无关加载器不变。原StateDot、动画和尺寸保留，无业务数据变化。

真实Chromium与已安装原生StateDot函数/CSS核验三入口color/stroke相同，三者仍使用dsh-state-dot-spin。卡片圆环14×14，列表标签64×24，文字对比度5.32:1。单元覆盖running及completed/waiting/failed/queued和历史只读非覆盖。100项定向测试通过，0失败/跳过。隔离夹具不触发真实任务或消息。

云端仅代码交付合并，百部由父任务拿最终SHA一次部署；Windows宿主和生产实机需部署后回验。CI当前仅workflow_dispatch，不自动随PR触发。
