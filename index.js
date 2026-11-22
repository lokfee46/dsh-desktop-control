/**
 * Desktop Control — 让模型真正操作这台电脑的 DSH 插件。
 *
 * 六个工具：鼠标、键盘、屏幕、窗口、应用、系统。
 * 危险动作（提权、删除、关机、服务、注册表、杀进程、任意命令、脚本宿主）一律先通过
 * ctx.approval 请示主人：只有拿到 `allowed-once` 才执行，其余结果全部按拒绝处理。
 *
 * 只依赖 Node 内建模块与一个本仓编译好的 native helper（native/DesktopControl.exe）。
 *
 * @module @local/desktop-control
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const NATIVE_DIR = join(HERE, 'native')
const HELPER_EXE = join(NATIVE_DIR, 'DesktopControl.exe')
/**
 * 运行时 helper 的落地目录。
 * 不能直接从工作区跑 exe：DSH 的 Windows 沙箱会对工作区路径下的可执行文件降权，
 * 表现为 SetCursorPos/SendInput 全部静默失败（同一个 exe 复制到 %TEMP% 调用就正常）。
 * 所以启动前把 exe 复制到 %LOCALAPPDATA%，从那里启动。
 */
const HELPER_HOME = join(process.env.LOCALAPPDATA || tmpdir(), 'dsh-desktop-control')
const HELPER_RUNTIME = join(HELPER_HOME, 'DesktopControl.exe')
const HELPER_SOURCE = join(NATIVE_DIR, 'DesktopControl.cs')

