# 公共健康检查调用合同验证

2026-10-21：公共脚本与运行指引已同步；31 个真实 loopback HTTP 用例通过。只验证脚本调用合同，没有访问 UAT、调用业务接口或执行部署；HTTP 健康不代表运行镜像身份或业务验收通过。

## 改动与合同

- `D:/baibu-agent/scripts/read-uat-health.ps1:57`：保留现有 JSON 字段与健康判定，仅将尾部改为成功显式 `exit 0`、失败显式 `exit 1`。同进程 `&` 调用会返回调用者并覆盖此前原生命令的退出码；独立 `pwsh -NoProfile -File` 使用相同 JSON 和进程退出码合同。输入非法仍抛错。
- `D:/baibu-agent/docs/ops/woodpecker-uat.md:115`：统一推荐 `&` 调用后立即保存 `$LASTEXITCODE`，再解析 JSON 并检查 `healthy`；使用 `-ErrorAction Stop`，不点源，不把缺失 JSON、异常或旧退出码解释为健康。保留 HTTP 健康、镜像身份与业务验收的边界。

健康判定未放宽：所有传入入口必须在同一轮同时满足 HTTP 200、JSON 媒体类型、JSON 对象与字符串 `status=UP`；不跟随跳转、不输出响应正文、有界重试。

## 实跑证据

命令：

```powershell
pwsh -NoProfile -File .\docs\acceptance\task-resource-lease\scripts\health-contract.test.ps1
```

测试使用当前 PowerShell 7.6.5 启动 loopback `HttpListener` fixture，并在 `finally` 停止监听、移除作业；不创建外部服务或访问 UAT。输出已独立回读：[health-contract-results.json](health-contract-results.json)，`pass=true`、`count=31`。

| 场景组 | 用例数 | 结果 |
|---|---:|---|
| 首次 `$LASTEXITCODE` 未初始化；原生退出码 17 后双入口成功；双入口中一个失败 | 3 | PASS |
| 同进程与独立 `pwsh -File`：UP、`application/health+json`、DOWN、503、HTML 200、非法 JSON、302 跳转、JSON 数组、布尔 status、小写 up | 20 | PASS |
| 两种调用方式的先失败后成功、重试耗尽 | 4 | PASS |
| 两种调用方式的非法 URI 与非法参数 | 4 | PASS |

每个正常健康/不健康结果均检查 JSON 可解析、退出码 0/1、调用者继续运行、有限尝试次数、全部入口覆盖、响应正文未泄露以及镜像身份校验边界。非法 URI 在发请求前拒绝，同进程抛错；独立进程返回非零退出码。`http://invalid.example/health` 只用于前置校验，不实际发请求。

语法检查：通过 PowerShell AST Parser 独立解析公共脚本和测试脚本，均为 `parseErrors=0`。

## 执行中修正

- 首次测试 harness 未进入完整用例：本机 `Get-Command pwsh` 返回两个安装路径，直接取 `.Source` 形成数组，导致原生命令定位失败。测试改为使用当前进程 `$PSHOME/pwsh.exe` 后通过 29 个用例；随后补上独立进程非法 URI / 参数的两项用例，最终 31 项通过。该次失败未修改健康判定，也未访问 UAT。
- 旧版本问题的既有证据：`D:/project/dingtalk-dsh-assistant/docs/acceptance/daily-task-review-20261020/evening-pr-review/health-contract-probe.json` 记录 `before=17, healthy=true, after=17`。本轮对应的 `native17-up` 和双入口用例均回读 `exitCode=0`。

## 文件 SHA256

| 文件 | 修改前 | 修改后 |
|---|---|---|
| `D:/baibu-agent/scripts/read-uat-health.ps1` | `DD89FB40D9E89A80A83003A19E6F8ACAA113CE81DE9A0B0C665579D24D68F1F3` | `4F6A775AD4DFA907893C996E9DD82E5E19EA77E5C79CC07C9D89046C44860DDC` |
| `D:/baibu-agent/docs/ops/woodpecker-uat.md` | `E057208A3C2B253D740C9EE4FDCCEF578D01DD1CF97B7F1774A777EFE27394B9` | `B0695E08925F4A37A0BC40B3C202776DB628DBF02AD60080E2408DDE2A8F8859` |

本分工未修改业务源码、插件、skill，未提交或推送。现有 skill 由主代理按本调用合同统一补强。
