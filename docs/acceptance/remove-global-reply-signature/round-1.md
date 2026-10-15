# 第一轮

格式器、设置 bundle 和配置 HTTP 初轮通过。首次未设置原生 profile 时有两项跳过，不计完成验收。

接入 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json` 后，新增断言误读 `request.system` 导致失败；实际协议是 `request.messages` 中的 system 消息。修正后完成/状态通过。

提问旧 fixture 未指定 audience，当前默认 operator，未产生群通知，断言失败。fixture 补入明确 requester，仅修正测试目标，不修改生产路由。第二轮重跑记录最终状态。