const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
const POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const CSC_CANDIDATES = [
  join(SYSTEM_ROOT, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(SYSTEM_ROOT, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
]

const MAX_OUTPUT = 60_000
const DEFAULT_HELPER_TIMEOUT = 25_000

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/** PowerShell 单引号字符串转义：内部单引号写两次。 */
/**
 * 把任意字符串安全地传进 PowerShell。
 * 不能用引号拼接：PowerShell 把 Unicode 智能引号（‘ ’ ‚ ‛）也当单引号，
 * 只转义 ASCII ' 会留下注入面。统一走 base64 + 运行时解码，彻底绕开引号规则。
 */
function psArg(value) {
  const encoded = Buffer.from(String(value ?? ''), 'utf8').toString('base64')
  // 必须包一层括号：PowerShell 参数模式下（-Name / -Path / -Value 后面），
  // 以 [ 开头的 token 不会被当表达式求值，会原样当字符串再被 (…) 拆成位置参数。
  // 实测：`Get-Service -Name [Text.Encoding]::…` 报 PositionalParameterNotFound。
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`
}

/** 内部生成的路径（UUID 文件名）用单引号字面量即可，且能直接放在 `&` 命令位置。 */
function psLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

function truncate(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const headLength = Math.floor(limit * 0.65)
  const tailLength = Math.floor(limit * 0.3)
  const head = value.slice(0, headLength)
  const tail = value.slice(value.length - tailLength)
  return `${head}\n…（省略 ${value.length - headLength - tailLength} 字符）…\n${tail}`
}

function stringify(value) {
  try {
    if (typeof value === 'string') return value
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function textBlock(text) {
  return [{ type: 'text', text: typeof text === 'string' ? text : stringify(text) }]
}

/** 输出 schema：宽松对象，杜绝输出校验失败。 */
const OBJECT_SCHEMA = { type: 'object' }

// ---------------------------------------------------------------------------
// 风险判定
// ---------------------------------------------------------------------------

/**
 * 只读命令白名单。命中白名单、不含组合字符、不含危险关键字时 pc_system exec
 * 直接执行；其余一切情况都必须先审批。误判方向永远是「多审一次」，不是漏放。
 */
const SAFE_COMMANDS = new Set([
  'dir', 'ls', 'get-childitem', 'gci',

  'ipconfig', 'systeminfo', 'whoami', 'hostname', 'date', 'get-date',
  'get-process', 'gps', 'tasklist', 'get-service', 'gsv', 'get-volume', 'get-disk',
  'get-partition', 'get-netadapter', 'get-netipaddress', 'get-netipconfiguration',
  'get-computerinfo', 'get-hotfix', 'get-ciminstance', 'get-wmiobject', 'get-command',
  'get-help', 'get-item', 'gi', 'test-path', 'resolve-path', 'split-path',
  'get-location', 'pwd', 'echo', 'write-output', 'quser', 'query',
  // ping / tracert / pathping / netstat 都能做 DNS 解析或对外发包，等同外联通道，不再算「本地只读」。
  //
])

const COMPOSITION_CHARS = /[><|;&$`(){}%!^\r\n]/

const DANGER_WORDS = [
  'remove-item', 'remove', 'delete', 'del ', 'rmdir', 'rd ', 'rm ', 'format',
  'diskpart', 'fdisk', 'shutdown', 'taskkill', 'regsvr32', 'mshta', 'rundll32',
  'certutil', 'bitsadmin', 'schtasks', 'cipher', 'takeown', 'icacls', 'attrib',
  'mklink', 'sc config', 'sc create', 'sc delete', 'sc stop', 'sc start',
  'net user', 'net localgroup', 'net share', 'net stop', 'net start',
  'reg add', 'reg delete', 'reg import', 'set-executionpolicy', 'invoke-',
  'iex', 'downloadstring', 'downloadfile', 'start-process', 'stop-process',
  'new-item', 'set-item', 'move-item', 'copy-item', 'rename-item', 'clear-content',
  'set-content', 'add-content', 'out-file', 'install-', 'uninstall-',
]

/**
 * 免审批命令允许携带的选项白名单。
 * 三轮评审下来，每一次新绕过都是「把已知的坏写法列出来」漏掉了另一种写法
 * （/server:host、/S:host、-ComputerName:host、-CN、-Comp 缩写…）。
 * 所以这里反过来：只放行明确列出的几个选项，其余一律审批。
 */
const SAFE_COMMAND_OPTIONS = new Set([
  '/all', '/groups', '/priv', '/user', '/fo', '/nh', '/v', '/verbose',
  '-a', '-n', '-r', '-t', '-l', '-s', '-size',
])

const POWER_VERBS = /\b(remove|new|set|move|copy|rename|clear|stop|start|restart|disable|enable|install|uninstall|invoke|out)-[a-z]/i

/** 能执行脚本或直接改动系统的宿主程序：旧黑名单保留作参数检查的补充信号。 */
const SCRIPT_FILE_EXT = /\.(bat|cmd|ps1|vbs|vbe|js|jse|wsf|hta|reg|msi|scr)$/i

/** 显式放行的协议（不含 http(s)，那两个由 URL_PATTERN 单独判断）。 */
const SAFE_SCHEMES = new Set([
  'ms-settings', 'ms-windows-store', 'ms-photos', 'ms-calculator', 'ms-screenclip', 'ms-clock', 'copilot',
])

const URL_PATTERN = /^(https?|mailto|ms-settings|ms-windows-store|ms-photos|ms-calculator|ms-screenclip|copilot):/i

/** 免审批启动的 GUI 程序（exe 名，不含路径与扩展名）。可用配置 allowedPrograms 扩展。 */
const DEFAULT_ALLOWED_PROGRAMS = [
  'notepad', 'calc', 'mspaint', 'explorer', 'charmap', 'snippingtool', 'osk', 'magnify',
  'chrome', 'msedge', 'firefox', 'thorium', 'brave',
  'code', 'devenv', 'idea64', 'pycharm64', 'sublime_text',
  'spotify', 'vlc', 'mpc-be64', 'potplayermini64',
  'winword', 'excel', 'powerpnt', 'outlook',
  'wechat', 'weixin', 'qq', 'telegram', 'discord', 'slack',
]

// 去掉 .doc/.xls/.ppt（可带宏）、.iso（会挂载）、.zip/.7z/.rar（解包后可能被执行）。
const DOCUMENT_EXT = /\.(pdf|docx|xlsx|pptx|txt|md|csv|json|ya?ml|log|png|jpe?g|gif|webp|bmp|svg|mp4|mkv|mov|mp3|wav|flac)$/i

/**
 * 判定一条 PowerShell 命令是否需要审批。
 * 命令名带路径（含 UNC、相对路径、盘符）一律审批：`\\evil\s\whoami.exe` 这类
 * 会在剥掉路径后命中白名单，等于免审批跑任意 exe。
 * @returns {{ safe: boolean, why: string }}
 */
function classifyCommand(command) {
  const text = String(command ?? '').trim()
  if (text.length === 0) return { safe: false, why: '命令为空' }
  if (text.length > 4000) return { safe: false, why: '命令过长（超过 4000 字符），请拆短后分批执行' }
  if (COMPOSITION_CHARS.test(text)) {
    return { safe: false, why: '命令含管道、重定向或子表达式，无法确认是只读操作' }
  }
  if (/[\\/]{2}/.test(text)) {
    return { safe: false, why: '命令含 UNC 路径（支持 \\\\ 与 // 两种写法），可能触发凭据外泄' }
  }
  const firstToken = text.split(/\s+/)[0].toLowerCase()
  if (/[\\/:]/.test(firstToken)) {
    return { safe: false, why: '命令名带路径，无法确认是系统自带程序' }
  }
  if (!SAFE_COMMANDS.has(firstToken)) {
    return { safe: false, why: `命令 ${firstToken} 不在只读白名单内` }
  }
  // 参数逐 token 过白名单：不再枚举「远程参数长什么样」，而是只放行已知安全选项。
  const tokens = text.split(/\s+/).slice(1)
  for (const token of tokens) {
    if (token.length === 0) continue
    if (token.startsWith('-') || token.startsWith('/')) {
      if (!SAFE_COMMAND_OPTIONS.has(token.toLowerCase())) {
        return { safe: false, why: `参数 ${token} 不在安全选项白名单内` }
      }
      continue
    }
    // 含冒号但不是盘符（C:）的一律拦：-ComputerName:host、/server:host 都走这里
    if (token.includes(':') && !/^[a-zA-Z]:[\\/]?/.test(token)) {
      return { safe: false, why: `参数含非盘符冒号：${token}` }
    }
    if (token.includes('@')) {
      return { safe: false, why: `参数含 @（PowerShell splatting）：${token}` }
    }
  }
  const lower = text.toLowerCase()
  for (const word of DANGER_WORDS) {
    if (lower.includes(word)) return { safe: false, why: `命令含危险关键字「${word.trim()}」` }
  }
  if (POWER_VERBS.test(text)) {
    return { safe: false, why: '命令使用了会改动系统的 PowerShell 动词' }
  }
  return { safe: true, why: '只读白名单命令' }
}

/** 启动参数的风险判定：组合字符、危险关键字、脚本扩展名。 */
function classifyLaunchArgs(args) {
  const rawArgs = String(args ?? '')
  const lowerArgs = rawArgs.toLowerCase()
  if (lowerArgs.length === 0) return { safe: true, why: '' }
  if (COMPOSITION_CHARS.test(rawArgs)) {
    return { safe: false, why: '启动参数含管道、重定向或子表达式' }
  }
  if (/^[\\/]{2}/.test(rawArgs) || /\s[\\/]{2}/.test(rawArgs)) {
    return { safe: false, why: '启动参数含 UNC 路径（会外泄凭据）' }
  }
  if (SCRIPT_FILE_EXT.test(lowerArgs)) {
    return { safe: false, why: '启动参数指向可执行脚本文件' }
  }
  for (const word of DANGER_WORDS) {
    if (lowerArgs.includes(word)) return { safe: false, why: `启动参数含危险关键字「${word.trim()}」` }
  }
  return { safe: true, why: '' }
}

/**
 * 判定一次「启动程序」是否需要审批。
 * 白名单制：网址、文档、GUI 程序白名单免审；其余一律审批。
 * 黑名单挡不住 `cmd`（不带 .exe）、`cmd.exe.`（Win32 忽略尾点）、`\\evil\s\x.exe`（UNC），
 * 所以这里只认「裸程序名且在白名单里」。
 * @returns {{ safe: boolean, why: string }}
 */
function classifyLaunch(target, args, allowedPrograms = DEFAULT_ALLOWED_PROGRAMS) {
  const text = String(target ?? '').trim()
  if (text.length === 0) return { safe: false, why: '启动目标为空' }

  const argsRisk = classifyLaunchArgs(args)
  if (!argsRisk.safe) return argsRisk

  // file:// 会被 ShellExecute 当成 SMB 路径（\\server\share），等于绕过 UNC 检查。
  // 除 http(s) 之外的任何 scheme:// 都不可信，一律审批。
  // 不再依赖 ://：file:\\evil\share\a.pdf 不带 // 也能被 ShellExecute 当 SMB 打开。
  // 至少两个字符才算 scheme，避免把盘符 C: 误判成协议。
  const scheme = text.match(/^([a-z][a-z0-9+.-]+):/i)
  if (scheme && !/^https?$/i.test(scheme[1]) && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) {
    return { safe: false, why: `${scheme[1]}: 协议不受信任，必须审批` }
  }
  if (/^mailto:/i.test(text)) {
    if (/[\\/]{2}/.test(text)) return { safe: false, why: 'mailto 目标里含 UNC/网络路径' }
    return { safe: true, why: '打开邮件链接' }
  }
  if (URL_PATTERN.test(text)) return { safe: true, why: '打开网址或协议链接' }
  // UNC 目标（\\server\share\x.docx）会触发 NTLM 凭据外泄，且远程文档可能带恶意内容
  if (/^[\\/]{2}/.test(text)) return { safe: false, why: 'UNC 路径会外泄凭据，必须审批' }
  if (DOCUMENT_EXT.test(text)) return { safe: true, why: '用默认程序打开文档' }
  if (/[\\/]$/.test(text)) return { safe: true, why: '打开文件夹' }

  const trimmed = text.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/)
  const rawBase = segments[segments.length - 1] || ''
  // Win32 会忽略结尾的点号与空格：`cmd.exe.` 等价于 `cmd.exe`。
  const normalized = rawBase.toLowerCase().replace(/[. ]+$/, '')
  const bare = normalized.replace(/\.exe$/, '')
  if (segments.length === 1) {
    const allowed = allowedPrograms.map((item) => String(item).toLowerCase())
    if (allowed.includes(bare)) {
      // 白名单程序 + 参数是新的绕过面：explorer 能执行 .bat，VS Code 的
      // --extensionDevelopmentPath、Chromium 的 --utility-cmd-prefix 都能前置任意命令。
      if (String(args ?? '').trim().length > 0) {
        return { safe: false, why: `白名单程序 ${bare} 带了参数，可能被用来启动子进程` }
      }
      return { safe: true, why: `白名单程序 ${bare}` }
    }
  }
  return { safe: false, why: `程序 ${normalized || text} 不在免审批白名单内，或带了路径` }
}

// ---------------------------------------------------------------------------
// 原生 helper 客户端
// ---------------------------------------------------------------------------

class DesktopHelper {
  #server
  #socket
  #child
  #connecting
  #pending = new Map()
  #nextId = 0
  #tail = Promise.resolve()
  #disposed = false
  #logger

  constructor({ logger }) {
    this.#logger = logger
  }

  /** 串行执行一次 helper 调用（鼠标键盘必须保序）。 */
  call(op, params = {}, { timeoutMs = DEFAULT_HELPER_TIMEOUT } = {}) {
    if (this.#disposed) return Promise.reject(new Error('desktop helper 已关闭'))
    const run = () => this.#callNow(op, params, timeoutMs)
    const result = this.#tail.then(run, run)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  async #callNow(op, params, timeoutMs) {
    const socket = await this.#ensureSocket()
    const id = ++this.#nextId
    const payload = JSON.stringify({ id, op, ...params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        // 协议已不同步：杀掉重来，避免后续调用错位。
        this.#teardown(`调用超时（${op}）`)
        reject(new Error(`desktop helper 在 ${timeoutMs}ms 内没有回应（${op}），已重启 helper`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        socket.write(`${payload}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error(`无法向 desktop helper 写入请求：${error.message}`))
      }
    })
  }

  async #ensureSocket() {
    const socket = this.#socket
    if (socket && !socket.destroyed && socket.writable) return socket
    if (this.#connecting) return this.#connecting
    this.#connecting = this.#connect()
    try {
      await this.#connecting
      return this.#socket
    } finally {
      this.#connecting = undefined
    }
  }

  /**
   * 建立一条 loopback 控制通道：本进程监听 127.0.0.1 的临时端口并生成一次性 token，
   * helper 用 `--port/--token` 连进来，先发 hello 完成握手。
   * DSH 的 Windows 沙箱禁止命名管道，管道式 stdio 会直接 EPERM，所以不能用 stdin/stdout。
   */
  async #connect() {
    const helperPath = await this.#ensureBinary()
    if (this.#disposed) throw new Error('desktop helper 已关闭')
    this.#teardown()

    const token = randomUUID()
    const server = createServer()
    this.#server = server
    let settled = false
    let resolveAccepted
    let rejectAccepted
    const accepted = new Promise((resolve, reject) => {
      resolveAccepted = resolve
      rejectAccepted = reject
    })
    const guard = setTimeout(() => {
      if (settled) return
      settled = true
      rejectAccepted(new Error('desktop helper 在 15 秒内没有连上控制通道'))
    }, 15_000)

    server.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      rejectAccepted(new Error(`控制通道监听失败：${error.message}`))
    })
    server.on('connection', (socket) => {
      if (this.#socket && !this.#socket.destroyed) {
        socket.destroy()
        return
      }
      this.#adopt(
        socket,
        token,
        () => {
          if (settled) return
          settled = true
          clearTimeout(guard)
          resolveAccepted()
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(guard)
          rejectAccepted(error)
        },
      )
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port

    const child = spawn(helperPath, [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--token', token,
    ], {
      cwd: HELPER_HOME,
      stdio: 'ignore',
      windowsHide: true,
    })
    this.#child = child
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      rejectAccepted(new Error(`desktop helper 启动失败：${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#rejectAll(new Error(`desktop helper 意外退出（code=${code}, signal=${signal ?? 'none'}）`))
    })

    await accepted
    try { server.close() } catch { /* 已关闭 */ }
    this.#server = undefined
  }

  /** 接管一条新连接：先校验 hello 握手，之后按行分发响应。 */
  #adopt(socket, token, onReady, onFail) {
    socket.setEncoding('utf8')
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
    let buffer = ''
    let authenticated = false
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) {
          if (!authenticated) {
            let hello
            try { hello = JSON.parse(line) } catch { hello = undefined }
            if (hello && hello.op === 'hello' && hello.token === token) {
              authenticated = true
              this.#socket = socket
              onReady()
            } else {
              try { socket.destroy() } catch { /* 已关闭 */ }
              onFail(new Error('desktop helper 握手校验失败'))
              return
            }
          } else {
            this.#onLine(line)
          }
        }
        index = buffer.indexOf('\n')
      }
      if (buffer.length > 4 * 1024 * 1024) {
        buffer = ''
        this.#teardown('helper 输出超过 4MB')
      }
    })
    socket.on('error', () => { /* close 事件统一收尾 */ })
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = undefined
      this.#rejectAll(new Error('desktop helper 控制通道已断开'))
    })
  }

  async #ensureBinary() {
    if (!existsSync(HELPER_EXE)) {
      if (!existsSync(HELPER_SOURCE)) {
        throw new Error(`缺少 native helper：${HELPER_EXE} 与 ${HELPER_SOURCE} 都不存在`)
      }
      const compiler = CSC_CANDIDATES.find((path) => existsSync(path))
      if (!compiler) {
        throw new Error('缺少 native helper 且找不到 .NET Framework 编译器 csc.exe；请重新安装插件')
      }
      await new Promise((resolve, reject) => {
        const child = spawn(compiler, [
          '/nologo', '/target:exe', '/platform:anycpu', '/optimize+',
          `/out:${HELPER_EXE}`, HELPER_SOURCE,
          '/r:System.Web.Extensions.dll', '/r:System.Drawing.dll',
        ], { cwd: NATIVE_DIR, stdio: 'ignore', windowsHide: true })
        child.on('error', (error) => reject(new Error(`编译 native helper 失败：${error.message}`)))
        child.on('exit', (code) => {
          if (code === 0 && existsSync(HELPER_EXE)) resolve()
          else reject(new Error(`编译 native helper 失败（csc exit ${code}）；请手动运行 csc 重新生成 ${HELPER_EXE}`))
        })
      })
    }
    return this.#installRuntimeBinary()
  }

  /**
   * 把 helper 复制到 %LOCALAPPDATA% 再跑：工作区里的 exe 会被沙箱降权，导致所有输入注入静默失败。
   * 文件名带上 size+mtime，旧版本进程不会占着新文件导致复制失败。
   */
  #installRuntimeBinary() {
    mkdirSync(HELPER_HOME, { recursive: true })
    const source = statSync(HELPER_EXE)
    const name = `DesktopControl-${source.size}-${Math.round(source.mtimeMs)}.exe`
    const target = join(HELPER_HOME, name)
    if (!existsSync(target)) {
      try {
        copyFileSync(HELPER_EXE, target)
      } catch (error) {
        if (!existsSync(target)) throw new Error(`无法部署 native helper 到 ${HELPER_HOME}：${error.message}`)
      }
    }
    return target
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      try { this.#logger?.warn?.(`desktop-control: helper 输出非 JSON：${truncate(line, 300)}`) } catch { /* ignore */ }
      return
    }
    const id = typeof message?.id === 'number' ? message.id : undefined
    if (id === undefined) return
    const entry = this.#pending.get(id)
    if (!entry) return
    this.#pending.delete(id)
    clearTimeout(entry.timer)
    if (message.ok === true) {
      entry.resolve(message.result)
    } else {
      const error = new Error(String(message.error || 'desktop helper 返回失败'))
      error.name = String(message.error_type || 'HelperError')
      entry.reject(error)
    }
  }

  #rejectAll(error) {
    const entries = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  /** 关闭当前通道与子进程；reason 非空时让所有等待中的调用一起失败。 */
  #teardown(reason) {
    const socket = this.#socket
    this.#socket = undefined
    if (socket) {
      try { socket.destroy() } catch { /* 已关闭 */ }
    }
    const child = this.#child
    this.#child = undefined
    if (child) {
      try { child.kill() } catch { /* 已结束 */ }
    }
    const server = this.#server
    this.#server = undefined
    if (server) {
      try { server.close() } catch { /* 已关闭 */ }
    }
    if (reason) this.#rejectAll(new Error(`desktop helper 已重启：${reason}`))
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#teardown()
    this.#rejectAll(new Error('desktop helper 已关闭'))
  }
}

