# 桌面操控（Desktop control）

让模型真实操作这台 Windows 电脑：移动鼠标、点击、打字、截图、切换窗口、启动程序、执行系统命令。

**危险动作不会偷偷执行。** 凡是需要管理员权限、会删除或改动文件系统、关机能重启、动系统服务、写注册表、结束进程、或启动命令解释器的请求，插件都会先向主人发起一次审批；只有主人在界面上点了「同意」才会真正执行，其余结果（拒绝、取消、没有审批通道）一律按拒绝处理，不做任何操作。

## 七个工具

| 工具 | 能力 |
|---|---|
| `pc_pointer` | 移动、单击/双击/右键/中键、按下/抬起、拖拽、滚轮、读取光标坐标 |
| `pc_keyboard` | 输入任意文本（中文、emoji、换行）、组合键（`ctrl+shift+s`）、按住/松开单键 |
| `pc_screen` | 屏幕信息（分辨率、光标、前台窗口）、截图保存为 PNG（全屏/窗口/区域/后台窗口） |
| `pc_window` | 列出可见窗口、激活到前台、最小化/最大化/还原、关闭、移动、调整大小 |
| `pc_app` | 启动程序/文件/文件夹/网址、列出进程、结束进程 |
| `pc_system` | 环境信息、剪贴板、音量、锁屏、执行命令、管理员提权、关机/重启/注销、系统服务、注册表 |
| `pc_batch` | **一次调用执行一串动作**（move/click/type/press/key/wait/focus/scroll），最多 200 步 |

## 前台 · 后台两种模式

**前台模式（默认）** 移动真实光标、发送真实按键，适合需要真实输入焦点的场景。

**后台模式（`mode: "background"` + `hwnd`）** 直接向目标窗口投递消息：

- `pc_pointer` `mode: background` —— 点击/滚轮不移动真实光标、不抢前台
- `pc_keyboard` `mode: background` —— 文字投递给窗口里**真正获得焦点的子控件**（不是顶层窗口）
- `pc_screen` `background: true, hwnd` —— 用 `PrintWindow` 抓后台窗口，被别的窗口遮住也能截

适用：传统 Win32 控件、WinForms/WPF、老式桌面程序。
**不适用**：Chromium/Electron/UWP 这类不读父窗口消息的应用——消息能投出去，但它们不会反应。这种情况请用前台模式。

## 为什么要有 `pc_batch`

每次单独调用工具都要一次模型往返（几秒）。把「移过去 → 点开 → 输入 → 回车」写成 `steps` 数组，一次调用内部串行执行完，整体耗时从「N × 几秒」压到「几十毫秒 + 一个往返」。

```json
{ "steps": [
  { "op": "focus", "hwnd": 123456 },
  { "op": "wait", "ms": 300 },
  { "op": "click", "x": 960, "y": 510 },
  { "op": "type", "text": "你好，世界" },
  { "op": "press", "keys": "enter" }
] }
```

## 审批怎么触发

| 动作 | 是否需要主人点同意 |
|---|---|
| 鼠标、键盘、截图、读屏幕信息 | 不需要 |
| 窗口列出/激活/最小化/最大化/还原/关闭/移动/缩放 | 不需要 |
| 启动白名单里的 GUI 程序（notepad、calc、浏览器、编辑器…）、文档、网址 | 不需要 |
| 启动其余任何程序：命令解释器、任意路径的 exe、脚本文件、未登记的程序 | **需要** |
| 结束进程 | **需要** |
| `pc_system exec` 执行命令 | 只读白名单命令（`dir`、`ipconfig`、`whoami`、`tasklist`、`Get-Process` 等且不含管道/重定向）免审；其余全部**需要** |
| `pc_system admin` 管理员提权 | **需要**（还会再弹一次系统 UAC） |
| 关机 / 重启 / 注销 / 睡眠 / 休眠 | **需要**（取消关机免审） |
| 启动/停止/重启系统服务 | **需要**（只查状态免审） |
| 写注册表 / 删注册表项 | **需要**（读免审） |

删除文件的路径只有 `pc_system exec`（命令不在白名单）和 `pc_system admin`，两者都走审批。

## 输入方式说明

文本输入默认走**剪贴板粘贴**：把文本写进剪贴板 → 发 `Ctrl+V` → 把原剪贴板内容写回去。这是唯一不会被中文输入法吃掉的路径——底层 UNICODE 字符注入在中文输入法开启时会被当成拼音输入（`中文测试` 会变成候选字）。

需要绕过剪贴板时（例如目标控件禁用粘贴），传 `method: "unicode"` 走底层字符注入；此时请先把系统输入法切到英文。

## 已知边界

- **键盘输入不做内容审查**：它等价于主人亲自打字，主人能在屏幕上看到全过程。工具层面的审批只覆盖「工具直接执行」的危险动作。
- 键鼠注入要求 helper 与目标窗口处于同一完整性级别；宿主被降权时 `SendInput` 会被系统拒绝，工具会明确报错而不是假装成功。
- 剪贴板模式会短暂占用剪贴板（完成输入后恢复原内容）。
- 坐标是**物理像素**（PerMonitorV2），原点为虚拟屏幕左上角；150% 缩放下也与截图一致。
- 需要 Windows 10/11 与 .NET Framework 4.x（Windows 自带）。native helper 已随包编译好，缺失时会尝试用系统自带的 `csc.exe` 重新编译。

