/**
 * 交互自测：真实驱动鼠标键盘，靶子是一个新开的记事本。
 * 安全策略：聚焦后必须确认该窗口确实在前台，否则一个键都不发。
 * 运行：ELECTRON_RUN_AS_NODE=1 <electron> test/interactive.mjs
 */

import { apply } from '../index.js'

const tools = new Map()
let approvalOutcome = 'allowed-once'
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
    if (name === 'approval') return { request: async () => approvalOutcome }
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
const exec = { agent: { id: 'interactive' }, callId: 'call-1', rootCallId: 'call-1', signal }

const call = async (name, args) => {
  const definition = tools.get(name)
  const value = await definition.execute(args, exec)
  return value
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

let targetPid = null
try {
  console.log('\n== 启动记事本 ==')
  const launched = await call('pc_app', { action: 'launch', target: 'notepad.exe' })
  targetPid = launched.pid
  check('notepad 已启动', typeof targetPid === 'number', JSON.stringify(launched))
  await wait(1500)

  console.log('\n== 找到并激活窗口 ==')
  let window = null
  for (let attempt = 0; attempt < 25 && !window; attempt++) {
    const list = await call('pc_window', { action: 'list' })
    window = (list.windows || []).find((row) => Number(row.pid) === Number(targetPid))
    if (!window) await wait(200)
  }
  check('找到记事本窗口', Boolean(window), `pid=${targetPid}`)
  if (!window) throw new Error('没有找到记事本窗口，终止测试')

  const focused = await call('pc_window', { action: 'focus', hwnd: window.hwnd })
  await wait(350)
  check('记事本已在前台', focused.foreground === true, JSON.stringify(focused))
  if (focused.foreground !== true) throw new Error('无法把记事本切到前台，为避免误输入已终止')

  console.log('\n== 鼠标：点击编辑区 ==')
  const centerX = Math.round(window.x + window.width / 2)
  const centerY = Math.round(window.y + Math.min(window.height * 0.35, 220))
  const clicked = await call('pc_pointer', { action: 'click', x: centerX, y: centerY })
  check('点击已发送', clicked.button === 'left' && clicked.x === centerX, JSON.stringify(clicked))
  await wait(150)

  console.log('\n== 键盘：文本输入（默认剪贴板粘贴）==')
  const marker = `desktop-control 自测 ${new Date().toISOString().slice(11, 19)}`
  const typed = await call('pc_keyboard', { action: 'type', text: `${marker} ✔`, intervalMs: 8 })
  check('文本输入完成', typed.chars > 0, JSON.stringify(typed))
  await wait(250)

  console.log('\n== 键盘：组合键 ==')
  const pressed = await call('pc_keyboard', { action: 'press', keys: 'ctrl+a' })
  check('ctrl+a 已发送', Array.isArray(pressed.pressed) && pressed.pressed.length === 1)

  console.log('\n== 键盘：剪贴板模式输入 ==')
  const pasted = await call('pc_keyboard', { action: 'type', text: '粘贴模式', method: 'clipboard' })
  check('clipboard 输入完成', pasted.method === 'clipboard', JSON.stringify(pasted))
  await wait(200)

  console.log('\n== 截图存证 ==')
  const shot = await call('pc_screen', { action: 'grab', hwnd: window.hwnd, path: 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\desktop-control\\test\\notepad-proof.png' })
  check('窗口截图已保存', Boolean(shot.path), JSON.stringify(shot))
  console.log(`       → ${shot.path} (${shot.width}x${shot.height})`)
} catch (error) {
  failures++
  console.log(`\n异常终止：${error.message}`)
} finally {
  console.log('\n== 清理 ==')
  if (targetPid) {
    try {
      const killed = await call('pc_app', { action: 'kill', pid: targetPid })
      console.log('  notepad 已结束:', JSON.stringify(killed.killed))
    } catch (error) {
      console.log('  结束 notepad 失败:', error.message)
    }
  }
  for (const dispose of disposers) {
    try { dispose() } catch { /* ignore */ }
  }
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
