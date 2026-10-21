# 发行流水线与夹具修复验证

基线 d9eb8cde7d4f98c9bf3da2283715e76af4a9ea7e；本地 Node24.19.0 / pnpm10.13.1，隔离原生 profile，当前用户可继承FullControl的短物理TEMP；没有用户provider凭据、真实钉钉消息或部署。

旧候选全测3293项：3274通过、13失败、0取消、6跳过，不能当作新提交通过。新main五文件定向40项：29通过、11失败。历史Git取证在新工作树通过（旧失败为跨SID dubious ownership）；PR232阶段进度配置修复已通过。恢复九项和清洁启动缺统筹config.provider，纯测试提交显式绑定同一注册fixture provider，保留所有原断言和超时。

修夹具后三文件复核17项：16通过、1失败（skills环境ACL），0取消/跳过。skills诊断的两个错误分别是pwsh原生grantWrite Win32 5和原预期task_session_stale；仅修测试根当前用户继承权限后skills原断言5/5通过。未修改业务逻辑，未删除用例或增加超时。

流程契约与真实tarball身份负向测试11/11通过，0失败/取消/跳过，覆盖缺验证依赖、同run下载、SHA/tag/lock/profile/node/pnpm/平台、文件缺失/增加/修改、脏受跟踪源码及未跟踪包内容拒绝。三包实打后，直接对这批tgz执行原生任务及resident健康smoke，2/2通过；当前只是本地2.0.2候选包，不是正式发行或部署证明。

完整映射266文件：unit41、native15/14、compat66/65/65，0退出。六组独立Windows runner；unit并发仍4，原生与兼容各组串行1，不提高同机并发。官方pnpm/Maven缓存只缓存依赖，不缓存通过结论。当前仍保留所有历史合同，动态导入静态分析不完整也不会成为删测依据。

本地独立检查：重新解析YAML并比对映射实际文件；检查DAG、只读验证权限、唯一publish OIDC、原NPM_PUBLISH保护、无PR/push普通CI/cron；审查发现仅HEAD不足以阻止脏源码冒充提交，已添加dirty/untracked shipping source拒绝和负向测试。构建只在全部验证成功后，实际包smoke后再次验hash；publish只下载同run同SHA产物，不装依赖、不重打包、不测试；npm部分成功仍SHA1回读，Release附件仍大小/SHA256回读。

此处不宣称新SHA权威CI已通过。正式tag后仍须一次精确提交的六组Release验证、固定产物构建和受保护发布，并独立回读三个npm版本及三个附件；发布重试仅重跑失败publish job，同run artifact缺失或过期必须停止而非重新打包冒充原验证。
