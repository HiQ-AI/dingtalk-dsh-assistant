// 隔离设置页预览；所有接口只读写本进程内存，不连接真实 Host 或钉钉。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(new URL('../../../../package.json', import.meta.url))
const react = new URL('./umd/react.production.min.js', `file:///${require.resolve('react').replaceAll('\\', '/')}`)
const reactDom = pathToFileURL(process.argv[2])
let config = { agentNames: ['预览助理'], workspaceDir: 'D:/fixture', model: 'fixture' }
let saved
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/react.js' || path === '/react-dom.js') {
    res.setHeader('content-type', 'text/javascript'); return res.end(await readFile(path === '/react.js' ? react : reactDom))
  }
  if (path === '/bundle.js') {
    res.setHeader('content-type', 'text/javascript')
    return res.end((await readFile(new URL('../../../../packages/dingtalk-dsh-assistant/web-client.js', import.meta.url), 'utf8')).replace('http://127.0.0.1:18998', ''))
  }
  if (path === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>署名移除隔离验收</title><body style="font:14px system-ui;margin:24px"><main id="root"></main><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load:({factory})=>{const c=factory(()=>React);ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(c.DingTalkDshAssistantCard))}}</script><script src="/bundle.js"></script></body></html>`)
  }
  if (path === '/config/agent') {
    let body = ''; for await (const chunk of req) body += chunk
    saved = JSON.parse(body); config = { ...config, ...saved }
  }
  const result = path === '/saved' ? saved : ['/config/agent', '/state/agent-config'].includes(path) ? config
    : ['/state/groups', '/state/tasks', '/state/supervisor/alerts'].includes(path) ? [] : {}
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result ?? null))
})
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`))
