# 第一轮：发布预检失败

基于main d3716c5准备三个2.0.1版本。依赖安装、Spring夹具、前端构建和三包manifest核对通过。Node24.19.0、真实Node22/JDK11、隔离profile及短物理TEMP下pnpm test：3219项，3191通过、21失败、2取消、5既有跳过，耗时2516.6秒。不得计作发布通过。

失败归类：contextPath字段未读的旧脚本模型；Windows创建file symlink时EPERM；两代工程真实流程240秒超时。单独人工回复仍失败，排除仅全量并发偶发。原日志docs/tmp/release-2.0.1-tests.log、release-2.0.1-human-recheck.log保留。
