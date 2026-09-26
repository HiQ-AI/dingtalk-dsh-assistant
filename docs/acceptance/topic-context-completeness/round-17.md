# Round 17：工程修改方案产出

## 根因

真实 inspect-and-propose v2 节点输出为 changes=[]、replacements=[一处局部替换]。接口漏映射 replacements，导致已存在的修改方案显示未记录文字产出。工件是持久 JSON 修改方案，没有单独的 Markdown 方案文件。

## 修复与验证

- 明确展示 replacements 的目标文件与修改前后内容，changes 展示完整修改内容或删除；哈希及工具参数不传输，仍按现有接口分页。
- 定向服务用例 3 PASS：产出隔离、真实引用及仅含替换的长方案跨页重组；Observer 10 PASS。
- 不改变工作流、不补造方案文件、不重跑业务节点。
- 已部署实现提交 d338e95 的两个插件；83 个 JS/YML 与源码一致，profile patch 未变。备份 node-outputs-d338e95 包含395文件、477004437字节，稳定存储校验 ok、invalidRecords=0、strippedFields=0。
- 新 PID 54456，health=ok、恢复问题0、入站开启。当前37个工件逐页在线回读与源码投影完全一致，含20类节点；见 round-17/live-audit.json。
- Assistant 包 SHA256：2B51332873AA99F4D717140EB8558C491789419163C7BC401E032C1BF1B41E04；Observer：BF7BD56037A31B4AA340BFC0156D4FC0F35FB28002EE75F123DF21B7869C630E。

## 追加：文件数量与全部当前节点核对

用户连续补充要求后，覆盖当前 73 个任务内 37 个已存工件、20 类节点。逐个核验内容哈希及投影非空，结果见 round-17/projection-audit.json；可选发布/数据流程没有当前样本，未宣称线上覆盖。

- 默认展示文件去重数量，折叠目录/文件/方案长文；展开才挂载内容。索引中 826 个文件无需默认铺开，统计不会受 1200 字分页影响。
- 修正应用修改误标为读取，补充提交、推送、PR 草稿及回执；准备与执行、创建与合并保持区别，未知回执不得显示成功。
- observer/http/service 组合测试 108 PASS。浏览器 40 项 PASS，27 次隔离请求，0 写入/页面错误；200 个文件的默认折叠、键盘展开、分页与折叠卸载通过。首次收起后立即断言遇到原生 toggle 异步事件，改为等待卸载后完整重跑通过。
- 桌面及 390px 截图已查看；strict 审计 0 findings。PNG 留本机，使用同目录 scripts/verify-observer-browser.mjs 可再生成。
- 当前项目无 build script；以上实跑测试与浏览器执行作为功能验证。

认证 Web 200。启动日志晚于API健康输出，首次认证读取遇空日志；等待地址实际写入后回读通过，未绕过鉴权。
