# 第 6 轮：统筹收尾时的部署检查

共享控制台检查已通过，后续账本检查拒绝切换。当时执行已提交结果，但统筹仍在收尾，不能将 execution_submit 回执当作整个实例排空。

随后独立账本只读核验返回 quiescent=true、drained=true、verifiedSessions=40、unknownOperations=0、unknownNotifications=1；原任务 API 回读 completed、原执行 succeeded，双方 drained=true。本轮仍无停止信号和安装动作。最后一次完整检查与部署使用第 7 轮独立目录，不复用失败证据。
