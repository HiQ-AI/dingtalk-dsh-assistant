# 第10轮：旧job读取账本反例及最终定向测试

四个相关测试文件124项通过、0失败、0跳过，见 round-10-native.log。增加旧账保留previousObservation、写效果拒绝、未来nativeJobRead=false拒绝、摘要/身份/无正常终态拒绝等反例。恢复只接受历史effectClass=unknown且无新标志的精确missing-job拒绝；不扩展任意错误、job_kill或新版本不受信同名工具。
