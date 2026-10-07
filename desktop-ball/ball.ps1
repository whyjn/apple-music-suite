param([switch]$TestOnly, [string]$MakeIcon, [int]$MeterMs = 0)

# ============================================================================
#  Apple Music 桌面悬浮球
# ----------------------------------------------------------------------------
#  · 真·无边框、真透明、永远置顶的液态玻璃球（WPF）
#  · 用 Windows 系统媒体会话读「正在播放」—— 浏览器里的 Apple Music、客户端都认
#  · 左键单击 = 播放/暂停（没有可控会话时 → 改为打开 Apple Music）
#  · 中键单击 = 打开音乐歌单管理面板
#  · 拖动 = 移动位置（自动记忆）
#  · 右键 = 菜单（播放暂停 / 上一首 / 下一首 / 歌单管理面板 / 打开 Apple Music /
#                  回到默认位置 / 悬浮球颜色 / 退出）
#  · 鼠标悬停 = 显示 标题 / 歌手 / 专辑 / 播放状态
#  · 不会自动退出，一直常驻，直到你自己右键选「退出悬浮球」
#
#  零依赖：只用 Windows 自带的 PowerShell 5.1 + WPF，不需要安装任何东西
#  用「启动悬浮球.bat」双击启动，或：
#     powershell.exe -NoProfile -ExecutionPolicy Bypass -File ball.ps1
#  自检（不弹窗）：
#     powershell.exe -NoProfile -ExecutionPolicy Bypass -File ball.ps1 -TestOnly
#  生成图标（按当前颜色渲染成 PNG，不弹窗）：
#     powershell.exe -NoProfile -ExecutionPolicy Bypass -File ball.ps1 -MakeIcon out.png
# ============================================================================

$ErrorActionPreference = 'Stop'

# ---------------------------- 可调参数 ----------------------------
  $BallSize  = 128          # 窗口总尺寸（球体 84，四周留 22px 给呼吸光环向外扩散）
  $RimGlowWidth = 5.5       # 呼吸光环粗细（描边宽度）
  $RimGlowBlur  = 11        # 呼吸光环柔化半径（越大越晕开）
$GlassCore = 84           # 玻璃球直径
$AppleSize = 40           # 苹果标尺寸
$TintR     = 168          # 玻璃色调 R
$TintG     = 200          #          G
$TintB     = 240          #          B
$PollMs    = 1200         # 刷新媒体信息间隔（毫秒）
$MeterMs   = if ($MeterMs -gt 0) { $MeterMs } else { 70 }   # 呼吸采样间隔（毫秒）：越小越跟手，CPU 越高
#                            60≈4.1%  90≈3%  150≈2%  1000≈0.9%  （单核占比）
$BreathOn  = $true        # 呼吸灯默认开关
# 呼吸灯只跟随这些进程的音频（不含 .exe）。
# msedge = 网页版 Apple Music；AppleMusic/Music = 客户端
$MeterProcs = @('msedge', 'AppleMusic', 'Music', 'iTunes')
  # ★ 刻意【排除 msedgewebview2.exe】—— 那是第三方软件内嵌的 Edge 内核，
  #   实测腾讯视频就用它。放进来的话球的呼吸和播放控制都会跟着腾讯视频跑。

  # 媒体会话白名单：只认【浏览器本体】和【原生音乐应用】。
  # 比 MeterProcs 更严：这里绝不能用通配符匹配 msedgewebview2。
  $SessionApps = @('MSEdge', 'AppleMusic', 'Music', 'iTunes')
$AppleMusicUrl = 'https://music.apple.com/'   # 中键单击打开这个地址
$ExtensionId   = 'gnkgbjakjmedbebcelkfkcijjbpeiljh'  # 歌单管家扩展 ID
$PanelSize     = '470,820'    # 歌单面板窗口大小（宽,高）
# ------------------------------------------------------------------

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile   = Join-Path $ScriptDir 'ball.log'
$PosFile   = Join-Path $ScriptDir 'ball-position.json'

$script:LogWrites = 0
function Write-Log($msg) {
    try {
        Add-Content -LiteralPath $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -Encoding UTF8

        # ★ 日志轮转：不控制的话它每天涨 ~150KB、一年 ~55MB，永不回收。
        #   每 200 次写入才查一次文件大小（避免每次都 stat）。
        $script:LogWrites++
        if ($script:LogWrites % 200 -eq 0) {
            $fi = Get-Item -LiteralPath $LogFile -ErrorAction SilentlyContinue
            if ($fi -and $fi.Length -gt 524288) {
                # 超过 512KB 就只保留最近 300 行
                $keep = @(Get-Content -LiteralPath $LogFile -Tail 300 -Encoding UTF8)
                [System.IO.File]::WriteAllLines($LogFile, $keep, (New-Object System.Text.UTF8Encoding($true)))
                Add-Content -LiteralPath $LogFile -Value ("[{0}] （日志已截断，仅保留最近 300 行）" -f (Get-Date -Format 'HH:mm:ss')) -Encoding UTF8
            }
        }
    } catch { }
}

function New-Brush([int]$a, [int]$r, [int]$g, [int]$b) {
    New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb($a, $r, $g, $b))
}

