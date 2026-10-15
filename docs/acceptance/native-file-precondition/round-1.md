# Round 1

初次运行67项：62 PASS/5 FAIL。新文件反例把undefined传入带默认值fixture，错误地重新构造FS_NOT_OBSERVED；原生结果错误码位于error.info而非error.code，首次文件纠错仍unknown。修正夹具及原生错误解包。

另两个旧unknown测试与当前main已废除全局门禁的合同不符；还原HEAD版本service后相同失败。未恢复旧全局门禁，改为断言独立终端调查可执行、同一operation身份不可二次派发。初轮输出未保存文件，不补造日志。
