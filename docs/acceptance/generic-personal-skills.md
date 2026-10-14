# 通用任务会话与独立个人技能接入验收

日期：2026-10-13。代码基线：4d77917cde017cf5e99946625155259ca59de8ef。

## 变更边界

- 复用 DSH alpha2 原生 skill registry、filesystem provider 和 tool-skill。任务与执行会话使用所选 preset；只发布名称/描述目录，正文及引用资料按需读取。
- 任务会话只开放准确已挂载的 skill 入口及四个统筹工具。普通文件、shell、浏览器和数据库操作继续由独立执行会话承担。skillNames 仅为委派元数据，不赋权、不注册固定流程、不触发完成判断。
- skill 读取失败不形成未知外部写入。同名后置替换不能继承任务会话调用许可或执行会话只读免账。入口代码来自用户已配置的可信 preset，不把任意不受信任插件当作沙箱。
- 个人署名改为明确 replySignature 配置，默认空；存储优先于首次 profile 配置。模型只提交业务正文，Host 对完成、状态及问题统一附加署名。保留原消息引用与真实提及。
- Assistant npm 发布显式列出 34 个当前 JavaScript 文件、通用包说明及 bundle patch；没有个人 skill、业务节点定义、旧 workflow-* 或私人适配器。去掉旧 ./execution 与 ./platform-host 导出。历史源码留在仓库作审计，不进入 npm 包。
- 通用清理、群消息和当前来源语义从历史模块拆出。退役封存校验移到源码历史模块，当前 resident 不导入旧引擎。
- 历史配置工具去掉私人两项目默认，项目和仓库必须来自明确配置；旧私人 checks 重写入口失败关闭。它不是新任务运行时入口。

个人业务技能正文、逐节点来源映射、安装说明与验收脚本独立交付，不写进公共插件仓库或 npm 包。提取覆盖与业务使用边界以个人包自身说明为准。

## 最终联合验证

运行环境：Linux，Node v24.19.0、pnpm 11.25.0；使用已安装 DSH 0.2.1-alpha.2 原生组件。Web 客户端先重新构建。

以下 19 个相关文件联合运行：176/176 通过，0 跳过，0 失败。不是全量仓库测试。

```powershell
node scripts/build-web-client.mjs
node --test --test-concurrency=4 test/task-session-package-native.test.js test/task-session-skills-native.test.js test/task-session-service-native.test.js test/task-session-material-history.test.js test/task-session-http-integration.test.js test/dynamic-execution-session-native.test.js test/task-session-persistence-native.test.js test/task-session-reply-identity.test.js test/group-reply-format.test.js test/workflow-notifications.test.js test/workflow-entry.test.js test/configure-project-local-acceptance.test.js test/dws-adapter.test.js test/group-coordinator-session-native.test.js test/agent-work.test.js test/release-workflow.test.js test/dingtalk-dsh-assistant.test.js test/client-reply-signature.test.js test/task-session-clean-start.test.js
```

实际 npm tarball 已解包验证：Web 主入口可导入；解包后的 task-session-service 完成外部个人技能任务；解包 resident 在没有旧工作流依赖的真实 native composition 中启动，/health 返回 200/ok。依赖来自当前已安装的官方依赖树，不从源码目录补缺失模块，不进行网络安装或发布。

个人包另经独立解压，逐项核对 manifest，并在真实 native registry/tool/session 下完成任务会话 7 次入口读取、执行会话 7 次入口与 7 份 procedure 读取；脚本模型控制调用，0 unknown effect、0 真实外部写入。两场 SQL 范围/未知效果前向推演通过，不等同于生产平台执行验证。

## 已确认的历史基线失败

提取时附加回归旧发布/SQL 11 个文件，113/115 通过。task-release-workflows.test.js 两处冻结摘要断言失败；隔离 git archive 4d77917 并复跑，同样 13/15、同两处失败。没有修改旧摘要期望来掩盖失败。

- :22：expected 0561d6cea70cc25ed978fea5710adc436e7df183911313902084e075603718f3，actual 4b9a1178a1306d9faa77fac56f7784f15d9a2d7b4b2beab144fa86e06e866b4f；只读归一函数源码换行为 LF 后吻合 expected。
- :158：要求旧生产 digest 3ed7ab9e46b14c27e1d770b9c1302785f523a5b20abb7b6bb9fc5902860ca38b 存在，基线列表中不含该值；当前基线 digest ffd212a4ae6b2214327fd9d6e7e7ff37cc44f81a980daea0919464b31f26d62d，列表含 cfc445fccb8aad25bd3fb646f148a3682de2b1c8de26f799710838e1a37c0c26。

## 未验范围

未在用户 Windows/百部实例安装，未执行真实 DWS 发送、GitHub 提交/推送/合并、CI/集群发布、Bytebase 建单或生产 SQL；未验证真实大模型的全部业务决策。没有远端推送、合并或 npm 发布。包仍使用仓库现有版本号，只能凭本次候选提交、树及包 SHA 标识，不得当成同版本正式发布已更新。

仓库中的退役历史源码、旧运维脚本及取证文档没有全局清除私人实例文字；它们不属于当前 Assistant npm 发布清单，也不能据此恢复旧业务写入口。
