# ============================================================================
#  一键安装桌面/开始菜单快捷方式
# ----------------------------------------------------------------------------
#  双击运行一次即可。它会在两个地方创建快捷方式：
#     · 桌面
#     · 开始菜单（之后可以按 Win 键搜索「Apple Music 悬浮球」）
#
#  快捷方式的图标用同目录下的 ball.ico（就是那颗球的样子）。
#  之后你只要双击桌面图标就能启动悬浮球，不会有黑色命令行闪窗。
#
#  想卸载：删掉那两个快捷方式即可，不影响悬浮球本身。
# ============================================================================

$ErrorActionPreference = 'Stop'

$dir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $dir '启动悬浮球.vbs'
$icon     = Join-Path $dir 'ball.ico'
$shortcutName = 'Apple Music 悬浮球'

Write-Host ''
Write-Host '=========== Apple Music 悬浮球 · 快捷方式安装 ===========' -ForegroundColor Cyan
Write-Host "  安装目录 : $dir"
Write-Host ''

if (-not (Test-Path -LiteralPath $launcher)) { throw "找不到启动器: $launcher" }
if (-not (Test-Path -LiteralPath $icon))     { Write-Host '  [警告] 找不到 ball.ico，将使用默认图标' -ForegroundColor Yellow }

# 目标目录：桌面 + 开始菜单
$targets = @()
$desktop = [Environment]::GetFolderPath('Desktop')
if ($desktop) { $targets += [pscustomobject]@{ Name = '桌面'; Path = $desktop } }
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
if (Test-Path -LiteralPath $startMenu) { $targets += [pscustomobject]@{ Name = '开始菜单'; Path = $startMenu } }

if ($targets.Count -eq 0) { throw '既找不到桌面也找不到开始菜单目录' }

$shell = New-Object -ComObject WScript.Shell
$made = 0

foreach ($t in $targets) {
    $lnkPath = Join-Path $t.Path "$shortcutName.lnk"
    try {
        $sc = $shell.CreateShortcut($lnkPath)
        $sc.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $sc.Arguments        = '"' + $launcher + '"'
        $sc.WorkingDirectory = $dir
        $sc.Description      = 'Apple Music 桌面悬浮球 —— 置顶玻璃球，可控制播放'
        if (Test-Path -LiteralPath $icon) { $sc.IconLocation = $icon }
        $sc.Save()

        if (Test-Path -LiteralPath $lnkPath) {
            Write-Host "  [完成] $($t.Name)  →  $lnkPath" -ForegroundColor Green
            $made++
        } else {
            Write-Host "  [失败] $($t.Name) 未能创建" -ForegroundColor Red
        }
    } catch {
        Write-Host "  [失败] $($t.Name): $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ''
if ($made -gt 0) {
    Write-Host "  共创建 $made 个快捷方式。" -ForegroundColor Green
    Write-Host '  现在去桌面双击「Apple Music 悬浮球」即可。'
    Write-Host '  也可以按 Win 键，输入「Apple Music 悬浮球」回车启动。'
} else {
    Write-Host '  一个都没创建成功，请把上面的错误信息发给我。' -ForegroundColor Red
}
Write-Host ''
Write-Host '  按任意键关闭…'
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
