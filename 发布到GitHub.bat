@echo off
cd /d "%~dp0"
setlocal

echo ============================================================
echo   Apple Music 歌单管家 + 桌面悬浮球  --  发布到 GitHub
echo ============================================================
echo.

where git >nul 2>nul
if errorlevel 1 goto nogit

git --version
echo.

set GHUSER=
set /p GHUSER=请输入你的 GitHub 用户名: 
if "%GHUSER%"=="" goto nouser

set REPO=
set /p REPO=仓库名（直接回车用 apple-music-suite）: 
if "%REPO%"=="" set REPO=apple-music-suite

echo.
echo === 1/4  初始化本地仓库 ===
if not exist ".git" git init -b main
git add -A
git -c user.name="%GHUSER%" -c user.email="%GHUSER%@users.noreply.github.com" commit -m "feat: Apple Music 歌单管家 + 桌面悬浮球（首个版本）"

echo.
echo === 2/4  设置远程地址 ===
git remote remove origin 2>nul
git remote add origin "https://github.com/%GHUSER%/%REPO%.git"
git branch -M main
git remote -v

echo.
echo === 3/4  创建 GitHub 仓库 ===
where gh >nul 2>nul
if errorlevel 1 goto manual
gh repo create "%REPO%" --public --source=. --remote=origin --push
if not errorlevel 1 goto done
echo [!] gh 创建失败，改为手动方式。

:manual
echo.
echo   请先在浏览器里新建一个【空】仓库（不要勾选 README）:
echo.
echo       https://github.com/new?name=%REPO%
echo.
echo   建好后回到这里按任意键继续。
echo.
pause

echo.
echo === 4/4  推送到 GitHub ===
git push -u origin main
if errorlevel 1 goto pushfail

:done
echo.
echo ============================================================
echo   完成！  https://github.com/%GHUSER%/%REPO%
echo ============================================================
pause
exit /b 0

:nogit
echo [x] 没有找到 git
echo.
echo     请先安装 Git for Windows:  https://git-scm.com/download/win
echo.
pause
exit /b 1

:nouser
echo.
echo [x] 用户名不能为空
pause
exit /b 1

:pushfail
echo.
echo [x] 推送失败。常见原因:
echo     - 用户名或仓库名写错
echo     - 仓库还没在 GitHub 上建好
echo     - 首次推送需要登录（会弹出浏览器，登录一次即可）
echo.
pause
exit /b 1