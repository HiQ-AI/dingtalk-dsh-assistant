# 钉钉个人助理技术标识统一方案

## 目标

将用户可见名称统一为“钉钉个人助理”，并将仓库内部仍带 `group` 的插件目录、Cordis ID、组件名、descriptor provider、storage domain 和测试文件名同步改为 `dingtalk-dsh-*` 命名。

## 命名映射

| 旧标识 | 新标识 |
| --- | --- |
| `dingtalk-group-assistant` | `dingtalk-dsh-assistant` |
| `dingtalk_group_assistant` | `dingtalk_dsh_assistant` |
| `DingTalkGroupAssistant` | `DingTalkDshAssistant` |
| `dingtalk-group-observer` | `dingtalk-dsh-observer` |
| `钉钉群聊个人助理` | `钉钉个人助理` |

公开包名 `@zzusp/dingtalk-dsh-assistant`、`@zzusp/dingtalk-dsh-observer` 和仓库名 `dingtalk-dsh-assistant` 已符合目标命名，保持不变。

## 改动范围

- 将包目录重命名为 `packages/dingtalk-dsh-assistant` 和 `packages/dingtalk-dsh-observer`。
- 更新 DSH profile 本地依赖路径、Cordis 插件 ID、Web slot ID、Runtime 名称和 descriptor provider。
- 将 storage domain 改为 `dingtalk_dsh_assistant`，对应默认状态目录改为 `storages/dingtalk-dsh-assistant`。
- 更新构建脚本、启动脚本、测试导入路径、测试断言和文档。
- 重命名仍含旧插件名的测试文件。

## 数据影响

storage domain 改名后，旧的 `dingtalk_group_assistant` 数据不会自动成为新 domain 的数据。当前改动不加入运行时双读或长期兼容分支；已部署环境升级前应停掉 DSH Web，备份旧 storage，再按实际 storage backend 做一次性迁移。新安装不受影响。

descriptor provider 也会改名。已有 Session 若需要继续复用，应在升级窗口内运行与当前存储格式匹配的一次性迁移；不能把旧 provider 当作新命名长期保留。

## 验证

1. 全仓检索旧中文名和四类旧技术标识，结果为 0。
2. 运行 `pnpm install`，确认本地包新目录可以装配。
3. 运行 `pnpm test`，所有测试通过。
4. 运行 Web client 构建脚本，确认生成文件与源码一致。
5. 检查 Git diff，确认没有修改包的公开名称和无关业务逻辑。
