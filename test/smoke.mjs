/**
 * 离线自测：不依赖 DSH 运行时，用最小 ctx 桩验证插件逻辑。
 * 运行：ELECTRON_RUN_AS_NODE=1 <electron> test/smoke.mjs
 */

import { apply } from '../index.js'

const tools = new Map()
const sections = []
const approvalCalls = []
let approvalOutcome = 'rejected'
let disposers = []

const ctx = {
  logger: {
    info: (...args) => console.log('[info]', ...args),
    warn: (...args) => console.log('[warn]', ...args),
  },
  tools: {
    register: (definition) => {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  get: (name) => {
    if (name === 'systemPrompt') {
      return { section: (value) => { sections.push(value); return () => {} } }
    }
    if (name === 'approval') {
      return {
        request: async (request) => {
          approvalCalls.push(request)
          return approvalOutcome
        },
      }
    }
    return undefined
  },
  effect: (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}

apply(ctx, {})

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const signal = new AbortController().signal
const exec = { agent: { id: 'test-session' }, callId: 'call-1', rootCallId: 'call-1', signal }

async function invoke(name, args) {
  const definition = tools.get(name)
  if (!definition) throw new Error(`missing tool: ${name}`)
  const value = await definition.execute(args, exec)
  const content = definition.output.render(args, value)
  const text = content.map((block) => block.text ?? '').join('\n')
  return { value, text }
}

async function expectThrow(label, name, args) {
  try {
    await invoke(name, args)
    check(label, false, '没有抛错')
  } catch (error) {
    check(label, true)
    console.log(`       → ${String(error.message).slice(0, 110)}`)
  }
  return undefined
}

console.log('\n== 注册 ==')
check('注册了 7 个工具（含 pc_batch）', tools.size === 7, `实际 ${tools.size}`)
check('工具名齐全', ['pc_pointer', 'pc_keyboard', 'pc_screen', 'pc_window', 'pc_app', 'pc_system', 'pc_batch'].every((n) => tools.has(n)))
check('写入了 systemPrompt 段落', sections.length === 1)
for (const definition of tools.values()) {
  const ok = definition.name && definition.description && definition.parameters?.type === 'object' && typeof definition.output?.render === 'function'
  check(`schema 完整 ${definition.name}`, Boolean(ok))
}

console.log('\n== 只读能力（真实调用 helper）==')
const screenInfo = await invoke('pc_screen', { action: 'info' })
check('pc_screen info 返回尺寸', /virtualWidth/.test(screenInfo.text) || screenInfo.value?.virtualWidth > 0)
console.log(`       → ${screenInfo.text.replace(/\s+/g, ' ').slice(0, 140)}`)

const windowList = await invoke('pc_window', { action: 'list' })
check('pc_window list 有窗口', /hwnd=/.test(windowList.text))
console.log(`       → 共 ${windowList.value?.count ?? 0} 个可见窗口`)

const pointer = await invoke('pc_pointer', { action: 'position' })
check('pc_pointer position 有坐标', /鼠标位置 -?\d+/.test(pointer.text), pointer.text)

const systemInfo = await invoke('pc_system', { action: 'info' })
check('pc_system info 有机器名', Boolean(systemInfo.value?.machine))

const clip = await invoke('pc_system', { action: 'clipboard_set', text: '桌面操控·自测 ✔' })
check('clipboard_set 写入', clip.value?.length > 0)
const clipRead = await invoke('pc_system', { action: 'clipboard_get' })
check('clipboard_get 读回一致', clipRead.value?.text === '桌面操控·自测 ✔', clipRead.value?.text)

console.log('\n== 审批 fail-closed ==')
approvalOutcome = 'rejected'
const before = approvalCalls.length
await expectThrow('关机被拒绝（rejected）', 'pc_system', { action: 'power', power: 'shutdown' })
check('审批确实被请求', approvalCalls.length === before + 1)
check('审批请求带中文说明', typeof approvalCalls.at(-1)?.displayReason?.zh === 'string')
check('审批请求带 toolName', approvalCalls.at(-1)?.toolName === 'pc_system')

approvalOutcome = 'unavailable'
const before2 = approvalCalls.length
await expectThrow('无审批通道时拒绝', 'pc_system', { action: 'service', serviceName: 'Spooler', serviceAction: 'stop' })
check('unavailable 也请求过审批', approvalCalls.length === before2 + 1)

approvalOutcome = 'cancelled'
// 用不依赖进程是否存在的动作，避免「因为没这个进程而抛错」被误当成「审批取消」。
await expectThrow('取消审批时拒绝', 'pc_system', { action: 'power', power: 'restart' })

console.log('\n== 危险命令与启动判定 ==')
const beforeDanger = approvalCalls.length
approvalOutcome = 'rejected'
await expectThrow('删除类命令被拦并要求审批', 'pc_system', { action: 'exec', command: 'Remove-Item -Recurse -Force C:\\Temp\\x' })
check('删除命令触发了审批', approvalCalls.length === beforeDanger + 1)
await expectThrow('管道命令被拦', 'pc_system', { action: 'exec', command: 'dir | Out-File x.txt' })
await expectThrow('启动 cmd 被拦', 'pc_app', { action: 'launch', target: 'C:\\Windows\\System32\\cmd.exe', args: '/c echo hi' })
await expectThrow('启动 bat 被拦', 'pc_app', { action: 'launch', target: 'C:\\temp\\x.bat' })
check('审批理由记录了原因', approvalCalls.slice(-3).every((call) => typeof call.reason === 'string' && call.reason.length > 0))

console.log('\n== 审批绕过回归（外部评审发现的洞）==')
{
  const before = approvalCalls.length
  approvalOutcome = 'rejected'
  await expectThrow('不带 .exe 的 cmd 被拦', 'pc_app', { action: 'launch', target: 'cmd', args: '/c echo hi' })
  await expectThrow('cmd.exe. 尾点被拦', 'pc_app', { action: 'launch', target: 'cmd.exe.' })
  await expectThrow('任意路径 exe 被拦', 'pc_app', { action: 'launch', target: 'C:\\Windows\\System32\\notepad.exe' })
  await expectThrow('UNC 路径命令被拦', 'pc_system', { action: 'exec', command: '\\\\evil\\share\\whoami.exe' })
  await expectThrow('带路径的命令名被拦', 'pc_system', { action: 'exec', command: '.\\whoami.exe' })
  await expectThrow('route add 被拦', 'pc_system', { action: 'exec', command: 'route add 1.2.3.4 mask 255.255.255.255 0.0.0.0' })
  check('每个绕过都触发了审批', approvalCalls.length >= before + 6, `实际 ${approvalCalls.length - before} 次`)
}

console.log('\n== 只读命令免审批 ==')
approvalOutcome = 'rejected'
const beforeSafe = approvalCalls.length
const whoami = await invoke('pc_system', { action: 'exec', command: 'whoami' })
check('whoami 免审批执行', /\\/.test(whoami.text) && approvalCalls.length === beforeSafe, whoami.text.slice(0, 80))
const echo = await invoke('pc_system', { action: 'exec', command: 'echo hello-desktop-control' })
const notepadLaunch = await invoke('pc_app', { action: 'launch', target: 'notepad' })
check('白名单程序 notepad 免审批', Boolean(notepadLaunch.value?.pid), JSON.stringify(notepadLaunch.value))
check('echo 免审批执行', /hello-desktop-control/.test(echo.text))

console.log('\n== 审批通过后放行 ==')
approvalOutcome = 'allowed-once'
const written = await invoke('pc_system', { action: 'exec', command: 'New-Item -ItemType Directory -Path "$env:TEMP\\dc-smoke-pass" -Force' })
check('allowed-once 后命令真的执行', /exit code: 0/.test(written.text), written.text.slice(0, 120))

console.log('\n== 参数校验 ==')
await expectThrow('未知 action 报错', 'pc_pointer', { action: 'teleport' })
await expectThrow('缺 x/y 报错', 'pc_pointer', { action: 'move', x: 1 })
await expectThrow('press 空 keys 报错', 'pc_keyboard', { action: 'press' })
await expectThrow('kill 缺目标报错', 'pc_app', { action: 'kill' })
await expectThrow('registry 写缺名字报错', 'pc_system', { action: 'registry', registryAction: 'write', registryKey: 'HKCU:\\SOFTWARE\\x' })

console.log('\n== 窗口动作（真实调用，作用于无害目标）==')
const focus = await invoke('pc_window', { action: 'list', title: 'Desktop' })
check('按标题过滤窗口不报错', Array.isArray(focus.value?.windows))

console.log('\n== 清理 ==')
for (const dispose of disposers) {
  try { dispose() } catch (error) { console.log('dispose error', error.message) }
}
console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