try {
    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName WindowsBase
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    Write-Log '---- 启动 ----'

    # ======================= WinRT 异步桥接 =======================
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    if (-not $asTaskGeneric) { throw '找不到 AsTask 异步桥接方法（需要 Windows PowerShell 5.1）' }

    function Await($op, $resultType) {
        $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        $task.Result
    }

    $MgrType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $PropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

    $script:Mgr = Await ($MgrType::RequestAsync()) $MgrType
    if (-not $script:Mgr) { throw '无法获取系统媒体会话管理器' }

    # ============ 苹果标路径（simple-icons 官方源，541 字符）============
    $ApplePath = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'

    $TintHex = '{0:X2}{1:X2}{2:X2}' -f $TintR, $TintG, $TintB

    # ======================= 界面 XAML =======================
    $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Apple Music 悬浮球"
        Width="$BallSize" Height="$BallSize"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        WindowStartupLocation="Manual" SnapsToDevicePixels="True">
  <Grid x:Name="Root" Background="Transparent">
  <Grid x:Name="Ball" Width="$GlassCore" Height="$GlassCore">
    <!-- 球体容器：内部元素一律相对【球】定位，与窗口尺寸解耦（镜面高光曾被绝对边距带偏） -->

    <!-- ============ 玻璃球主体（第一版结构）============ -->
    <Ellipse x:Name="Glass" Width="$GlassCore" Height="$GlassCore">
      <Ellipse.Fill>
        <RadialGradientBrush GradientOrigin="0.30,0.16" Center="0.30,0.16" RadiusX="1.15" RadiusY="1.15">
          <GradientStop Color="#E6FFFFFF" Offset="0"/>
          <GradientStop Color="#4DFFFFFF" Offset="0.22"/>
          <GradientStop Color="#B8$TintHex" Offset="0.58"/>
          <GradientStop Color="#F0$TintHex" Offset="1"/>
        </RadialGradientBrush>
      </Ellipse.Fill>
    </Ellipse>

    <!-- ============ 呼吸光环 ============
         贴着球体外缘的一圈发光，透明度由音量驱动。
         模糊 + BitmapCache：模糊只算一次并缓存，之后每帧只改透明度。
         窗口只需比球大 6px 就能容下它，不必额外放大。 -->
    <Ellipse x:Name="RimGlow" Width="$GlassCore" Height="$GlassCore" IsHitTestVisible="False" Opacity="0"
             Stroke="#$TintHex" StrokeThickness="$RimGlowWidth">
      <Ellipse.CacheMode>
        <BitmapCache RenderAtScale="1.0"/>
      </Ellipse.CacheMode>
      <Ellipse.Effect>
        <BlurEffect Radius="$RimGlowBlur" KernelType="Gaussian"/>
      </Ellipse.Effect>
    </Ellipse>

    <!-- 左上镜面高光 -->
    <Ellipse x:Name="Spec" Width="36" Height="24" HorizontalAlignment="Left" VerticalAlignment="Top" Margin="13,11,0,0">
      <Ellipse.Fill>
        <RadialGradientBrush>
          <GradientStop Color="#E6FFFFFF" Offset="0"/>
          <GradientStop Color="#00FFFFFF" Offset="1"/>
        </RadialGradientBrush>
      </Ellipse.Fill>
    </Ellipse>

    <!-- 白苹果 -->
    <Viewbox Width="$AppleSize" Height="$AppleSize">
      <Canvas Width="24" Height="24">
        <Path x:Name="Apple" Data="$ApplePath" Stroke="#FFFFFFFF" StrokeThickness="0.5" StrokeLineJoin="Round">
          <Path.Fill>
            <LinearGradientBrush StartPoint="0.2,0" EndPoint="0.8,1">
              <GradientStop Color="#FFFFFFFF" Offset="0"/>
              <GradientStop Color="#D9FFFFFF" Offset="0.55"/>
              <GradientStop Color="#A6FFFFFF" Offset="1"/>
            </LinearGradientBrush>
          </Path.Fill>
          <Path.Effect>
            <DropShadowEffect Color="#FF000000" BlurRadius="4" ShadowDepth="1" Direction="270" Opacity="0.45"/>
          </Path.Effect>
        </Path>
      </Canvas>
    </Viewbox>

    <!-- 玻璃棱边 -->
    <!-- ============ 跳动音波 ============
         球内下半部的一条波形填充。数据来自真实音量：把最近若干次采样
         按【不同延迟】铺成一条曲线，波形就会横向流动，而不是整条一起跳。
         整条波只用一个 Path → 每帧只改 1 个属性，比 20 根柱子省得多。 -->
    <Path x:Name="Wave" IsHitTestVisible="False" Opacity="0.9">
      <Path.Clip>
        <EllipseGeometry Center="42,42" RadiusX="42" RadiusY="42"/>
      </Path.Clip>
      <Path.Fill>
        <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
          <GradientStop Color="#B3FFFFFF" Offset="0"/>
          <GradientStop Color="#5CFFFFFF" Offset="0.28"/>
          <GradientStop Color="#2E$TintHex" Offset="1"/>
        </LinearGradientBrush>
      </Path.Fill>
    </Path>

    <Ellipse x:Name="Edge" Width="$GlassCore" Height="$GlassCore" Stroke="#B3FFFFFF" StrokeThickness="1.3"/>

    <!-- 播放状态环 -->
    <Ellipse x:Name="Ring" Width="$GlassCore" Height="$GlassCore" Stroke="#00FFFFFF" StrokeThickness="2.2"/>

  </Grid>
  </Grid>
</Window>
"@

    $reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
    $window = [Windows.Markup.XamlReader]::Load($reader)
    if (-not $window) { throw 'XAML 解析失败' }

    $root = $window.FindName('Root')
    $ring = $window.FindName('Ring')
    $glass = $window.FindName('Glass')
    # 苹果是「透明玻璃 + 里面一层渐变」；那层渐变就是呼吸的载体
    $apple = $window.FindName('Apple')
    $rimGlow = $window.FindName('RimGlow')
    $script:Wave = $window.FindName('Wave')
    $wave = $script:Wave

    # ======================= 音频计量（呼吸灯用） =======================
    # audio.cs 提供 AmAudio：按【音频会话】读实时电平，只跟随指定进程
    $script:MeterReady = $false
    try {
        $csPath = Join-Path $ScriptDir 'audio.cs'
        if (Test-Path -LiteralPath $csPath) {
            Add-Type -Path $csPath -ErrorAction Stop
            $script:MeterReady = $true
            Write-Log '音频计量模块已加载'
        } else {
            Write-Log "找不到 audio.cs：$csPath（呼吸灯将不可用）"
        }
    } catch {
        Write-Log "音频计量模块加载失败: $($_.Exception.Message)"
    }

    # ======================= 悬停提示（在代码里建，确保引用可靠）=======================
    $tip = New-Object System.Windows.Controls.ToolTip
    $tip.Padding = New-Object System.Windows.Thickness(12, 9, 12, 9)
    $tip.BorderThickness = New-Object System.Windows.Thickness(1)
    $tip.BorderBrush = New-Brush 255 58 58 74
    $tip.Background = New-Brush 242 20 20 28
    $tip.Foreground = New-Brush 255 232 232 234

    $sp = New-Object System.Windows.Controls.StackPanel
    $sp.MaxWidth = 320

    $mTitle = New-Object System.Windows.Controls.TextBlock
    $mTitle.Text = '未在播放'; $mTitle.FontWeight = 'Bold'; $mTitle.FontSize = 13
    $mTitle.TextWrapping = 'Wrap'; $mTitle.Foreground = New-Brush 255 240 240 244

    $mArtist = New-Object System.Windows.Controls.TextBlock
    $mArtist.FontSize = 12; $mArtist.TextWrapping = 'Wrap'
    $mArtist.Margin = New-Object System.Windows.Thickness(0, 3, 0, 0)
    $mArtist.Foreground = New-Brush 255 185 185 196

    $mAlbum = New-Object System.Windows.Controls.TextBlock
    $mAlbum.FontSize = 11; $mAlbum.TextWrapping = 'Wrap'
    $mAlbum.Margin = New-Object System.Windows.Thickness(0, 2, 0, 0)
    $mAlbum.Foreground = New-Brush 255 130 130 143

    $mState = New-Object System.Windows.Controls.TextBlock
    $mState.FontSize = 11
    $mState.Margin = New-Object System.Windows.Thickness(0, 6, 0, 0)
    $mState.Foreground = New-Brush 255 103 176 255

    $mHint = New-Object System.Windows.Controls.TextBlock
    $mHint.Text = '左键 播放/暂停    中键 打开 Apple Music    拖动 移动    右键 菜单'
    $mHint.FontSize = 10
    $mHint.Margin = New-Object System.Windows.Thickness(0, 6, 0, 0)
    $mHint.Foreground = New-Brush 255 111 111 124

    $sp.Children.Add($mTitle) | Out-Null
    $sp.Children.Add($mArtist) | Out-Null
    $sp.Children.Add($mAlbum) | Out-Null
    $sp.Children.Add($mState) | Out-Null
    $sp.Children.Add($mHint) | Out-Null
    $tip.Content = $sp
    $root.ToolTip = $tip

    # ======================= 颜色 / 位置 =======================
    $script:Tint = @([int]$TintR, [int]$TintG, [int]$TintB)
    $script:BreathLevel = 0.0
    $script:LastWave = -1.0
    # 音波：音量历史环形队列（延迟铺开 → 波形横向流动）
    $script:WaveBars = 12        # 历史长度（水面流多快）：12 × 130ms ≒ 1.6 秒
    $script:WavePoints = 40      # 视觉点数（水面多平滑）
    $script:WaveHist = New-Object double[] $script:WaveBars
    $script:WaveHead = 0
    $script:IdleDone = $false

    # 把「呼吸」这一层染成当前色调
    # 球里的「液体」：水面由音量历史驱动，水面以下填满。
    # 两个数量刻意【解耦】：
    #   WaveBars   = 历史长度 → 决定水面流多快（越短越快）
    #   WavePoints = 视觉点数 → 决定水面多平滑（越多越顺）
    # 中间用线性插值 + smoothstep 连接，所以短历史也能画出平滑水面。
    # 骨架只建一次，之后每帧只改 Point（结构体，零对象分配）。
    function Update-Wave {
        $n = $script:WavePoints
        $hn = $script:WaveBars
        $w = [double]$GlassCore
        $fill = 0.34 + 0.10 * $script:BreathLevel
        $baseY = $w * (1.0 - $fill)
        $amp = $w * 0.26        # 起伏幅度（实际位移 = 此值 × 音量，音乐约 0.3~0.6）
        $bottom = $w + 6.0
        $step = $w / ($n - 1)

        if (-not $script:WaveSegs) {
            $fig = New-Object System.Windows.Media.PathFigure
            $fig.IsClosed = $true
            $fig.IsFilled = $true
            $fig.StartPoint = [System.Windows.Point]::new(0.0, $baseY)
            $segs = New-Object System.Collections.Generic.List[object]
            for ($i = 1; $i -le $n; $i++) {
                $sg = New-Object System.Windows.Media.LineSegment
                $fig.Segments.Add($sg); $segs.Add($sg)
            }
            $e1 = New-Object System.Windows.Media.LineSegment; $fig.Segments.Add($e1); $segs.Add($e1)
            $e2 = New-Object System.Windows.Media.LineSegment; $fig.Segments.Add($e2); $segs.Add($e2)
            $g = New-Object System.Windows.Media.PathGeometry
            $g.Figures.Add($fig)
            $script:WaveSegs = $segs
            $script:WaveWidth = $w
            if ($script:Wave) { $script:Wave.Data = $g }
        }

        $head = $script:WaveHead
        $hist = $script:WaveHist
        $segs = $script:WaveSegs
        $p = [System.Windows.Point]::new(0.0, 0.0)
        $last = $hn - 1

        for ($i = 0; $i -lt $n; $i++) {
            # 把 n 个视觉点铺到 hn 个历史样本上，线性插值
            $f = ($i / ($n - 1)) * $last
            $k = [int][math]::Floor($f)
            if ($k -ge $last) { $k = $last - 1; $t = 1.0 } else { $t = $f - $k }
            $t = $t * $t * (3.0 - 2.0 * $t)        # smoothstep → 曲线更顺
            $v0 = $hist[($head + 1 + $k) % $hn]
            $v1 = $hist[($head + 2 + $k) % $hn]
            $v = $v0 + ($v1 - $v0) * $t
            if ($v -lt 0) { $v = 0 } elseif ($v -gt 1) { $v = 1 }
            $p.X = $i * $step
            $p.Y = $baseY - $v * $amp
            $segs[$i].Point = $p
        }
        $p.X = $w; $p.Y = $bottom
        $segs[$n].Point = $p
        $p.X = 0.0; $p.Y = $bottom
        $segs[$n + 1].Point = $p
    }

    # 初始波形：未播放时是一条贴底的平线（否则 Data 为空，什么都不画）
    Update-Wave
    function Apply-WaveColor([double]$lv) {
        try {
            if ($lv -lt 0) { $lv = 0 }
            if ($lv -gt 1) { $lv = 1 }
            # 呼吸光环：贴着球体外缘的一圈发光
            if ($rimGlow) { $rimGlow.Opacity = 0.05 + 0.90 * $lv }
        } catch { }
    }

    function Set-Tint([int]$r, [int]$g, [int]$b) {
        try {
            $script:Tint = @($r, $g, $b)
            # 球体渐变里承载色调的是索引 2、3
            $gs = $glass.Fill.GradientStops
            if ($gs.Count -ge 4) {
                $gs[2].Color = [System.Windows.Media.Color]::FromArgb(184, $r, $g, $b)
                $gs[3].Color = [System.Windows.Media.Color]::FromArgb(240, $r, $g, $b)
            }
            # 呼吸光环的颜色
            if ($rimGlow) {
                $rimGlow.Stroke = New-Brush 255 $r $g $b
                # 颜色变了必须重建缓存，否则模糊位图还是旧色
                $rimGlow.CacheMode = New-Object System.Windows.Media.BitmapCache
            }
            Apply-WaveColor $script:BreathLevel
            Save-Position
            Write-Log "换色: $r,$g,$b"
        } catch {
            Write-Log "换色失败: $($_.Exception.Message)"
        }
    }

    function Pick-CustomColor {
        try {
            Add-Type -AssemblyName System.Drawing
            $dlg = New-Object System.Windows.Forms.ColorDialog
            $dlg.FullOpen = $true
            $dlg.Color = [System.Drawing.Color]::FromArgb($script:Tint[0], $script:Tint[1], $script:Tint[2])
            if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                Set-Tint $dlg.Color.R $dlg.Color.G $dlg.Color.B
            }
            $dlg.Dispose()
        } catch {
            Write-Log "取色失败: $($_.Exception.Message)"
        }
    }

    function Save-Position {
        # 诊断模式（-TestOnly / -MakeIcon）绝不写配置：
        # 那时窗口没显示过，位置值不可靠，会写坏文件。
        if ($TestOnly -or $MakeIcon) { return }
        if ($script:NoSave) { return }
        try {
            # 存【球心】而不是窗口左上角 —— 窗口改尺寸时球不会视觉偏移
            $cxv = $window.Left + $BallSize / 2
            $cyv = $window.Top + $BallSize / 2
            if ([double]::IsNaN($cxv) -or [double]::IsNaN($cyv)) { return }
            if ($cxv -eq 0 -and $cyv -eq 0) { return }
            $o = [ordered]@{
                cx   = [math]::Round($cxv)
                cy   = [math]::Round($cyv)
                tint = "$($script:Tint[0]),$($script:Tint[1]),$($script:Tint[2])"
                breath = $script:BreathOn
            }
            ($o | ConvertTo-Json -Compress) | Set-Content -LiteralPath $PosFile -Encoding UTF8
        } catch { }
    }

    function Set-DefaultPosition {
        $vs = [System.Windows.SystemParameters]::WorkArea
        $window.Left = $vs.Right - $BallSize - 40
        $window.Top = $vs.Bottom - $BallSize - 140
    }

    try {
        $vs = [System.Windows.SystemParameters]::WorkArea
        Set-DefaultPosition
        if (Test-Path -LiteralPath $PosFile) {
            $pos = Get-Content -LiteralPath $PosFile -Raw | ConvertFrom-Json
            $cx = $null; $cy = $null
            if ($null -ne $pos.cx -and $null -ne $pos.cy) {
                # 新格式：直接是球心
                $cx = [double]$pos.cx; $cy = [double]$pos.cy
            } elseif ($null -ne $pos.left -and $null -ne $pos.top) {
                # 旧格式：窗口左上角。旧窗口是 88px，球心在 +44
                $cx = [double]$pos.left + 44; $cy = [double]$pos.top + 44
            }
            if ($null -ne $cx) {
                $l = $cx - $BallSize / 2
                $t = $cy - $BallSize / 2
                if ($l -lt $vs.Right - 30 -and $l -gt $vs.Left - 30) { $window.Left = $l }
                if ($t -lt $vs.Bottom - 30 -and $t -gt $vs.Top - 30) { $window.Top = $t }
            }
            if ($pos.tint) {
                $tp = "$($pos.tint)".Split(',')
                if ($tp.Count -eq 3) { Set-Tint ([int]$tp[0]) ([int]$tp[1]) ([int]$tp[2]) }
            }
            if ($null -ne $pos.breath) { $script:BreathOn = [bool]$pos.breath }
        }
    } catch {
        Write-Log "位置恢复失败: $($_.Exception.Message)"
    }

    # ======================= 媒体读取 =======================
    $script:Sess = $null
    $script:LastKey = ''
    # 判断某个会话是不是【音乐类应用】的。
    # 必须过滤：Chromium 在暂停久了之后会撤销 Apple Music 的媒体会话，
    # 于是 GetCurrentSession() 返回的是【别的应用】（实测切到了腾讯视频），
    # 球就会一直去控制那个应用 —— 比"控制失败"更糟，是误操作。
    function Test-MusicApp($sess) {
        try {
            $id = "$($sess.SourceAppUserModelId)"
            # ★ 必须先排除：'msedgewebview2.exe' 以 "msedge" 开头，
            #   任何 *MSEdge* 形式的通配符都会把它放行（-like 不区分大小写）。
            if ($id -like '*msedgewebview2*') { return $false }
            # Edge 浏览器本体：AUMID 就是精确的 'MSEdge'
            if ($id -eq 'MSEdge') { return $true }
            if ($id -like '*MicrosoftEdge*') { return $true }
            # 原生音乐应用
            foreach ($n in @('AppleMusic', 'iTunes')) {
                if ($id -like "*$n*") { return $true }
            }
        } catch { }
        return $false
    }

    function Get-CurrentSession {
        try {
            # 优先用系统的"当前会话"，但必须是音乐类应用
            $cur = $script:Mgr.GetCurrentSession()
            if ($cur -and (Test-MusicApp $cur)) { return $cur }
            # 否则在全部会话里找第一个音乐类应用的
            foreach ($x in @($script:Mgr.GetSessions())) {
                if (Test-MusicApp $x) { return $x }
            }
        } catch { }
        return $null
    }

    function Update-Media {
        try {
            $s = Get-CurrentSession
            $script:Sess = $s

            if (-not $s) {
                $ring.Stroke = New-Brush 0 255 255 255
                if ($glass.Opacity -ne 0.78) { $glass.Opacity = 0.78 }   # 发灰 = 当前没有可控播放器
                if ($script:LastKey -ne 'none') {
                    $script:LastKey = 'none'
                    $mTitle.Text = '未在播放'
                    $mArtist.Text = ''
                    $mAlbum.Text = ''
                    $mState.Text = '点球即打开 Apple Music；播一首后就能控制'
                }
                return
            }

            if ($glass.Opacity -ne 1) { $glass.Opacity = 1 }
            $p = Await ($s.TryGetMediaPropertiesAsync()) $PropsType
            $info = $s.GetPlaybackInfo()
            $st = "$($info.PlaybackStatus)"

            $key = "$($p.Title)|$($p.Artist)|$st"
            if ($key -eq $script:LastKey) { return }
            $script:LastKey = $key

            if ($p.Title) { $mTitle.Text = $p.Title } else { $mTitle.Text = '（无标题）' }
            if ($p.Artist) { $mArtist.Text = $p.Artist } else { $mArtist.Text = '' }
            if ($p.AlbumTitle) { $mAlbum.Text = $p.AlbumTitle } else { $mAlbum.Text = '' }

            $app = "$($s.SourceAppUserModelId)"
            if ($app -like '*msedge*') { $app = 'Edge' }
            elseif ($app -like '*chrome*') { $app = 'Chrome' }
            elseif ($app -like '*AppleMusic*') { $app = 'Apple Music' }

            if ($st -eq 'Playing') {
                $mState.Text = "正在播放 · $app"
                $ring.Stroke = New-Brush 179 255 255 255
            } elseif ($st -eq 'Paused') {
                $mState.Text = "已暂停 · $app"
                $ring.Stroke = New-Brush 77 255 255 255
            } else {
                $mState.Text = "$st · $app"
                $ring.Stroke = New-Brush 0 255 255 255
            }
            Write-Log "媒体: $($p.Title) / $($p.Artist) [$st]"
        } catch {
            Write-Log "Update-Media 出错: $($_.Exception.Message)"
        }
    }

    # ======================= 控制 =======================
    function Invoke-Media([string]$what) {
        try {
            $s = Get-CurrentSession
            if (-not $s) {
                # SMTC 无法凭空启动播放 —— 系统里还没有任何媒体会话时，
                # 退而求其次：直接帮用户打开 Apple Music
                Write-Log "没有媒体会话($what) → 打开 Apple Music"
                if ($what -eq 'toggle') { Open-AppleMusic }
                return
            }
            if ($what -eq 'toggle') { Await ($s.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
            elseif ($what -eq 'next') { Await ($s.TrySkipNextAsync()) ([bool]) | Out-Null }
            elseif ($what -eq 'prev') { Await ($s.TrySkipPreviousAsync()) ([bool]) | Out-Null }
            Write-Log "控制: $what"
            Start-Sleep -Milliseconds 250
            $script:LastKey = ''
            Update-Media
        } catch {
            Write-Log "控制出错($what): $($_.Exception.Message)"
        }
    }

    # ======================= 打开 Apple Music =======================
    function Open-AppleMusic {
        try {
            Start-Process $AppleMusicUrl
            Write-Log "打开 Apple Music: $AppleMusicUrl"
        } catch {
            Write-Log "打开失败: $($_.Exception.Message)"
        }
    }

    # ======================= 打开歌单管理面板 =======================
    function Find-Edge {
        foreach ($p in @(
                "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
                "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
            )) {
            if (Test-Path -LiteralPath $p) { return $p }
        }
        return $null
    }

    function Open-Panel {
        # 主方案：用 --app 打开扩展面板页 —— 不占标签页，是个没有地址栏的干净小窗口。
        #   之前这里会弹"Edge 权限不同"的窗，是因为球进程完整性级别偏低；
        #   现已把 AppleMusicBall.exe 恢复为 Medium，冲突消除。
        # 备用方案：找不到 msedge.exe 时，打开带 #am-panel 的网址，
        #   由页面里的扩展检测到 hash 后自己弹面板窗口。
        try {
            $edge = Find-Edge
            if ($edge) {
                # 把当前颜色一并传给面板，做到两处配色一致
                $t = "$($script:Tint[0]),$($script:Tint[1]),$($script:Tint[2])"
                $appUrl = "chrome-extension://$ExtensionId/panel.html?tint=$t"
                Start-Process -FilePath $edge -ArgumentList @(
                    "--app=$appUrl",
                    "--window-size=$PanelSize",
                    '--window-position=120,70'
                )
                Write-Log "打开歌单面板(--app): $appUrl"
                return
            }

            Write-Log '找不到 msedge.exe，改用网址方式唤起面板'
            Start-Process "$AppleMusicUrl#am-panel"
        } catch {
            Write-Log "打开歌单面板失败: $($_.Exception.Message)"
        }
    }

    # ======================= 右键菜单 =======================
    $menu = New-Object System.Windows.Controls.ContextMenu

    $mi = New-Object System.Windows.Controls.MenuItem; $mi.Header = '播放 / 暂停'
    $mi.Add_Click({ Invoke-Media 'toggle' }); $menu.Items.Add($mi) | Out-Null

    $mi = New-Object System.Windows.Controls.MenuItem; $mi.Header = '下一首'
    $mi.Add_Click({ Invoke-Media 'next' }); $menu.Items.Add($mi) | Out-Null

    $mi = New-Object System.Windows.Controls.MenuItem; $mi.Header = '上一首'
    $mi.Add_Click({ Invoke-Media 'prev' }); $menu.Items.Add($mi) | Out-Null

    $menu.Items.Add((New-Object System.Windows.Controls.Separator)) | Out-Null

    $mi = New-Object System.Windows.Controls.MenuItem
    $mi.Header = '🎵 歌单管理面板'
    $mi.FontWeight = 'Bold'
    $mi.Add_Click({ Open-Panel }); $menu.Items.Add($mi) | Out-Null

    $mi = New-Object System.Windows.Controls.MenuItem
    $mi.Header = '打开 Apple Music 网页版'
    $mi.Add_Click({ Open-AppleMusic }); $menu.Items.Add($mi) | Out-Null

    $menu.Items.Add((New-Object System.Windows.Controls.Separator)) | Out-Null

    $mi = New-Object System.Windows.Controls.MenuItem; $mi.Header = '回到默认位置'
    $mi.Add_Click({ Set-DefaultPosition; Save-Position }); $menu.Items.Add($mi) | Out-Null

    # ---- 悬浮球颜色 子菜单 ----
    $miColor = New-Object System.Windows.Controls.MenuItem
    $miColor.Header = '悬浮球颜色'
    $presets = @(
        @('冰蓝', 168, 200, 240),
        @('水青', 150, 224, 216),
        @('琥珀', 224, 170, 96),
        @('粉紫', 226, 110, 176),
        @('石墨', 150, 156, 166),
        @('曜石', 52, 58, 72)
    )
    foreach ($p in $presets) {
        $ci = New-Object System.Windows.Controls.MenuItem
        $ci.Header = $p[0]
        $pr = [int]$p[1]; $pg = [int]$p[2]; $pb = [int]$p[3]
        # GetNewClosure 保证每个菜单项捕获自己的 r/g/b
        $ci.Add_Click({ Set-Tint $pr $pg $pb }.GetNewClosure())
        $miColor.Items.Add($ci) | Out-Null
    }
    $miColor.Items.Add((New-Object System.Windows.Controls.Separator)) | Out-Null
    $ciCustom = New-Object System.Windows.Controls.MenuItem
    $ciCustom.Header = '自定义…'
    $ciCustom.Add_Click({ Pick-CustomColor })
    $miColor.Items.Add($ciCustom) | Out-Null
    $menu.Items.Add($miColor) | Out-Null

    # ---- 呼吸灯开关 ----
    $miBreath = New-Object System.Windows.Controls.MenuItem
    $miBreath.Header = '呼吸灯（跟随音乐律动）'
    $miBreath.IsCheckable = $true
    $miBreath.IsChecked = [bool]$script:BreathOn
    $miBreath.Add_Click({
            $script:BreathOn = [bool]$miBreath.IsChecked
            if (-not $script:BreathOn) {
                $script:BreathLevel = 0
                Apply-WaveColor 0
            }
            Save-Position
            Write-Log "呼吸灯: $($script:BreathOn)"
        })
    $menu.Items.Add($miBreath) | Out-Null

    # ---- 诊断：把所有媒体会话打进日志（排查"控制错程序/控制失效"用）----
    $miDiag = New-Object System.Windows.Controls.MenuItem
    $miDiag.Header = '诊断：列出媒体会话'
    $miDiag.Add_Click({
            try {
                Write-Log '===== 媒体会话诊断 ====='
                $all = @($script:Mgr.GetSessions())
                Write-Log "会话总数: $($all.Count)"
                foreach ($s in $all) {
                    $st = '?'
                    try { $st = "$($s.GetPlaybackInfo().PlaybackStatus)" } catch { }
                    $isM = Test-MusicApp $s
                    Write-Log ("  app=[" + "$($s.SourceAppUserModelId)" + "] status=$st 音乐类=" + $isM)
                }
                $cur = $script:Mgr.GetCurrentSession()
                Write-Log ("系统当前会话: " + $(if ($cur) { "[$($cur.SourceAppUserModelId)]" } else { '（无）' }))
                $pick = Get-CurrentSession
                Write-Log ("球选中的会话: " + $(if ($pick) { "[$($pick.SourceAppUserModelId)]" } else { '（无 → 点球会去打开 Apple Music）' }))
                Write-Log '===== 诊断结束 ====='
                [System.Windows.MessageBox]::Show('诊断结果已写入 ball.log', '悬浮球', 'OK', 'Information') | Out-Null
            } catch {
                Write-Log "诊断失败: $($_.Exception.Message)"
            }
        })
    $menu.Items.Add($miDiag) | Out-Null

    # ---- 查看最近操作（排错用：球的操作日志在这里，不依赖面板）----
    $miLog = New-Object System.Windows.Controls.MenuItem
    $miLog.Header = '查看最近操作'
    $miLog.Add_Click({
            try {
                $lines = @(Get-Content -LiteralPath $LogFile -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue)
                $body = if ($lines.Count) { $lines -join "`r`n" } else { '（日志还是空的）' }

                $w = New-Object System.Windows.Window
                $w.Title = '悬浮球 · 最近操作（可选中复制）'
                $w.Width = 520
                $w.Height = 380
                $w.WindowStartupLocation = 'CenterScreen'
                $w.Topmost = $true
                $w.Background = New-Brush 255 26 26 30

                $tb = New-Object System.Windows.Controls.TextBox
                $tb.Text = $body
                $tb.IsReadOnly = $true
                $tb.FontFamily = 'Consolas'
                $tb.FontSize = 12
                $tb.Foreground = New-Brush 255 222 222 228
                $tb.Background = New-Brush 255 26 26 30
                $tb.BorderThickness = 0
                $tb.Padding = '8,6,8,6'
                $tb.TextWrapping = 'NoWrap'
                $tb.VerticalScrollBarVisibility = 'Auto'
                $tb.HorizontalScrollBarVisibility = 'Auto'

                $w.Content = $tb
                $w.ShowDialog() | Out-Null
            } catch {
                Write-Log "查看最近操作失败: $($_.Exception.Message)"
            }
        })
    $menu.Items.Add($miLog) | Out-Null

    $menu.Items.Add((New-Object System.Windows.Controls.Separator)) | Out-Null

    $mi = New-Object System.Windows.Controls.MenuItem; $mi.Header = '退出悬浮球'
    $mi.Add_Click({ $window.Close() }); $menu.Items.Add($mi) | Out-Null

    $window.ContextMenu = $menu

    # ======================= 鼠标：拖动 / 左键 / 中键 =======================
    # 窗口比球大（四周留给呼吸光晕），所以球体之外的点击不响应，
    # 否则贴着球边缘点一下就会误触播放/暂停。
    function Test-InBall($e) {
        $pt = $e.GetPosition($window)
        $cx = $window.ActualWidth / 2.0
        $cy = $window.ActualHeight / 2.0
        $r = $GlassCore / 2.0 + 3.0
        $dx = $pt.X - $cx
        $dy = $pt.Y - $cy
        return (($dx * $dx + $dy * $dy) -le ($r * $r))
    }

    $window.Add_MouseLeftButtonDown({
            param($sender, $e)
            if (-not (Test-InBall $e)) { return }

            $bx = $window.Left; $by = $window.Top
            try { $window.DragMove() } catch { }
            $moved = ([math]::Abs($window.Left - $bx) -gt 4) -or ([math]::Abs($window.Top - $by) -gt 4)
            if ($moved) { Save-Position }
            else { Invoke-Media 'toggle' }
        })

    # 中键单击 → 打开歌单管理面板
    $window.Add_MouseDown({
            param($sender, $e)
            if ($e.ChangedButton -eq [System.Windows.Input.MouseButton]::Middle) {
                Open-Panel
                $e.Handled = $true
            }
        })

    # ======================= 定时器 =======================
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds($PollMs)
    $timer.Add_Tick({ Update-Media })

    # ---------------------- 呼吸灯 ----------------------
    # 只读【指定进程】的音频会话峰值（见 audio.cs），别的应用出声不会带动它。
    # 包络：快起慢落，避免闪烁，接近真实 VU 表的手感。
    $script:BreathLevel = 0.0
    $script:LastWave = -1.0
    # 音波：音量历史环形队列（延迟铺开 → 波形横向流动）
    $script:WaveBars = 12        # 历史长度（水面流多快）：12 × 130ms ≒ 1.6 秒
    $script:WavePoints = 40      # 视觉点数（水面多平滑）
    $script:WaveHist = New-Object double[] $script:WaveBars
    $script:WaveHead = 0
    $script:IdleDone = $false
    $script:LastWave = -1.0
    $meterTimer = New-Object System.Windows.Threading.DispatcherTimer
    $meterTimer.Interval = [TimeSpan]::FromMilliseconds($MeterMs)
    $meterTimer.Add_Tick({
            if (-not $script:BreathOn -or -not $script:MeterReady) { return }
            try {
                $peak = [AmAudio]::GetPeakForProcesses($script:MeterProcs)

                # 音乐峰值常落在 0.1~0.6，乘 2.2 拉到满量程
                $n = $peak * 2.2
                if ($n -gt 1.0) { $n = 1.0 }
                if ($n -lt 0.0) { $n = 0.0 }

                # 包络：快起慢落，避免闪烁，接近真实 VU 表的手感
                if ($n -gt $script:BreathLevel) { $script:BreathLevel = $script:BreathLevel + ($n - $script:BreathLevel) * 0.55 }
                else { $script:BreathLevel = $script:BreathLevel * 0.84 }

                # 开方让低音量段也看得见变化
                $lv = [math]::Pow($script:BreathLevel, 0.75)

                # 安静时：等水位落到底之后【完全不重绘】，CPU 回到 ~0.9%
                if ($script:BreathLevel -lt 0.03) {
                    if ($script:IdleDone) { return }
                    $script:IdleDone = $true
                    Apply-WaveColor 0
                    Update-Wave
                    return
                }
                $script:IdleDone = $false

                # 变化太小也跳过
                if ([math]::Abs($lv - $script:LastWave) -lt 0.012) { return }
                $script:LastWave = $lv

                Apply-WaveColor $lv

                # 推入音波历史，并重画波形
                $script:WaveHead = ($script:WaveHead + 1) % $script:WaveBars
                $script:WaveHist[$script:WaveHead] = $lv
                Update-Wave
            } catch { }
        })

    $window.Add_Closed({
            $timer.Stop(); $meterTimer.Stop()
            Save-Position; Write-Log '---- 已退出 ----'
        })

    # ======================= 生成图标模式 =======================
    if ($MakeIcon) {
        try {
            $grid = $window.FindName('Root')
            $grid.Measure((New-Object System.Windows.Size($BallSize, $BallSize)))
            $grid.Arrange((New-Object System.Windows.Rect(0, 0, $BallSize, $BallSize)))
            $grid.UpdateLayout()

            # 渲染成 PNG 字节流
            function Render-PngBytes([int]$s) {
                $dv = New-Object System.Windows.Media.DrawingVisual
                $dc = $dv.RenderOpen()
                $vb = New-Object System.Windows.Media.VisualBrush($grid)
                $dc.DrawRectangle($vb, $null, (New-Object System.Windows.Rect(0, 0, $s, $s)))
                $dc.Close()
                $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap(
                    $s, $s, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
                $rtb.Render($dv)
                $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
                $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
                $ms = New-Object System.IO.MemoryStream
                $enc.Save($ms)
                return , $ms.ToArray()
            }

            # 渲染成 ICO 需要的 DIB(BMP) 数据块
            # —— Windows 的资源管理器只完全支持 DIB，PNG 内嵌会导致图标显示成白纸
            function Render-DibBytes([int]$s) {
                $dv = New-Object System.Windows.Media.DrawingVisual
                $dc = $dv.RenderOpen()
                $vb = New-Object System.Windows.Media.VisualBrush($grid)
                $dc.DrawRectangle($vb, $null, (New-Object System.Windows.Rect(0, 0, $s, $s)))
                $dc.Close()
                $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap(
                    $s, $s, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
                $rtb.Render($dv)

                $stride = $s * 4
                $pixels = New-Object byte[] ($stride * $s)
                $rtb.CopyPixels($pixels, $stride, 0)

                # PBGRA(预乘) → BGRA(直通)；ICO 的 32bpp 数据要直通 alpha
                for ($i = 0; $i -lt $pixels.Length; $i += 4) {
                    $a = $pixels[$i + 3]
                    if ($a -ne 0 -and $a -ne 255) {
                        $pixels[$i]     = [byte][math]::Min(255, [math]::Round($pixels[$i]     * 255.0 / $a))
                        $pixels[$i + 1] = [byte][math]::Min(255, [math]::Round($pixels[$i + 1] * 255.0 / $a))
                        $pixels[$i + 2] = [byte][math]::Min(255, [math]::Round($pixels[$i + 2] * 255.0 / $a))
                    }
                }

                $maskRow  = [int]([math]::Ceiling($s / 32.0) * 4)   # AND 掩码每行 4 字节对齐
                $maskSize = $maskRow * $s

                $ms = New-Object System.IO.MemoryStream
                $bw = New-Object System.IO.BinaryWriter($ms)
                # BITMAPINFOHEADER (40 字节)
                $bw.Write([UInt32]40)
                $bw.Write([Int32]$s)
                $bw.Write([Int32]($s * 2))        # 高度 = 2 倍（XOR + AND）
                $bw.Write([UInt16]1)
                $bw.Write([UInt16]32)
                $bw.Write([UInt32]0)              # BI_RGB
                $bw.Write([UInt32]($stride * $s + $maskSize))
                $bw.Write([Int32]0); $bw.Write([Int32]0)
                $bw.Write([UInt32]0); $bw.Write([UInt32]0)
                # XOR 位图：DIB 是自下而上
                for ($y = $s - 1; $y -ge 0; $y--) { $bw.Write($pixels, $y * $stride, $stride) }
                # AND 掩码：全 0（透明度交给 alpha 通道）
                $bw.Write((New-Object byte[] $maskSize), 0, $maskSize)
                $bw.Flush()
                return , $ms.ToArray()
            }

            if ($MakeIcon.ToLower().EndsWith('.ico')) {
                $sizes = @(16, 24, 32, 48, 64, 128, 256)
                $blobs = @()
                foreach ($s in $sizes) { $blobs += , (Render-DibBytes $s) }

                $fs = [System.IO.File]::Create($MakeIcon)
                $bw = New-Object System.IO.BinaryWriter($fs)
                $bw.Write([UInt16]0)                  # reserved
                $bw.Write([UInt16]1)                  # type = icon
                $bw.Write([UInt16]$sizes.Count)       # count
                $offset = 6 + 16 * $sizes.Count
                for ($i = 0; $i -lt $sizes.Count; $i++) {
                    $s = $sizes[$i]
                    $dim = if ($s -ge 256) { 0 } else { $s }
                    $bw.Write([Byte]$dim)
                    $bw.Write([Byte]$dim)
                    $bw.Write([Byte]0)                # color count
                    $bw.Write([Byte]0)                # reserved
                    $bw.Write([UInt16]1)              # planes
                    $bw.Write([UInt16]32)             # bit count
                    $bw.Write([UInt32]$blobs[$i].Length)
                    $bw.Write([UInt32]$offset)
                    $offset += $blobs[$i].Length
                }
                foreach ($b in $blobs) { $bw.Write($b, 0, $b.Length) }
                $bw.Flush(); $bw.Close(); $fs.Close()
                "ICO 已生成: $MakeIcon  (DIB 格式, 尺寸: $($sizes -join ', '))"
            } else {
                [System.IO.File]::WriteAllBytes($MakeIcon, (Render-PngBytes 256))
                "PNG 已生成: $MakeIcon  (256 x 256)"
            }
            exit 0
        } catch {
            Write-Log "生成图标失败: $($_.Exception.Message)"
            "生成图标失败: $($_.Exception.Message)"
            exit 1
        }
    }

    # ======================= 自检模式 =======================
    Update-Media
    if ($TestOnly) {
        'XAML 解析      : OK'
        foreach ($n in @('Root', 'Glass', 'RimGlow', 'RimOuter', 'RimInner', 'DishEdge', 'Spec', 'Apple', 'Ring')) {
            $el = $window.FindName($n)
            if ($el) { "FindName($n)".PadRight(22) + ': ' + $el.GetType().Name }
            else { "FindName($n)".PadRight(22) + ': NULL ✗' }
        }
        '苹果路径长度   : ' + $ApplePath.Length
        '窗口尺寸       : ' + $window.Width + ' x ' + $window.Height
        'Topmost        : ' + $window.Topmost
        'AllowsTransparent: ' + $window.AllowsTransparency
        '媒体会话       : ' + $(if (Get-CurrentSession) { '有 ✓' } else { '（当前没有在播放）' })
        ''
        '--- 换色功能测试 ---'
        $r0 = $script:Tint[0]; $g0 = $script:Tint[1]; $b0 = $script:Tint[2]
        $before = "$($glass.Fill.GradientStops[2].Color)"
        Set-Tint 226 110 176
        $after = "$($glass.Fill.GradientStops[2].Color)"
        "Set-Tint 前      : $before"
        "Set-Tint(粉紫)后 : $after"
        if ($before -ne $after) { '换色通路       : 生效 ✓' } else { '换色通路       : ✗ 没变化' }
        Set-Tint $r0 $g0 $b0
        "已还原为原色    : $r0,$g0,$b0 → $($glass.Fill.GradientStops[2].Color)"

        ''
        '--- 呼吸灯 / 音频计量 ---'
        "计量模块       : " + $(if ($script:MeterReady) { '已加载 ✓' } else { '✗ 不可用' })
        "跟随进程       : $($script:MeterProcs -join ', ')"
        "采样间隔       : $MeterMs ms"
        if ($script:MeterReady) {
            try {
                '音频会话:'
                ([AmAudio]::DumpSessions() -split "`n") | ForEach-Object { '  ' + $_ }
                $hit = [AmAudio]::GetMatchedSessionCount($script:MeterProcs)
                "命中会话数     : $hit"
                if ($hit -gt 0) {
                    $p1 = [AmAudio]::GetPeakForProcesses($script:MeterProcs)
                    Start-Sleep -Milliseconds 350
                    $p2 = [AmAudio]::GetPeakForProcesses($script:MeterProcs)
                    "峰值采样       : $([math]::Round($p1,4)) → $([math]::Round($p2,4))"
                    '取值通路       : 可用 ✓'
                } else {
                    '取值通路       : ⚠ 没命中任何会话（先在浏览器播一首歌，或把进程名告诉我）'
                }
            } catch {
                "计量测试异常   : $($_.Exception.Message)"
            }
        }

        # 呼吸波视觉通路测试（不依赖音频）
        Apply-WaveColor 0.0
        $w0 = [math]::Round($rimGlow.Opacity, 3)
        Apply-WaveColor 1.0
        $w1 = [math]::Round($rimGlow.Opacity, 3)
        "呼吸环 安静态  : opacity = $w0"
        "呼吸环 高潮态  : opacity = $w1"
        '呼吸环通路     : ' + $(if ($w0 -ne $w1) { '生效 ✓' } else { '✗ 没变化' })
        Apply-WaveColor 0.0

        '自检完成'
        exit 0
    }

    # ======================= 显示 =======================
    $timer.Start()
    if ($script:BreathOn -and $script:MeterReady) { $meterTimer.Start() }
    $window.ShowDialog() | Out-Null

} catch {
    Write-Log "FATAL: $($_.Exception.Message)"
    Write-Log "STACK: $($_.ScriptStackTrace)"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("$($_.Exception.Message)`n`n详情见 ball.log", '桌面悬浮球 启动失败', 'OK', 'Error') | Out-Null
    } catch { }
    exit 1
}