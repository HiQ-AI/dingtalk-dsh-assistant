// 从修复后的 DSH 源码工作树运行；默认 Windows 聚合配置排除此文件。
export default {
  root: process.cwd(),
  resolve: { tsconfigPaths: true },
  test: { include: ['packages/subprocess/subprocess-local/tests/terminal.spec.ts'] },
};
