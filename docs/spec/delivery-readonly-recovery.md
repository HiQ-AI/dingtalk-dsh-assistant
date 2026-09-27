# 外部效果未知结果的原生恢复

## 当前问题
UAT 原子快进已成功，但紧随其后的 GitHub PR 查询仍返回旧元数据，效果账正确记为 unknown。定时任务恢复只接纳暂态错误，排除 DELIVERY_RECONCILIATION_REQUIRED，因此迟到的远端事实无法自动收敛。构建进行中的未知结果有同类问题。

## 最小修复
复用运行时已有 delivery.reconcile；仅对单个已排空、等待 DELIVERY_RECONCILIATION_REQUIRED 的节点，读取并对账属于该节点、同代同输入的已存在 unknown operation。调用 reconcile 永不调用 execute，不创建效果、不重发远端写。所有运行效果均为 succeeded 后，经原生 controller.recover 恢复原节点，复用已成功回执；failed、prepared、starting/executing 或未知仍保持等待。

维护、暂停、停止、新输入、任务控制状态及节点身份在对账前后复核。对账期间进入维护仍允许保存已获得事实，但不恢复派发；维护门禁本身不变。历史无对应效果不凭等待原因自动恢复。

## 验证
用独立临时控制账、真实 Delivery/Controller/service 恢复入口验证：远端未知后成功只执行一次，持续未知和明确失败不恢复，维护/暂停/停止/新输入不恢复，原节点身份与代际不变；既有暂态三次退避测试仍通过。不连接运行控制账、不发真实远端写。
