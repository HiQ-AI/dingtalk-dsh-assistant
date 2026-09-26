# 第十二轮：任务详情视觉重设计

## 改动

- 顶部中文状态、24px 标题、更新时间、真实步骤完成数与分段进度。
- 左侧阶段与编号时间线，保留 01/02 等顺序号；当前、等待、失败与完成分层显示。
- 右侧突出待处理原因、最新产出和任务目标；窄屏单栏。隐藏技术编号，不增加诊断接口请求。
- 历史执行展开时才加载，保留分页、重试和已绑定会话入口。

## 本轮证据

- `node --test test/observer-client.test.js`：10 PASS，0 FAIL。
- 浏览器脚本：24 项检查通过，17 次只读请求、0 写入、0 页面错误；实际核对 4 个步骤编号与宽窄屏截图。
- `node scripts/build-web-client.mjs` 已执行；Observer 为直接加载 JS，`node --check` 通过。
- Premium strict 静态审计 0 findings。截图为完整 observer 与真实 React 的隔离夹具，宿主 primitives 为语义替身，不代表真实钉钉业务结果。
- C21 任务详情阅读层次与编号保留：PASS；C22 历史按需加载与窄屏：PASS。用户对最终视觉效果尚未反馈，不声称用户验收通过。

## 重现

运行 `scripts/verify-observer-browser.mjs <playwright模块目录> docs/acceptance/topic-context-completeness/round-12`。截图本地生成，不入库。
