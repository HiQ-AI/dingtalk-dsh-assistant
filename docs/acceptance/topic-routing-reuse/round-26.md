# 轮次26：唤醒通过，原生投影回归失败

dynamic-task-store与原生job恢复测试83/83 PASS，0 skip。连续三个普通工具操作产生0个operation唤醒，阶段和执行终态各一次；统筹总计3轮（初始、阶段、结束）。unknown、cancelled、对账、排空、过期绑定、重启恢复仍唤醒，原job与操作身份及真实效果未改变。

六文件上下文原生套件95项中90 PASS、5 FAIL，证据context-native-tests.log。原因是source.body未投影，以及终态执行缺input/resultRef，导致模型夹具无法取回目标和结果。不是Host运行成功。修复恢复这三个必要字段，并将stale纳入执行终态裁剪；不通过放宽断言掩盖回归。
