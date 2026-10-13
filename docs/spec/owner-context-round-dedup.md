# Owner 每轮上下文去重方案

## 目标

取消原生工具逐次独立回执通知，固定解释只放系统提示；续轮复用一份可见任务基础信息，保留完整有效需求、来源、授权和当前状态。

## 当前实现与取舍

post-execute 为每次工具结束追加 coordinator 消息；run 将旧快照缩为历史标记，再传完整快照。单条JSON长度不能代表整轮模型成本。

采用现有surface投影：goal/currentSources/acceptanceItems/workflowCatalog/capabilities/sharedMaterials/materialAccess存为单份可见ownerContextBase。新回合只传动态状态及基线身份；基线变化就替换，若压缩后不可见则从本轮Host完整输入重建。sameAs相对基线与当前输入合成的逻辑上下文。Host原始输入和必读校验保持不变。基线仍计入模型总输入，不能将转移字段算作token减少。

工具原结果内容末尾附引用；block保留feedback并附引用。SDK value替换分支必须保留原生输出schema校验及渲染，不强改成content，凭据仍从既有材料索引可查。固定规则由完整Owner系统提示承载，包括暂停评估。

## 验证

真实SDK模型请求验证成功、错误结果与凭据同在且无独立通知；基线复用、需求变更、压缩丢失恢复、跨会话隔离及sameAs完整性；当前有效上下文只保留一份。记录整体输入与新注入的长度分别比较，不宣称模型token收益。定向测试后按既有PR交付，不代做原UAT业务。
