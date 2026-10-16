# 撤回新增蓝色覆盖

对账时PR198已经标准合并，main为b80e5be8f1637c882c1a18e9381aa73d1144bae5；用户随后明确“算了不改蓝色了”。本独立修正分支fix/restore-native-running-colors恢复PR196原配色，仅删除PR197列表和PR198顶部/卡片新增颜色覆盖。不是整PR回退。

statusTone/statusTag与卡片active原生图标代码逐段和PR196 c2b29151b417ca791ee8d15a3ad5b005ada8a6c0核对完全一致。原有品牌色仍保留；不强制改灰。原生StateDot动画/尺寸不变，不动其他状态、无关加载器、业务数据或执行行为。PR197标题、冗余文案删除、成功快照刷新时间及tooltip分层均保留。

99项定向测试通过，0失败/跳过。隔离Chromium使用真实原生StateDot源/CSS验证三入口恢复host tertiary语义（夹具定义#8b8d94），标签恢复原始brand #4d6bfe，圆环仍为dsh-state-dot-spin，尺寸不变。同步验证标题、时间和失败保持旧记录等未丢失。实际宿主token取宿主主题值，不以夹具颜色硬编码运行时。

百部尚未部署PR197/198，无需现场回滚；父拿最终main一次部署。当前CI仅workflow_dispatch，无自动PR CI。
