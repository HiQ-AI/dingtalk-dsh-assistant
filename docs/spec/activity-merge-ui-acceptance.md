# 生产活动合并结果的真实候选 UI 验收

当前 task-f559 候选新增失败结果弹窗，但 Detail.vue 的 handleMergeResultContinue 后缺逗号，完整脚本解析失败。旧 review-opinion-draft 仅测试评审草稿，不能覆盖此业务，因此新增专用 local-acceptance-activity-merge.mjs；不改插件和运行中的候选。

复用已安装候选 Vue/Element UI 和浏览器依赖、原 prepare-web/serve-web。专用本地测试页挂载候选原始 Reminder/Result SFC 模板、脚本和样式；以原 Detail 方法及 activity-merge-state 连接完整事件流。完整 Detail 先做语法解析，再提取所需方法；不补语法、不替换业务处理。原 API 导出函数继续生成请求，在浏览器网络边界以固定合约响应模拟部分/全部失败、成功和下载文件。仅允许本地专用测试页、已知静态依赖及精确 fixture 路由；阻止外部网络和WebSocket。

覆盖全部提交组名称/状态/计数，取消不生成且成功合并事实保留，继续进入原确认框且确认前不生成，全部成功旧提示、无候选旧确认、结果下载POST参数/Blob字节/文件名、错误文件错误提示。真实后台权限、可信状态及Excel15列生成不由fixture证明；后端导出路由缺失单列阻塞，不能宣布业务全通过。

配置严格绑定Task和UAT3；namespace由已有runner提供，initialize/cleanup/verify-cleanup只操作该namespace证据，独立浏览器关闭、无远程资源。--check仅读取/解析，不生成或改动候选文件。证据round53。脚本自测可在docs/tmp复制候选并仅修复语法构成测试夹具，证明验收器其余路径；夹具PASS不得替代真实候选FAIL。
