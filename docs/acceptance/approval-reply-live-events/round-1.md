# Round 1

## 自动化结果

- `pnpm test`：151 项通过，0 失败。
- 关键审批用例连续运行 20 轮：`stress_rounds=20 result=PASS`。
- adapter 用例验证 `event +listen-im --kind all-direct --events message --format ndjson`，且 ready 前事件不交付。
- bridge 用例验证错误引用和红线模糊回复均不恢复；正确引用的明确批准只恢复一次。
- 普通人工处置的实时和历史轮询路径都断言 `decision=approved`。
- 个人 listener 异常退出后建立第二代订阅，健康状态恢复为 `ready`。
- `pnpm --dir packages/dingtalk-dsh-assistant pack` 生成发行包；归档清单包含 `dws-adapter.js` 和 `dws-bridge.js`，SHA-256 为 `070FF869C4DB470BEEE2108312C3776EC833C42FF0FF2FB875BA85BEDFE8F322`。提交后部署包会重新生成并再次记录不可变哈希。
- 提交 `92859f159673b308003165013da14ad6d9498622` 的部署包 SHA-256 仍为 `070FF869C4DB470BEEE2108312C3776EC833C42FF0FF2FB875BA85BEDFE8F322`；安装目录中 `dws-adapter.js`、`dws-bridge.js` 与源码哈希分别一致。
- 本地重启后只有一个 DSH Web 主进程（PID 11676），同时监听 `127.0.0.1:3080` 和 `127.0.0.1:18998`；Web HTTP 200，Runtime `status=ok`、`recoveryIssueCount=0`。
- `/state/dws-bridge` 回读 `healthy=true`，群 listener 与 `humanReplies` 均为 `ready`，代次均为 1，重连次数均为 0。

## 尚待验证

- 真实钉钉可控申请引用回复 E2E；该项需要一条实际等待中的申请，不能以模拟事件替代。
