import { readFile, writeFile } from 'node:fs/promises'

const sourceUrl = new URL('../packages/dingtalk-dsh-assistant/client.js', import.meta.url)
const targetUrl = new URL('../packages/dingtalk-dsh-assistant/web-client.js', import.meta.url)
let source = await readFile(sourceUrl, 'utf8')
source = source
  .replace(/^import React, \{ useCallback, useEffect, useState \} from 'react'\r?\n/, '')
  .replaceAll('export const ', 'const ')
  .replaceAll('export async function ', 'async function ')
  .replaceAll('export function ', 'function ')
const bundle = `window.__ModuleLoader__.load({
  id: '@zzusp/dingtalk-dsh-assistant',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const { IconRefreshOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives')
${source.split('\n').map((line) => line === '' ? '' : `    ${line}`).join('\n')}
    module.exports = { apply, inject, name, readResidentOverview, DingTalkDshAssistantCard }
    return module.exports
  },
})
`
await writeFile(targetUrl, bundle)
