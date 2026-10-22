# SG2 独立审查与反例复核

日期：2026-10-22，Asia/Shanghai。审查代理 `dws_combined_capability` 只读审查 helper、接入指引及测试，未修改技能实现。修复由 `uat_validation_skills` 实施。本记录的最小反例使用进程内请求替身与临时字节文件；没有读取凭据、真实登录、业务网络、生产写入或外发。

## 结论

独立审查发现的两项实质缺陷均已修复，并由审查代理重新读取当前实现、独立运行原最小反例确认。此结论仅覆盖辅助代码与指引约束，不代表真实 UAT 业务验收或正在运行的旧会话已加载新 skill。

## 发现与修复前后证据

| 发现 | 修复前的独立反例结果 | 当前修复与独立复核结果 |
| --- | --- | --- |
| `verify_identity()` 将 request/JSON 原始异常传到上层，异常可能包含认证头。 | 进程内 get 替身抛出带合成认证标记的 RuntimeError；退出 `with` 后仍收到原始 RuntimeError，标记可见，虽然 finally 已尝试清理。 | 当前在 helper 边界转成固定 `SessionCheckFailed("auth.current-request") from None`。同一反例返回该固定异常；`traceback.format_exc()` 不含合成认证标记；本地 context 与 Cookie 均关闭/清理。模拟注销请求本身失败，因此仍准确记录 `cleanupState=unknown`，没有宣称服务端注销成功。 |
| 只有截图、没有自动业务断言的报告，视觉复核会补入两条检查并误判 PASS。 | `PageAcceptance()` 仅添加截图；原自动报告 `checks=[]`，完整视觉复核填 0 后返回 PASS。 | 自动结果独立保存 `automaticCheckCount=0`；首次及第二次完整视觉复核后均为 `PENDING_AUTOMATIC_CHECKS`。新增视觉检查不再充作自动业务断言。 |

本轮最终最小反例的实际摘要：

```json
{
  "no_automatic_checks": {
    "automaticCheckCount": 0,
    "automaticStatus": "PENDING_AUTOMATIC_CHECKS",
    "firstVisualStatus": "PENDING_AUTOMATIC_CHECKS",
    "secondVisualStatus": "PENDING_AUTOMATIC_CHECKS"
  },
  "sanitized_current_exception": {
    "exceptionType": "SessionCheckFailed",
    "safeMessage": "auth.current-request",
    "sensitiveMarkerInTraceback": false,
    "contextClosed": true,
    "cookiesCleared": true,
    "cleanupState": "unknown"
  }
}
```

此前审查还检查了“第一张已复核截图在第二次部分复核前被替换”。实施代理同期已加入最终复核必须覆盖全部截图的要求，独立运行观察到当前结果为 `PENDING_VISUAL_REVIEW`，未列作仍未修复项。

另外独立读取 [round-3/results.json](round-3/results.json)：21 个用例通过、0 failure、0 error。其中包括上述两项新增回归。该文件是实施代理的测试结果；独立审查本次仅重跑以上两个最小反例，没有把回读结果冒充重新执行整套测试。

## 主代理的图片观察

来源：主代理 `/root` 明确回报已使用 `view_image` 打开 round-1 的两个本地浏览器夹具截图：

- [error.png](round-1/browser-fixtures/error.png)：可见红色 `Network Error`。
- [clean.png](round-1/browser-fixtures/clean.png)：没有该错误提示。

这是主代理的实际读图观察，本审查代理没有重复打开图片。它验证本地错误/正常夹具的差异，**不是真实 UAT 页面或线上登录证据**。

## 仍由调用者负责的边界

- 认证 helper 只能接收本轮新建、专用 BrowserContext，不能把用户共享会话交给自动清理；登录前注册观察器，并用 `with` 覆盖提交登录本身。
- 现有受管凭据仅在受管进程使用；外层浏览器/页面异常仍须转换成安全阶段与断言标识，不记录认证 HAR、storage-state 或原始异常正文。
- 从核实后的 current 数据提取权限；未知用 `None`，不能将缺失数据替换成空权限以伪造只读成功。精确请求清单须依据本版本业务语义检查，不能按 GET/POST 一概分类。
- `visible_error_count` 必须来自对所有交付截图的实际读取；helper 的 SHA256 绑定和失败留存不能替代视觉判断。错误画面、布局缺失、加载状态仍需检查，不能固定填 0。
- 同一轮使用同一份累计结果，保留原失败，定位器/超时等外部失败调用 `record_failure`；失败轮次不能重造一份无失败的报告覆盖。
- 页面、身份、服务端注销与本地关闭分别报告。页面 PASS 不代表注销已验证，`unknown/identity-unverified` 也不能写成清理完成。

当前未发现需要为模拟不遵守上述契约而继续增加抽象的理由。后续接入真实任务时，验证实际调用和产物，不只检查 helper 测试通过。

## 最终回读的实现身份

| 文件 | SHA256 |
| --- | --- |
| `D:/dsh_home/skills/baibu-uat-account-verify/scripts/hiq_uat_session.py` | `05b094617af9206d8aa8efe380f986596e15dd4ed2bc13b41fa4e90e316c88f0` |
| `D:/dsh_home/skills/business-development/scripts/page_acceptance.py` | `14d393eccd468b40abd9673f4209bf13ea435695a6ccc4ee2db3627f0749ff62` |

接入指引已读取：`baibu-uat-account-verify/references/verified-flow.md` 与 `business-development/references/page-verification.md`。此处记录 hash 是本次审查版本身份，不宣称运行中任务已重新加载。
