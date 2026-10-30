// Cinema Setup: a dark installer window. It downloads the normal installer from the release and runs it quietly,
// showing real progress. Written for the C# 5 compiler that ships with Windows, so it needs nothing to build.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Collections.Generic;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class SetupForm : Form
{
    enum Stage { Welcome, Working, Done, Failed }

    static readonly Color BG = Color.FromArgb(29, 31, 42);
    static readonly Color ACCENT = Color.FromArgb(139, 123, 255);
    static readonly Color TEAL = Color.FromArgb(45, 212, 191);
    static readonly Color TEXT = Color.FromArgb(242, 243, 247);
    static readonly Color MUTE = Color.FromArgb(172, 179, 194);
    static readonly Color LINE = Color.FromArgb(58, 61, 76);
    static readonly Color RAISE = Color.FromArgb(38, 41, 54);

    [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, int w, int l);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    Stage stage = Stage.Welcome;
    string installDir;
    string status = "";
    string error = "";
    volatile float target;
    float shown;
    volatile bool cancel;
    Process proc;
    Thread worker;
    float sc = 1f;
    Button bInstall, bCancel, bChange, bLaunch, bClose, bMin, bX, bOpen;
    System.Windows.Forms.Timer tick;
    // live install log: what is being written, replaced or removed, and where
    readonly object logLock = new object();
    List<string[]> logLines = new List<string[]>();   // { kind, text }
    int filesNew, filesOver, filesGone;
    static readonly Color AMBER = Color.FromArgb(245, 184, 75);
    static readonly Color ROSE = Color.FromArgb(255, 122, 147);

    void Log(string kind, string text)
    {
        lock (logLock) { logLines.Add(new string[] { kind, text }); if (logLines.Count > 600) logLines.RemoveAt(0); }
    }

    static Dictionary<string, string> Snapshot(string dir)
    {
        Dictionary<string, string> m = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try { Walk(dir, m); } catch { }
        return m;
    }
    static void Walk(string dir, Dictionary<string, string> m)
    {
        try
        {
            foreach (string f in Directory.GetFiles(dir))
            {
                try { FileInfo fi = new FileInfo(f); m[f] = fi.Length + "|" + fi.LastWriteTimeUtc.Ticks; } catch { }
            }
            foreach (string d in Directory.GetDirectories(dir)) Walk(d, m);
        }
        catch { }
    }
    static string Rel(string root, string full)
    {
        return full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? full.Substring(root.Length).TrimStart('\\') : full;
    }
    static string FmtSize(long b)
    {
        if (b >= 1048576) return (b / 1048576.0).ToString("0.0") + " MB";
        if (b >= 1024) return (b / 1024) + " KB";
        return b + " B";
    }

    int S(int v) { return (int)Math.Round(v * sc); }

    public SetupForm()
    {
        using (Graphics g = CreateGraphics()) { sc = g.DpiX / 96f; }
        installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Cinema");
        Text = "Cinema Setup";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(S(780), S(460));
        BackColor = BG;
        DoubleBuffered = true;
        ResizeRedraw = true;
        try { Region = Region.FromHrgn(CreateRoundRectRgn(0, 0, Width + 1, Height + 1, S(22), S(22))); } catch { }
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        bInstall = MakeButton("Install", true);
        bCancel = MakeButton("Cancel", false);
        bChange = MakeButton("Change…", false);
        bLaunch = MakeButton("Start Cinema", true);
        bClose = MakeButton("Close", false);
        bOpen = MakeButton("Open the download page", false);
        bMin = MakeButton("\u2013", false); bX = MakeButton("\u00D7", false);
        bInstall.Click += delegate { Begin(); };
        bCancel.Click += delegate { if (stage == Stage.Working) { cancel = true; } else Close(); };
        bChange.Click += delegate { Pick(); };
        bLaunch.Click += delegate { try { Process.Start(Path.Combine(installDir, "Cinema.exe")); } catch { } Close(); };
        bClose.Click += delegate { Close(); };
        bX.Click += delegate { if (stage == Stage.Working) cancel = true; else Close(); };
        bMin.Click += delegate { WindowState = FormWindowState.Minimized; };
        bOpen.Click += delegate { try { Process.Start(BuildInfo.Page); } catch { } };
        Control[] all = new Control[] { bInstall, bCancel, bChange, bLaunch, bClose, bMin, bX, bOpen };
        foreach (Control c in all) Controls.Add(c);
        bMin.Font = new Font("Segoe UI", 11f * sc / sc); bX.Font = new Font("Segoe UI", 12f);
        PlaceButtons();

        tick = new System.Windows.Forms.Timer();
        tick.Interval = 33;
        tick.Tick += delegate
        {
            float d = target - shown;
            if (Math.Abs(d) > 0.0005f) { shown += d * 0.12f; Invalidate(RightRect()); }
            if (stage == Stage.Working) Invalidate(RightRect());
        };
        tick.Start();
        MouseDown += delegate (object s, MouseEventArgs e) { if (e.Y < S(46)) { ReleaseCapture(); SendMessage(Handle, 0xA1, 2, 0); } };
    }

    Rectangle RightRect() { return new Rectangle(S(300), 0, ClientSize.Width - S(300), ClientSize.Height); }

    Button MakeButton(string text, bool primary)
    {
        Button b = new Button();
        b.Text = text;
        b.FlatStyle = FlatStyle.Flat;
        b.Font = new Font("Segoe UI Semibold", 10f);
        b.Cursor = Cursors.Hand;
        b.UseVisualStyleBackColor = false;
        b.FlatAppearance.BorderSize = primary ? 0 : 1;
        b.FlatAppearance.BorderColor = LINE;
        b.BackColor = primary ? ACCENT : RAISE;
        b.ForeColor = primary ? Color.FromArgb(17, 17, 20) : TEXT;
        b.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(160, 148, 255) : Color.FromArgb(36, 36, 46);
        b.FlatAppearance.MouseDownBackColor = primary ? Color.FromArgb(120, 104, 240) : Color.FromArgb(48, 48, 60);
        b.TabStop = true;
        return b;
    }

    void PlaceButtons()
    {
        int w = ClientSize.Width, h = ClientSize.Height;
        bX.SetBounds(w - S(44), S(10), S(34), S(30)); bMin.SetBounds(w - S(82), S(10), S(34), S(30));
        bX.FlatAppearance.BorderSize = 0; bMin.FlatAppearance.BorderSize = 0; bX.BackColor = BG; bMin.BackColor = BG;
        int by = h - S(78);
        bInstall.SetBounds(w - S(40) - S(150), by, S(150), S(42));
        bCancel.SetBounds(w - S(40) - S(150) - S(12) - S(110), by, S(110), S(42));
        bChange.SetBounds(w - S(40) - S(110), S(238), S(110), S(36));
        bLaunch.SetBounds(w - S(40) - S(170), by, S(170), S(42));
        bClose.SetBounds(w - S(40) - S(170) - S(12) - S(110), by, S(110), S(42));
        bOpen.SetBounds(w - S(40) - S(220), by, S(220), S(42));
        bInstall.Visible = bCancel.Visible = bChange.Visible = stage == Stage.Welcome;
        bLaunch.Visible = stage == Stage.Done; bClose.Visible = stage == Stage.Done || stage == Stage.Failed; bOpen.Visible = stage == Stage.Failed;
        if (stage == Stage.Failed) bClose.SetBounds(w - S(40) - S(220) - S(12) - S(110), by, S(110), S(42));
        if (stage == Stage.Working) { bCancel.Visible = true; bCancel.Text = "Cancel"; bCancel.SetBounds(w - S(40) - S(110), by, S(110), S(42)); }
        else { bCancel.Text = "Cancel"; }
        bMin.Visible = bX.Visible = true;
    }

    void Pick()
    {
        using (FolderBrowserDialog d = new FolderBrowserDialog())
        {
            d.Description = "Choose where to install Cinema";
            if (d.ShowDialog(this) == DialogResult.OK)
            {
                string p = d.SelectedPath;
                installDir = p.EndsWith("Cinema", StringComparison.OrdinalIgnoreCase) ? p : Path.Combine(p, "Cinema");
                Invalidate(RightRect());
            }
        }
    }

    void Begin()
    {
        stage = Stage.Working; cancel = false; target = 0; shown = 0; status = "Starting…"; error = "";
        lock (logLock) { logLines.Clear(); } filesNew = 0; filesOver = 0; filesGone = 0;
        PlaceButtons(); Invalidate();
        worker = new Thread(Work); worker.IsBackground = true; worker.Start();
    }

    void Go(Stage s) { BeginInvoke(new Action(delegate { stage = s; PlaceButtons(); Invalidate(); })); }

    static long DirSize(string dir)
    {
        long n = 0;
        try
        {
            foreach (string f in Directory.GetFiles(dir)) { try { n += new FileInfo(f).Length; } catch { } }
            foreach (string d in Directory.GetDirectories(dir)) n += DirSize(d);
        }
        catch { }
        return n;
    }

    void Work()
    {
        string file = null;
        try
        {
            string tmp = Path.Combine(Path.GetTempPath(), "CinemaSetup");
            Directory.CreateDirectory(tmp);
            file = Path.Combine(tmp, "Cinema-Setup-" + BuildInfo.Version + ".exe");
            status = "Downloading Cinema…";
            Log("info", "Connecting to " + new Uri(BuildInfo.Url).Host);
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768; } catch { }
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(BuildInfo.Url);
            req.UserAgent = "CinemaSetup"; req.AllowAutoRedirect = true; req.Timeout = 30000; req.ReadWriteTimeout = 30000;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (Stream inp = resp.GetResponseStream())
            using (FileStream outp = File.Create(file))
            {
                long total = resp.ContentLength > 0 ? resp.ContentLength : BuildInfo.InstallerBytes;
                Log("info", "Downloading the installer (" + FmtSize(total) + ") to " + file);
                byte[] buf = new byte[81920]; long got = 0; int n; int milestone = 20;
                DateTime t0 = DateTime.UtcNow;
                while ((n = inp.Read(buf, 0, buf.Length)) > 0)
                {
                    if (cancel) throw new OperationCanceledException();
                    outp.Write(buf, 0, n); got += n;
                    target = 0.55f * Math.Min(1f, (float)got / total);
                    double secs = Math.Max(0.1, (DateTime.UtcNow - t0).TotalSeconds);
                    status = string.Format("Downloading… {0} of {1} MB  ({2:0.0} MB/s)", got >> 20, total >> 20, got / secs / 1048576.0);
                    int pc = (int)(100.0 * got / Math.Max(1L, total));
                    if (pc >= milestone && milestone < 100) { Log("info", "Downloaded " + pc + "%  (" + FmtSize(got) + ")"); milestone += 20; }
                }
                Log("info", "Download complete. Saved " + FmtSize(got));
            }
            if (cancel) throw new OperationCanceledException();
            status = "Installing…";
            Log("head", "Installing to " + installDir);
            Dictionary<string, string> before = Snapshot(installDir);
            Log("info", before.Count > 0 ? "Found an existing install (" + before.Count + " files). It will be updated." : "Fresh install. Nothing to replace.");
            HashSet<string> reported = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> removed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            ProcessStartInfo psi = new ProcessStartInfo(file, "/S /D=" + installDir);
            psi.UseShellExecute = false; psi.CreateNoWindow = true;
            proc = Process.Start(psi);
            while (!proc.WaitForExit(350))
            {
                Dictionary<string, string> now = Snapshot(installDir);
                long sz = 0;
                foreach (KeyValuePair<string, string> kv in now)
                {
                    sz += long.Parse(kv.Value.Split('|')[0]);
                    if (reported.Contains(kv.Key)) continue;
                    string old;
                    if (!before.TryGetValue(kv.Key, out old)) { reported.Add(kv.Key); filesNew++; Log("new", "Writing      " + Rel(installDir, kv.Key) + "   " + FmtSize(long.Parse(kv.Value.Split('|')[0]))); }
                    else if (removed.Contains(kv.Key) || old != kv.Value) { reported.Add(kv.Key); filesOver++; Log("over", "Overwriting  " + Rel(installDir, kv.Key) + "   " + FmtSize(long.Parse(kv.Value.Split('|')[0]))); }
                }
                bool first = true;
                foreach (string k in before.Keys)
                {
                    if (now.ContainsKey(k) || removed.Contains(k)) continue;
                    removed.Add(k); filesGone++;
                    if (first && filesGone == 1) { Log("del", "Removing the previous version's files…"); }
                    first = false;
                }
                double frac = Math.Min(1.0, sz / (double)Math.Max(1L, BuildInfo.UnpackedBytes));
                target = (float)(0.55 + 0.43 * frac);
                status = "Installing… " + (int)(frac * 100) + "%   " + (filesNew + filesOver) + " files written";
            }
            if (proc.ExitCode != 0) { Log("del", "The installer stopped with code " + proc.ExitCode); throw new Exception("The installer stopped with code " + proc.ExitCode + "."); }
            Log("info", "Files finished (" + filesNew + " new, " + filesOver + " replaced).");
            string desk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Cinema.lnk");
            string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Cinema.lnk");
            string un = Path.Combine(installDir, "Uninstall Cinema.exe");
            if (File.Exists(un)) Log("new", "Writing      Uninstall Cinema.exe (so you can remove Cinema later)");
            if (File.Exists(menu)) Log("new", "Shortcut     Start menu: " + menu);
            if (File.Exists(desk)) Log("new", "Shortcut     Desktop: " + desk);
            Log("head", "Done. Cinema is installed in " + installDir);
            target = 1f; status = "Done";
            Thread.Sleep(450);
            Go(Stage.Done);
        }
        catch (OperationCanceledException) { target = 0; shown = 0; Go(Stage.Welcome); }
        catch (Exception e)
        {
            error = e is WebException ? "Could not download the installer. Check your internet connection and try again." : e.Message;
            Go(Stage.Failed);
        }
        finally { try { if (file != null && File.Exists(file)) File.Delete(file); } catch { } }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        int w = ClientSize.Width, h = ClientSize.Height;

        // left panel
        Rectangle left = new Rectangle(0, 0, S(300), h);
        using (LinearGradientBrush lb = new LinearGradientBrush(left, Color.FromArgb(34, 33, 54), Color.FromArgb(26, 30, 40), 90f)) g.FillRectangle(lb, left);
        Glow(g, S(90), S(120), S(210), Color.FromArgb(110, ACCENT));
        Glow(g, S(260), h - S(30), S(190), Color.FromArgb(70, TEAL));
        using (SolidBrush pb = new SolidBrush(Color.FromArgb(22, 255, 255, 255)))
            for (int y = S(14); y < h - S(14); y += S(26)) { FillRound(g, pb, new Rectangle(S(14), y, S(11), S(14)), S(3)); FillRound(g, pb, new Rectangle(S(300) - S(25), y, S(11), S(14)), S(3)); }
        int cx = S(150), cy = S(140);
        Glow(g, cx, cy, S(70), Color.FromArgb(140, ACCENT));
        using (SolidBrush a = new SolidBrush(ACCENT)) g.FillEllipse(a, cx - S(17), cy - S(17), S(34), S(34));
        g.FillEllipse(Brushes.White, cx - S(8), cy - S(8), S(16), S(16));
        StringFormat mid = new StringFormat(); mid.Alignment = StringAlignment.Center;
        using (Font f = new Font("Segoe UI Semibold", 25f)) g.DrawString("Cinema", f, Brushes.White, new RectangleF(0, cy + S(34), S(300), S(50)), mid);
        using (Font f = new Font("Segoe UI", 10f)) using (SolidBrush m = new SolidBrush(MUTE)) g.DrawString("Your private screening room", f, m, new RectangleF(0, cy + S(84), S(300), S(24)), mid);
        using (Pen p = new Pen(LINE)) g.DrawLine(p, S(300), 0, S(300), h);

        // right side
        int x = S(340), cw = w - x - S(40);
        using (SolidBrush t = new SolidBrush(TEXT)) using (SolidBrush m = new SolidBrush(MUTE))
        {
            Font big = new Font("Segoe UI Semibold", 22f), body = new Font("Segoe UI", 10.5f), small = new Font("Segoe UI", 9.5f);
            if (stage == Stage.Welcome)
            {
                g.DrawString("Install Cinema", big, t, x, S(70));
                g.DrawString("Stream from your own server, save videos to watch offline, and keep your whole library in one place.", body, m, new RectangleF(x, S(124), cw, S(70)));
                g.DrawString("Install location", small, m, x, S(214));
                Rectangle box = new Rectangle(x, S(238), cw - S(122), S(36));
                using (SolidBrush r = new SolidBrush(RAISE)) FillRound(g, r, box, S(8));
                using (Pen p = new Pen(LINE)) DrawRound(g, p, box, S(8));
                StringFormat ell = new StringFormat(); ell.Trimming = StringTrimming.EllipsisPath; ell.FormatFlags = StringFormatFlags.NoWrap; ell.LineAlignment = StringAlignment.Center;
                g.DrawString(installDir, small, t, new RectangleF(box.X + S(10), box.Y, box.Width - S(16), box.Height), ell);
                g.DrawString("About " + (BuildInfo.UnpackedBytes >> 20) + " MB. No administrator rights needed.", small, m, x, S(288));
            }
            else if (stage == Stage.Working)
            {
                g.DrawString("Installing Cinema", big, t, x, S(60));
                g.DrawString(status, body, m, new RectangleF(x, S(108), cw, S(26)));
                StringFormat pe = new StringFormat(); pe.Trimming = StringTrimming.EllipsisPath; pe.FormatFlags = StringFormatFlags.NoWrap;
                g.DrawString("Saving to  " + installDir, small, m, new RectangleF(x, S(134), cw, S(22)), pe);
                Rectangle bar = new Rectangle(x, S(164), cw - S(50), S(8));
                using (SolidBrush r = new SolidBrush(RAISE)) FillRound(g, r, bar, S(4));
                int fw = (int)(bar.Width * Math.Max(0f, Math.Min(1f, shown)));
                if (fw > S(8))
                {
                    Rectangle fr = new Rectangle(bar.X, bar.Y, fw, bar.Height);
                    using (LinearGradientBrush lb = new LinearGradientBrush(fr, ACCENT, TEAL, 0f)) FillRound(g, lb, fr, S(4));
                }
                g.DrawString((int)(Math.Max(0f, Math.Min(1f, shown)) * 100) + "%", small, t, bar.Right + S(8), S(158));

                // live log: every step, every file written or replaced, and where
                Rectangle lg = new Rectangle(x, S(190), cw, ClientSize.Height - S(190) - S(96));
                using (SolidBrush r = new SolidBrush(Color.FromArgb(24, 26, 36))) FillRound(g, r, lg, S(8));
                using (Pen p = new Pen(LINE)) DrawRound(g, p, lg, S(8));
                List<string[]> snap;
                lock (logLock) { snap = new List<string[]>(logLines); }
                using (Font mono = new Font("Consolas", 8.5f))
                {
                    int lh = (int)Math.Ceiling(mono.GetHeight(g)) + S(2);
                    int rows = Math.Max(1, (lg.Height - S(12)) / lh);
                    int from = Math.Max(0, snap.Count - rows);
                    StringFormat ln = new StringFormat(); ln.Trimming = StringTrimming.EllipsisCharacter; ln.FormatFlags = StringFormatFlags.NoWrap;
                    for (int i = from; i < snap.Count; i++)
                    {
                        Color c = snap[i][0] == "new" ? TEAL : snap[i][0] == "over" ? AMBER : snap[i][0] == "del" ? ROSE : snap[i][0] == "head" ? TEXT : MUTE;
                        using (SolidBrush lbr = new SolidBrush(c))
                            g.DrawString(snap[i][1], mono, lbr, new RectangleF(lg.X + S(10), lg.Y + S(6) + (i - from) * lh, lg.Width - S(18), lh), ln);
                    }
                }
                g.DrawString("Please keep this window open.", small, m, S(340), ClientSize.Height - S(58));
            }
            else if (stage == Stage.Done)
            {
                g.DrawString("Cinema is ready", big, t, x, S(70));
                g.DrawString("It is installed and a shortcut is on your desktop.\nPress Ctrl+K inside the app to find anything quickly.", body, m, new RectangleF(x, S(124), cw, S(80)));
                g.DrawString(filesNew + " files written, " + filesOver + " replaced", small, m, x, S(262));
                StringFormat pe2 = new StringFormat(); pe2.Trimming = StringTrimming.EllipsisPath; pe2.FormatFlags = StringFormatFlags.NoWrap;
                g.DrawString("Installed in  " + installDir, small, m, new RectangleF(x, S(284), cw, S(22)), pe2);
                using (SolidBrush a = new SolidBrush(TEAL)) g.FillEllipse(a, x, S(220), S(22), S(22));
                using (Pen p = new Pen(BG, 2.5f)) { g.DrawLines(p, new Point[] { new Point(x + S(6), S(231)), new Point(x + S(10), S(235)), new Point(x + S(17), S(226)) }); }
            }
            else
            {
                g.DrawString("Something went wrong", big, t, x, S(70));
                g.DrawString(error, body, m, new RectangleF(x, S(124), cw, S(110)));
            }
            big.Dispose(); body.Dispose(); small.Dispose();
        }
        using (Pen p = new Pen(LINE)) g.DrawRectangle(p, 0, 0, w - 1, h - 1);
    }

    void Glow(Graphics g, int cx, int cy, int r, Color c)
    {
        using (GraphicsPath gp = new GraphicsPath())
        {
            gp.AddEllipse(cx - r, cy - r, r * 2, r * 2);
            using (PathGradientBrush pg = new PathGradientBrush(gp))
            {
                pg.CenterColor = c; pg.SurroundColors = new Color[] { Color.FromArgb(0, c) };
                Region old = g.Clip; g.SetClip(new Rectangle(0, 0, S(300), ClientSize.Height), CombineMode.Intersect);
                g.FillEllipse(pg, cx - r, cy - r, r * 2, r * 2); g.Clip = old;
            }
        }
    }
    static GraphicsPath RoundPath(Rectangle r, int rad)
    {
        GraphicsPath p = new GraphicsPath(); int d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90); p.CloseFigure(); return p;
    }
    static void FillRound(Graphics g, Brush b, Rectangle r, int rad) { using (GraphicsPath p = RoundPath(r, rad)) g.FillPath(b, p); }
    static void DrawRound(Graphics g, Pen pen, Rectangle r, int rad) { using (GraphicsPath p = RoundPath(r, rad)) g.DrawPath(pen, p); }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        cancel = true;
        
        base.OnFormClosing(e);
    }

    [STAThread]
    static void Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm());
    }
}