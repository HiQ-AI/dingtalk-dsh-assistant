# 第二轮：补实际浏览器请求与完整图片绑定

19 个行为用例通过，见 [results.json](round-2/results.json)。新增验证真实 current 请求头复用、不依赖 Cookie 兜底；实际 Edge 访问本机动态端口服务：精确只读 POST `/api/query` 成功，`/api/save` 在到达服务前被中止，服务接收列表只有查询一次。

补强多图复核的最终调用必须重新提供全部图片，避免分批复核后复用已变化文件。实际 view_image 读取本轮两个 PNG 后调用 finalizer，错误图保持 FAIL、干净图转为 PASS；记录 [reviewed-results.json](round-2/browser-fixtures/reviewed-results.json)。只记录实际观察，未隐藏错误提示或伪造页面。

独立审查随后找出两个本轮仍有的反例：认证 request/json 原异常可逃出；无原自动断言时视觉断言可能冒充自动检查而 PASS。两者在第三轮修复并补测试；本轮通过不能覆盖这两个遗漏场景。
