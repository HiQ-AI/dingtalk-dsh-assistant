# Topic 外围验证与界面约定

日期：2026-09-07。范围为 HTTP、DWS bridge/adapter、Observer Topic 入口；不涉及真实 DWS 外发、生产安装或部署。

## 界面与行为归属

沿用 Observer 的运行看板、颜色变量、Button / Menu / StateDot、分页工具条和空态，不建立另一套视觉系统。业务依据为 `docs/spec/topic-driven-message-processing.md`。技能中的根 DESIGN.md 建议与仓库“非源码输出必须放 docs 子目录”冲突，按用户规则在本验收记录保存本次映射，不新增根文档。

| 能力 | 既有所有者 | 本次行为 |
| --- | --- | --- |
| 颜色/主题 | DSH `--dsw-alias-*`，Observer `colors` | 沿用 surface、border、muted、danger，无新增色板 |
| 按钮/筛选 | DSH Button、Observer SelectMenu / DSH Menu | Topic 列表与 Task 跳转使用原生按钮语义；群筛选复用 SelectMenu |
| 页面导航 | Observer `pages` 与 activePage | 新增“话题”，复用宿主内页面状态，不改写 DSH Session URL |
| 列表/分页 | Observer tableFrame、toolbar、tableFooter | 每页 25 条；API 默认 50，最大 100；群筛选重置页码，列表缩小时校正页码 |
| 上下文 | Topic 固定 revision API | 消息按选定版本读取；当前摘要明确标注 summaryRevision，当前未决问题单独标注 |
| Task 来源 | Task topicRefs | Task 卡片跳转到该 Task 接纳的 Topic revision；详情关联 Task 可打开原叶子 Session |
| 异步反馈 | Observer emptyState 与本地错误区 | 加载、空态、列表失败、详情失败与重试；请求失效后忽略旧响应 |
| 响应式 | Observer 自然内容滚动 | 话题两栏使用 auto-fit，窄屏成为单栏；不改变既有其他页滚动结构 |

## 实跑结果

- `node --test test/http.test.js test/dws-adapter.test.js test/dws-bridge.test.js test/observer-client.test.js`：57/57 PASS。
- `node docs/acceptance/topic-driven-processing/scripts/verify-topic-observer.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`：PASS。独立 Edge 无头进程运行真实 Observer 脚本；DSH 宿主与 primitives 用最小替身，所有 HTTP 回包为 fixture。验证列表、固定版本详情、分页、Task 引用版本跳转、键盘、390px 话题区无溢出、空态、列表/详情失败重试、加载状态和旧请求不能覆盖新选择。0 pageerror。
- `python .../frontend-design-premium/scripts/audit_project.py <worktree> --mode strict`：0 findings。完整 JSON 留在同目录 `observer-ui-audit.json`；静态审计不能替代真实宿主验收。
- `node --check packages/dingtalk-dsh-observer/web-client.js`：PASS。

HTTP 测试核对列表截断、分页参数错误、固定版本参数透传、跨群 404、群消息保留及内部 Topic/归类/预约日志不泄漏。DWS 测试核对同文不同引用分别发送和回读、无引用回复不能认领其他话题的引用回复、补拉 ok 只代表接收、事实补齐重新 ingest、附件恢复清除不可读原因。

## 验收边界

浏览器截图 `docs/tmp/topic-observer/narrow.png` 为可再生成的临时产物，不提交仓库。独立浏览器验证没有覆盖已安装 DSH 的真实 Menu portal、主题切换和宿主 Session 导航；本次不声称插件已发布、profile 已升级、真实群业务闭环已完成。新增页面保持现有宿主导航，窄屏全局导航横向可达性属于既有宿主问题，话题内容区域已单独验证。