// ---------------------------------------------------------------------------
// 权限门控
// ---------------------------------------------------------------------------

function describeOutcome(outcome) {
  switch (outcome) {
    case 'rejected':
      return '主人拒绝了这个操作，已经停止。不要换一种说法绕过审批重试；需要的话先向主人说明想做什么。'
    case 'cancelled':
      return '审批被取消，操作没有执行。'
    case 'unavailable':
      return '当前会话没有可用的审批通道（unavailable），操作没有执行。'
    default:
      return `审批返回了未知结果「${outcome}」，按未授权处理，操作没有执行。`
  }
}

/**
 * 请示主人。只有 `allowed-once` 才继续；其余一律抛出，绝不放行。
 */
async function requestApproval(ctx, exec, request) {
  const approval = ctx.get('approval')
  if (!approval || typeof approval.request !== 'function') {
    throw new Error('这个操作需要主人同意，但当前部署没有审批服务，因此按拒绝处理。')
  }
  if (!exec?.agent) {
    throw new Error('这个操作需要主人同意，但这次调用没有关联的会话，因此按拒绝处理。')
  }
  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: request.toolName,
      callId: exec.callId,
      reason: request.reason,
      displayReason: { en: request.en, zh: request.zh },
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
  } catch (error) {
    if (exec.signal?.aborted) throw error
    throw new Error(`审批请求本身失败，按拒绝处理：${error?.message ?? error}`)
  }
  if (outcome === 'allowed-once') return
  throw new Error(describeOutcome(outcome))
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

/** 截图默认落盘目录。 */
const SHOTS_DIR = join(tmpdir(), 'dsh-desktop-control', 'shots')

/**
 * 校验截图目标路径：必须是 .png、不覆盖已有文件、且落在允许的目录里。
 * 之前 path 无限制，传一份 .docx 的路径就会被 PNG 覆盖，而且不走审批。
 */
function resolveScreenshotPath(requested, extraRoot) {
  const resolved = resolvePath(requested)
  if (!/\.png$/i.test(resolved)) {
    throw new Error('截图文件名必须以 .png 结尾')
  }
  if (existsSync(resolved)) {
    throw new Error(`目标文件已存在，拒绝覆盖：${resolved}`)
  }
  const roots = [SHOTS_DIR, resolvePath(process.cwd())]
  if (typeof extraRoot === 'string' && extraRoot.trim().length > 0) roots.push(resolvePath(extraRoot))
  const lower = resolved.toLowerCase()
  const allowed = roots.some((root) => {
    const base = root.toLowerCase().replace(/[\\/]+$/, '')
    return lower === base || lower.startsWith(base + '\\') || lower.startsWith(base + '/')
  })
  if (!allowed) {
    throw new Error(`截图只能写到这些目录下：${roots.join(' / ')}`)
  }
  return resolved
}

function workDirectory(cwd) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return process.cwd()
  return isAbsolute(cwd) ? cwd : resolvePath(process.cwd(), cwd)
}

function safeReadText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 杀掉整棵进程树（Windows 上 child.kill() 不会带走孙进程）。 */
function killTree(pid) {
  if (!pid) return
  try {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    // 没有 error 监听时，spawn 失败会以未捕获的 'error' 事件崩掉整个 Host。
    killer.on('error', () => { /* taskkill 不可用，调用方还会 child.kill() 兜底 */ })
  } catch {
    // 同步抛错同样忽略，调用方仍会 child.kill()。
  }
}

