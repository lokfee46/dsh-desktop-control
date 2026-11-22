// DesktopControl — 常驻桌面操控 helper。
// 通信：启动后连接 127.0.0.1:<port>（参数 --host/--port/--token），先发一行 hello 握手，
// 之后每行一个 JSON 请求，每行一个 JSON 响应（UTF-8，无 BOM）。
// 请求：{"id":<any>,"op":"pointer.click","x":1,"y":2,...}
// 响应：{"id":<any>,"ok":true,"result":{...}} 或 {"id":<any>,"ok":false,"error":"..."}
// 目标框架：.NET Framework 4.0（Windows 自带），C# 5 语法。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class DesktopControl
{
    // ---------------- Win32 声明 ----------------

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [DllImport("user32.dll")]
    private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr ChildWindowFromPointEx(IntPtr hwnd, POINT point, uint flags);

    [DllImport("user32.dll")]
    private static extern int MapWindowPoints(IntPtr from, IntPtr to, ref POINT points, uint count);

    private const uint CWP_SKIPINVISIBLE = 0x0001;
    private const uint CWP_SKIPDISABLED = 0x0002;
    private const uint CWP_SKIPTRANSPARENT = 0x0004;

    private const uint GA_ROOT = 2;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint n, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLengthW(IntPtr h);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr h);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr h);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr h);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr h);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr h);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr h);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr h, int cmd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr h, out RECT r);

    [DllImport("user32.dll")]
    private static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);

    [DllImport("user32.dll")]
    private static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int i);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint a, uint b, bool f);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowW(string cls, string title);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);

    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDpiAwarenessContext();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

    [DllImport("kernel32.dll")]
    private static extern bool LockWorkStation();

    // 后台操控（PostMessage / PrintWindow）：不移动真实光标、不抢前台
    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKeyW(uint code, uint mapType);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);

    // 剪贴板（避免依赖 STA 线程的 WinForms Clipboard）
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr owner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);

    [DllImport("user32.dll")]
    private static extern uint EnumClipboardFormats(uint format);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint format, IntPtr mem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr mem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr mem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr mem);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll")]
    private static extern ulong GetTickCount64();

    [DllImport("user32.dll")]
    private static extern IntPtr GetProcessWindowStation();

    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder buffer, int length, out int needed);

    // ---------------- 常量 ----------------

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x01000;

    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private const int SW_MINIMIZE = 6;
    private const int SW_RESTORE = 9;
    private const int SW_MAXIMIZE = 3;
    private const uint WM_CLOSE = 0x0010;

    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;
    private const uint GMEM_ZEROINIT = 0x0040;

    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;
    private const uint WM_CHAR = 0x0102;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint WM_RBUTTONDOWN = 0x0204;
    private const uint WM_RBUTTONUP = 0x0205;
    private const uint WM_MBUTTONDOWN = 0x0207;
    private const uint WM_MBUTTONUP = 0x0208;
    private const uint WM_MOUSEWHEEL = 0x020A;
    private const uint MK_LBUTTON = 0x0001;
    private const uint MK_RBUTTON = 0x0002;
    private const uint MK_MBUTTON = 0x0010;
    private const uint PW_RENDERFULLCONTENT = 0x00000002;

    private static int InputSize = Marshal.SizeOf(typeof(INPUT));

    private static string BootProbe = "";

    // ---------------- 入口 ----------------

    public static int Main(string[] args)
    {
        string host = "127.0.0.1";
        int port = 0;
        string token = "";
        for (int i = 0; i + 1 < args.Length; i++)
        {
            string key = args[i];
            string value = args[i + 1];
            if (key == "--host") host = value;
            else if (key == "--port") { int parsed; if (int.TryParse(value, out parsed)) port = parsed; }
            else if (key == "--token") token = value;
        }
        if (port <= 0)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--selftest")
                {
                    RunSelfTest();
                    return 0;
                }
            }
            try { Console.Error.WriteLine("DesktopControl: missing --port"); } catch (Exception) { }
            return 2;
        }

        try
        {
            // 进程级 PerMonitorV2：坐标、截图、SendInput 全部统一为物理像素。
            // 只设线程上下文会让 SendInput 的绝对坐标仍按系统 DPI 虚拟化，表现为「移 960 却停在 686」。
            bool aware = false;
            string forced = Environment.GetEnvironmentVariable("DC_FORCE_DPI_UNAWARE");
            if (forced != "1")
            {
                // 三管齐下：进程级 API 不一定成功（返回 false 时进程保持 unaware），
                // 线程级 API 才决定 GetSystemMetrics / SendInput 实际使用的坐标空间。
                try { aware = SetProcessDpiAwarenessContext(new IntPtr(-4)); }
                catch (Exception) { aware = false; }
                try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
                catch (Exception) { }
                if (!aware)
                {
                    try { SetProcessDPIAware(); } catch (Exception) { }
                    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
                }
            }
        }
        catch (Exception) { }

        // 启动自检：在建立 TCP 连接之前，先确认这个进程此刻能不能动光标。
        try
        {
            POINT bootCursor;
            GetCursorPos(out bootCursor);
            bool bootMoved = SetCursorPos(bootCursor.X, bootCursor.Y);
            BootProbe = "setCursor=" + bootMoved + " err=" + (bootMoved ? 0 : Marshal.GetLastWin32Error());
        }
        catch (Exception error)
        {
            BootProbe = "exception:" + error.Message;
        }

        // 通信走 TCP loopback：DSH 的 Windows 沙箱禁止命名管道，管道式 stdio 会 EPERM。
        TcpClient client = new TcpClient();
        try { client.NoDelay = true; } catch (Exception) { }
        bool connected = false;
        for (int attempt = 0; attempt < 200; attempt++)
        {
            try { client.Connect(host, port); connected = true; break; }
            catch (Exception) { Thread.Sleep(15); }
        }
        if (!connected)
        {
            try { Console.Error.WriteLine("DesktopControl: cannot connect to " + host + ":" + port); } catch (Exception) { }
            return 3;
        }

        NetworkStream stream = client.GetStream();
        StreamReader reader = new StreamReader(stream, new UTF8Encoding(false), false, 8192);
        StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false), 8192);
        writer.AutoFlush = true;

        JavaScriptSerializer handshake = new JavaScriptSerializer();
        Dictionary<string, object> hello = new Dictionary<string, object>();
        hello["op"] = "hello";
        hello["token"] = token;
        hello["pid"] = Process.GetCurrentProcess().Id;
        hello["version"] = 1;
        hello["dpi"] = "physical";
        writer.WriteLine(handshake.Serialize(hello));

        JavaScriptSerializer json = new JavaScriptSerializer();
        json.MaxJsonLength = 8 * 1024 * 1024;
        json.RecursionLimit = 100;

        while (true)
        {
            string line;
            try
            {
                line = reader.ReadLine();
            }
            catch (Exception)
            {
                break;
            }
            if (line == null) break;
            if (line.Trim().Length == 0) continue;

            object id = null;
            Dictionary<string, object> response = new Dictionary<string, object>();
            try
            {
                object parsed = json.DeserializeObject(line);
                Dictionary<string, object> request = AsDict(parsed);
                if (request == null) throw new InvalidOperationException("request must be a JSON object");
                id = request.ContainsKey("id") ? request["id"] : null;
                string op = Str(request, "op", null);
                if (string.IsNullOrEmpty(op)) throw new InvalidOperationException("missing op");
                object result = Dispatch(op, request);
                response["id"] = id;
                response["ok"] = true;
                response["result"] = result;
            }
            catch (Exception error)
            {
                response["id"] = id;
                response["ok"] = false;
                response["error"] = error.Message;
                response["error_type"] = error.GetType().Name;
            }

            string payload;
            try
            {
                payload = json.Serialize(response);
            }
            catch (Exception serializeError)
            {
                payload = "{\"id\":null,\"ok\":false,\"error\":\"serialize failed: "
                    + EscapeJson(serializeError.Message) + "\"}";
            }
            writer.WriteLine(payload);
        }
        try { writer.Flush(); } catch (Exception) { }
        try { client.Close(); } catch (Exception) { }
        return 0;
    }

    private static string EscapeJson(string text)
    {
        if (text == null) return "";
        StringBuilder sb = new StringBuilder(text.Length + 8);
        foreach (char ch in text)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        return sb.ToString();
    }

    // ---------------- 分发 ----------------

    private static object Dispatch(string op, Dictionary<string, object> req)
    {
        switch (op)
        {
            case "ping": return Ping();
            case "pointer.move": return PointerMove(req);
            case "pointer.smooth": return PointerSmooth(req);
            case "pointer.click": return PointerClick(req);
            case "pointer.down": return PointerButton(req, true);
            case "pointer.up": return PointerButton(req, false);
            case "pointer.drag": return PointerDrag(req);
            case "pointer.scroll": return PointerScroll(req);
            case "pointer.position": return PointerPosition();
            case "keyboard.type": return KeyboardType(req);
            case "keyboard.press": return KeyboardPress(req);
            case "keyboard.down": return KeyboardDown(req);
            case "keyboard.up": return KeyboardUp(req);
            case "screen.info": return ScreenInfo();
            case "screen.grab": return ScreenGrab(req);
            case "window.list": return WindowList();
            case "window.focus": return WindowFocus(req);
            case "window.minimize": return WindowShow(req, SW_MINIMIZE);
            case "window.maximize": return WindowShow(req, SW_MAXIMIZE);
            case "window.restore": return WindowShow(req, SW_RESTORE);
            case "window.close": return WindowClose(req);
            case "window.move": return WindowMove(req);
            case "window.resize": return WindowResize(req);
            case "app.launch": return AppLaunch(req);
            case "app.list": return AppList(req);
            case "app.kill": return AppKill(req);
            case "system.clipboard_get": return ClipboardGet();
            case "system.clipboard_set": return ClipboardSet(req);
            case "system.volume": return SystemVolume(req);
            case "system.mute": return SystemMute();
            case "system.lock": return SystemLock();
            case "system.info": return SystemInfo();
            case "window.bg_info": return WindowBackgroundInfo(req);
            case "pointer.bg_click": return BackgroundClick(req);
            case "pointer.bg_scroll": return BackgroundScroll(req);
            case "keyboard.bg_type": return BackgroundType(req);
            case "keyboard.bg_press": return BackgroundPress(req);
            case "screen.bg_grab": return BackgroundGrab(req);
            default:
                throw new InvalidOperationException("unknown op: " + op);
        }
    }

    private static object Ping()
    {
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["helper"] = "desktop-control";
        result["version"] = 1;
        result["pid"] = Process.GetCurrentProcess().Id;
        result["os"] = Environment.OSVersion.VersionString;
        result["is64"] = Environment.Is64BitProcess;
        result["input_size"] = InputSize;
        return result;
    }

    // ---------------- 鼠标 ----------------

    private static object PointerPosition()
    {
        POINT p;
        GetCursorPos(out p);
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["x"] = p.X;
        result["y"] = p.Y;
        return result;
    }

    private static bool MoveCursorTo(int x, int y)
    {
        return MoveCursorTo(x, y, true);
    }

    /// <summary>
    /// 把光标移到屏幕物理像素坐标。
    /// 优先 SendInput 绝对移动：某些环境下 SetCursorPos 直接返回 FALSE（句柄被拦或桌面受限），
    /// 而 SendInput 仍然可用。SendInput 是异步入队的，校验前必须留一点时间；
    /// verify=false 用于平滑移动的中间帧，避免每帧多等十几毫秒。
    /// </summary>
    private static bool MoveCursorTo(int x, int y, bool verify)
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (vw <= 1) vw = 2;
        if (vh <= 1) vh = 2;

        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
        inputs[0].u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
        inputs[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        bool sent = SendInput(1, inputs, InputSize) == 1;
        if (!verify) return sent;

        POINT now;
        if (sent)
        {
            Thread.Sleep(12);
            GetCursorPos(out now);
            if (Math.Abs(now.X - x) <= 3 && Math.Abs(now.Y - y) <= 3) return true;
        }

        bool placed = SetCursorPos(x, y);
        Thread.Sleep(8);
        GetCursorPos(out now);
        if (Math.Abs(now.X - x) <= 3 && Math.Abs(now.Y - y) <= 3) return true;

        // 两条 API 至少一条报告成功、只是光标还没同步到位：按成功处理，让调用方读实际位置。
        return sent || placed;
    }

    private static object PointerMove(Dictionary<string, object> req)
    {
        int x = Int(req, "x", 0);
        int y = Int(req, "y", 0);
        if (!MoveCursorTo(x, y))
        {
            throw new InvalidOperationException("移动光标失败：SendInput 与 SetCursorPos 都被系统拒绝（Win32 "
                + Marshal.GetLastWin32Error() + "）");
        }
        return PointerPosition();
    }

    private static object PointerSmooth(Dictionary<string, object> req)
    {
        int x = Int(req, "x", 0);
        int y = Int(req, "y", 0);
        int duration = Int(req, "durationMs", 0);
        if (duration <= 0)
        {
            return PointerMove(req);
        }
        if (duration > 10000) duration = 10000;
        POINT from;
        GetCursorPos(out from);
        int steps = duration / 10;
        if (steps < 6) steps = 6;
        if (steps > 400) steps = 400;
        int delay = duration / steps;
        for (int i = 1; i <= steps; i++)
        {
            double t = (double)i / steps;
            double eased = t < 0.5 ? 2.0 * t * t : 1.0 - Math.Pow(-2.0 * t + 2.0, 2.0) / 2.0;
            int cx = from.X + (int)Math.Round((x - from.X) * eased);
            int cy = from.Y + (int)Math.Round((y - from.Y) * eased);
            MoveCursorTo(cx, cy, false);
            if (delay > 0) Thread.Sleep(delay);
        }
        MoveCursorTo(x, y);
        return PointerPosition();
    }

    private static uint ButtonFlag(string button, bool down)
    {
        string name = (button == null ? "left" : button).Trim().ToLowerInvariant();
        switch (name)
        {
            case "left": return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
            case "right": return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
            case "middle": return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
            default: throw new InvalidOperationException("unknown mouse button: " + button);
        }
    }

    private static bool MouseButton(string button, bool down)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dwFlags = ButtonFlag(button, down);
        uint sent = SendInput(1, inputs, InputSize);
        if (sent != 1)
        {
            throw new InvalidOperationException("鼠标注入被系统拒绝（Win32 " + Marshal.GetLastWin32Error()
                + "）：注入键鼠要求与目标窗口处于同等级别，低完整性或受限令牌下会被 UIPI 拦截");
        }
        return true;
    }

    private static object PointerClick(Dictionary<string, object> req)
    {
        if (req.ContainsKey("x") && req.ContainsKey("y"))
        {
            PointerMove(req);
        }
        string button = Str(req, "button", "left");
        int count = Int(req, "count", 1);
        if (count < 1) count = 1;
        if (count > 3) count = 3;
        for (int i = 0; i < count; i++)
        {
            MouseButton(button, true);
            Thread.Sleep(12);
            MouseButton(button, false);
            if (i < count - 1) Thread.Sleep(60);
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["button"] = button;
        result["count"] = count;
        POINT p;
        GetCursorPos(out p);
        result["x"] = p.X;
        result["y"] = p.Y;
        return result;
    }

    private static object PointerButton(Dictionary<string, object> req, bool down)
    {
        string button = Str(req, "button", "left");
        bool sent = MouseButton(button, down);
        if (!sent) throw new InvalidOperationException("SendInput mouse " + (down ? "down" : "up") + " failed");
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["button"] = button;
        result["state"] = down ? "down" : "up";
        return result;
    }

    private static object PointerDrag(Dictionary<string, object> req)
    {
        int x1 = Int(req, "x1", 0);
        int y1 = Int(req, "y1", 0);
        int x2 = Int(req, "x2", 0);
        int y2 = Int(req, "y2", 0);
        int duration = Int(req, "durationMs", 400);
        string button = Str(req, "button", "left");

        MoveCursorTo(x1, y1);
        Thread.Sleep(30);
        MouseButton(button, true);
        Thread.Sleep(60);
        try
        {
            if (duration > 0)
            {
                if (duration > 20000) duration = 20000;
                int steps = duration / 10;
                if (steps < 8) steps = 8;
                if (steps > 600) steps = 600;
                int delay = duration / steps;
                for (int i = 1; i <= steps; i++)
                {
                    double t = (double)i / steps;
                    double eased = t < 0.5 ? 2.0 * t * t : 1.0 - Math.Pow(-2.0 * t + 2.0, 2.0) / 2.0;
                    MoveCursorTo(x1 + (int)Math.Round((x2 - x1) * eased), y1 + (int)Math.Round((y2 - y1) * eased), false);
                    if (delay > 0) Thread.Sleep(delay);
                }
            }
            MoveCursorTo(x2, y2);
            Thread.Sleep(40);
        }
        finally
        {
            MouseButton(button, false);
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["from"] = new object[] { x1, y1 };
        result["to"] = new object[] { x2, y2 };
        return result;
    }

    private static object PointerScroll(Dictionary<string, object> req)
    {
        int dy = Int(req, "dy", 0);
        int dx = Int(req, "dx", 0);
        if (dy != 0)
        {
            INPUT[] vertical = new INPUT[1];
            vertical[0].type = INPUT_MOUSE;
            vertical[0].u.mi.dwFlags = MOUSEEVENTF_WHEEL;
            vertical[0].u.mi.mouseData = unchecked((uint)(dy * 120));
            SendInput(1, vertical, InputSize);
        }
        if (dx != 0)
        {
            INPUT[] horizontal = new INPUT[1];
            horizontal[0].type = INPUT_MOUSE;
            horizontal[0].u.mi.dwFlags = MOUSEEVENTF_HWHEEL;
            horizontal[0].u.mi.mouseData = unchecked((uint)(dx * 120));
            SendInput(1, horizontal, InputSize);
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["dy"] = dy;
        result["dx"] = dx;
        return result;
    }

    // ---------------- 键盘 ----------------

    private static bool KeyEvent(int vk, bool up, bool extended)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = (ushort)vk;
        inputs[0].u.ki.wScan = 0;
        uint flags = up ? KEYEVENTF_KEYUP : 0u;
        if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
        inputs[0].u.ki.dwFlags = flags;
        uint sent = SendInput(1, inputs, InputSize);
        if (sent != 1)
        {
            throw new InvalidOperationException("键盘注入被系统拒绝（Win32 " + Marshal.GetLastWin32Error()
                + "）：注入键鼠要求与目标窗口处于同等级别，低完整性或受限令牌下会被 UIPI 拦截");
        }
        return true;
    }

    private static bool KeyUnicode(ushort codeUnit, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = 0;
        inputs[0].u.ki.wScan = codeUnit;
        inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u);
        uint sent = SendInput(1, inputs, InputSize);
        if (sent != 1)
        {
            throw new InvalidOperationException("字符注入被系统拒绝（Win32 " + Marshal.GetLastWin32Error()
                + "）：注入键鼠要求与目标窗口处于同等级别，低完整性或受限令牌下会被 UIPI 拦截");
        }
        return true;
    }

    private static bool IsExtendedKey(int vk)
    {
        // 方向键、Ins/Del/Home/End/PgUp/PgDn、右 Ctrl/Alt、Win、Apps、NumPad 运算符等。
        if (vk >= 33 && vk <= 40) return true;
        if (vk == 45 || vk == 46 || vk == 36 || vk == 35) return true;
        if (vk == 91 || vk == 92 || vk == 93) return true;
        if (vk == 162 || vk == 163 || vk == 164 || vk == 165) return true;
        if (vk >= 166 && vk <= 179) return true;
        if (vk == 144 || vk == 145) return true;
        return false;
    }

    private static object KeyboardType(Dictionary<string, object> req)
    {
        string text = Str(req, "text", "");
        if (text == null) text = "";
        int interval = Int(req, "intervalMs", 0);
        // 默认走剪贴板：中文输入法会把 UNICODE 注入当成拼音输入吃掉，只有它稳定可用。
        string method = Str(req, "method", "clipboard");
        if (interval < 0) interval = 0;
        if (interval > 1000) interval = 1000;

        if (text.Length > 20000) throw new InvalidOperationException("text is too long (max 20000 characters)");

        // 剪贴板里没有文本（是图片/文件/空）时，粘贴要先 EmptyClipboard —— 备份不出来，
        // 用户原内容就没了。这种情况改走 unicode 注入，完全不碰剪贴板。
        string previous = null;
        bool useClipboard = method != "unicode";
        if (useClipboard)
        {
            try { previous = ClipboardReadText(); } catch (Exception) { previous = null; }
            // 只有纯文本才碰剪贴板：富文本（HTML/RTF）和图片恢复不了，
            // 粘完再写回纯文本等于把用户原来的格式毁掉。
            if (previous == null || !ClipboardIsPlainText()) useClipboard = false;
        }

        if (useClipboard)
        {
            // 剪贴板粘贴法：不受输入法影响，中文/emoji 都可靠。
            bool restored = false;
            ClipboardWriteText(text.Replace("\r\n", "\n").Replace("\n", "\r\n"));
            Thread.Sleep(40);
            KeyChord(17, 86, false); // Ctrl+V
            Thread.Sleep(240);
            if (previous != null)
            {
                try { ClipboardWriteText(previous); restored = true; } catch (Exception) { }
            }
            Dictionary<string, object> pasted = new Dictionary<string, object>();
            pasted["method"] = "clipboard";
            pasted["chars"] = text.Length;
            pasted["clipboardRestored"] = restored;
            return pasted;
        }

        int sent = 0;
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            // 换行统一走 Enter，制表符走 Tab：某些应用对 \n 的 UNICODE 码元无反应。
            if (ch == '\r') continue;
            if (ch == '\n')
            {
                KeyEvent(13, false, false);
                Thread.Sleep(15);
                KeyEvent(13, true, false);
            }
            else if (ch == '\t')
            {
                KeyEvent(9, false, false);
                Thread.Sleep(15);
                KeyEvent(9, true, false);
            }
            else
            {
                // 代理对（emoji 等）按两个 UTF-16 码元依次发送。
                KeyUnicode((ushort)ch, false);
                Thread.Sleep(8);
                KeyUnicode((ushort)ch, true);
            }
            sent++;
            if (interval > 0) Thread.Sleep(interval);
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["method"] = "unicode";
        result["chars"] = sent;
        return result;
    }

    private static void KeyChord(int modifierVk, int keyVk, bool extended)
    {
        KeyEvent(modifierVk, false, false);
        Thread.Sleep(18);
        KeyEvent(keyVk, false, extended);
        Thread.Sleep(18);
        KeyEvent(keyVk, true, extended);
        Thread.Sleep(18);
        KeyEvent(modifierVk, true, false);
    }

    private static object KeyboardPress(Dictionary<string, object> req)
    {
        List<object> combos = ListOf(req, "combos");
        if (combos == null || combos.Count == 0)
        {
            string single = Str(req, "keys", null);
            if (single == null) throw new InvalidOperationException("missing keys");
            combos = new List<object>();
            combos.Add(single);
        }
        List<object> done = new List<object>();
        foreach (object entry in combos)
        {
            string combo = entry == null ? "" : entry.ToString();
            PressCombo(combo);
            done.Add(combo);
            Thread.Sleep(30);
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["pressed"] = done;
        return result;
    }

    private static void PressCombo(string combo)
    {
        if (combo == null || combo.Trim().Length == 0) throw new InvalidOperationException("empty key combo");
        string[] parts = combo.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) throw new InvalidOperationException("empty key combo: " + combo);

        // 允许 "ctrl++" 这类写法：把最后的 '+' 当作主键。
        if (combo.TrimEnd().EndsWith("++"))
        {
            List<string> rebuilt = new List<string>();
            for (int i = 0; i < parts.Length; i++) rebuilt.Add(parts[i]);
            rebuilt.Add("+");
            parts = rebuilt.ToArray();
        }

        List<int> modifiers = new List<int>();
        List<string> modifierNames = new List<string>();
        int mainVk = 0;
        string mainName = null;
        for (int i = 0; i < parts.Length; i++)
        {
            string raw = parts[i].Trim();
            if (raw.Length == 0) throw new InvalidOperationException("empty key in combo: " + combo);
            int vk = VirtualKey(raw);
            if (vk == 0) throw new InvalidOperationException("unknown key name: " + raw);
            bool modifier = IsModifier(raw);
            if (modifier)
            {
                if (i == parts.Length - 1)
                {
                    // 末尾是修饰键（例如 "ctrl+shift"）：按住再松开，作为独立动作。
                    mainVk = vk;
                    mainName = raw;
                }
                else
                {
                    modifiers.Add(vk);
                    modifierNames.Add(raw);
                }
            }
            else
            {
                if (i != parts.Length - 1) throw new InvalidOperationException("only the last key may be non-modifier in combo: " + combo);
                mainVk = vk;
                mainName = raw;
            }
        }
        if (mainVk == 0) throw new InvalidOperationException("combo has no main key: " + combo);
        bool extended = IsExtendedKey(mainVk);

        // + 与 = 共用 VK_OEM_PLUS，靠 Shift 区分；不在 modifiers 里补 Shift 就只会打出 =
        if (mainName == "+" || mainName == "*")
        {
            modifiers.Insert(0, 160); // VK_LSHIFT
            modifierNames.Insert(0, "shift");
        }

        // 用 try/finally 保证异常时修饰键不会卡在按下状态
        List<int> pressed = new List<int>();
        try
        {
            foreach (int vk in modifiers)
            {
                KeyEvent(vk, false, IsExtendedKey(vk));
                pressed.Add(vk);
                Thread.Sleep(15);
            }
            Thread.Sleep(10);
            KeyEvent(mainVk, false, extended);
            Thread.Sleep(25);
            KeyEvent(mainVk, true, extended);
        }
        finally
        {
            for (int i = pressed.Count - 1; i >= 0; i--)
            {
                try { KeyEvent(pressed[i], true, IsExtendedKey(pressed[i])); }
                catch (Exception) { }
                Thread.Sleep(10);
            }
        }
    }

    private static bool IsModifier(string raw)
    {
        string name = raw.Trim().ToLowerInvariant();
        return name == "ctrl" || name == "control" || name == "shift" || name == "alt" || name == "win"
            || name == "lwin" || name == "rwin";
    }

    private static object KeyboardDown(Dictionary<string, object> req)
    {
        string key = Str(req, "key", null);
        if (key == null) throw new InvalidOperationException("missing key");
        int vk = VirtualKey(key);
        if (vk == 0) throw new InvalidOperationException("unknown key name: " + key);
        KeyEvent(vk, false, IsExtendedKey(vk));
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["key"] = key;
        result["state"] = "down";
        return result;
    }

    private static object KeyboardUp(Dictionary<string, object> req)
    {
        string key = Str(req, "key", null);
        if (key == null) throw new InvalidOperationException("missing key");
        int vk = VirtualKey(key);
        if (vk == 0) throw new InvalidOperationException("unknown key name: " + key);
        KeyEvent(vk, true, IsExtendedKey(vk));
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["key"] = key;
        result["state"] = "up";
        return result;
    }

    private static int VirtualKey(string raw)
    {
        if (raw == null) return 0;
        string name = raw.Trim().ToLowerInvariant();
        if (name.Length == 0) return 0;
        if (name.Length == 1)
        {
            char ch = name[0];
            if (ch >= 'a' && ch <= 'z') return 65 + (ch - 'a');
            if (ch >= 'A' && ch <= 'Z') return 65 + (ch - 'A');
            if (ch >= '0' && ch <= '9') return 48 + (ch - '0');
        }
        switch (name)
        {
            case "backspace": case "back": return 8;
            case "tab": return 9;
            case "enter": case "return": return 13;
            case "shift": return 16;
            case "ctrl": case "control": return 17;
            case "alt": case "menu": return 18;
            case "pause": case "break": return 19;
            case "capslock": return 20;
            case "esc": case "escape": return 27;
            case "space": case "spacebar": return 32;
            case "pageup": case "pgup": return 33;
            case "pagedown": case "pgdn": return 34;
            case "end": return 35;
            case "home": return 36;
            case "left": case "arrowleft": return 37;
            case "up": case "arrowup": return 38;
            case "right": case "arrowright": return 39;
            case "down": case "arrowdown": return 40;
            case "printscreen": case "prtsc": return 44;
            case "insert": case "ins": return 45;
            case "delete": case "del": return 46;
            case "win": case "lwin": case "super": case "meta": return 91;
            case "rwin": return 92;
            case "apps": case "contextmenu": return 93;
            case "num0": return 96;
            case "num1": return 97;
            case "num2": return 98;
            case "num3": return 99;
            case "num4": return 100;
            case "num5": return 101;
            case "num6": return 102;
            case "num7": return 103;
            case "num8": return 104;
            case "num9": return 105;
            case "multiply": return 106;
            case "add": return 107;
            case "subtract": return 109;
            case "decimal": return 110;
            case "divide": return 111;
            case "f1": return 112;
            case "f2": return 113;
            case "f3": return 114;
            case "f4": return 115;
            case "f5": return 116;
            case "f6": return 117;
            case "f7": return 118;
            case "f8": return 119;
            case "f9": return 120;
            case "f10": return 121;
            case "f11": return 122;
            case "f12": return 123;
            case "f13": return 124;
            case "f14": return 125;
            case "f15": return 126;
            case "f16": return 127;
            case "numlock": return 144;
            case "scrolllock": return 145;
            case "volumemute": case "mute": return 173;
            case "volumedown": return 174;
            case "volumeup": return 175;
            case "medianext": case "nexttrack": return 176;
            case "mediaprev": case "prevtrack": return 177;
            case "mediastop": case "stop": return 178;
            case "mediaplay": case "playpause": return 179;
            case "plus": case "+": return 187;
            case "asterisk": case "*": return 106;
            case "semicolon": case ";": return 186;
            case "equal": case "=": return 187;
            case "comma": case ",": return 188;
            case "minus": case "-": return 189;
            case "period": case ".": return 190;
            case "slash": case "/": return 191;
            case "backtick": case "`": return 192;
            case "lbracket": case "[": return 219;
            case "backslash": case "\\": return 220;
            case "rbracket": case "]": return 221;
            case "quote": case "'": return 222;
            default: return 0;
        }
    }

    // ---------------- 屏幕 ----------------

    private static Dictionary<string, object> ScreenMetrics()
    {
        Dictionary<string, object> metrics = new Dictionary<string, object>();
        metrics["screenWidth"] = GetSystemMetrics(SM_CXSCREEN);
        metrics["screenHeight"] = GetSystemMetrics(SM_CYSCREEN);
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        metrics["virtualX"] = vx;
        metrics["virtualY"] = vy;
        metrics["virtualWidth"] = vw;
        metrics["virtualHeight"] = vh;
        return metrics;
    }

    private static object ScreenInfo()
    {
        Dictionary<string, object> result = ScreenMetrics();
        POINT p;
        GetCursorPos(out p);
        Dictionary<string, object> cursor = new Dictionary<string, object>();
        cursor["x"] = p.X;
        cursor["y"] = p.Y;
        result["cursor"] = cursor;

        IntPtr foreground = GetForegroundWindow();
        Dictionary<string, object> window = new Dictionary<string, object>();
        window["hwnd"] = foreground.ToInt64();
        window["title"] = WindowTitle(foreground);
        uint pid;
        GetWindowThreadProcessId(foreground, out pid);
        window["pid"] = pid;
        try { window["process"] = Process.GetProcessById((int)pid).ProcessName; }
        catch (Exception) { window["process"] = null; }
        result["foreground"] = window;
        return result;
    }

    private static object ScreenGrab(Dictionary<string, object> req)
    {
        string path = Str(req, "path", null);
        if (string.IsNullOrEmpty(path)) throw new InvalidOperationException("missing path");

        Dictionary<string, object> region = Dict(req, "region");
        int x, y, w, h;
        if (region != null)
        {
            x = Int(region, "x", 0);
            y = Int(region, "y", 0);
            w = Int(region, "w", 0);
            h = Int(region, "h", 0);
        }
        else
        {
            long hwndValue = Long(req, "hwnd", 0);
            if (hwndValue != 0)
            {
                RECT rect;
                if (!GetWindowRect(new IntPtr(hwndValue), out rect))
                {
                    throw new InvalidOperationException("cannot read the window rectangle");
                }
                x = rect.Left;
                y = rect.Top;
                w = rect.Right - rect.Left;
                h = rect.Bottom - rect.Top;
            }
            else
            {
                Dictionary<string, object> metrics = ScreenMetrics();
                x = Int(metrics, "virtualX", 0);
                y = Int(metrics, "virtualY", 0);
                w = Int(metrics, "virtualWidth", 0);
                h = Int(metrics, "virtualHeight", 0);
            }
        }

        if (w <= 0 || h <= 0) throw new InvalidOperationException("capture area is empty (" + w + "x" + h + ")");
        if (w > 20000 || h > 20000) throw new InvalidOperationException("capture area is too large (" + w + "x" + h + ")");

        DirectoryInfo parent = Directory.GetParent(path);
        if (parent != null && !parent.Exists) parent.Create();

        using (Bitmap bitmap = new Bitmap(w, h, PixelFormat.Format24bppRgb))
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            bitmap.Save(path, ImageFormat.Png);
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["path"] = path;
        result["width"] = w;
        result["height"] = h;
        result["origin"] = new object[] { x, y };
        return result;
    }

    // ---------------- 窗口 ----------------

    private static string WindowTitle(IntPtr hwnd)
    {
        int length = GetWindowTextLengthW(hwnd);
        if (length <= 0) return "";
        StringBuilder sb = new StringBuilder(length + 2);
        GetWindowTextW(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static List<Dictionary<string, object>> EnumerateWindows()
    {
        List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
        EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr lParam)
        {
            try
            {
                if (!IsWindowVisible(hwnd)) return true;
                string title = WindowTitle(hwnd);
                if (title.Length == 0) return true;
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                RECT rect;
                GetWindowRect(hwnd, out rect);
                Dictionary<string, object> row = new Dictionary<string, object>();
                row["hwnd"] = hwnd.ToInt64();
                row["pid"] = pid;
                row["title"] = title;
                row["state"] = IsIconic(hwnd) ? "minimized" : (IsZoomed(hwnd) ? "maximized" : "normal");
                row["x"] = rect.Left;
                row["y"] = rect.Top;
                row["width"] = rect.Right - rect.Left;
                row["height"] = rect.Bottom - rect.Top;
                try { row["process"] = Process.GetProcessById((int)pid).ProcessName; }
                catch (Exception) { row["process"] = null; }
                rows.Add(row);
            }
            catch (Exception) { }
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        return rows;
    }

    private static object WindowList()
    {
        List<Dictionary<string, object>> windows = EnumerateWindows();
        IntPtr foreground = GetForegroundWindow();
        foreach (Dictionary<string, object> row in windows)
        {
            row["foreground"] = ((long)row["hwnd"]) == foreground.ToInt64();
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["windows"] = windows;
        result["count"] = windows.Count;
        return result;
    }

    private static IntPtr FindWindow(Dictionary<string, object> req)
    {
        long hwndValue = Long(req, "hwnd", 0);
        if (hwndValue != 0)
        {
            IntPtr direct = new IntPtr(hwndValue);
            if (!IsWindow(direct)) throw new InvalidOperationException("window handle " + hwndValue + " is not a valid window");
            return direct;
        }
        string title = Str(req, "title", null);
        int pid = Int(req, "pid", 0);
        if (string.IsNullOrEmpty(title) && pid == 0)
        {
            throw new InvalidOperationException("pass hwnd, or title, or pid to identify the window");
        }
        List<Dictionary<string, object>> windows = EnumerateWindows();
        if (pid != 0)
        {
            foreach (Dictionary<string, object> row in windows)
            {
                if ((int)(uint)row["pid"] == pid) return new IntPtr((long)row["hwnd"]);
            }
        }
        if (!string.IsNullOrEmpty(title))
        {
            string needle = title.Trim().ToLowerInvariant();
            foreach (Dictionary<string, object> row in windows)
            {
                string candidate = ((string)row["title"]).ToLowerInvariant();
                if (candidate == needle) return new IntPtr((long)row["hwnd"]);
            }
            foreach (Dictionary<string, object> row in windows)
            {
                string candidate = ((string)row["title"]).ToLowerInvariant();
                if (candidate.Contains(needle)) return new IntPtr((long)row["hwnd"]);
            }
            throw new InvalidOperationException("no visible window title contains: " + title);
        }
        throw new InvalidOperationException("no visible window belongs to pid " + pid);
    }

    private static object WindowFocus(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);

        // 前台锁：把当前线程输入队列临时附到目标窗口线程后才能稳定调用。
        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid;
        uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
        uint targetPid;
        uint targetThread = GetWindowThreadProcessId(hwnd, out targetPid);
        uint self = GetCurrentThreadId();
        bool attached = false;
        if (targetThread != 0 && targetThread != self)
        {
            attached = AttachThreadInput(self, targetThread, true);
        }
        try
        {
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            Thread.Sleep(60);
        }
        finally
        {
            if (attached) AttachThreadInput(self, targetThread, false);
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["title"] = WindowTitle(hwnd);
        result["foreground"] = GetForegroundWindow().ToInt64() == hwnd.ToInt64();
        return result;
    }

    private static object WindowShow(Dictionary<string, object> req, int command)
    {
        IntPtr hwnd = FindWindow(req);
        ShowWindow(hwnd, command);
        Thread.Sleep(50);
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["title"] = WindowTitle(hwnd);
        result["state"] = IsIconic(hwnd) ? "minimized" : (IsZoomed(hwnd) ? "maximized" : "normal");
        return result;
    }

    private static object WindowClose(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        bool posted = PostMessageW(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        if (!posted) throw new InvalidOperationException("failed to send WM_CLOSE");
        Thread.Sleep(80);
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["title"] = WindowTitle(hwnd);
        result["stillOpen"] = IsWindow(hwnd);
        return result;
    }

    private static object WindowMove(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        RECT rect;
        GetWindowRect(hwnd, out rect);
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        int x = Int(req, "x", rect.Left);
        int y = Int(req, "y", rect.Top);
        if (!MoveWindow(hwnd, x, y, width, height, true))
        {
            throw new InvalidOperationException("MoveWindow failed");
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["x"] = x;
        result["y"] = y;
        result["width"] = width;
        result["height"] = height;
        return result;
    }

    private static object WindowResize(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        RECT rect;
        GetWindowRect(hwnd, out rect);
        int width = Int(req, "width", rect.Right - rect.Left);
        int height = Int(req, "height", rect.Bottom - rect.Top);
        if (width <= 0 || height <= 0) throw new InvalidOperationException("width and height must be positive");
        if (!MoveWindow(hwnd, rect.Left, rect.Top, width, height, true))
        {
            throw new InvalidOperationException("MoveWindow failed");
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["width"] = width;
        result["height"] = height;
        return result;
    }

    // ---------------- 应用 ----------------

    private static object AppLaunch(Dictionary<string, object> req)
    {
        string target = Str(req, "target", null);
        if (string.IsNullOrEmpty(target) || target.Trim().Length == 0)
        {
            throw new InvalidOperationException("missing target");
        }
        ProcessStartInfo info = new ProcessStartInfo(target);
        // 明确的 exe 用 CreateProcess 直启：比 ShellExecute 快，也不受 shell 关联解析影响。
        info.UseShellExecute = !target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
        string arguments = Str(req, "args", null);
        if (!string.IsNullOrEmpty(arguments)) info.Arguments = arguments;
        string workingDirectory = Str(req, "cwd", null);
        if (!string.IsNullOrEmpty(workingDirectory)) info.WorkingDirectory = workingDirectory;
        string verb = Str(req, "verb", null);
        if (!string.IsNullOrEmpty(verb)) info.Verb = verb;

        Process process = Process.Start(info);
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["target"] = target;
        if (process == null)
        {
            result["pid"] = null;
            result["note"] = "Windows started the target through its file association; no process handle is available.";
            return result;
        }
        result["pid"] = process.Id;
        try { result["process"] = process.ProcessName; }
        catch (Exception) { result["process"] = null; }
        // 故意不读 MainWindowTitle：它会阻塞到目标窗口创建，足以让 launch 调用超时。
        return result;
    }

    private static object AppList(Dictionary<string, object> req)
    {
        string filter = Str(req, "filter", null);
        string needle = string.IsNullOrEmpty(filter) ? null : filter.Trim().ToLowerInvariant();
        List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
        foreach (Process process in Process.GetProcesses())
        {
            try
            {
                string name = null;
                try { name = process.ProcessName; } catch (Exception) { }
                if (needle != null && (name == null || !name.ToLowerInvariant().Contains(needle))) continue;
                Dictionary<string, object> row = new Dictionary<string, object>();
                row["pid"] = process.Id;
                row["name"] = name;
                try { row["title"] = process.MainWindowTitle; }
                catch (Exception) { row["title"] = null; }
                try { row["responding"] = process.Responding; }
                catch (Exception) { row["responding"] = null; }
                try { row["memoryMb"] = Math.Round(process.WorkingSet64 / 1048576.0, 1); }
                catch (Exception) { row["memoryMb"] = null; }
                rows.Add(row);
            }
            catch (Exception) { }
        }
        rows.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
        {
            string left = a["name"] == null ? "" : a["name"].ToString();
            string right = b["name"] == null ? "" : b["name"].ToString();
            return string.Compare(left, right, StringComparison.OrdinalIgnoreCase);
        });
        bool truncated = rows.Count > 300;
        if (truncated) rows = rows.GetRange(0, 300);
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["processes"] = rows;
        result["count"] = rows.Count;
        result["truncated"] = truncated;
        return result;
    }

    private static object AppKill(Dictionary<string, object> req)
    {
        int pid = Int(req, "pid", 0);
        string name = Str(req, "name", null);
        List<object> killed = new List<object>();
        List<object> failed = new List<object>();
        List<int> protectedPids = new List<int>();
        protectedPids.Add(Process.GetCurrentProcess().Id);
        List<object> extraProtected = ListOf(req, "protectPids");
        if (extraProtected != null)
        {
            foreach (object item in extraProtected)
            {
                try { int value = Convert.ToInt32(item); if (value > 0) protectedPids.Add(value); }
                catch (Exception) { }
            }
        }

        List<Process> targets = new List<Process>();
        if (pid > 0)
        {
            try { targets.Add(Process.GetProcessById(pid)); }
            catch (Exception error) { throw new InvalidOperationException("cannot open pid " + pid + ": " + error.Message); }
        }
        else if (!string.IsNullOrEmpty(name))
        {
            string needle = name.Trim().ToLowerInvariant();
            foreach (Process process in Process.GetProcesses())
            {
                try
                {
                    // 全等而不是子串：`node` 不该命中 `node-helper`，更不该顺手带走一堆同名进程。
                    if (process.ProcessName.ToLowerInvariant() == needle) targets.Add(process);
                }
                catch (Exception) { }
            }
            if (targets.Count == 0) throw new InvalidOperationException("no running process matches: " + name);
        }
        else
        {
            throw new InvalidOperationException("pass pid or name");
        }

        foreach (Process target in targets)
        {
            // 自保护：helper 自己、宿主进程（由 Node 侧传入）、以及系统关键进程一律不许杀。
            if (IsProtectedForKill(target, protectedPids)) continue;
            Dictionary<string, object> entry = new Dictionary<string, object>();
            entry["pid"] = target.Id;
            try { entry["name"] = target.ProcessName; }
            catch (Exception) { entry["name"] = null; }
            try
            {
                target.Kill();
                entry["killed"] = true;
                killed.Add(entry);
            }
            catch (Exception error)
            {
                entry["killed"] = false;
                entry["error"] = error.Message;
                failed.Add(entry);
            }
            finally
            {
                try { target.Dispose(); } catch (Exception) { }
            }
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["killed"] = killed;
        result["failed"] = failed;
        return result;
    }

    /** 杀掉这些进程会直接把机器或宿主搞坏：helper 自己、宿主进程、系统关键进程。 */
    private static bool IsProtectedForKill(Process process, List<int> protectedPids)
    {
        try
        {
            if (protectedPids.Contains(process.Id)) return true;
            string name = process.ProcessName.ToLowerInvariant();
            switch (name)
            {
                case "system":
                case "registry":
                case "memory compression":
                case "smss":
                case "csrss":
                case "wininit":
                case "winlogon":
                case "services":
                case "lsass":
                case "svchost":
                case "dwm":
                case "explorer":
                case "spoolsv":
                    return true;
            }
            return false;
        }
        catch (Exception)
        {
            return true;
        }
    }

    // ---------------- 系统 ----------------

    private static object ClipboardGet()
    {
        string text = ClipboardReadText();
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["text"] = text ?? "";
        result["length"] = (text ?? "").Length;
        result["hasText"] = text != null;
        return result;
    }

    private static object ClipboardSet(Dictionary<string, object> req)
    {
        string text = Str(req, "text", "");
        if (text == null) text = "";
        ClipboardWriteText(text);
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["length"] = text.Length;
        return result;
    }

    /**
     * 剪贴板里是不是「只有纯文本」。
     * 用数量阈值不可靠：应用只提交一种文本格式时，系统会合成出 CF_TEXT / CF_OEMTEXT /
     * CF_UNICODETEXT / CF_LOCALE 四个，数量就已经是 4。
     * 按格式 ID 判断才准：1=TEXT 7=OEMTEXT 13=UNICODETEXT 16=LOCALE，其余一律视为有富内容。
     */
    private static bool ClipboardIsPlainText()
    {
        try
        {
            if (!OpenClipboard(IntPtr.Zero)) return false;
            try
            {
                bool hasText = false;
                uint format = 0;
                while ((format = EnumClipboardFormats(format)) != 0)
                {
                    if (format == 1u || format == 7u || format == 13u) { hasText = true; continue; }
                    if (format == 16u) continue;
                    return false;
                }
                return hasText;
            }
            finally { CloseClipboard(); }
        }
        catch (Exception) { return false; }
    }

    private static string ClipboardReadText()
    {
        for (int attempt = 0; attempt < 10; attempt++)
        {
            if (OpenClipboard(IntPtr.Zero))
            {
                try
                {
                    IntPtr handle = GetClipboardData(CF_UNICODETEXT);
                    if (handle == IntPtr.Zero) return null;
                    IntPtr pointer = GlobalLock(handle);
                    if (pointer == IntPtr.Zero) return "";
                    try { return Marshal.PtrToStringUni(pointer) ?? ""; }
                    finally { GlobalUnlock(handle); }
                }
                finally { CloseClipboard(); }
            }
            Thread.Sleep(50);
        }
        throw new InvalidOperationException("the clipboard is busy; retry the call");
    }

    private static void ClipboardWriteText(string text)
    {
        byte[] payload = Encoding.Unicode.GetBytes(text + "\0");
        for (int attempt = 0; attempt < 10; attempt++)
        {
            if (!OpenClipboard(IntPtr.Zero))
            {
                Thread.Sleep(50);
                continue;
            }
            try
            {
                if (!EmptyClipboard()) throw new InvalidOperationException("EmptyClipboard failed");
                IntPtr memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, new UIntPtr((uint)payload.Length));
                if (memory == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed");
                IntPtr pointer = GlobalLock(memory);
                if (pointer == IntPtr.Zero)
                {
                    GlobalFree(memory);
                    throw new InvalidOperationException("GlobalLock failed");
                }
                try { Marshal.Copy(payload, 0, pointer, payload.Length); }
                finally { GlobalUnlock(memory); }
                if (SetClipboardData(CF_UNICODETEXT, memory) == IntPtr.Zero)
                {
                    GlobalFree(memory);
                    throw new InvalidOperationException("SetClipboardData failed");
                }
                return;
            }
            finally { CloseClipboard(); }
        }
        throw new InvalidOperationException("the clipboard is busy; retry the call");
    }

    private static object SystemVolume(Dictionary<string, object> req)
    {
        string direction = Str(req, "direction", "up").Trim().ToLowerInvariant();
        int times = Int(req, "times", 1);
        if (times < 1) times = 1;
        if (times > 50) times = 50;
        int vk = direction == "down" ? 174 : 175;
        for (int i = 0; i < times; i++)
        {
            KeyEvent(vk, false, true);
            Thread.Sleep(12);
            KeyEvent(vk, true, true);
            Thread.Sleep(45);
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["direction"] = direction;
        result["times"] = times;
        return result;
    }

    private static object SystemMute()
    {
        KeyEvent(173, false, true);
        Thread.Sleep(15);
        KeyEvent(173, true, true);
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["mute"] = "toggled";
        return result;
    }

    private static object SystemLock()
    {
        bool locked = LockWorkStation();
        if (!locked) throw new InvalidOperationException("LockWorkStation failed");
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["locked"] = true;
        return result;
    }

    private static object SystemInfo()
    {
        Dictionary<string, object> result = ScreenMetrics();
        result["osVersion"] = Environment.OSVersion.VersionString;
        result["machine"] = Environment.MachineName;
        result["user"] = Environment.UserName;
        result["is64BitProcess"] = Environment.Is64BitProcess;
        result["processorCount"] = Environment.ProcessorCount;
        try { result["uptimeSeconds"] = (long)(GetTickCount64() / 1000UL); }
        catch (Exception) { result["uptimeSeconds"] = Environment.TickCount / 1000; }
        try
        {
            Process current = Process.GetCurrentProcess();
            result["helperPid"] = current.Id;
        }
        catch (Exception) { result["helperPid"] = null; }
        try
        {
            DriveInfo systemDrive = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory));
            Dictionary<string, object> disk = new Dictionary<string, object>();
            disk["name"] = systemDrive.Name;
            disk["freeGb"] = Math.Round(systemDrive.AvailableFreeSpace / 1073741824.0, 1);
            disk["totalGb"] = Math.Round(systemDrive.TotalSize / 1073741824.0, 1);
            result["systemDrive"] = disk;
        }
        catch (Exception) { result["systemDrive"] = null; }

        // 输入能力自检：把光标原地「移动」一次，判断前台注入是否被系统拒绝。
        // 很多环境里 GetCursorPos 正常但 SetCursorPos/SendInput 被 UIPI 拦，必须在运行时暴露出来。
        try
        {
            POINT cursor;
            GetCursorPos(out cursor);
            bool moved = SetCursorPos(cursor.X, cursor.Y);
            Dictionary<string, object> probe = new Dictionary<string, object>();
            probe["cursorX"] = cursor.X;
            probe["cursorY"] = cursor.Y;
            probe["setCursor"] = moved;
            probe["setCursorError"] = moved ? 0 : Marshal.GetLastWin32Error();

            INPUT[] noop = new INPUT[1];
            noop[0].type = INPUT_MOUSE;
            noop[0].u.mi.dwFlags = 0;
            uint sent = SendInput(1, noop, InputSize);
            probe["sendInput"] = sent == 1;
            probe["sendInputError"] = sent == 1 ? 0 : Marshal.GetLastWin32Error();
            probe["session"] = Process.GetCurrentProcess().SessionId;
            probe["foregroundInjection"] = sent == 1;
            result["inputProbe"] = probe;
        }
        catch (Exception error)
        {
            result["inputProbe"] = error.Message;
        }
        result["backgroundInjection"] = "PostMessage";

        // 进程环境诊断：Job Object / 窗口站 / 桌面，用来解释「同进程树里 PowerShell 能注入、helper 不能」。
        try
        {
            bool inJob = false;
            IsProcessInJob(Process.GetCurrentProcess().Handle, IntPtr.Zero, out inJob);
            result["inJobObject"] = inJob;
        }
        catch (Exception) { result["inJobObject"] = null; }
        try
        {
            result["windowStation"] = UserObjectName(GetProcessWindowStation());
            result["desktop"] = UserObjectName(GetThreadDesktop(GetCurrentThreadId()));
        }
        catch (Exception) { }

        result["bootProbe"] = BootProbe;
        return result;
    }

    private static void RunSelfTest()
    {
        try
        {
            Console.WriteLine("pid=" + Process.GetCurrentProcess().Id);
            Console.WriteLine("dpiCtx=" + GetThreadDpiAwarenessContext().ToInt64());
            Console.WriteLine("winsta=" + UserObjectName(GetProcessWindowStation()));
            Console.WriteLine("desktop=" + UserObjectName(GetThreadDesktop(GetCurrentThreadId())));
            bool inJob = false;
            IsProcessInJob(Process.GetCurrentProcess().Handle, IntPtr.Zero, out inJob);
            Console.WriteLine("inJob=" + inJob);

            POINT p;
            GetCursorPos(out p);
            Console.WriteLine("cursor=" + p.X + "," + p.Y);
            bool setOk = SetCursorPos(120, 120);
            int err = Marshal.GetLastWin32Error();
            Console.WriteLine("setCursor(120,120)=" + setOk + " err=" + err);
            Thread.Sleep(80);
            POINT q;
            GetCursorPos(out q);
            Console.WriteLine("afterSet=" + q.X + "," + q.Y);

            int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dx = (int)Math.Round(600.0 * 65535.0 / (vw - 1));
            inputs[0].u.mi.dy = (int)Math.Round(300.0 * 65535.0 / (vh - 1));
            inputs[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
            uint sent = SendInput(1, inputs, InputSize);
            Thread.Sleep(120);
            POINT r;
            GetCursorPos(out r);
            Console.WriteLine("sendInput=" + sent + " vw=" + vw + " vh=" + vh + " afterSend=" + r.X + "," + r.Y);
        }
        catch (Exception error)
        {
            Console.WriteLine("selftest error: " + error.Message);
        }
    }

    private static string UserObjectName(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return "";
        StringBuilder buffer = new StringBuilder(256);
        int needed;
        if (!GetUserObjectInformationW(handle, 2, buffer, 512, out needed)) return "";
        return buffer.ToString();
    }

    // ---------------- 后台操控（PostMessage / PrintWindow） ----------------
    // 不移动真实光标、不抢前台：直接向目标窗口投递鼠标/键盘消息。
    // 适用：传统 Win32 控件、WinForms/WPF、老式程序。
    // 不适用：Chromium/Electron/UWP 等不读父窗口消息的应用，它们只会收到消息但不反应。

    private static IntPtr MakeLParam(int low, int high)
    {
        return new IntPtr((high << 16) | (low & 0xFFFF));
    }

    /**
     * 找到目标窗口里真正拥有键盘焦点的子控件。
     * 直接把 WM_CHAR 投给顶层窗口时，WinForms/Win32 的 Form 不会自动转给 TextBox，
     * 表现就是「消息投递成功、字却没进去」。所以先问系统这个线程的焦点窗口是谁。
     */
    private static IntPtr FocusTarget(IntPtr hwnd)
    {
        uint pid;
        uint threadId = GetWindowThreadProcessId(hwnd, out pid);
        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(threadId, ref info) && info.hwndFocus != IntPtr.Zero)
        {
            if (GetAncestor(info.hwndFocus, GA_ROOT) == hwnd) return info.hwndFocus;
        }
        return hwnd;
    }

    private static object WindowBackgroundInfo(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        RECT client;
        GetClientRect(hwnd, out client);
        POINT origin;
        origin.X = 0;
        origin.Y = 0;
        ClientToScreen(hwnd, ref origin);
        RECT windowRect;
        GetWindowRect(hwnd, out windowRect);
        StringBuilder cls = new StringBuilder(256);
        GetClassNameW(hwnd, cls, 256);

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["title"] = WindowTitle(hwnd);
        result["className"] = cls.ToString();
        result["clientWidth"] = client.Right - client.Left;
        result["clientHeight"] = client.Bottom - client.Top;
        result["clientOriginX"] = origin.X;
        result["clientOriginY"] = origin.Y;
        result["windowX"] = windowRect.Left;
        result["windowY"] = windowRect.Top;
        result["windowWidth"] = windowRect.Right - windowRect.Left;
        result["windowHeight"] = windowRect.Bottom - windowRect.Top;
        result["foreground"] = GetForegroundWindow().ToInt64() == hwnd.ToInt64();
        return result;
    }

    private static object BackgroundClick(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        int x = Int(req, "x", 0);
        int y = Int(req, "y", 0);
        string button = Str(req, "button", "left");
        int count = Int(req, "count", 1);
        if (count < 1) count = 1;
        if (count > 3) count = 3;

        uint down;
        uint up;
        uint pressed;
        switch ((button ?? "left").Trim().ToLowerInvariant())
        {
            case "right": down = WM_RBUTTONDOWN; up = WM_RBUTTONUP; pressed = MK_RBUTTON; break;
            case "middle": down = WM_MBUTTONDOWN; up = WM_MBUTTONUP; pressed = MK_MBUTTON; break;
            default: down = WM_LBUTTONDOWN; up = WM_LBUTTONUP; pressed = MK_LBUTTON; break;
        }

        // 先做子控件命中：直接投给顶层窗口时，WinForms 的按钮、树、列表都不会响应。
        // 一路降到最深的子控件：只下一层的话，按钮嵌在 Panel/GroupBox 里时
        // 命中的是容器而不是按钮，点了等于没点。
        POINT hit;
        hit.X = x;
        hit.Y = y;
        IntPtr target = hwnd;
        for (int depth = 0; depth < 8; depth++)
        {
            IntPtr child = ChildWindowFromPointEx(target, hit, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
            if (child == IntPtr.Zero || child == target) break;
            MapWindowPoints(target, child, ref hit, 1);
            target = child;
        }
        IntPtr position = MakeLParam(hit.X, hit.Y);
        for (int i = 0; i < count; i++)
        {
            bool okDown = PostMessageW(target, down, new IntPtr((long)pressed), position);
            Thread.Sleep(12);
            bool okUp = PostMessageW(target, up, IntPtr.Zero, position);
            if (!okDown || !okUp)
            {
                throw new InvalidOperationException("后台点击投递失败（Win32 " + Marshal.GetLastWin32Error()
                    + "）；目标窗口可能已关闭或拒绝消息");
            }
            if (i < count - 1) Thread.Sleep(60);
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["x"] = x;
        result["y"] = y;
        result["button"] = button;
        result["count"] = count;
        result["mode"] = "background";
        return result;
    }

    private static object BackgroundScroll(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        int x = Int(req, "x", 0);
        int y = Int(req, "y", 0);
        int dy = Int(req, "dy", 0);
        int dx = Int(req, "dx", 0);

        POINT screen;
        screen.X = x;
        screen.Y = y;
        ClientToScreen(hwnd, ref screen);

        if (dy != 0)
        {
            long delta = ((long)(dy * 120) & 0xFFFF) << 16;
            PostMessageW(hwnd, WM_MOUSEWHEEL, new IntPtr(delta), MakeLParam(screen.X, screen.Y));
        }
        if (dx != 0)
        {
            long delta = ((long)(dx * 120) & 0xFFFF) << 16;
            PostMessageW(hwnd, 0x020E, new IntPtr(delta), MakeLParam(screen.X, screen.Y));
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["dy"] = dy;
        result["dx"] = dx;
        result["mode"] = "background";
        return result;
    }

    private static object BackgroundType(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        IntPtr target = FocusTarget(hwnd);
        string text = Str(req, "text", "");
        if (text == null) text = "";
        if (text.Length > 20000) throw new InvalidOperationException("text is too long (max 20000 characters)");

        int sent = 0;
        foreach (char ch in text)
        {
            if (ch == '\r') continue;
            char outCh = ch == '\n' ? '\r' : ch;
            PostMessageW(target, WM_CHAR, new IntPtr((long)outCh), new IntPtr(1));
            sent++;
            if (sent % 40 == 0) Thread.Sleep(2);
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["target"] = target.ToInt64();
        result["chars"] = sent;
        result["mode"] = "background";
        return result;
    }

    private static object BackgroundPress(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        IntPtr target = FocusTarget(hwnd);
        List<object> combos = ListOf(req, "combos");
        if (combos == null || combos.Count == 0)
        {
            string single = Str(req, "keys", null);
            if (single == null) throw new InvalidOperationException("missing keys");
            combos = new List<object>();
            combos.Add(single);
        }

        List<object> done = new List<object>();
        foreach (object entry in combos)
        {
            string combo = entry == null ? "" : entry.ToString();
            string[] parts = combo.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) throw new InvalidOperationException("empty key combo: " + combo);

            List<int> modifiers = new List<int>();
            int mainVk = 0;
            for (int i = 0; i < parts.Length; i++)
            {
                int vk = VirtualKey(parts[i].Trim());
                if (vk == 0) throw new InvalidOperationException("unknown key name: " + parts[i]);
                if (IsModifier(parts[i]) && i < parts.Length - 1) modifiers.Add(vk);
                else mainVk = vk;
            }
            if (mainVk == 0) throw new InvalidOperationException("combo has no main key: " + combo);
            if (modifiers.Count > 0)
            {
                // 后台投递 WM_KEYDOWN 时目标读的是真实键盘状态（GetKeyState），修饰键传不过去：
                // ctrl+a 实际只会到达一个 'a'。宁可明确报错，也不要假装成功。
                throw new InvalidOperationException("后台模式不支持组合键：目标按真实键盘状态读修饰键，ctrl+a 只会变成 a。请改用前台模式（不传 mode）。");
            }

            foreach (int vk in modifiers)
            {
                PostMessageW(target, WM_KEYDOWN, new IntPtr(vk), KeyLParam(vk, false));
                Thread.Sleep(10);
            }
            PostMessageW(target, WM_KEYDOWN, new IntPtr(mainVk), KeyLParam(mainVk, false));
            Thread.Sleep(20);
            PostMessageW(target, WM_KEYUP, new IntPtr(mainVk), KeyLParam(mainVk, true));
            for (int i = modifiers.Count - 1; i >= 0; i--)
            {
                Thread.Sleep(10);
                PostMessageW(target, WM_KEYUP, new IntPtr(modifiers[i]), KeyLParam(modifiers[i], true));
            }
            done.Add(combo);
            Thread.Sleep(30);
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["hwnd"] = hwnd.ToInt64();
        result["pressed"] = done;
        result["mode"] = "background";
        return result;
    }

    private static IntPtr KeyLParam(int vk, bool up)
    {
        long scan = (long)MapVirtualKeyW((uint)vk, 0);
        long value = 1 | (scan << 16);
        if (IsExtendedKey(vk)) value |= 1 << 24;
        if (up) value |= (1L << 30) | (1L << 31);
        return new IntPtr(value);
    }

    private static object BackgroundGrab(Dictionary<string, object> req)
    {
        IntPtr hwnd = FindWindow(req);
        string path = Str(req, "path", null);
        if (string.IsNullOrEmpty(path)) throw new InvalidOperationException("missing path");

        // 目标窗口可能是 DPI 不感知的：位图按物理像素建、PrintWindow 按逻辑尺寸画，
        // 内容就会缩在左上角（150% 缩放下比例正好 1.5）。先切到目标窗口的 DPI 上下文。
        IntPtr targetContext = GetWindowDpiAwarenessContext(hwnd);
        IntPtr previousContext = IntPtr.Zero;
        if (targetContext != IntPtr.Zero) previousContext = SetThreadDpiAwarenessContext(targetContext);
        bool printed;
        int width;
        int height;
        try
        {
            RECT windowBox;
            GetWindowRect(hwnd, out windowBox);
            width = windowBox.Right - windowBox.Left;
            height = windowBox.Bottom - windowBox.Top;
            if (width <= 0 || height <= 0) throw new InvalidOperationException("窗口尺寸为空（可能已最小化）");

            DirectoryInfo parent = Directory.GetParent(path);
            if (parent != null && !parent.Exists) parent.Create();

            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    IntPtr hdc = graphics.GetHdc();
                    try { printed = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT); }
                    finally { graphics.ReleaseHdc(hdc); }
                }
                bitmap.Save(path, ImageFormat.Png);
            }
        }
        finally
        {
            if (previousContext != IntPtr.Zero) SetThreadDpiAwarenessContext(previousContext);
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["path"] = path;
        result["width"] = width;
        result["height"] = height;
        result["mode"] = "background";
        result["printWindow"] = printed;
        return result;
    }

    // ---------------- JSON 取值辅助 ----------------

    private static Dictionary<string, object> AsDict(object value)
    {
        Dictionary<string, object> dict = value as Dictionary<string, object>;
        if (dict != null) return dict;
        IDictionary<string, object> generic = value as IDictionary<string, object>;
        if (generic != null)
        {
            Dictionary<string, object> copy = new Dictionary<string, object>();
            foreach (KeyValuePair<string, object> pair in generic) copy[pair.Key] = pair.Value;
            return copy;
        }
        return null;
    }

    private static Dictionary<string, object> Dict(Dictionary<string, object> source, string key)
    {
        if (source == null || !source.ContainsKey(key)) return null;
        return AsDict(source[key]);
    }

    private static List<object> ListOf(Dictionary<string, object> source, string key)
    {
        if (source == null || !source.ContainsKey(key)) return null;
        object value = source[key];
        if (value == null) return null;
        List<object> list = value as List<object>;
        if (list != null) return list;
        ArrayList arrayList = value as ArrayList;
        if (arrayList != null) return new List<object>(arrayList.ToArray());
        IList enumerable = value as IList;
        if (enumerable != null)
        {
            List<object> copy = new List<object>();
            foreach (object item in enumerable) copy.Add(item);
            return copy;
        }
        return null;
    }

    private static string Str(Dictionary<string, object> source, string key, string fallback)
    {
        if (source == null || !source.ContainsKey(key) || source[key] == null) return fallback;
        return source[key].ToString();
    }

    private static int Int(Dictionary<string, object> source, string key, int fallback)
    {
        if (source == null || !source.ContainsKey(key) || source[key] == null) return fallback;
        object value = source[key];
        if (value is int) return (int)value;
        if (value is long) return (int)(long)value;
        if (value is double) return (int)Math.Round((double)value);
        if (value is decimal) return (int)Math.Round((decimal)value);
        int parsed;
        if (int.TryParse(value.ToString(), out parsed)) return parsed;
        return fallback;
    }

    private static long Long(Dictionary<string, object> source, string key, long fallback)
    {
        if (source == null || !source.ContainsKey(key) || source[key] == null) return fallback;
        object value = source[key];
        if (value is long) return (long)value;
        if (value is int) return (long)(int)value;
        if (value is double) return (long)Math.Round((double)value);
        if (value is decimal) return (long)Math.Round((decimal)value);
        long parsed;
        if (long.TryParse(value.ToString(), out parsed)) return parsed;
        return fallback;
    }
}
