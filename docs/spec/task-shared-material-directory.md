# 同任务共享材料目录

Owner已读文档在需求修订后被当前版本查询证据过滤，工程阶段只见摘要。复用既有逻辑Task work/tmp/outputs及work/artifacts，不移动原生会话cwd，不复制正文到节点，不新增存储或授权系统。

按需从本Task已保存工件重建work/materials-index.json：仅列查询材料、需求来源、文档及文件产物，不将内部执行账无差别作为材料。记录原artifactRef、相对位置、类别和来源版本；旧需求证据标history，仅供参考，不升级授权或验收证明。当前版本按调用者提供的需求版本识别，未知版本不推断current。已有历史材料自动可发现，新材料下次读取立即可见，不重启流程或新增generation。

Owner与工程共用readTaskMaterials入口。读取仍采用现有artifact哈希校验；限制在当前逻辑Task目录，拒绝跨Task及junction。索引仅导航，不替代来源事实。原生cwd保持不变，提示给出共享目录绝对位置。
