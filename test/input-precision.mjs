/**
 * 精确输入验证：靶子是 test/target-app.exe（WinForms TextBox），
 * 它会把 TextBox 内容每 150ms 写到 %TEMP%\dc-target.txt，据此判定注入是否真的成功。
 */

import { apply } from '../index.js'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tools = new Map()
const disposers = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: {
    register: (definition) => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  get: (name) => {
    if (name === 'systemPrompt') return { section: () => {} }
    if (name === 'approval') return { request: async () => 'allowed-once' }
    return undefined
  },
  effect: (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}
apply(ctx, {})

const signal = new AbortController().signal
const exec = { agent: { id: 'target' }, callId: 'c1', rootCallId: 'c1', signal }
const call = async (name, args) => tools.get(name).execute(args, exec)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const targetFile = join(tmpdir(), 'dc-target.txt')
const readTarget = () => {
  try { return readFileSync(targetFile, 'utf8') } catch { return '' }
}

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const exePath = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\desktop-control\\test\\target-app.exe'
let pid = null
try {
  console.log('\n== 启动靶子 ==')
  const launched = await call('pc_app', { action: 'launch', target: exePath })
  pid = launched.pid
  check('target-app 已启动', typeof pid === 'number', JSON.stringify(launched))
  await wait(1800)

  let window = null
  for (let attempt = 0; attempt < 25 && !window; attempt++) {
    const list = await call('pc_window', { action: 'list' })
    window = (list.windows || []).find((row) => Number(row.pid) === Number(pid))
    if (!window) await wait(200)
  }
  check('找到靶子窗口', Boolean(window))
  if (!window) throw new Error('没找到靶子窗口')

  const focused = await call('pc_window', { action: 'focus', hwnd: window.hwnd })
  check('靶子在前台', focused.foreground === true, JSON.stringify(focused))
  await wait(300)

  const centerX = Math.round(window.x + window.width / 2)
  const centerY = Math.round(window.y + window.height / 2)
  const clicked = await call('pc_pointer', { action: 'click', x: centerX, y: centerY })
  check('点击了客户区中心', clicked.button === 'left', JSON.stringify(clicked))
  await wait(300)

  console.log('\n== 单字符串验证 ==')
  await call('pc_keyboard', { action: 'type', text: 'A', intervalMs: 0 })
  await wait(500)
  check('单个 ASCII 字符进入 TextBox', readTarget().includes('A'), `实际内容=${JSON.stringify(readTarget())}`)

  console.log('\n== 中文 + emoji ==')
  const expected = '中文测试 ✔'
  await call('pc_keyboard', { action: 'type', text: expected, intervalMs: 10 })
  await wait(600)
  check('中文与 emoji 进入 TextBox', readTarget().includes(expected), `实际内容=${JSON.stringify(readTarget())}`)

  console.log('\n== 组合键 + 剪贴板模式 ==')
  await call('pc_keyboard', { action: 'press', keys: 'ctrl+a' })
  await wait(200)
  await call('pc_keyboard', { action: 'type', text: '剪贴板覆盖', method: 'clipboard' })
  await wait(600)
  check('剪贴板模式覆盖成功', readTarget().includes('剪贴板覆盖'), `实际内容=${JSON.stringify(readTarget())}`)

  console.log('\n== 滚轮与拖拽 ==')
  await call('pc_pointer', { action: 'scroll', dy: 1 })
  check('滚轮调用未抛错', true)
} catch (error) {
  failures++
  console.log(`\n异常：${error.message}`)
} finally {
  if (pid) {
    try { await call('pc_app', { action: 'kill', pid }) } catch { /* ignore */ }
  }
  for (const dispose of disposers) {
    try { dispose() } catch { /* ignore */ }
  }
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
