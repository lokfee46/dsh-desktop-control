// 测试靶子：一个最小 WinForms 窗口，多行 TextBox，每 200ms 把内容写进 %TEMP%\dc-target.txt。
// 用于精确验证 SendInput 是否把字符送进了标准 Win32 编辑控件。

using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class TargetApp
{
    [STAThread]
    public static void Main()
    {
        string outPath = Path.Combine(Path.GetTempPath(), "dc-target.txt");
        try { File.WriteAllText(outPath, "", new UTF8Encoding(false)); } catch (Exception) { }

        Form form = new Form();
        form.Text = "DC Target";
        form.Width = 900;
        form.Height = 640;
        form.StartPosition = FormStartPosition.CenterScreen;

        TextBox box = new TextBox();
        box.Multiline = true;
        box.Dock = DockStyle.Fill;
        box.Font = new Font("Microsoft YaHei UI", 18f);
        box.ScrollBars = ScrollBars.Vertical;
        form.Controls.Add(box);

        Timer timer = new Timer();
        timer.Interval = 150;
        timer.Tick += delegate(object sender, EventArgs e)
        {
            try { File.WriteAllText(outPath, box.Text, new UTF8Encoding(false)); }
            catch (Exception) { }
        };
        timer.Start();

        form.Shown += delegate(object sender, EventArgs e)
        {
            form.Activate();
            box.Focus();
        };

        Application.Run(form);
    }
}
