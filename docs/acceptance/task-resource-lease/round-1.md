# 缺陷基线与定向初验

资源基线在隔离账本中经公开接口复现：原同资源双 claim 均成功；资源键未归一化；续办显式改键未生效；同续办 key 不同资源合同被复用。初始四项均 FAIL，见 independent-review.md。没有重放真实业务任务。

初步核心修复后资源测试 12 PASS。随后 store/service/observability 定向运行 132 项，95 PASS、37 SKIP；跳过项缺少原生 DSH profile，不作为原生验证。为后续实跑明确配置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`，只复用已安装官方依赖，测试账本/模型/发送端仍隔离。原输出保留于 round-1-targeted.log。

独立反证先后发现 task.blockers 缺实时资源、service 幂等回执绕过资源合同校验并返回旧状态、取消 prepared 操作后遗漏释放父执行。修复后 16 PASS，测试前后文件 SHA256 一致。各失败轮与定位见 independent-review.md。

健康脚本旧问题为同进程运行前退出码 17、JSON healthy=true 后退出码仍 17。本次成功显式 exit 0，失败 exit 1。31 项本机真实 HTTP 场景及 AST 通过，详见 health-contract.md；不代表 UAT 业务验证。
