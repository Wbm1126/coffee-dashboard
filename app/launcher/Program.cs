using System.Diagnostics;
using System.Drawing;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

namespace CoffeeDashboard.Launcher;

internal static class Program
{
    private const string PayloadResource = "CoffeeDashboard.Payload.zip";
    private static readonly string ProductVersion = Assembly.GetExecutingAssembly()
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "unknown";
    private static readonly string ProductRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CoffeeDashboard");
    private static readonly string LogFile = Path.Combine(ProductRoot, "logs", "launcher.log");
    private static readonly object LogLock = new();

    [STAThread]
    private static void Main(string[] args)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(LogFile)!);
        var smokeTest = args.Contains("--smoke-test", StringComparer.OrdinalIgnoreCase);
        using var mutex = new Mutex(true, "Local\\CoffeeDashboard.v1", out var ownsMutex);
        if (!ownsMutex && !smokeTest)
        {
            if (WaitForExistingInstance().GetAwaiter().GetResult()) OpenBrowser("http://127.0.0.1:4173");
            else MessageBox.Show("已有豆迹正在启动，但尚未就绪。请稍后再次双击。", "豆迹正在启动", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        try
        {
            Environment.ExitCode = smokeTest ? RunSmokeTest().GetAwaiter().GetResult() : RunDesktop();
        }
        catch (Exception error)
        {
            Log(error.ToString());
            if (!smokeTest)
            {
                MessageBox.Show(
                    $"豆迹没有成功启动。\n\n诊断日志：{LogFile}\n\n{error.Message}",
                    "豆迹启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            Environment.ExitCode = 1;
        }
    }

    private static int RunDesktop()
    {
        var runtimeRoot = EnsurePayload();
        var port = 4173;
        using var process = StartServer(runtimeRoot, Path.Combine(ProductRoot, "data"), port);
        try
        {
            WaitUntilReady(process, port).GetAwaiter().GetResult();
            var address = $"http://127.0.0.1:{port}";
            OpenBrowser(address);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using var tray = new NotifyIcon
            {
                Icon = SystemIcons.Application,
                Text = $"豆迹 v{ProductVersion}",
                Visible = true,
            };
            using var menu = new ContextMenuStrip();
            menu.Items.Add("打开豆迹", null, (_, _) => OpenBrowser(address));
            menu.Items.Add("打开数据目录", null, (_, _) => OpenFolder(Path.Combine(ProductRoot, "data")));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出豆迹", null, (_, _) => Application.Exit());
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (_, _) => OpenBrowser(address);
            process.EnableRaisingEvents = true;
            process.Exited += (_, _) => Application.Exit();
            Application.Run();
            tray.Visible = false;
        }
        finally
        {
            StopServer(process);
        }
        return 0;
    }

    private static async Task<int> RunSmokeTest()
    {
        var smokeProductRoot = Path.Combine(Path.GetTempPath(), $"coffee-dashboard-exe-runtime-{Guid.NewGuid():N}");
        var runtimeRoot = EnsurePayload(smokeProductRoot);
        var cachedClientEntry = Path.Combine(runtimeRoot, "app", "dist", "client", "index.html");
        File.Delete(cachedClientEntry);
        runtimeRoot = EnsurePayload(smokeProductRoot);
        if (!File.Exists(cachedClientEntry))
            throw new InvalidOperationException("同版本运行时缓存损坏后未能自动修复。");
        var smokeData = Path.Combine(Path.GetTempPath(), $"coffee-dashboard-exe-smoke-{Guid.NewGuid():N}");
        Directory.CreateDirectory(smokeData);
        var port = FindFreePort();
        using var process = StartServer(runtimeRoot, smokeData, port);
        try
        {
            await WaitUntilReady(process, port);
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var health = await client.GetStringAsync($"http://127.0.0.1:{port}/api/health");
            var home = await client.GetStringAsync($"http://127.0.0.1:{port}/");
            if (!health.Contains("\"mode\":\"ready\"", StringComparison.Ordinal)
                || !home.Contains("<div id=\"root\">", StringComparison.Ordinal)
                || !File.Exists(Path.Combine(smokeData, "coffee-data.json")))
            {
                throw new InvalidOperationException("自包含发行包未通过健康检查、静态页面或数据初始化验证。");
            }
            return 0;
        }
        finally
        {
            StopServer(process);
            try { Directory.Delete(smokeData, true); } catch { /* best effort for test-only data */ }
            try { Directory.Delete(smokeProductRoot, true); } catch { /* best effort for test-only runtime */ }
        }
    }

    private static string EnsurePayload(string? productRootOverride = null)
    {
        var productRoot = productRootOverride ?? ProductRoot;
        var versionRoot = Path.Combine(productRoot, $"runtime-v{ProductVersion}");
        var marker = Path.Combine(versionRoot, ".installed");
        if (IsPayloadValid(versionRoot, marker)) return versionRoot;

        Directory.CreateDirectory(productRoot);
        if (Directory.Exists(versionRoot)) Directory.Delete(versionRoot, true);
        var stagingRoot = Path.Combine(productRoot, $".install-{Guid.NewGuid():N}");
        Directory.CreateDirectory(stagingRoot);
        try
        {
            using var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource)
                ?? throw new InvalidOperationException("发行包中缺少内置应用资源。");
            using var archive = new ZipArchive(payload, ZipArchiveMode.Read);
            var stagingPrefix = Path.GetFullPath(stagingRoot) + Path.DirectorySeparatorChar;
            foreach (var entry in archive.Entries)
            {
                var target = Path.GetFullPath(Path.Combine(stagingRoot, entry.FullName));
                if (!target.StartsWith(stagingPrefix, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("发行包包含越界路径，已停止解压。");
                if (string.IsNullOrEmpty(entry.Name))
                {
                    Directory.CreateDirectory(target);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                entry.ExtractToFile(target, true);
            }
            File.WriteAllText(Path.Combine(stagingRoot, ".installed"), ProductVersion, Encoding.UTF8);
            Directory.Move(stagingRoot, versionRoot);
            return versionRoot;
        }
        finally
        {
            if (Directory.Exists(stagingRoot)) Directory.Delete(stagingRoot, true);
        }
    }

    private static bool IsPayloadValid(string versionRoot, string marker)
    {
        if (!File.Exists(marker)) return false;
        try
        {
            return File.ReadAllText(marker, Encoding.UTF8).Trim() == ProductVersion
                && File.Exists(Path.Combine(versionRoot, "runtime", "node.exe"))
                && File.Exists(Path.Combine(versionRoot, "app", "dist", "server", "start.js"))
                && File.Exists(Path.Combine(versionRoot, "app", "dist", "client", "index.html"));
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static Process StartServer(string runtimeRoot, string dataDirectory, int port)
    {
        Directory.CreateDirectory(dataDirectory);
        var node = Path.Combine(runtimeRoot, "runtime", "node.exe");
        var entry = Path.Combine(runtimeRoot, "app", "dist", "server", "start.js");
        if (!File.Exists(node) || !File.Exists(entry)) throw new FileNotFoundException("内置运行时不完整。请重新下载发行文件。");
        var start = new ProcessStartInfo(node)
        {
            WorkingDirectory = runtimeRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(entry);
        start.Environment["NODE_ENV"] = "production";
        start.Environment["COFFEE_DASHBOARD_DATA_DIR"] = dataDirectory;
        start.Environment["COFFEE_DASHBOARD_PORT"] = port.ToString();
        var edge = FindEdge();
        if (edge is not null) start.Environment["COFFEE_DASHBOARD_CHROMIUM_PATH"] = edge;
        var process = Process.Start(start) ?? throw new InvalidOperationException("无法启动内置本地服务。");
        process.OutputDataReceived += (_, eventArgs) => { if (eventArgs.Data is not null) Log(eventArgs.Data); };
        process.ErrorDataReceived += (_, eventArgs) => { if (eventArgs.Data is not null) Log(eventArgs.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static async Task WaitUntilReady(Process process, int port)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited) throw new InvalidOperationException($"本地服务提前退出，代码 {process.ExitCode}。请查看诊断日志。");
            try
            {
                var health = await client.GetStringAsync($"http://127.0.0.1:{port}/api/health");
                if (health.Contains("\"mode\":\"ready\"", StringComparison.Ordinal) && !process.HasExited) return;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
            await Task.Delay(150);
        }
        throw new TimeoutException("本地服务未在 20 秒内完成启动。");
    }

    private static async Task<bool> WaitForExistingInstance()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var health = await client.GetStringAsync("http://127.0.0.1:4173/api/health");
                if (health.Contains("\"ok\":true", StringComparison.Ordinal)) return true;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
            await Task.Delay(150);
        }
        return false;
    }

    private static string? FindEdge()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    private static int FindFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static void StopServer(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(true);
                process.WaitForExit(5_000);
            }
        }
        catch (Exception error) { Log($"停止本地服务失败：{error.Message}"); }
    }

    private static void OpenBrowser(string address) => Process.Start(new ProcessStartInfo(address) { UseShellExecute = true });
    private static void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
    }

    private static void Log(string message)
    {
        lock (LogLock)
        {
            File.AppendAllText(LogFile, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}", Encoding.UTF8);
        }
    }
}
