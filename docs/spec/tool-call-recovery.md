# 工具调用恢复方案

## 目标

Resident 的 Topic/Task 工具在参数不合法、请求被替换、消息版本变化、进程重启或提交结果投影失败时，必须返回可判断、可恢复且不会诱发重复副作用的结果。

## 现状与根因

- 路由请求保存在内存 `routes`，持久化回执 `routeHistory` 却在内存校验之后才读取；重启和新请求替换旧请求都会误报 `topic_route_request_unknown`。
- 回复请求保存在内存 `replies`；Outbox 已按任务结果幂等，但提交请求没有稳定的 Outbox 标识，无法在重启后确认是否已经受理。
- `topic_message_version_stale` 属于可预期并发冲突，却以异常形式暴露，模型无法获得当前请求。
- Zod 联合类型错误直接穿透，产生冗长 `invalid_union`；工具输出只依赖一次 JSON 往返清理，没有明确报告不可表示值。

## 实施设计

1. 工具边界统一把 Zod 参数错误投影为 `invalid-arguments`，仅保留字段路径和原因；其他异常保持失败语义。
2. 路由提交先查当前群的持久化 `routeHistory`。相同 `requestId` 已提交时返回原回执；旧请求已被替换时返回当前请求；消息版本变化时刷新请求并返回 `stale`。
3. Task 回复以 `reply-<requestId>` 作为 Outbox 稳定标识。内存请求消失后，若 Outbox 已存在则返回已受理回执；否则返回 `request-unavailable`，禁止盲目重放。
4. JSON 输出规范化显式拒绝根级 `undefined` 和不可序列化值，并在副作用提交成功后只返回稳定的小型回执。
5. Task 结果按 `status` 和 `waitingKind` 选择对应 schema，避免联合类型的全分支错误噪声。

## 风险边界

- 无持久化回执的未知请求不会自动执行，避免重复发消息或错误归类。
- 回执查询只在当前群数据中完成，不泄露其他群请求是否存在。
- 旧版 Outbox 没有请求 ID 派生标识，无法反推历史随机 requestId；只对升级后的提交提供重启恢复。
