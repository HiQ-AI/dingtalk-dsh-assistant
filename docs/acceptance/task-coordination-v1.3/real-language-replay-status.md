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
