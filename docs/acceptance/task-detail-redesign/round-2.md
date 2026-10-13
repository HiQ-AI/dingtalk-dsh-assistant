# 第二轮浏览器验收

2026-10-13，继续使用独立 headless Edge 155.0.4283.45、React 18.3.1 和同一合成夹具。

```powershell
node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs round-2
```

源码 SHA256：`40c553761ca2146d406081e6d7e7c04f66ede1f2c6ee4f07043202e9cbe4faeb`，独立 `Get-FileHash` 与 JSON 中源码哈希一致。

完整结果位于 `docs/tmp/task-detail-redesign/round-2/browser-results.json`。原有 13 组和新增 30 步长目录检查共 14 组自动断言通过；对新增的初始可见性指标独立复核发现 FAIL，因此本轮整体未全绿，不能仅用脚本 `passed:true` 声称完成。

## PASS 证据

- 第一轮列出的 13 组在相同源码上再次通过；逐 case 状态见 `matrix.csv`。
- 30 步仍完整显示为 3 组，默认选择第 30 个受阻步骤。
- 390px 下目录高度 364px（内容 360px 加边框），`scrollHeight > clientHeight`，详情无横向溢出。
- 查看所选步骤后阅读标题位于 sticky 顶栏下方；返回步骤目录后第 30 步获得焦点，按钮完整处于目录可视区且未被顶栏遮挡。
- 截图 `docs/tmp/task-detail-redesign/round-2/narrow-30-steps.png` 展示第 27—30 步与选中末步、阅读面板。
- `pageerror=[]`、写入请求 `[]`；会话调用参数为 `session-current-step`。

## FAIL：初始选中项未进入窄屏目录可视区

切换为 390 × 844 后，在未操作任何步骤前读取初始第 6 步与目录边界：

| 指标 | 浏览器测量 |
| --- | ---: |
| 目录 top / bottom | 831.5625 / 1195.5625 |
| 选中第 6 步 top / bottom | 1277.890625 / 1346.28125 |
| selectedVisibleInsideDirectory | false |

因此即使页面滚到目录，初始选中的当前等待步骤仍位于目录内部可视区以下。建议首次选择和删除回退时只滚动目录容器使选中按钮可见，避免滚动整个页面或打断后续阅读。

该指标已由脚本写入 `metrics[label=initial-selection-narrow]`，当轮尚未转为强制断言，故整体状态以矩阵 FAIL 为准。下一轮应增加断言并验证修复、普通刷新不抢目录/正文位置。证据截图为 `initial-selection-narrow.png`；边界与第一轮一致，仍未验证真实 DSH 宿主或钉钉业务链路。
