# 第七轮：跨任务隔离与窄屏测量失败

2026-10-13。跨任务旧提示清理已加入产品和异步回归；Observer 定向测试38/38通过、0失败、0跳过，日志 `docs/tmp/task-detail-review/ui-unit-round-7.log`。

浏览器执行 `node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs round-7`：loading、overview通过，第三项 initial-visible 失败后停止，其余场景未运行。结果保留在 `docs/tmp/task-detail-redesign/round-7/browser-results.json`，源码 SHA256 为 `b6e0898858786273dd69502ccbcc3cf2aca571f591490149669cfded8480c85b`。

失败发生在切换视口后立即读取目录位置。脚本尚未等待 matchMedia change 回调与选中项滚动完成。下一轮为该断言增加可见条件等待，仍要求按钮完整落在目录内部，不放宽阈值、不增加产品延时、不修改产品源码。以相同产品摘要的下一轮实测区分产品问题与测试同步问题，本轮保持 FAIL。
