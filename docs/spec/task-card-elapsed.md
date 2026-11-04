# 任务卡片总历时

卡片底栏保持现有 `fmt(task.updatedAt)` 日期及归档行为，在日期后同排追加 `· <1m`、`· 35m`、`· 4h 3m`、`· 1d 2h`。分钟向下取整，天级显示天/小时，零的次级单位省略。缺少可靠时间或异常显示 `· —`，不显示推测值或补成零。日期和操作不压缩，只有新增时长可以省略，完整值和口径通过提示及无障碍标签保留。

总历时为任务首次创建到当前或最终结束的单一墙钟跨度，包含排队、执行、等待、暂停及完成至重开的间隔，不累加并行执行。活动任务从 createdAt 计到当前；最终结束仅使用 completion.at 或 cancelledAt。完成回执需求修订须匹配任务，创建或结束时间缺失、逆序、未来、终态冲突时未知；updatedAt 仅表示最后活动时间，不能补结束时间。归档、报告更新和页面时钟不延长已结束值。历史重开或前次完成回执缺失不影响这两个当前端点，详情时间图仍保留原分段口径。

任务分页响应沿用 `elapsedTiming: { complete, closedMs, activeSince }`。活动任务返回 `{ complete:true, closedMs:0, activeSince:createdAt }`；最终结束返回创建至结束的 closedMs 与 activeSince:null；未知返回 `{ complete:false, closedMs:null, activeSince:null }`。只投影当前页任务记录，不读取执行日志、历史 wake 或回执，也不添加详情请求。

前端仅在任务看板显示活动任务时建立一个共享时钟；无活动卡片、进入详情或切页后清理。复用原分页刷新。浏览器时钟早于可信创建时间时显示未知，不钳制成零。

验证：任务时间投影、实际分页SQL不读取历史、缺失/异常端点、重开间隔、并行执行、格式及归档回归；`docs/acceptance/task-card-elapsed/scripts/verify-browser.py` 加载完整Observer和真实React，检查日期原样、窄屏、共用时钟、终态固定、刷新失败及键盘归档。HTTP使用隔离替身，宿主primitive用语义适配，不能称已完成真实登录DSH业务验证。
