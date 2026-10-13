# Round 4：定位宿主夹具侧栏溢出

`verify 4` 记录 25 项通过，并测得 viewport=390、documentWidth=392。目录主体没有溢出；原有 sidebar 按钮在夹具中被铺满整页，其 width=394、right=392。实际侧栏使用独立受限 slot，夹具未模拟该边界。

修正方案仅调整浏览器宿主替身：用 240px、overflow hidden 的 aside 包住 sidebar，不改生产代码。原始测量见 `round-4/browser-results.json` 的 layout。实现 SHA256 与 round 2 相同。
