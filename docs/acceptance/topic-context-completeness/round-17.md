# Round 17：工程修改方案产出

## 根因

真实 inspect-and-propose v2 节点输出为 changes=[]、replacements=[一处局部替换]。接口漏映射 replacements，导致已存在的修改方案显示未记录文字产出。工件是持久 JSON 修改方案，没有单独的 Markdown 方案文件。

## 修复与验证

- 明确展示 replacements 的目标文件与修改前后内容，changes 展示完整修改内容或删除；哈希及工具参数不传输，仍按现有接口分页。
- 定向服务用例 3 PASS：产出隔离、真实引用及仅含替换的长方案跨页重组；Observer 10 PASS。
- 不改变工作流、不补造方案文件、不重跑业务节点。
- 本地部署回读待完成。
