# 首轮原生选择适配

使用原生组件代替浏览器 select，并让三个草稿目录使用同一个原生全提供方 catalog。首轮 `node --test test/client.test.js test/web-client-build.test.js test/task-model-config.test.js` 输出 15 passed、1 failed、0 skipped：官方模块加载测试仍断言旧 inject=['slots']，实际新增 locale 与 remote.session，已调整契约断言并进入第二轮。没有跳过失败断言。

另修正适配问题：保存层的空深度字符串应在原生目录快照中呈现为 undefined，以显示模型默认等级；独立选项未加载时不提前显示“不支持深度”的错误。首轮不作为最终交付证据。
