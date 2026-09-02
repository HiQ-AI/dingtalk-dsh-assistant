# Round 1

## 自动化结果

- `pnpm test`：151 项通过，0 失败。
- 关键审批用例连续运行 20 轮：`stress_rounds=20 result=PASS`。
- adapter 用例验证 `event +listen-im --kind all-direct --events message --format ndjson`，且 ready 前事件不交付。
- bridge 用例验证错误引用和红线模糊回复均不恢复；正确引用的明确批准只恢复一次。
- 普通人工处置的实时和历史轮询路径都断言 `decision=approved`。
- 个人 listener 异常退出后建立第二代订阅，健康状态恢复为 `ready`。
- `pnpm --dir packages/dingtalk-dsh-assistant pack` 生成发行包；归档清单包含 `dws-adapter.js` 和 `dws-bridge.js`，SHA-256 为 `070FF869C4DB470BEEE2108312C3776EC833C42FF0FF2FB875BA85BEDFE8F322`。提交后部署包会重新生成并再次记录不可变哈希。

## 尚待验证

- 本地安装重启后的双 listener 健康状态。
- 真实钉钉可控申请引用回复 E2E；该项需要一条实际等待中的申请，不能以模拟事件替代。
