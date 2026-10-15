# 第8轮：清理阶段发现job读取误记未知

原job_output查询已释放的pwsh-7，在seq599返回Error: unknown job pwsh-7；插件遗漏固定原生job读取身份，误记operation-9585dd4be15889115b7dd8b22c6d522371315cbf unknown。只读调查结束仍无法对账，原任务申请技术介入。未重放查询或全仓测试。

本轮最终交付门禁FAIL。修复及测试见第9/10轮，部署及实际对账见第11轮。
