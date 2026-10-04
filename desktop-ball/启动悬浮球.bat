@echo off
rem ============================================================
rem  Apple Music 桌面悬浮球  启动器
rem  双击本文件即可。关闭窗口（右键菜单 -> 退出悬浮球）或
rem  关闭所有浏览器后，球会自动消失。
rem ============================================================
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0ball.ps1"
exit
