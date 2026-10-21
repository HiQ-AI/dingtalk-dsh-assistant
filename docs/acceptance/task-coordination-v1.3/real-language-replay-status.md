# 真实语言回放最终状态

用户批准百部隔离验证与任务消息交接；下述成功结果来自父任务转交摘要，原 JSON 未导入云端。没有新增云端真实模型调用，也未重试被拒 Library 下载或云端登录。

| 阶段 | stream 尝试 | 完成 | 语义通过 | 耗时 |
|---|---:|---:|---:|---:|
| 原候选传输失败 | 1 | 0 | 0 | 未提供 |
| 原候选冒烟 | 4 | 4 | 3 | 未提供 |
| 修后冒烟 | 4 | 4 | 4 | 42,142ms |
| 修后完整 | 16 | 16 | 16 | 149,293ms |

百部总25次尝试、24次完成；修后20次全部通过，totalTokens 合计194,842。费用、provider内部重试与底层网络调用数未知（不是0）。早先云端1次账号不可用 stream 入口尝试另列历史，不混入百部25次计数。

路由始终为临时 `openai-codex/gpt-5.6-sol`，使用百部既有官方 runtime/账号及已配置代理，只固定合成16样例，无真实群数据、业务写入或渠道外发，不改长期模型配置。原候选因显式+08时区未规范为UTC导致精确断言失败；修复入口规范化后重跑，不放宽断言。

任务消息报告的原件SHA256（云端未取得原件，未重新计算）：

- 冒烟：`f04802eb935292c9017a7e8a9bf3e2df925396b2b613fe16f59cd74244aaf831`
- 完整：`4575f63aceb7b5377a9d2b36ba23f5a57231111a0bfa161560f7026fad486fad`

百部程序回归21通过；扩展43通过11跳过。云端使用完整测试profile补跑相关回归34通过，另风险回归67通过，均无跳过。代码tree与百部实测精确一致，见 [导入与审查记录](./repair-707766a.md)。真实钉钉送达、生产迁移和部署未验证，不称上线验收通过。

## 历史云端阻断记录（已改验证环境，不再重试）

# 已授权真实路由回放：当前阻断

用户选定临时 `openai-codex / gpt-5.6-sol`，先4项冒烟通过再完整16项，仅固定合成数据；未授权新登录、凭据转移或持续访问。

## 已完成

- 从 npm 官方 registry 恢复 profile 已声明的固定依赖，使用既有 pnpm 11.25.0、ignore-scripts；所有安装位于独立 workspace 目录，未改原 profile。
- `dsh-codex-connect@0.1.0-alpha.4.30`（Apache-2.0）、`dsh-base@0.2.1-alpha.2`（MIT）下载来源、版本和完整性已核对。
- 原 profile 的 API 版本与连接器 peer API 不兼容，导入时报缺少 `offloadRequestImagesWithPolicy`。未升级连接器或原 profile；按其已声明 peer 版本另建 LLM-only runtime（DSH API0.1.2-rc.1、pi-ai0.84.2），strict-peer 检查与官方 doctor 均通过。
- 实际 runtime 仅加载 llm 和真实 Codex Connect；代理、搜索、图片、自动审查关闭，没有 resident、钉钉渠道、业务工具或 TaskStore。
- 真实 provider 已注册，指定模型配置解析通过，首个合成样例进入标准 stream；没有用脚本模型或其他 Agent 代答。

## 精确结果

首项 `six`：1次 plan、1次标准 stream 尝试、22ms，终态 error。真实连接器返回：

> OpenAI Codex request account is unavailable. Please select an account or sign in again.

标准LLM失败码为 `UNKNOWN`；完整原始失败、输入及空模型输出均已保存。该错误是模型路由鉴权前置缺失，不能算作语言理解失败或样例通过。
官方 doctor 的 secret-free 元数据报告 `credentialFile.state=missing`。未直接读取 OAuth 内容，未进行登录、刷新、复制凭据或新建持续访问。

其余3个冒烟项未执行，完整16项因冒烟前置未满足而未执行。成功模型结果0；提供方网络调用计数未知，未返回 token/usage，成本未知（null），不写0。

## 当前唯一阻断与继续条件

依赖和版本问题已经修复，剩余是该云端没有可用的既有 Codex Connect 账号。需要一个已授权且实际可用的同路由 LLM-only runtime/既有账号；当前禁止新增登录，因此不能在本轮自行修复该项。不要把其他机器的凭据搬入本环境。

隔离安装和锁文件保留在 `/workspace/coordination-replay-runtime` 与 `/workspace/coordination-llm-only-runtime`；原始回放记录、doctor与安装日志在 `/workspace/coordination-final-evidence`。
仓库只增强回放器的原始输出、输入、耗时、usage及错误保存，区分 plan尝试和实际stream入口；定向7项测试通过，不计作真实语言通过。

未推送、建PR、部署、修改长期模型配置或真实群外发。
