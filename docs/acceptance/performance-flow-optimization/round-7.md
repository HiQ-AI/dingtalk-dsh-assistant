# 第 7 轮：全量、构建与打包

- `pnpm test`：511 PASS、0 FAIL、0 SKIP，见 `round-7-tests.log`。
- `node scripts/build-web-client.mjs` 后 `git diff --exit-code -- packages/dingtalk-dsh-assistant/web-client.js`：exit 0，Web 产物未改变。
- 三包 `pnpm pack` 实跑成功；独立 `tar -tf`、文件长度与 SHA256 读回见 `round-7/package-readback.json`。后续第 8 轮代码变化后重新打包并覆盖该制品清单，二进制不入库。

再生成：

```powershell
pnpm pack --pack-destination docs/acceptance/performance-flow-optimization/round-7/packages
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/acceptance/performance-flow-optimization/round-7/packages
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/acceptance/performance-flow-optimization/round-7/packages
```

版本号未变，这些是本地验证包，不是已发布版本。未安装到运行中的 profile。
