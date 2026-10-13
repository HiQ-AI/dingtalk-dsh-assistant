# 第 1 轮：来源及定向本机回归

2026-10-13 Windows11 / PowerShell7 / Node24.19.0。

- suite ZIP SHA256 与 PR169 来源记录一致；verify-bundle.mjs 实跑校验34个文件和两个相对profile。
- 钉钉main b2fb1ac，相关14文件341项测试全部通过，无取消/跳过。命令清单与完整输出在本机 docs/tmp/unified-native-tests.log，覆盖持久日志、V3/V4、执行、群Inbox、Owner、Observer导航与维护卸载。
- Convergent main17d7c54，npm ci/typecheck/build通过，8文件171项测试通过；本机包57094bytes、SHA256 de6af00e6a6dcda35cf34b302a1565a60817bf9b5a90a4f516606248a73a5211。
- Bytebase：精确alpha2依赖以及JsonValue改用dsh-util-values；npm run check通过（6文件19项测试、类型、build、pack）。本机包28891bytes、SHA256 369c4a38ecd2dd55abf12616f63e3f83ec83564e92d042dec783844697f89d01。
- Provider真实alpha2 API烟测：注册/prepare11模型、reasoning11、dispose移除，通过；无网络请求，不使用真实凭据。全check的既有Windows canary/POSIX用例未全绿，定向provider验证尚在执行，不将这层写成全绿。
- 正式profile：DSH0.1.2-rc.1、Connect4.42、PID46964，health ok、Bridge正常、recovery0、maintenance inactive、busy全0。尚未安装正式升级包。
