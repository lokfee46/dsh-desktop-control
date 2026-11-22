# 桌面操控（Desktop Control）

> 一个给 DeepSeek Harness 用的桌面操控插件：让模型真实操作这台 Windows 电脑——鼠标、键盘、截图、窗口、程序与系统命令，危险动作一律先请示主人。

- **包名**：`@local/desktop-control`
- **挂载 id**：`desktop-control`
- **界面显示名**：桌面操控 / Desktop control
- **工具前缀**：`pc_`
- **版本**：1.1.4

## 为什么叫这个名字

`desktop-control` 是功能描述，不是代号：

- `desktop` 划清范围——它操作的是这台电脑的桌面，不是某个网页、某个 API、某个远程机器。
- `control` 比 `automation` 更准确——它提供的是「操作原语」（移鼠标、敲键、截图、开窗口），而不是「流程编排」。真正把原语串成流程的是调用它的模型。
- 名字保持中性，是因为它带审批。确认框里出现「桌面操控 请求执行 …」时，主人需要的是一个可靠工具，不是一个俏皮的玩具。

界面上显示的中文名是「桌面操控」。如果哪天要换个更好听的显示名，只改 `locale/zh.json` 与 `locale/en.json` 的 `meta.title` 即可，包名和 id 不用动。

## 它能做什么

| 工具 | 能力 |
|---|---|
| `pc_pointer` | 移动、点击（单/双/右/中）、按下/抬起、拖拽、滚轮、读取光标坐标 |
| `pc_keyboard` | 输入任意文本（中文、emoji、换行）、组合键、按住/松开单键 |
| `pc_screen` | 屏幕信息、截图（全屏/窗口/区域/后台窗口） |
| `pc_window` | 列出、激活、最小化/最大化/还原、关闭、移动、缩放窗口 |
| `pc_app` | 启动程序/文件/文件夹/网址、列出进程、结束进程 |
| `pc_system` | 环境信息、剪贴板、音量、锁屏、执行命令、提权、关机/重启、服务、注册表 |
| `pc_batch` | 一次调用串行执行最多 200 个动作，省掉 N 次模型往返 |

鼠标和键盘支持**前台**（真实光标与按键）和**后台**（向指定窗口投递消息，不抢焦点）两种模式。后台模式适合 Win32/WinForms/WPF；Chromium/Electron/UWP 不读这类消息，需用前台。

## 安全边界

设计原则一句话：**能免审的都是明确的、有限的；其余一律走审批，且审批失败即拒绝。**

- 免审：鼠标、键盘、截图、读屏幕信息、窗口操作、启动白名单 GUI 程序 / 文档 / 网址、只读命令白名单。
- 需审批：启动其余任何程序、结束进程、执行非白名单命令、管理员提权、关机重启、系统服务、注册表写入、截图写到非允许目录。
- 审批通道不可用（例如没有审批界面的聊天通道）时按**拒绝**处理，不会降级放行。
- 安全判定采用白名单制：命令参数只允许「已知安全选项 + 盘符路径 + 普通片段」，不枚举坏写法。

需要诚实说明的边界：**键盘输入不做内容审查**（它等价于主人亲自打字，结果在屏幕上可见）；键鼠注入要求 helper 与目标窗口完整性级别一致，宿主被降权时会明确报错而不是假装成功。

## 安装

本插件是 DeepSeek Harness（DSH）的 bundle，要装进某个 profile，并在该 profile 的 `package.json` 里登记。

### 方式一：安装包（推荐）

`dist/local-desktop-control-1.1.4.tgz` 是用 `npm pack` 生成的安装包：

```bash
cd <profile 目录>
npm install <本仓库本地路径>/dist/local-desktop-control-1.1.4.tgz
```

### 方式二：本地链接（开发用）

```bash
cd <profile 目录>
npm install link:<源码目录>
```

装好后确认 profile 的 `package.json`：

- `dependencies` 里有 `@local/desktop-control`
- `dsh.profile.bundles` 里有 `@local/desktop-control`

改动 JS 侧后必须**完全退出 DSH 再重启**才会加载——bundle 内条目不支持热重载。

### 依赖

Windows 10/11 + .NET Framework 4.x（系统自带）。`native/DesktopControl.exe` 已编译好；若缺失，插件会尝试用系统自带的 `csc.exe` 重新编译。

## 文档

- [docs/DETAIL.md](docs/DETAIL.md) — 完整说明：模式、审批矩阵、输入方式、实现要点、已知边界。
- [docs/FIX-REPORT-v1.1.4.md](docs/FIX-REPORT-v1.1.4.md) — 第四轮独立评审的修复报告。
- [test/](test/) — `smoke.mjs`（注册与审批回归）、`audit.mjs`（安全断言）、`verify-package.mjs`（打包前自检）。

打包前请运行：

```bash
node test/verify-package.mjs
node test/smoke.mjs
node test/audit.mjs
```

## 已知限制

- 后台模式下组合键不可靠（目标读真实键盘状态），插件会直接报错并提示改用前台。
- 剪贴板粘贴输入会短暂占用剪贴板，完成后恢复原内容；若剪贴板含富文本/图片则改用底层字符注入，完全不碰剪贴板。
- 截图坐标是物理像素（PerMonitorV2），原点为虚拟屏幕左上角，多显示器下与截图一致。
- 不能承诺「零 bug」：能保证的是链路完整、关键路径有测试、失败方向是拒绝而非放行。
