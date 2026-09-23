# M1 输入批次容量修订与交付验证

日期：2026-09-23，环境及边界沿用 round-1。

## 反例与修订

单条合法 input.accept 可以积累很多长 inputId，之前 Controller 全部合成一个 input.apply，可能超过 256 KiB RPC 上限，留下无法推进的屏障。现在每批最多 16 条，inputId JSON 编码字节最多 128 KiB，为其余固定节点引用留出余量；使用已有有序前缀事务，不增加另一套协议。

回归实际接纳 65 个长度超过 4080 的 ID，其中重复 NUL 字符经过 JSON 转义扩大字节数；旧节点 held 期间全部接纳，释放后处理所有批次。断言 pending=0、succeeded、最终结果132，执行输入记录严格为 `[0,65]`，中间输入没有进入执行器。

## 交付验证

- 最终 `pnpm test`：**691/691 PASS，0 fail，0 skipped，33.5 秒**；新增 execution 用例 59 项（Controller 13、Store 14、效果16、原生Session 12、原生组合4）。
- `git diff --check` 通过；重新打包并独立 tar 读回7个execution模块，包 SHA256：`EEDDA3459538D6ED58D0CA51216A53BAB38E37FC00B1FBDE24D1794A1C6F7631`。
- 最终统计以本轮和 matrix.csv 为准，前轮结果不覆盖。仍未生产部署、未接入真实消息渠道/业务效果，未证明真实耗时与 token 改善。
