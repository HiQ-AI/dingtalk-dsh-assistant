# 第 2 轮：集成与失败定位

| 检查 | 证据 | 实际结果 |
| --- | --- | --- |
| 单元、账本、通知集成 | round-2/unit-tests.log | 306 PASS，0 FAIL，0 SKIP |
| 原生协调及通知 | round-2/native-tests.log | 41 PASS、1 FAIL；outbox 投影 status 为 sent，通知状态为 delivered，夹具混淆两个字段 |
| 过期通知诊断 | round-2/expired-diagnostic.log | 确认上述两个状态字段合同；修正后保留双字段断言 |
| 发布冒烟 | round-2/release-smoke.log | 11 PASS、1 FAIL、2 CANCELLED；映射未更新及两个打包用例超时 |
| 打包重跑 | round-2/package-directed.log、package-directed-2.log | 打包期间其他修复仍在编辑源码，正确触发源码与包字节不一致断言 |
| 源码冻结后打包终验 | round-2/package-directed-final.log | 2 PASS、0 SKIP，单项 14.36s / 15.79s，未放宽 30s timeout |

测试映射已按实际 import 闭包更新：299 文件各注册一次、296 release、3 history；公平恢复测试使用 native Host 后移入 native 分组，其他变化仅为按既有算法平衡原生分组。

首次并行打包超时没有足够阶段证据确定根因，不以“资源竞争”替代已证实结论。冻结源码后的专门验证通过；最终仍需完整发布冒烟复跑。失败记录不删除，最新通过记录见第 3 轮。
