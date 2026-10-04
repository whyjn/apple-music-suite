@echo off
cd /d "%~dp0"
setlocal

echo ============================================================
echo   同步工作副本到 GitHub
echo ============================================================
echo.
echo   来源:  ..\apple-music-manager     ..\apple-music-desktop-ball
echo   目标:  extension\                desktop-ball\
echo.

where git >nul 2>nul
if errorlevel 1 goto nogit

if not exist "..\apple-music-manager\manifest.json" goto nosrc
if not exist "..\apple-music-desktop-ball\ball.ps1" goto nosrc

echo === 1/4  同步扩展 ===
xcopy /Y /Q "..\apple-music-manager\*.js"   "extension\" >nul
xcopy /Y /Q "..\apple-music-manager\*.json" "extension\" >nul
xcopy /Y /Q "..\apple-music-manager\*.html" "extension\" >nul
xcopy /Y /Q "..\apple-music-manager\*.png"  "extension\" >nul
echo       完成

echo.
echo === 2/4  同步桌面悬浮球 ===
copy /Y "..\apple-music-desktop-ball\ball.ps1"           "desktop-ball\" >nul
copy /Y "..\apple-music-desktop-ball\audio.cs"           "desktop-ball\" >nul
copy /Y "..\apple-music-desktop-ball\launcher.cs"        "desktop-ball\" >nul
copy /Y "..\apple-music-desktop-ball\ball.ico"           "desktop-ball\" >nul
copy /Y "..\apple-music-desktop-ball\AppleMusicBall.exe" "desktop-ball\" >nul
copy /Y "..\apple-music-desktop-ball\启动悬浮球.vbs"        "desktop-ball\" >nul
copy /Y "..\apple-music-desktop-ball\启动悬浮球.bat"        "desktop-ball\" >nul
copy /Y "..\apple-music-desktop-ball\安装快捷方式.bat"      "desktop-ball\" >nul
copy /Y "..\apple-music-desktop-ball\安装快捷方式.ps1"      "desktop-ball\" >nul
del "desktop-ball\ball.log" 2>nul
del "desktop-ball\ball-position.json" 2>nul
echo       完成

echo.
echo === 3/4  提交 ===
git add -A
git status --short
echo.
set MSG=
set /p MSG=提交说明（直接回车用默认）: 
if "%MSG%"=="" set MSG=chore: 同步工作副本
git commit -m "%MSG%"
if errorlevel 1 goto nothing

echo.
echo === 4/4  推送到 GitHub ===
git push
if errorlevel 1 goto pushfail

echo.
echo ============================================================
echo   完成！  https://github.com/whyjn/apple-music-suite
echo ============================================================
pause
exit /b 0

:nothing
echo.
echo [!] 没有需要提交的改动 —— 工作副本和仓库已经一致
pause
exit /b 0

:nogit
echo [x] 没有找到 git
pause
exit /b 1

:nosrc
echo [x] 找不到工作副本目录
echo.
echo     本脚本必须放在 apple-music-suite 文件夹里运行，
echo     并且 apple-music-manager / apple-music-desktop-ball 是它的同级目录。
echo.
pause
exit /b 1

:pushfail
echo.
echo [x] 推送失败 —— 检查网络，或仓库是否有冲突
pause
exit /b 1