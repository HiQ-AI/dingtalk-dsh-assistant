# 阶段成果与统筹巡查预览

基线 main `3d7a188ede9e605f218cf2a82e163620f209dbc3`。复用既有 decisions API，无后端/账本/调度改动。只接纳关联 execution.progress.review 的决定，wait 结论也显示。成果来自 timeline 原始 milestones，同一个稳定身份只出现一次；保留时间图成果刻线和活动明细，其成果文字移入同一区域混排列表。

分页对全部统筹决定使用原游标，普通决定不显示但仍可继续向前读取；不将已加载范围当全量。读取、失败保留、重试、刷新及卸载失效响应已测试。不臆造“等待统筹”或“巡查失败”单条记录；当前API不足表达它们，只明确本列表展示已落账结论。记录手动刷新，避免每次看板刷新清空历史阅读位置。大量历史阶段成果仍受现有 timeline 投影范围限制，不声称提供额外历史归档。

验证：项目规定受影响5文件测试100/100、0 fail、0 skip；新增混排筛选/排序/去重与分页失败/重试/重复点击/卸载测试。Chromium 真实React和完整observerCss/taskDetailCss通过，合成阶段成果和巡查混排，桌面1280与手机390px、折叠活动明细、游标分页、失败重试、无横向页面溢出、字体样式与无pageerror均已核验。宿主Button在预览中映射原生button，未冒充原生宿主验收。严格premium audit 0发现。未调用真实模型、读取生产任务、群外发、创建PR或部署。

运行预览：`node docs/acceptance/task-review-results/browser.mjs <Playwright工具根> <输出目录> <浏览器可执行文件> [React依赖根]`。工具根应包含 `node_modules/playwright-core`，React依赖根应包含 React 18 和 ReactDOM 18 的 UMD 文件；省略时沿工具根读取。浏览器路径由调用方显式提供，支持 Windows Edge/Chrome 与 Linux Chromium。依赖使用已有隔离目录，不新增仓库依赖。当前脚本同时验证阶段证据、报告时活动、安全链接、加载与空态，新的本轮结果见 `../task-collaboration-quality/round-1.md`。

截图：`/workspace/task-review-results-preview/task-review-results-desktop.png`、`/workspace/task-review-results-preview/task-review-results-mobile.png`。Library prepare已返回上传会话，但官方上传工作流报 `hosted apps tools/call request failed: network`，没有成功创建Library文件，不能提供library_file_id或声称上传完成。

后续交付：排查未重复创建后，通过受支持本地文件上传完成两张截图：桌面 `libfile_53c68175b3188191a698de300342fbfa`，手机 `libfile_fbf8bdf473f88191874a57622c680887`。

发布前将 main #244（8fe0eeb）无冲突合入，业务代码未额外调整。实际 npm 双包解包逐文件比对：Assistant 67 文件、141 本地引用目标完整；Observer 4 文件，新混排UI及decisions读取资源均在web-client.js。针对同一实际Assistant tarball的原生启动/skill及Observer相关回归62/62、0失败0跳过，未重复全量或调用真实模型。
