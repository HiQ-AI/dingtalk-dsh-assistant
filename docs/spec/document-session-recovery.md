# 文档类型与会话恢复补充分析

## 现场证据

首版部署后，原Task已重评为pending，但同群四条routing_pending令Task领取返回MESSAGE_INPUT_PENDING。监听认证ready，主群回补失败GROUP_COORDINATOR_SESSION_ALREADY_LIVE。协调持久账仍idle/lease59；原会话在本进程启动后只有session/end-seed，无新的协调领取。宿主Web订阅存在自动恢复冷会话的代码路径；未将此相关性写成已经取得内存创建者证明。

通过与Runtime相同的Windows Principal执行原生只读DWS诊断，drive inspect证实目标为FILE/html，doc fetch明确拒绝非adoc；drive download取得57222字节，UTF-8核验有40个标题、5个表格及UPR等规则关键词。诊断任务完成后已独立确认删除，无凭据变更。

## 取舍

1. 直接dispose已注册Agent：排除。SDK裸Agent没有dispose capability；释放权限只属于创建者持有的AgentHandle。
2. 启动时抢先恢复所有群会话：排除。不能证明始终早于Web重连，仍存在竞争，也扩大初始化范围。
3. 已证实空闲观察会话派生受管子会话：采用已有工作区迁移的原生seed/inheritedEventCount/parentSession及账本CAS。公开runMaintenance锁内核验身份、群、cwd、当前lease、无pending inbox、已结束turn及无新增用户输入，保留外部会话，禁止私有字段或注册表修改。活跃或不明会话仍拒绝。

此恢复仅转换群协调会话的受管绑定；不创建Task、不伪造交办、不绕过消息门禁，来源与版本照常由Host核验。

## 文档读取修订

alidocs节点先以drive inspect的真实类型分支。adoc使用doc fetch全文；明确FILE及允许文本扩展使用drive download。严格接受现场统一DWS成功信封，核验fileId/nodeId/complete/savedPath/sizeBytes、临时目录边界及UTF-8。HTML只作为完整文本读取，不执行脚本，也不抓登录页。

正文及稳定元数据由Task现有查询证据保存，两次回读比较内容和修改信息；临时诊断正文不提交Git，不代替原Task工具证据。
