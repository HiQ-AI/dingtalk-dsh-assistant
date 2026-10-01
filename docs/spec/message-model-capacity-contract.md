# 模型容量与消息调用合同

## 真实反证及根因

第24轮完整工作簿进入R，生产三次失败包含两次MESSAGE_MODEL_INCOMPLETE和一次MESSAGE_NODE_TIMEOUT。仅凭原错误不能推断提供方容量不足。

隔离探针复用正式安装模块、完整原节点inputHash、正式settings与同一模型。相同输入约980KB；1800输出额度下，原生返回完整JSON，但pi-ai适配器将正常stop依据本地fallback catalog的272000容量二次改判为CONTEXT_WINDOW_EXCEEDED。该轮input及cacheRead合计290031，output534；不是服务端明确拒绝，也不是本地7200字节阈值触发。provider允许的contextWindowOverrides配置范围最高872000，这不等同实测服务端全容量。

隔离设置原生override=872000后，同inputHash、同模型和1800输出自然stop，schema及来源校验通过；一次耗时64.332秒，说明60秒Host窗口也会误中止正常请求。原始模型输出及配置仅留本机docs/tmp，不公开。

已排除或限定的候选：

- 固定输出额度耗尽：本次完整JSON、stop及输出字节未触阈值为反证，暂不改该额度。
- 服务端拒绝完整材料：本次原生stop被本地usage/catalog规则转换为error，不能如此归因。
- 本地容量目录与实际已接受请求不一致：同输入原生override后通过，已复现。
- 调用窗口过短：正常64.332秒返回会超过现60秒，独立成立。

## 本轮统一方案

1. 不换模型、不裁剪材料、不修改工作簿格式。使用provider原生settings单字段CAS覆盖本模型contextWindow；先独立备份根settings并记录原字段，再核验唯一变化与有效读取。该设置作用于共享DSH_HOME的同provider模型，不改变模型ID、凭据或其他模型。
2. 消息Host采用单一180秒调用窗口，节点lease继续由同一窗口加提交余量冻结；排队不计入。保留调用次数及真实暂态失败保护，超时仍中止。
3. 记录真实finish分类、明确失败code与usage到内部节点诊断；不将所有异常折成不完整输出，不吞error。确定性容量错误不通过重复同输入调用制造恢复。
4. 完整R及含实际材料的IB隔离验证通过后再部署；不能用小IB旧夹具替代未来完整信封。部署后继续原四条业务消息，核验Task、答复、阶段条件和独立通知回读。

## 运维边界

现有部署备份只覆盖profile设置，未覆盖D:/dsh_home/settings.yaml，须增加本次根settings备份及SHA证据。恢复配置通过原生namespace revision CAS操作目标字段，不能整份覆盖其他并发设置。真实容量超出或提供方错误仍拒绝执行，不能因为JSON可解析而吞掉错误。
