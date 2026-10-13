# 第一轮浏览器验收

2026-10-13，使用独立 headless Edge 155.0.4283.45、React 18.3.1。最终完整执行 13 组场景均通过；未连接真实运行实例。

## 配方与源码

```powershell
node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs baseline
node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs round-1
```

- 基线：`git show origin/main:packages/dingtalk-dsh-observer/web-client.js`，`origin/main` 为 `462c213fe84bcd1ce5e31e1015d3fde0a1f81212`，SHA256 `c6ce7f50cd310ed3e2ade3bc42af925e806e916397c5c1d51572e17f0e7ddb52`。
- 新版 SHA256：`40c553761ca2146d406081e6d7e7c04f66ede1f2c6ee4f07043202e9cbe4faeb`。
- 固定合成夹具 SHA256：`e73b249c545e2653371509d0ba09c9b79c0a6a780713cdd104fa2cd3c12d3ba9`。
- 完整结果：`docs/tmp/task-detail-redesign/round-1/browser-results.json`；基线同路径 `baseline/browser-results.json`。二进制截图留在 `docs/tmp/`，不入库。

## 已验证

1. 初次等待状态、读取失败、重试后恢复任务详情。
2. 12 个步骤完整分为 3 组；默认选中等待步骤；初次未选产出请求为 0，旧版同夹具为 4。
3. 当前结果位于步骤前，结果链接保持正确；完整任务目标可展开；处理数区分完成 4 与跳过 1。
4. 原生按钮 Enter 切换，Tab 顺序正确，键盘 focus-visible 有轮廓；目录与正文互相聚焦。
5. 产出首次读取失败重试，600 字分块读取到正文末尾，长连续英文标识可换行，下载地址包含正确节点和版本。
6. 切换步骤与无关详情版本刷新保持选择、分页和展开；刷新失败保留正文并允许重试。
7. 390px、暗色主题、长文本的任务详情与文档均无横向溢出。
8. 跨组同名步骤按 stepKey 区分；跳过、复用、控制原因、重试次数、等待原因保留。
9. 产物身份改变后旧正文重置；旧慢响应晚返回不混入新正文。
10. 删除选中步骤转至相邻步骤并给出提示和焦点；清空步骤聚焦执行步骤标题。
11. 空计划、步骤未确定与 definitionPending 不误报 100%。
12. 首次打开分别选择失败、受阻、未开始步骤；全部完成时选择末步；会话按钮传入所选步骤的 sessionId。
13. `pageerror=[]`、非 GET 写入请求 `[]`；没有执行历史请求。

## 截图与指标

| 场景 | 基线当前结果顶部 | 新版当前结果顶部 | 新版详情宽度 |
| --- | ---: | ---: | ---: |
| 1440 × 1100 | 2169px | 466px | 1200px |
| 390 × 844 | 2305px | 526px | 366px |

截图：`baseline/desktop.png`、`baseline/narrow.png` 与 `round-1/desktop.png`、`round-1/narrow.png`、`round-1/dark.png`、`round-1/long-output.png`、`round-1/narrow-selected-last.png`。相对根目录为 `docs/tmp/task-detail-redesign/`。

视觉检查：概览、结果、步骤目录和阅读区层次明确；暗色下正文和辅助说明可辨。窄屏目录内容高 360px（含边框测得 364px），正文自然滚动。未变更的全局顶部栏在语义替身按钮中存在刷新文字换行，不能据此证明真实 DSH primitive 的布局；本轮不扩展到全局顶部栏。

## 边界

使用真实 React 和完整 observer 源码，但全部任务数据为脚本内合成夹具，DSH primitive、槽位、会话 API 和运行时 HTTP 为隔离替身；未部署、未读取真实任务、未做钉钉业务 E2E。宿主真实样式和运行时集成仍需部署环境验证。正式完整执行前修正过测试选择器（stepKey 位于 li）以及等待 details onToggle 的脚本同步；这些属于验收脚本缺陷，未改产品规避。

## 定向回归首次运行

`node --test test/observer-client.test.js test/observer-node-control-display.test.js`：25/34通过，9项失败来自旧单测对全量时间线行的提取、原生会话button断言及模拟DOM接口。按新TaskStepDetail组件适配断言与mock，继续验证原状态/原因/输出绑定；未删除原业务断言。新增未读不挂载/已读保留测试。首次严格UI审计0发现。原始输出位于 docs/tmp/task-detail-redesign/unit-round-1.log。