/**
 * 以独立 PowerShell 进程运行一段脚本，输出通过文件回收。
 * 不用管道：DSH 的 Windows 沙箱禁止命名管道，piped stdio 会 EPERM。
 * 也不用 Start-Process（受限令牌下会被拒绝）：runner 在同一进程内用 `1> / 2>` 重定向。
 * 命令写进临时 .ps1，命令里的 `exit` 最多结束这个 runner，不会带走常驻 helper。
 */
function runPowerShellScript(script, { cwd, timeoutMs = 60_000, signal } = {}) {
  const dir = join(tmpdir(), 'dsh-desktop-control', 'runs')
  mkdirSync(dir, { recursive: true })
  const id = randomUUID()
  const bodyPath = join(dir, `body-${id}.ps1`)
  const runnerPath = join(dir, `runner-${id}.ps1`)
  const outPath = join(dir, `out-${id}.txt`)
  const errPath = join(dir, `err-${id}.txt`)
  const codePath = join(dir, `code-${id}.txt`)

  // BOM + 显式 UTF-8 输出，保证中文不乱码。
  writeFileSync(
    bodyPath,
    `\uFEFF[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n$OutputEncoding = [System.Text.Encoding]::UTF8\r\n${script}\r\n`,
    'utf8',
  )
  const runner = [
    "$ErrorActionPreference = 'Continue'",
    "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
    '$exitCode = 0',
    'try {',
    `  & ${psLiteral(bodyPath)} 1> ${psLiteral(outPath)} 2> ${psLiteral(errPath)}`,
    '  if ($LASTEXITCODE -ne $null) { $exitCode = [int]$LASTEXITCODE }',
    '} catch {',
    `  $_ | Out-String | Set-Content -LiteralPath ${psLiteral(errPath)} -Encoding UTF8`,
    '  $exitCode = 1',
    '}',
    `Set-Content -LiteralPath ${psLiteral(codePath)} -Value $exitCode -Encoding Ascii`,
  ].join('\r\n')
  writeFileSync(runnerPath, `\uFEFF${runner}\r\n`, 'utf8')

  const cleanup = () => {
    for (const path of [bodyPath, runnerPath, outPath, errPath, codePath]) {
      try { unlinkSync(path) } catch { /* 可能还没生成 */ }
    }
  }

  return new Promise((resolve, reject) => {
    let timedOut = false
    let finished = false
    let timer
    let onAbort

    const finish = () => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener?.('abort', onAbort)
      const stdout = safeReadText(outPath)
      const stderr = safeReadText(errPath)
      const rawCode = safeReadText(codePath).trim()
      cleanup()
      resolve({
        exitCode: rawCode.length > 0 && Number.isFinite(Number(rawCode)) ? Number(rawCode) : null,
        signal: null,
        timedOut,
        aborted: Boolean(signal?.aborted),
        stdout: truncate(stdout, MAX_OUTPUT),
        stderr: truncate(stderr, MAX_OUTPUT),
      })
    }

    let child
    try {
      child = spawn(POWERSHELL, [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', runnerPath,
      ], {
        cwd: workDirectory(cwd),
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      cleanup()
      reject(new Error(`无法启动 PowerShell：${error.message}`))
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      try { child.kill() } catch { /* 已结束 */ }
      setTimeout(finish, 500)
    }, timeoutMs)

    onAbort = () => {
      killTree(child.pid)
      try { child.kill() } catch { /* 已结束 */ }
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.on('error', (error) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener?.('abort', onAbort)
      cleanup()
      reject(new Error(`PowerShell 启动失败：${error.message}`))
    })
    child.on('close', () => finish())
  })
}

