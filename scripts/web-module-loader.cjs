const { registerHooks } = require('node:module')

// 大型本地插件图在同线程加载；解析、模块内容与缓存仍交给 Node 原生实现。
registerHooks({
  load(url, context, nextLoad) {
    return nextLoad(url, context)
  },
})