## 实现要点（踩过的坑）

1. **helper 不能从工作区运行**：DSH 沙箱会对工作区路径下的 exe 降权，`SetCursorPos`/`SendInput` 全部静默失败。插件启动时把 exe 复制到 `%LOCALAPPDATA%\dsh-desktop-control\` 再从那里启动。
2. **`SetCursorPos` 可能被 hook 拒绝**（返回 FALSE、错误码 0），所以移动优先用 `SendInput` 的绝对坐标，`SetCursorPos` 只作兜底。
3. **DPI 必须进程级 + 线程级都设**：只设一个会让 `SendInput` 的绝对坐标按系统 DPI 虚拟化，表现为「移 960 却停在 686」。
4. **后台打字要投给焦点子控件**：`GetGUIThreadInfo` 拿到 `hwndFocus`，否则消息到了 Form 就被吞掉。
5. **通信走 TCP loopback**：沙箱禁止命名管道，管道式 stdio 会 `spawn EPERM`。
6. **不用 `Start-Process`**：受限令牌下会被拒绝，命令执行改成同进程 `1> / 2>` 重定向 + 文件回收。
7. `Process.MainWindowTitle` 会阻塞到窗口创建，足以让 `launch` 超时，不要读；`.exe` 目标用 `UseShellExecute=false` 直启。

## 典型用法

```
pc_screen info                                  # 看分辨率与前台窗口
pc_window list                                  # 找到目标窗口
pc_batch steps: [focus, click, type, enter]     # 一次完成整套操作
pc_pointer click x:400 y:300                    # 点一下
pc_pointer mode:background hwnd:123 click x:40 y:60   # 后台点击，不抢鼠标
pc_keyboard mode:background hwnd:123 type text:"..."  # 后台打字
pc_screen grab background:true hwnd:123         # 后台截图（被遮挡也能截）
pc_system exec command:"ipconfig"               # 只读命令，免审批
pc_system exec command:"Remove-Item C:\\Temp\\x"      # 会先请示主人
```

## v1.1.1：外部评审驱动的安全修复

另一位 AI 对 v1.1 的源码做了独立审阅，指出若干「承诺了审批、实际能绕过」的漏洞。以下已修复并加了回归用例（`test/smoke.mjs` 的「审批绕过回归」一节）：

- **`launch` 由黑名单改为白名单**：只认裸程序名且在白名单里（`allowedPrograms` 可配置）。原黑名单挡不住 `cmd`（不带 `.exe`）、`cmd.exe.`（Win32 忽略尾点）、`\\evil\s\x.exe`（UNC）、任意路径 exe。
- **`exec` 拒绝带路径的命令名与 UNC**：`\\evil\s\whoami.exe`、`.\ping.exe` 不再因为剥掉路径后命中白名单而免审批。
- **`route` / `arp` / `ver` / `time` 移出只读白名单**（前两个会改系统状态，后两个在 PowerShell 里不存在）。
- **消灭字符串拼接注入**：所有用户输入改用 base64 + 运行时解码传入 PowerShell。原 `psQuote` 只转义 ASCII `'`，而 PowerShell 把 `‘ ’ ‚ ‛` 也当单引号。
- **审批框不再截断命令**：主人必须看到完整的待批准内容。
- **截图路径受限**：必须是 `.png`、不覆盖已有文件、且只能落在截图目录或工作目录下。原实现可以用 PNG 覆盖任意文件。
- **`kill` 显示真实命中名单并加自保护**：先解析出会杀哪些进程再弹审批；C# 侧拒绝杀 helper 自己、宿主进程和系统关键进程，进程名改为全等匹配（原来子串匹配会顺手带走一堆同名进程）。
- **`pc_batch` 可取消**：逐步检查 `exec.signal`，`wait` 可被中断。
- **其它小修**：`SetCursorPos` 补 `SetLastError`；绝对移动补 `MOUSEEVENTF_VIRTUALDESK`；`focus` 不再把最大化窗口还原；后台截图按窗口矩形取尺寸；剪贴板非文本内容不再被空字符串覆盖；后台点击先做子控件命中（按钮能点到了）；删除 `sleep` 键映射（按一下等于绕过 power 审批）；批处理允许负坐标（副屏在主屏左侧/上方）；批处理 `key` 默认改为按下。

### 仍未解决 / 明确限制

- **后台组合键不可靠**：目标读的是真实键盘状态，`ctrl+a` 只会到达 `a`。现在后台模式下带组合键会**直接报错**，提示改用前台模式。
- **键盘输入不做内容审查**：等价于主人亲自打字，这条边界不变。
- **C# 侧无法在 Linux 沙箱里验证**：本次修改都经过编译，但「多显示器负坐标」「子控件命中」这类行为只在本机单屏环境验证过。
