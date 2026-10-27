# 第三轮正式部署验收：未通过

已从 main ebfc45a0 安装双包，安装校验、新PID96492、双端口、health=ok、recoveryIssueCount=0均通过。但实际认证 DSH 设置页打开“内置插件→钉钉个人助理”时组件崩溃，浏览器输出 `cannot get property "remote" without inject`，不能认为模型UI验收通过。

根因：声明了 remote.session 而未声明 ctx.remote 父级服务。普通对象 fixture不实施 Cordis sibling 服务注入隔离，先前隔离浏览器及仅模块导入验证未覆盖。采用真实 Cordis 的 sibling provider 注册可独立复现；补齐 remote 后目录可读。进入第四轮修复及正式重部署，不将后端健康冒充UI通过，不热改安装文件。
