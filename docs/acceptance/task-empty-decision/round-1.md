# 首轮记录

- resident profile 缺少测试组合所需模块，11 项环境失败。改用锁定 workspace 内的 test/fixtures/native-profile/package.json，不修改实际 resident profile，不跳过原生测试。
- 旧故障夹具的计数会被话题标题迁移请求消费；首次新增的两项空返回测试没有打中统筹模型，断言 providerRecovery 不存在而失败。修正本文件故障夹具对标题请求的独立应答后重跑，不放宽业务断言。
- 首轮统筹服务测试 39 项中 38 项通过，1 项容量用例 tasks=1/executions=1 超过原有 15 秒限制被取消。后续单独重跑，不修改超时时间。
- 这些结果不声明全绿，后续证据见 round-2.md。
