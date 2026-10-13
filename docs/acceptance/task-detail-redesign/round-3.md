# 第三轮浏览器验收

2026-10-13，独立 headless Edge 155.0.4283.45、React 18.3.1；16 组场景全部 PASS。第二轮发现的窄屏初始选中不可见已由本轮强制断言覆盖并通过。

## 重放配方

先执行 `pnpm install --frozen-lockfile`。脚本默认 Playwright 模块来自本机 Codex runtime，若路径不同，第 3 参数传入本机 Playwright 的模块 `file:` URL：

```powershell
node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs baseline
node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs round-3
# 可选覆写：node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs round-3 file:///C:/your-runtime/node_modules/playwright/index.mjs
```

基线已固定为脚本 `BASE_COMMIT=462c213fe84bcd1ce5e31e1015d3fde0a1f81212`，后续合并改变 `origin/main` 不会改变基线。首次基线运行使用 `origin/main`，已读回确认就是该提交。

## 独立读回

- 产品源码 SHA256：`b7cf3eb9d5b74a3973828704f276e54138e7ca29cac06898f469c2a208c753f5`，脚本结果与最终 `Get-FileHash -Algorithm SHA256 packages/dingtalk-dsh-observer/web-client.js` 一致。
- 合成夹具 SHA256：`e73b249c545e2653371509d0ba09c9b79c0a6a780713cdd104fa2cd3c12d3ba9`，与基线一致。
- 浏览器结果：`docs/tmp/task-detail-redesign/round-3/browser-results.json`，`passed:true`、16 项 `PASS`、`errors:[]`、`writes:[]`。
- 脚本 `node --check` 通过。

## 逐项结果

| 用例 | 结果与关键断言 |
| --- | --- |
| loading | PASS：首次等待、503 错误提示和重试恢复 |
| overview | PASS：12 步 3 组，默认等待步骤，未访问产出 0 请求，完整目标与结果链接 |
| initial-visible | PASS：切至 390px 后，第 6 步 top/bottom 为 1122.890625/1191.28125，目录为 831.5625/1195.5625，完整处于目录可视区 |
| keyboard | PASS：Tab/Enter、focus-visible、查看所选步骤与返回目录焦点 |
| output | PASS：产出失败重试、600 字分页至末尾、长文本换行、节点与版本下载参数 |
| preserve | PASS：切换与刷新保留选择、分页、展开；刷新失败保留正文并可重试 |
| responsive | PASS：1440px 与 390px、明暗色、长文本均无任务详情或文档横向溢出；阅读标题未被 sticky 头遮挡 |
| controls | PASS：跨组同名身份，跳过、复用、操作原因、等待原因与第 2 次处理耗时 |
| directory-scroll | PASS：直接窄屏进入、窄屏返回看板再打开同一任务，均使初始第 6 步可见；普通刷新前后目录 scrollTop=0、宿主 scrollTop=600 完全保持 |
| slow | PASS：产物身份变更重置正文；旧慢响应不混入新版本 |
| removed | PASS：选中第 5 步删除后转第 6 步，宣告变化并移交焦点 |
| empty | PASS：清空计划聚焦章节标题，无假进度；未确定步骤不显示 100% |
| defaults | PASS：首次失败、受阻、未开始与全部完成末步选择 |
| long-plan | PASS：30 步完整 3 组，窄屏目录局部滚动；返回末步焦点时按钮在目录内且未被头遮挡 |
| session | PASS：所选等待步骤会话打开 `session-current-step` |
| isolation | PASS：无 pageerror，无非 GET 请求，无历史执行查询 |

## 截图与边界

截图均保存在 `docs/tmp/task-detail-redesign/round-3/`：`desktop.png`、`dark.png`、`narrow.png`、`initial-selection-narrow.png`、`narrow-selected-last.png`、`narrow-30-steps.png`、`long-output.png`、`loading.png`、`initial-error.png`、`empty.png`。二进制不入库，脚本可再生成。

当前结果从基线桌面距顶部约 2169px 前移到 466px；窄屏约 2305px 前移到 526px。明暗截图中的正文层次与任务状态可读，目录和阅读区没有横向溢出。本轮覆盖合成数据 + 真实 React/observer 的 UI 行为；DSH primitive、会话与 API 为隔离替身，真实宿主集成、部署状态、钉钉消息和业务任务链路均不在本轮证明范围。

## 最终工程核验

- `node --test test/observer-client.test.js test/observer-node-control-display.test.js`：35/35通过，0失败、0跳过；最终日志 `docs/tmp/task-detail-redesign/unit-final.log`。第二轮适配组件提取与DOM mock后已35/35，第三轮窄屏修复后再次通过。
- `node --check packages/dingtalk-dsh-observer/web-client.js`、`git diff --check`：退出0。
- `python <frontend-design-premium>/scripts/audit_project.py . --mode strict --config docs/acceptance/task-current-steps/scripts/ui-audit-config.json --output docs/acceptance/task-detail-redesign/ui-audit.json`：0错误、0警告，结果已独立读取。
- `npx --yes -p @google/design.md designmd lint docs/manual/observer-design.md`：0错误；纯Markdown既有设计约定无YAML，1条提示。沿用运行时token为权威，不建立重复token源。
- `pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/tmp/task-detail-redesign/packages`：生成38866字节包，Python tarfile独立读取`package/web-client.js`与当前源码字节相等。摘要见`package-check.json`。二进制保留在docs/tmp，不入库。
- 人工检查本次diff：新增选择控件为原生button；复用宿主Button和既有读取/时长组件；无新写入请求、原生对话框、HTML执行或状态转移。
