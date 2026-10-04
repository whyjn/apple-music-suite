using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

class AppleMusicBallLauncher
{
    [STAThread]
    static void Main(string[] args)
    {
        try
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            string ps1 = Path.Combine(dir, "ball.ps1");

            if (!File.Exists(ps1))
            {
                MessageBox.Show("找不到 ball.ps1：\r\n" + ps1,
                    "Apple Music 悬浮球", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + ps1 + "\"";
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Apple Music 悬浮球 启动失败",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
