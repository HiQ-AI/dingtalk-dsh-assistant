# 第一轮：提取正常路径并验证基本失败场景

已更新现有两个 skill，提取 `HiqUatSession` 与 `PageAcceptance`，没有新增 skill。17 个行为用例通过，见 [results.json](round-1/results.json) 和 [matrix.csv](matrix.csv)。认证用内存替身；页面用禁止所有网络请求的专用 Edge，未读取任何真实凭据。

登录测试覆盖业务成功但无响应 Authorization、业务步骤失败后的清理、身份未知/不匹配、注销仅返回 200 但未失效、未知原登录不重试及重复 finish 不重放。页面覆盖只读账号权限、精确只读 POST、断言 expected/actual、截图待实际读图、图片被替换、错误图与 PASS 冲突等。

实际 [error.png](round-1/browser-fixtures/error.png) 显示红色 Network Error，[clean.png](round-1/browser-fixtures/clean.png) 无错误。自动结果分别 FAIL 和 PENDING_VISUAL_REVIEW，正确阻止将自动完成当成截图交付完成。执行者实际用 view_image 看两张图；本轮不作为后续修改后的最终候选证据。

结构检查第一次因 Python 默认 GBK 读取中文失败，改为 `python -X utf8 -B .../quick_validate.py` 后两个 skill 均 valid；没有修改系统 validator。
