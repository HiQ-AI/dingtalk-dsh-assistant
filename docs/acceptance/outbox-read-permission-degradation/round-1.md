# Round 1 验证记录

## 根因

实际 DWS profile 登录和网络正常，但 `chat +chat-messages` 返回 `CLI_ORG_NOT_AUTHORIZED`。旧实现把群历史回读作为发送前硬前提，导致新格式 Outbox 在真正发送前一直 pending。

## 自动化证据

- 定向测试：`node --test test/dws-adapter.test.js test/dws-bridge.test.js test/store.test.js`，69/69 通过。
- 完整测试：`npm test`，275/275 通过。
- 覆盖权限降级成功发送、未知回执保留 pending、其他读取异常不降级，以及投递尝试字段的写入与成功清理。

## 本地运行态

- 第一版部署后，三条新格式 pending Outbox 已进入实际投递：两条最新任务完成通知记录 `dws_reply_failed:1`，确认消息记录 `dws_recall_failed:1`，证明不再停在发送前回读。
- 使用相同 profile 和稳定 UUID 直接执行 DWS 引用回复，服务端返回 `CLI_ORG_NOT_AUTHORIZED (operation: chat/send_personal_message)`，明确说明该组织尚未开启 CLI 数据访问权限。
- `dws doctor` 为登录、凭据后端和网络三项通过；DWS 版本仅有更新提醒，不是本次服务端授权拒绝的根因。
- 因发送接口也被组织权限拒绝，两条完成通知仍为 pending。权限恢复后，10 秒重试器会沿用相同 Outbox 幂等键自动补发。
- 最终本地包 SHA-256 为 `D469D408FBC61762D73B30A66536B954FFAEA51E99ECC90E3124288E150A6E37`。重启后同一 Node 进程监听 3080/18998；两条完成通知均明确记录 `dws_reply_failed:1:CLI_ORG_NOT_AUTHORIZED`，没有被错误标记为 sent。