/** 提权启动：参数来自 JSON 文件，避免任何字符串拼接注入。 */
async function launchElevated({ file, args, cwd }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${psArg(file)}`,
    `$arguments = ${psArg(args ?? '')}`,
    '$info = New-Object System.Diagnostics.ProcessStartInfo',
    '$info.FileName = $target',
    'if ($arguments.Length -gt 0) { $info.Arguments = $arguments }',
    "$info.Verb = 'runas'",
    '$info.UseShellExecute = $true',
    cwd ? `$info.WorkingDirectory = ${psArg(cwd)}` : '',
    '$process = [System.Diagnostics.Process]::Start($info)',
    "Write-Output ('elevated pid=' + $process.Id)",
  ].filter(Boolean).join('\r\n')
  return runPowerShellScript(script, { timeoutMs: 120_000 })
}

// ---------------------------------------------------------------------------
// 工具包装
// ---------------------------------------------------------------------------

function defineTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: OBJECT_SCHEMA,
      render(args, value) {
        try {
          return textBlock(def.format ? def.format(args, value) : stringify(value))
        } catch {
          return textBlock(stringify(value))
        }
      },
    },
    ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
    async execute(args, exec) {
      const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
      return def.run(safeArgs, exec)
    },
  }
}

function requireAction(args, allowed, toolName) {
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
  if (!allowed.includes(action)) {
    throw new Error(`${toolName} 的 action 必须是 ${allowed.join(' / ')} 之一，收到「${action || '(空)'}」`)
  }
  return action
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`参数 ${name} 必须是非空字符串`)
  }
  return value
}

function optionalNumber(value, name) {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`参数 ${name} 必须是数字`)
  return n
}

function combosOf(args) {
  const raw = args.keys ?? args.key
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean)
  if (typeof raw !== 'string') return []
  return raw.split(/[,，]/).map((part) => part.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export const name = 'desktop-control'
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const helper = new DesktopHelper({ logger })
  const helperTimeout = clampInt(config.helperTimeoutMs, 1000, 120_000, DEFAULT_HELPER_TIMEOUT)
  const allowedPrograms = Array.isArray(config.allowedPrograms) && config.allowedPrograms.length > 0
    ? config.allowedPrograms.map((item) => String(item))
    : DEFAULT_ALLOWED_PROGRAMS
  const call = (op, params, options) => helper.call(op, params, { timeoutMs: helperTimeout, ...options })

  try {
    logger?.info?.('desktop-control: 插件已加载')
  } catch { /* ignore */ }

  // 提示词：讲清审批规则，避免模型把「拒绝」当成「失败」。
  try {
    const systemPrompt = ctx.get('systemPrompt')
    systemPrompt?.section?.({
      name: 'tool:desktop-control',
      order: 900,
      text: '桌面操控工具（pc_pointer / pc_keyboard / pc_screen / pc_window / pc_app / pc_system）会真实操作这台电脑。'
        + '涉及管理员权限、删除文件、关机重启、系统服务、注册表写入、结束进程、启动命令解释器或任意命令时，工具会先请求主人在界面上批准；'
        + '只有主人点了同意才会执行。被拒绝是主人明确的选择：停下来向主人说明，不要换一种说法绕过审批重试。'
        + '坐标使用屏幕物理像素，原点在虚拟屏幕左上角；先 pc_screen info 确认尺寸，用 pc_window list 找到目标窗口再操作。',
    })
  } catch { /* systemPrompt 不可用时不影响工具 */ }

  // -- 后台鼠标（PostMessage，不抢前台）--------------------------------------
  const runPointerBackground = async (args, action) => {
    const hwnd = clampInt(args.hwnd, 1, Number.MAX_SAFE_INTEGER, 0)
    if (!hwnd) throw new Error('background 模式需要 hwnd（先用 pc_window list 查）')
    if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'middle_click') {
      const button = action === 'right_click'
        ? 'right'
        : action === 'middle_click'
          ? 'middle'
          : (args.button ?? 'left')
      const count = action === 'double_click' ? 2 : clampInt(args.count, 1, 3, 1)
      return call('pointer.bg_click', {
        hwnd,
        x: clampInt(args.x, 0, 100000, 0),
        y: clampInt(args.y, 0, 100000, 0),
        button,
        count,
      })
    }
    if (action === 'scroll') {
      return call('pointer.bg_scroll', {
        hwnd,
        x: clampInt(args.x, 0, 100000, 0),
        y: clampInt(args.y, 0, 100000, 0),
        dy: clampInt(args.dy, -100, 100, 0),
        dx: clampInt(args.dx, -100, 100, 0),
      })
    }
    throw new Error('background 模式只支持 click / double_click / right_click / middle_click / scroll')
  }

  // -- pc_pointer -----------------------------------------------------------
  const pointerTool = defineTool({
    name: 'pc_pointer',
    description: '控制鼠标：移动、单击/双击/右键/中键、按下/抬起、拖拽、滚轮、读取当前坐标。'
      + '坐标是屏幕物理像素（原点为虚拟屏幕左上角）。move 带 durationMs 时平滑移动；'
      + 'drag 用于拖动窗口、选中文本或在画布上划线。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'down', 'up', 'drag', 'scroll', 'position'],
          description: '要执行的鼠标动作。',
        },
        mode: {
          type: 'string',
          enum: ['foreground', 'background'],
          description: 'foreground（默认）移动真实光标；background 直接向 hwnd 投递消息，不抢前台、不动真实光标。',
        },
        hwnd: { type: 'number', description: 'background 模式的目标窗口句柄（pc_window list 可得）。' },
        x: { type: 'number', description: '目标 X 坐标（物理像素）。' },
        y: { type: 'number', description: '目标 Y 坐标（物理像素）。' },
        x2: { type: 'number', description: 'drag 的终点 X。' },
        y2: { type: 'number', description: 'drag 的终点 Y。' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '按键，默认 left。' },
        count: { type: 'number', description: 'click 的点击次数，1-3，默认 1。' },
        dy: { type: 'number', description: 'scroll 的垂直格数，正数向上、负数向下。' },
        dx: { type: 'number', description: 'scroll 的水平格数，正数向右。' },
        durationMs: { type: 'number', description: 'move/drag 的持续时间（毫秒）。move 默认瞬移，drag 默认 400。' },
      },
    },
    timeoutMs: 60_000,
    async run(args) {
      const action = requireAction(
        args,
        ['move', 'click', 'double_click', 'right_click', 'middle_click', 'down', 'up', 'drag', 'scroll', 'position'],
        'pc_pointer',
      )
      if (args.mode === 'background') {
        return runPointerBackground(args, action)
      }
      switch (action) {
        case 'position':
          return call('pointer.position', {})
        case 'move': {
          const x = optionalNumber(args.x, 'x')
          const y = optionalNumber(args.y, 'y')
          if (x === undefined || y === undefined) throw new Error('move 需要 x 与 y')
          const duration = optionalNumber(args.durationMs, 'durationMs') ?? 0
          return duration > 0
            ? call('pointer.smooth', { x, y, durationMs: duration })
            : call('pointer.move', { x, y })
        }
        case 'scroll':
          return call('pointer.scroll', {
            dy: clampInt(args.dy, -100, 100, 0),
            dx: clampInt(args.dx, -100, 100, 0),
          })
        case 'down':
        case 'up':
          return call(`pointer.${action}`, { button: args.button ?? 'left' })
        case 'drag': {
          const x1 = optionalNumber(args.x, 'x')
          const y1 = optionalNumber(args.y, 'y')
          const x2 = optionalNumber(args.x2, 'x2')
          const y2 = optionalNumber(args.y2, 'y2')
          if ([x1, y1, x2, y2].some((value) => value === undefined)) {
            throw new Error('drag 需要 x、y、x2、y2')
          }
          return call('pointer.drag', {
            x1, y1, x2, y2,
            durationMs: clampInt(args.durationMs, 0, 20_000, 400),
            button: args.button ?? 'left',
          })
        }
        default: {
          const button = action === 'right_click'
            ? 'right'
            : action === 'middle_click'
              ? 'middle'
              : (args.button ?? 'left')
          const count = action === 'double_click' ? 2 : clampInt(args.count, 1, 3, 1)
          const payload = { button, count }
          const x = optionalNumber(args.x, 'x')
          const y = optionalNumber(args.y, 'y')
          if (x !== undefined && y !== undefined) {
            payload.x = x
            payload.y = y
          }
          return call('pointer.click', payload)
        }
      }
    },
    format(args, value) {
      if (args?.action === 'position' && value && typeof value === 'object') {
        return `鼠标位置 ${value.x}, ${value.y}`
      }
      return stringify(value)
    },
  })

  // -- pc_keyboard ----------------------------------------------------------
  const keyboardTool = defineTool({
    name: 'pc_keyboard',
    description: '控制键盘：输入任意文本（含中文与 emoji）、发送组合键、按住/松开单键。'
      + '组合键写成 "ctrl+shift+s"、"alt+f4"、"win+r"、"enter"、"esc"；多个组合键用逗号分隔。'
      + '文本默认走剪贴板粘贴（写剪贴板 → Ctrl+V → 恢复原剪贴板），这是唯一不受中文输入法干扰的方式；'
      + 'method=unicode 用底层字符注入，只在目标程序不接受粘贴时使用（中文输入法开着时会被吃成拼音）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['type', 'press', 'down', 'up'], description: '键盘动作。' },
        mode: {
          type: 'string',
          enum: ['foreground', 'background'],
          description: 'foreground（默认）发给当前前台窗口；background 直接向 hwnd 投递消息，不抢前台。',
        },
        hwnd: { type: 'number', description: 'background 模式的目标窗口句柄。' },
        text: { type: 'string', description: 'type 要输入的文本，支持中文、emoji 与换行。' },
        keys: {
          type: 'string',
          description: 'press 的组合键；多个组合键用逗号分隔，如 "ctrl+s, enter"。',
        },
        key: { type: 'string', description: 'down/up 的单个键名，如 "shift"、"ctrl"、"a"、"f5"。' },
        method: {
          type: 'string',
          enum: ['clipboard', 'unicode'],
          description: 'type 的输入方式：clipboard（默认，可靠）/ unicode（底层注入，可能被输入法拦截）。',
        },
        intervalMs: { type: 'number', description: 'type 的字符间隔（毫秒），仅 unicode 模式有效，默认 0。' },
      },
    },
    timeoutMs: 120_000,
    async run(args) {
      const action = requireAction(args, ['type', 'press', 'down', 'up'], 'pc_keyboard')
      if (args.mode === 'background') {
        const hwnd = clampInt(args.hwnd, 1, Number.MAX_SAFE_INTEGER, 0)
        if (!hwnd) throw new Error('background 模式需要 hwnd')
        if (action === 'type') {
          const text = typeof args.text === 'string' ? args.text : ''
          if (text.length === 0) throw new Error('type 需要非空 text')
          return call('keyboard.bg_type', { hwnd, text }, { timeoutMs: Math.max(helperTimeout, 5000 + text.length * 20) })
        }
        if (action === 'press') {
          const combos = combosOf(args)
          if (combos.length === 0) throw new Error('press 需要至少一个组合键（keys）')
          return call('keyboard.bg_press', { hwnd, combos })
        }
        throw new Error('background 模式只支持 type / press')
      }
      if (action === 'type') {
        const text = typeof args.text === 'string' ? args.text : ''
        if (text.length === 0) throw new Error('type 需要非空 text')
        return call('keyboard.type', {
          text,
          method: args.method === 'unicode' ? 'unicode' : 'clipboard',
          intervalMs: clampInt(args.intervalMs, 0, 1000, 0),
        }, { timeoutMs: Math.max(helperTimeout, 8000 + text.length * 40) })
      }
      if (action === 'press') {
        const combos = combosOf(args)
        if (combos.length === 0) throw new Error('press 需要至少一个组合键（keys）')
        return call('keyboard.press', { combos })
      }
      const key = requireString(args.key, 'key')
      return call(`keyboard.${action}`, { key })
    },
  })

  // -- pc_screen ------------------------------------------------------------
  const screenTool = defineTool({
    name: 'pc_screen',
    description: '查看屏幕：info 返回分辨率、光标位置与前台窗口；grab 截图保存为 PNG，返回路径与尺寸。'
      + '默认抓整个虚拟桌面（多显示器全覆盖），也可只截窗口或矩形区域。'
      + '要真正「看」图，用 read_image 工具打开返回的路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['info', 'grab'], description: 'info 查屏幕信息，grab 截图。' },
        background: {
          type: 'boolean',
          description: 'grab 时配合 hwnd 使用 PrintWindow 截取后台窗口，不需要窗口在前台、也不会被其他窗口遮挡。',
        },
        path: { type: 'string', description: 'grab 的保存路径；默认放在临时目录。' },
        hwnd: { type: 'number', description: '只截这个窗口。' },
        title: { type: 'string', description: '按标题截窗口（子串匹配，不区分大小写）。' },
        region: {
          type: 'object',
          description: '只截这个矩形区域（物理像素）。',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          required: ['x', 'y', 'w', 'h'],
          additionalProperties: false,
        },
      },
    },
    timeoutMs: 60_000,
    async run(args) {
      const action = requireAction(args, ['info', 'grab'], 'pc_screen')
      if (action === 'info') return call('screen.info', {})
      if (args.background === true) {
        const hwnd = clampInt(args.hwnd, 1, Number.MAX_SAFE_INTEGER, 0)
        if (!hwnd) throw new Error('background 截图需要 hwnd')
        const dir = join(tmpdir(), 'dsh-desktop-control', 'shots')
        mkdirSync(dir, { recursive: true })
        const requested = typeof args.path === 'string' && args.path.trim().length > 0
          ? args.path.trim()
          : join(dir, `window-${Date.now()}.png`)
        const path = resolveScreenshotPath(requested, config.screenshotDir)
        return call('screen.bg_grab', { hwnd, path }, { timeoutMs: Math.max(helperTimeout, 30_000) })
      }
      const region = args.region && typeof args.region === 'object'
        ? {
          x: clampInt(args.region.x, -32768, 32768, 0),
          y: clampInt(args.region.y, -32768, 32768, 0),
          w: clampInt(args.region.w, 1, 20000, 1),
          h: clampInt(args.region.h, 1, 20000, 1),
        }
        : undefined
      const payload = {}
      if (region) payload.region = region
      const dir = join(tmpdir(), 'dsh-desktop-control', 'shots')
      mkdirSync(dir, { recursive: true })
      const requested = typeof args.path === 'string' && args.path.trim().length > 0
        ? args.path.trim()
        : join(dir, `screen-${Date.now()}.png`)
      payload.path = resolveScreenshotPath(requested, config.screenshotDir)
      if (region === undefined) {
        if (args.hwnd !== undefined) {
          payload.hwnd = clampInt(args.hwnd, 1, Number.MAX_SAFE_INTEGER, 0)
        } else if (typeof args.title === 'string' && args.title.trim().length > 0) {
          const windows = await call('window.list', {})
          const needle = args.title.trim().toLowerCase()
          const match = (windows.windows || []).find((row) => String(row.title || '').toLowerCase().includes(needle))
          if (!match) throw new Error(`没有标题包含「${args.title}」的可见窗口`)
          payload.hwnd = match.hwnd
        }
      }
      return call('screen.grab', payload, { timeoutMs: Math.max(helperTimeout, 30_000) })
    },
    format(_args, value) {
      if (value && typeof value === 'object' && value.path) {
        return `截图已保存：${value.path}\n尺寸：${value.width}x${value.height}，原点：${(value.origin || []).join(', ')}`
      }
      return stringify(value)
    },
  })

  // -- pc_window ------------------------------------------------------------
  const windowTool = defineTool({
    name: 'pc_window',
    description: '管理窗口：列出所有可见窗口（句柄、进程、标题、位置、是否前台）、激活到前台、'
      + '最小化/最大化/还原、发送关闭、移动、调整大小。以 hwnd 最精确，也可用标题子串或 pid 定位。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'],
          description: '窗口动作。',
        },
        hwnd: { type: 'number', description: '窗口句柄（pc_window list 返回的 hwnd）。' },
        title: { type: 'string', description: '窗口标题子串（不区分大小写）。' },
        pid: { type: 'number', description: '进程 id。' },
        x: { type: 'number', description: 'move 的目标 X。' },
        y: { type: 'number', description: 'move 的目标 Y。' },
        width: { type: 'number', description: 'resize 的宽度。' },
        height: { type: 'number', description: 'resize 的高度。' },
      },
    },
    timeoutMs: 45_000,
    async run(args) {
      const action = requireAction(
        args,
        ['list', 'focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'],
        'pc_window',
      )
      if (action === 'list') {
        const result = await call('window.list', {})
        if (typeof args.title === 'string' && args.title.trim().length > 0) {
          const needle = args.title.trim().toLowerCase()
          result.windows = (result.windows || []).filter((row) => String(row.title || '').toLowerCase().includes(needle))
          result.count = result.windows.length
        }
        return result
      }
      const target = {}
      if (args.hwnd !== undefined) target.hwnd = clampInt(args.hwnd, 1, Number.MAX_SAFE_INTEGER, 0)
      if (typeof args.title === 'string' && args.title.trim().length > 0) target.title = args.title.trim()
      if (args.pid !== undefined) target.pid = clampInt(args.pid, 1, Number.MAX_SAFE_INTEGER, 0)
      if (target.hwnd === undefined && target.title === undefined && target.pid === undefined) {
        throw new Error('需要 hwnd、title 或 pid 之一来定位窗口')
      }
      switch (action) {
        case 'focus':
          return call('window.focus', target)
        case 'move':
          return call('window.move', {
            ...target,
            x: clampInt(args.x, -32768, 32768, 0),
            y: clampInt(args.y, -32768, 32768, 0),
          })
        case 'resize':
          return call('window.resize', {
            ...target,
            width: clampInt(args.width, 1, 20000, 800),
            height: clampInt(args.height, 1, 20000, 600),
          })
        default:
          return call(`window.${action}`, target)
      }
    },
    format(_args, value) {
      if (value && Array.isArray(value.windows)) {
        if (value.windows.length === 0) return '当前没有可见窗口。'
        return value.windows.map((row) => {
          const mark = row.foreground ? '*' : ' '
          return `${mark} hwnd=${row.hwnd} pid=${row.pid} [${row.state}] ${row.x},${row.y} ${row.width}x${row.height}  ${row.title}`
        }).join('\n')
      }
      return stringify(value)
    },
  })

  // -- pc_app ---------------------------------------------------------------
  const appTool = defineTool({
    name: 'pc_app',
    description: '启动和管理程序：launch 打开程序、文件、文件夹或网址（走 Windows 文件关联）；'
      + 'list 列出正在运行的进程；kill 结束进程。'
      + '启动命令解释器（cmd/powershell 等）或脚本文件、以及结束进程，都会先请主人批准。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['launch', 'list', 'kill'], description: '程序动作。' },
        target: { type: 'string', description: 'launch 的目标：exe 路径、文档、文件夹或 https:// 网址。' },
        args: { type: 'string', description: 'launch 传给程序的命令行参数。' },
        cwd: { type: 'string', description: 'launch 的工作目录。' },
        filter: { type: 'string', description: 'list 按进程名过滤（子串，不区分大小写）。' },
        pid: { type: 'number', description: 'kill 的进程 id。' },
        processName: { type: 'string', description: 'kill 的进程名（子串匹配，会结束所有匹配项）。' },
        justification: { type: 'string', description: '危险动作的一句话理由，会显示给主人。' },
      },
    },
    timeoutMs: 60_000,
    async run(args, exec) {
      const action = requireAction(args, ['launch', 'list', 'kill'], 'pc_app')
      if (action === 'list') {
        return call('app.list', {
          ...(typeof args.filter === 'string' && args.filter.trim() ? { filter: args.filter.trim() } : {}),
        })
      }
      if (action === 'launch') {
        const target = requireString(args.target, 'target')
        const extraArgs = typeof args.args === 'string' && args.args.length > 0 ? args.args : undefined
        const risk = classifyLaunch(target, extraArgs, allowedPrograms)
        if (!risk.safe) {
          const justification = typeof args.justification === 'string' ? args.justification.trim() : ''
          await requestApproval(ctx, exec, {
            toolName: 'pc_app',
            reason: `launch ${target} ${extraArgs ?? ''} (${risk.why})`.trim(),
            zh: `要启动：\n${target}${extraArgs ? ` ${extraArgs}` : ''}\n\n原因：${risk.why}${justification ? `\n理由：${justification}` : ''}`,
            en: `Launch ${target}${extraArgs ? ` ${extraArgs}` : ''} (${risk.why})`,
          })
        }
        return call('app.launch', {
          target,
          ...(extraArgs ? { args: extraArgs } : {}),
          ...(typeof args.cwd === 'string' && args.cwd.trim() ? { cwd: args.cwd.trim() } : {}),
        })
      }
      const pid = args.pid === undefined ? undefined : clampInt(args.pid, 1, Number.MAX_SAFE_INTEGER, 0)
      const processName = typeof args.processName === 'string' && args.processName.trim()
        ? args.processName.trim()
        : undefined
      if (pid === undefined && processName === undefined) throw new Error('kill 需要 pid 或 processName')
      const justification = typeof args.justification === 'string' && args.justification.trim()
        ? args.justification.trim()
        : ''

      // 先解析真实命中名单，让主人看到自己到底在批准什么；并保护 helper 与宿主进程。
      const protectPids = [process.pid]
      if (typeof process.ppid === 'number' && process.ppid > 0) protectPids.push(process.ppid)
      let targets
      if (pid !== undefined) {
        const listed = await call('app.list', {})
        const found = (listed.processes || []).find((row) => Number(row.pid) === Number(pid))
        targets = [{ pid, name: found?.name ?? '(未知进程)' }]
      } else {
        const listed = await call('app.list', { filter: processName })
        targets = (listed.processes || []).filter(
          (row) => String(row.name || '').toLowerCase() === processName.toLowerCase(),
        )
        if (targets.length === 0) throw new Error(`没有名为「${processName}」的进程在运行`)
      }
      const summary = targets.slice(0, 20).map((row) => `${row.pid}  ${row.name}`).join('\n')
      const more = targets.length > 20 ? `\n…还有 ${targets.length - 20} 个` : ''
      await requestApproval(ctx, exec, {
        toolName: 'pc_app',
        reason: `terminate ${targets.length} process(es): ${targets.map((row) => row.pid).join(', ')}`,
        zh: `要结束以下 ${targets.length} 个进程：\n${summary}${more}${justification ? `\n理由：${justification}` : ''}`,
        en: `Terminate ${targets.length} process(es): ${targets.slice(0, 20).map((row) => row.pid).join(', ')}`,
      })
      return call('app.kill', {
        ...(pid !== undefined ? { pid } : {}),
        ...(processName !== undefined ? { name: processName } : {}),
        protectPids,
      })
    },
    format(_args, value) {
      if (value && Array.isArray(value.processes)) {
        if (value.processes.length === 0) return '没有匹配的进程。'
        return value.processes
          .map((row) => `${row.pid}\t${row.name}\t${row.memoryMb ?? '?'}MB\t${row.title || ''}`.trimEnd())
          .join('\n')
      }
      return stringify(value)
    },
  })

  // -- pc_system ------------------------------------------------------------
  const systemTool = defineTool({
    name: 'pc_system',
    description: '系统级操作：环境信息、剪贴板读写、音量、锁屏、执行命令、管理员提权、关机/重启/注销、'
      + '系统服务、注册表。凡是要改动系统的动作都会先请主人批准；只读命令（白名单内）可直接执行。'
      + 'exec 使用 PowerShell 语法并跑在独立进程里；admin 需要「可执行文件路径 + 参数」，会触发 UAC。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['info', 'clipboard_get', 'clipboard_set', 'volume', 'mute', 'lock', 'exec', 'admin', 'power', 'service', 'registry'],
          description: '系统动作。',
        },
        text: { type: 'string', description: 'clipboard_set 要写入的文本。' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'volume 的方向。' },
        times: { type: 'number', description: 'volume 调整的档数，1-50，默认 1。' },
        command: { type: 'string', description: 'exec 的 PowerShell 命令；admin 的「可执行文件路径 + 参数」。' },
        cwd: { type: 'string', description: 'exec/admin 的工作目录。' },
        timeoutMs: { type: 'number', description: 'exec 的超时毫秒数，默认 60000。' },
        power: {
          type: 'string',
          enum: ['shutdown', 'restart', 'logoff', 'sleep', 'hibernate', 'abort'],
          description: 'power 的具体动作。abort 取消已经排定的关机。',
        },
        serviceName: { type: 'string', description: 'service 的服务名。' },
        serviceAction: { type: 'string', enum: ['start', 'stop', 'restart', 'status'], description: 'service 的动作。' },
        registryKey: { type: 'string', description: 'registry 的注册表路径，如 HKLM:\\SOFTWARE\\Vendor\\App' },
        registryAction: { type: 'string', enum: ['read', 'write', 'delete'], description: 'registry 动作。' },
        registryName: { type: 'string', description: 'registry 的键值名。' },
        registryValue: { type: 'string', description: 'registry write 的值。' },
        justification: { type: 'string', description: '危险动作的一句话理由，会显示给主人。' },
      },
    },
    timeoutMs: 180_000,
    async run(args, exec) {
      const action = requireAction(
        args,
        ['info', 'clipboard_get', 'clipboard_set', 'volume', 'mute', 'lock', 'exec', 'admin', 'power', 'service', 'registry'],
        'pc_system',
      )
      const justification = typeof args.justification === 'string' && args.justification.trim()
        ? args.justification.trim()
        : ''

      switch (action) {
        case 'info':
          return call('system.info', {})
        case 'clipboard_get':
          return call('system.clipboard_get', {})
        case 'clipboard_set': {
          const text = typeof args.text === 'string' ? args.text : ''
          if (text.length === 0) throw new Error('clipboard_set 需要非空 text')
          return call('system.clipboard_set', { text })
        }
        case 'volume':
          return call('system.volume', {
            direction: args.direction === 'down' ? 'down' : 'up',
            times: clampInt(args.times, 1, 50, 1),
          })
        case 'mute':
          return call('system.mute', {})
        case 'lock':
          return call('system.lock', {})
        case 'exec': {
          const command = requireString(args.command, 'command')
          const risk = classifyCommand(command)
          if (!risk.safe) {
            await requestApproval(ctx, exec, {
              toolName: 'pc_system',
              reason: `run command: ${command} (${risk.why})`,
              zh: `要在这台电脑上执行命令：\n${command}\n\n原因：${risk.why}${justification ? `\n理由：${justification}` : ''}`,
              en: `Run a command on this PC: ${command} (${risk.why})`,
            })
          }
          return runPowerShellScript(command, {
            cwd: typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined,
            timeoutMs: clampInt(args.timeoutMs, 1000, 600_000, 60_000),
            signal: exec.signal,
          })
        }
        case 'admin': {
          const command = requireString(args.command, 'command').trim()
          if (/[\r\n]/.test(command)) throw new Error('admin 的命令不能包含换行')
          const spaceIndex = command.indexOf(' ')
          const file = spaceIndex > 0 ? command.slice(0, spaceIndex) : command
          const rest = spaceIndex > 0 ? command.slice(spaceIndex + 1) : ''
          if (!isAbsolute(file) && /[\\/]/.test(file)) {
            throw new Error('admin 的可执行文件必须是绝对路径或 PATH 中的名字')
          }
          await requestApproval(ctx, exec, {
            toolName: 'pc_system',
            reason: `run elevated: ${command}`,
            zh: `要以管理员权限启动：\n${command}\n\n这会触发 UAC 提权。${justification ? `\n理由：${justification}` : ''}`,
            en: `Start with administrator rights: ${command}`,
          })
          const result = await launchElevated({
            file,
            args: rest,
            cwd: typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined,
          })
          return { ...result, elevated: result.exitCode === 0 }
        }
        case 'power': {
          const kind = String(args.power || '').trim().toLowerCase()
          const labels = {
            shutdown: '关机',
            restart: '重启',
            logoff: '注销当前用户',
            sleep: '睡眠',
            hibernate: '休眠',
          }
          if (!['shutdown', 'restart', 'logoff', 'sleep', 'hibernate', 'abort'].includes(kind)) {
            throw new Error('power 必须是 shutdown / restart / logoff / sleep / hibernate / abort')
          }
          if (kind === 'abort') {
            return runPowerShellScript('shutdown.exe /a', { timeoutMs: 20_000, signal: exec.signal })
          }
          await requestApproval(ctx, exec, {
            toolName: 'pc_system',
            reason: `power ${kind}`,
            zh: `要执行电源操作：${labels[kind]}${justification ? `\n理由：${justification}` : ''}`,
            en: `Perform power action: ${kind}`,
          })
          const script = {
            shutdown: 'shutdown.exe /s /t 0',
            restart: 'shutdown.exe /r /t 0',
            logoff: 'shutdown.exe /l',
            sleep: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
            hibernate: 'shutdown.exe /h',
          }[kind]
          return runPowerShellScript(script, { timeoutMs: 30_000, signal: exec.signal })
        }
        case 'service': {
          const serviceName = requireString(args.serviceName, 'serviceName')
          const serviceAction = String(args.serviceAction || 'status').trim().toLowerCase()
          if (!['start', 'stop', 'restart', 'status'].includes(serviceAction)) {
            throw new Error('serviceAction 必须是 start / stop / restart / status')
          }
          if (serviceAction !== 'status') {
            const labels = { start: '启动', stop: '停止', restart: '重启' }
            await requestApproval(ctx, exec, {
              toolName: 'pc_system',
              reason: `system service ${serviceAction}: ${serviceName}`,
              zh: `要${labels[serviceAction]}系统服务：${serviceName}${justification ? `\n理由：${justification}` : ''}`,
              en: `System service ${serviceAction}: ${serviceName}`,
            })
          }
          const quoted = psArg(serviceName)
          const script = serviceAction === 'status'
            ? `Get-Service -Name ${quoted} -ErrorAction Stop | Format-List Name, DisplayName, Status, StartType`
            : `$verb = ${psArg(serviceAction)}; `
              + `if ($verb -eq 'start') { Start-Service -Name ${quoted} -ErrorAction Stop } `
              + `elseif ($verb -eq 'stop') { Stop-Service -Name ${quoted} -Force -ErrorAction Stop } `
              + `else { Restart-Service -Name ${quoted} -Force -ErrorAction Stop }; `
              + `Start-Sleep -Milliseconds 400; `
              + `Get-Service -Name ${quoted} | Format-List Name, Status`
          return runPowerShellScript(script, { timeoutMs: 90_000, signal: exec.signal })
        }
        case 'registry': {
          const key = requireString(args.registryKey, 'registryKey')
          const registryAction = String(args.registryAction || 'read').trim().toLowerCase()
          if (!['read', 'write', 'delete'].includes(registryAction)) {
            throw new Error('registryAction 必须是 read / write / delete')
          }
          const name = typeof args.registryName === 'string' && args.registryName.trim()
            ? args.registryName.trim()
            : undefined
          const quotedKey = psArg(key)
          let script
          if (registryAction === 'read') {
            script = name
              ? `Get-ItemProperty -Path ${quotedKey} -Name ${psArg(name)} -ErrorAction Stop | Format-List`
              : `Get-ItemProperty -Path ${quotedKey} -ErrorAction Stop | Format-List`
          } else {
            // 先校验再审批：让主人批准一个注定失败的操作很糟糕。
            if (!name) throw new Error('写或删注册表必须提供 registryName')
            await requestApproval(ctx, exec, {
              toolName: 'pc_system',
              reason: `registry ${registryAction}: ${key}${name ? ` (${name})` : ''}`,
              zh: `要${registryAction === 'write' ? '写入' : '删除'}注册表：\n${key}${name ? `\\${name}` : ''}${justification ? `\n理由：${justification}` : ''}`,
              en: `Registry ${registryAction}: ${key}${name ? ` (${name})` : ''}`,
            })
            script = registryAction === 'write'
              ? `Set-ItemProperty -Path ${quotedKey} -Name ${psArg(name)} -Value ${psArg(String(args.registryValue ?? ''))} -Type String -ErrorAction Stop; Write-Output 'registry value written'`
              : `Remove-ItemProperty -Path ${quotedKey} -Name ${psArg(name)} -ErrorAction Stop; Write-Output 'registry value removed'`
          }
          return runPowerShellScript(script, { timeoutMs: 45_000, signal: exec.signal })
        }
        default:
          throw new Error(`未处理的系统动作：${action}`)
      }
    },
    format(_args, value) {
      if (value && typeof value === 'object' && 'exitCode' in value && 'stdout' in value) {
        const parts = []
        if (value.stdout) parts.push(String(value.stdout).trimEnd())
        if (value.stderr) parts.push(`[stderr]\n${String(value.stderr).trimEnd()}`)
        parts.push(`[exit code: ${value.exitCode ?? 'null'}]${value.timedOut ? ' [timed out]' : ''}`)
        return parts.filter(Boolean).join('\n')
      }
      return stringify(value)
    },
  })

  // -- pc_batch：一次调用跑完一串动作 --------------------------------------
  const runStep = async (step, op, exec) => {
    switch (op) {
      case 'move': {
        const duration = clampInt(step.durationMs, 0, 60_000, 0)
        const x = clampInt(step.x, -100000, 100000, 0)
        const y = clampInt(step.y, -100000, 100000, 0)
        return duration > 0 ? call('pointer.smooth', { x, y, durationMs: duration }) : call('pointer.move', { x, y })
      }
      case 'click': {
        const payload = { button: step.button ?? 'left', count: clampInt(step.count, 1, 3, 1) }
        if (step.x !== undefined && step.y !== undefined) {
          payload.x = clampInt(step.x, -100000, 100000, 0)
          payload.y = clampInt(step.y, -100000, 100000, 0)
        }
        return call('pointer.click', payload)
      }
      case 'type': {
        const text = String(step.text ?? '')
        if (text.length === 0) throw new Error('type 需要 text')
        return call('keyboard.type', { text, method: step.method === 'unicode' ? 'unicode' : 'clipboard' })
      }
      case 'press': {
        const combos = String(step.keys ?? '').split(/[,，]/).map((part) => part.trim()).filter(Boolean)
        if (combos.length === 0) throw new Error('press 需要 keys')
        return call('keyboard.press', { combos })
      }
      case 'key':
        return call(`keyboard.${step.action === 'up' ? 'up' : 'down'}`, { key: requireString(step.key, 'key') })
      case 'wait': {
        const ms = clampInt(step.ms, 0, 120_000, 200)
        await new Promise((resolve) => {
          const signal = exec?.signal
          if (signal?.aborted) { resolve(); return }
          const timer = setTimeout(done, ms)
          function done() {
            clearTimeout(timer)
            signal?.removeEventListener?.('abort', done)
            resolve()
          }
          signal?.addEventListener?.('abort', done, { once: true })
        })
        if (exec?.signal?.aborted) throw new Error('操作已被取消')
        return { waited: true }
      }
      case 'focus': {
        const target = {}
        if (step.hwnd !== undefined) target.hwnd = clampInt(step.hwnd, 1, Number.MAX_SAFE_INTEGER, 0)
        if (typeof step.title === 'string' && step.title.trim()) target.title = step.title.trim()
        if (target.hwnd === undefined && target.title === undefined) throw new Error('focus 需要 hwnd 或 title')
        return call('window.focus', target)
      }
      case 'scroll':
        return call('pointer.scroll', {
          dy: clampInt(step.dy, -100, 100, 0),
          dx: clampInt(step.dx, -100, 100, 0),
        })
      default:
        throw new Error(`未知动作：${op}`)
    }
  }

  const batchTool = defineTool({
    name: 'pc_batch',
    description: '一次调用按顺序执行一串动作：move / click / type / press / key / wait / focus / scroll。'
      + '把「移过去→点开→输入→回车」这种连贯操作放进一个 steps 数组，一次完成，比多次单独调用快得多。'
      + '任何一步失败会立刻停下并报告是第几步。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          description: '动作数组，按顺序执行，最多 200 步。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              op: { type: 'string', enum: ['move', 'click', 'type', 'press', 'key', 'wait', 'focus', 'scroll'], description: '动作类型。' },
              x: { type: 'number', description: 'move/click 的 X。' },
              y: { type: 'number', description: 'move/click 的 Y。' },
              durationMs: { type: 'number', description: 'move 的持续时间。' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
              count: { type: 'number' },
              text: { type: 'string', description: 'type 的文本。' },
              method: { type: 'string', enum: ['clipboard', 'unicode'] },
              keys: { type: 'string', description: 'press 的组合键。' },
              key: { type: 'string', description: 'key 的单个键名。' },
              action: { type: 'string', enum: ['down', 'up'] },
              ms: { type: 'number', description: 'wait 的毫秒数。' },
              hwnd: { type: 'number', description: 'focus 的窗口句柄。' },
              title: { type: 'string', description: 'focus 的窗口标题。' },
              dy: { type: 'number' },
              dx: { type: 'number' },
            },
          },
        },
      },
    },
    timeoutMs: 300_000,
    async run(args, exec) {
      const steps = Array.isArray(args.steps) ? args.steps : []
      if (steps.length === 0) throw new Error('steps 不能为空')
      if (steps.length > 200) throw new Error('steps 最多 200 步')
      const results = []
      for (let index = 0; index < steps.length; index++) {
        if (exec?.signal?.aborted) {
          throw new Error(`操作已被取消：在第 ${index + 1} 步之前停止，已完成 ${results.filter((row) => row.ok).length} 步`)
        }
        const step = steps[index] && typeof steps[index] === 'object' ? steps[index] : {}
        const op = String(step.op || '').trim().toLowerCase()
        try {
          const value = await runStep(step, op, exec)
          results.push({ index, op, ok: true, result: value })
        } catch (error) {
          results.push({ index, op, ok: false, error: error.message })
          throw new Error(`第 ${index + 1} 步（${op || '?'}）失败：${error.message}；已完成 ${results.filter((row) => row.ok).length} 步`)
        }
      }
      return { steps: results, count: results.length }
    },
    format(_args, value) {
      if (value && Array.isArray(value.steps)) {
        return value.steps.map((row) => `${row.ok ? 'ok  ' : 'FAIL'} ${row.index + 1}. ${row.op}${row.ok ? '' : ` — ${row.error}`}`).join('\n')
      }
      return stringify(value)
    },
  })

  for (const tool of [pointerTool, keyboardTool, screenTool, windowTool, appTool, systemTool, batchTool]) {
    ctx.tools.register(tool)
  }
  try {
    logger?.info?.('desktop-control: 已注册 6 个桌面操控工具')
  } catch { /* ignore */ }

  // helper 生命周期跟随插件：卸载时结束子进程，避免留下孤儿。
  ctx.effect(() => () => {
    helper.dispose()
  })
}
