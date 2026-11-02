# 插件首屏请求并行化验证

## 范围与版本

仅修改本仓库 Observer 前端加载函数、相关测试和 README；不改 DeepSeek Harness、安装目录或运行实例。基线为 PR #332 合并提交 `9e95ded46369efc7028fef35270c60aee5d904a1`，本轮验证对象为 worktree-observer-load-pipeline 未提交工作树。旧的本地部署验收资料不属于本轮提交。

## 根因与改动

旧 load 先等待 health、群摘要与当前栏目请求全部完成，再请求群消息/发信箱；分页只需要群目录，却被独立 health 请求串行阻塞。新实现建立群目录 Promise 的依赖分支，群目录返回即并行发起两类分页，并将其与 health 一起等待。展示仍要求完整结果，保持原错误、取消、选群回退、分页版本与过滤合同，不缓存旧数据、不吞错。

非群栏目不额外发请求，群为空时不请求分页。任务卡片需要完整目标、话题与执行统计，现有 summary 不满足合同，因此不直接切换 summary。宿主慢会话列表和公共脚本仍保持不动；本改动不承诺修复每页首次加载或消除共享进程停顿。

## 验证

- `node --test test/observer-client.test.js test/observer-group-pages.test.js test/observer-archive-interaction.test.js test/observer-board-restoration.test.js`：63 tests，63 pass，0 fail，0 skip。
- 新增受控 Promise 测试直接执行实际 load：health 尚未完成即观察到两个分页请求；覆盖指定群/不存在群回退、分页/过滤/版本、同一 AbortSignal 传递、空群、非群页面，以及群目录/health/两类分页分别失败时原错误向上传播。
- 使用临时 localhost HTTP 服务，分别执行 git show origin/main 的原 load 与当前 load，health 延迟 160 ms、群摘要 10 ms、两类分页各 100 ms；三轮前/后分别为 293.17/178.35、310.03/186.18、292.63/188.60 ms。服务实际监听动态空闲端口，完成后关闭全部连接与 listener。这是受控本地 HTTP 对照，包含本机调度开销，不是生产或浏览器渲染基准。
- `node --check packages/dingtalk-dsh-observer/web-client.js` 与 `git diff --check` 通过。

## 未验证与边界

未部署本轮修改，未对修改后的已安装插件做真实认证浏览器复验，未发送群消息。已有首次加载浏览器取证属于修改前现场，不作为修改后验收。未运行 CI，不变更工作流。仅消除插件群消息首屏/刷新的一段瀑布，不减少接口数量，也不移除 health 的最终展示等待。

对照脚本为一次性内存执行；临时输出和测试日志在汇总核对后清理，必要文字证据保留于本报告。回滚只需恢复前端 load，无持久化结构或 API 改动。
