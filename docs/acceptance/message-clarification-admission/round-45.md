# Round 45：受管 rebind 后旧失败取证承认已消费父历史

1edb 当前真实绑定 session execution-f3950ac25fdf73bec1288597a5a47b7915149fb8、lease4。原生 rebind seq92 从父07ec1d2c派生，迁移lease3；父输入seq10/85分别lease1/2，当前输入seq98 lease4；end153为TRANSPORT/fetch failed。

修复前只读helper返回null：全历史coordinator input必须同当前session的检查误拒绝可信父历史。修复复用validateHistory已核验的单一rebind身份，只允许rebind前、精确parentSessionId、lease早于迁移lease的输入及inbox。当前输入必须仍为当前session/当前lease，最后end、无提交、额外输入检查不变；不迁移会话，不写历史。

## 证据

只读脚本 docs/tmp/inspect-current-legacy-failures.mjs 用实际DB binding+原生session事件调用helper，agents/sessions为空stub。修改前1edb proof=null，修改后返回EXECUTION_PROVIDER_TRANSIENT，inputSeq98/endSeq153。真实内容仅在private临时文件引用，未提交session正文。

```powershell
node --test --test-name-pattern='旧provider|历史.*路径|历史中断证据' test/execution-session-native.test.js
```

10/10 PASS。新增7例精确父历史成功、外来session拒绝、rebind后父输入拒绝、父新lease拒绝、rebind后父inbox拒绝、当前提交拒绝、当前lease不符拒绝。现有provider原生身份及中断取证仍通过。

## 83独立结论与盲点

83 gen4/session97c9d965 的helper离线已返回ENGINEERING_READ_PATH_INVALID(input10/end82)，无需对此扩大历史规则。控制账只有inspect-and-propose等待且所有节点drained、output为空；输入摘要和workflowDigest/nodeId匹配；既有effects仅prepare-workspace成功，目标节点无effect；冻结节点只读。尚未核实Runtime的agents/sessions attached状态，离线成功不代表正式扫描已接纳。未调用可能附着会话的原生观察接口，也未修改其业务状态。

本轮仅helper及native测试改动，未部署或写现场；现场恢复需正式扫描另行回读。
