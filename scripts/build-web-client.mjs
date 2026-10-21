import { readFile, writeFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { fileURLToPath } from 'node:url'

const sourceUrl = new URL('../packages/dingtalk-dsh-assistant/client.js', import.meta.url)
const targetUrl = new URL('../packages/dingtalk-dsh-assistant/web-client.js', import.meta.url)
let source = await readFile(sourceUrl, 'utf8')
source = source
  .replaceAll('\r\n', '\n')
  .replace(/^import React, \{ useCallback, useEffect, useState, useRef \} from 'react'\r?\n/, '')
  .replaceAll('export const ', 'const ')
  .replaceAll('export async function ', 'async function ')
  .replaceAll('export function ', 'function ')
const bundle = `window.__ModuleLoader__.load({
  id: '@zzusp/dingtalk-dsh-assistant',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useState, useRef } = React
${source.split('\n').map((line) => line === '' ? '' : `    ${line}`).join('\n')}
    module.exports = { apply, inject, name, readResidentOverview, DingTalkDshAssistantCard }
    return module.exports
  },
})
`
// Reject invalid output before replacing the last usable browser module.
new Script(bundle, { filename: fileURLToPath(targetUrl) })
await writeFile(targetUrl, bundle)
