@echo off
setlocal
set "HERE=%~dp0"
set "ZCODE_BIN="

if defined ZCODE_EXE set "ZCODE_BIN=%ZCODE_EXE%"
if not defined ZCODE_BIN if exist "%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" set "ZCODE_BIN=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
if not defined ZCODE_BIN if exist "%ProgramFiles%\ZCode\ZCode.exe" set "ZCODE_BIN=%ProgramFiles%\ZCode\ZCode.exe"
set "PF86=%ProgramFiles(x86)%"
if not defined ZCODE_BIN if defined PF86 if exist "%PF86%\ZCode\ZCode.exe" set "ZCODE_BIN=%PF86%\ZCode\ZCode.exe"

rem ---------------------------------------------------------------------------
rem Auto-repair the ZCode keyring addon.
rem
rem ZCode ships @napi-rs/keyring, whose .node imports VCRUNTIME140.dll. Images
rem without the VC++ runtime (Windows Sandbox) fail to load it, and ZCode then
rem reports "System credential storage is unavailable" instead of logging in.
rem zcode-sync copies vcruntime140*.dll next to the addon (Node searches the
rem addon's own directory first), preferring the copy Edge ships.
rem
rem Both probes below are plain file checks, so a healthy machine pays nothing.
rem Set ZCS_NO_AUTOFIX=1 to opt out.
rem ---------------------------------------------------------------------------
set "ZCS_AUTOFIX="
if /i "%~1"=="fix-keyring" goto keyring_checked
if /i "%~1"=="--help" goto keyring_checked
if /i "%~1"=="-h" goto keyring_checked
if /i "%~1"=="--version" goto keyring_checked
if /i "%~1"=="-V" goto keyring_checked
call :check_keyring_runtime
:keyring_checked

if defined ZCODE_BIN goto run_zcode

where node >nul 2>nul
if not errorlevel 1 goto run_node

echo [zcode-sync] ZCode.exe or Node.js not found.
echo [zcode-sync] Set ZCODE_EXE to ZCode.exe, or install Node.js 22+.
exit /b 4

:run_node
if defined ZCS_AUTOFIX node "%HERE%zcode-sync.cjs" fix-keyring --auto
node "%HERE%zcode-sync.cjs" %*
exit /b %ERRORLEVEL%

:run_zcode
set "ELECTRON_RUN_AS_NODE=1"
if defined ZCS_AUTOFIX "%ZCODE_BIN%" "%HERE%zcode-sync.cjs" fix-keyring --auto
"%ZCODE_BIN%" "%HERE%zcode-sync.cjs" %*
exit /b %ERRORLEVEL%

:check_keyring_runtime
if defined ZCS_NO_AUTOFIX goto :eof
if exist "%SystemRoot%\System32\vcruntime140.dll" goto :eof
set "ZCS_ADDON_DIR=%LOCALAPPDATA%\Programs\ZCode\resources\app.asar.unpacked\node_modules\@napi-rs\keyring-win32-x64-msvc"
if defined ZCODE_BIN for %%I in ("%ZCODE_BIN%") do set "ZCS_ADDON_DIR=%%~dpIresources\app.asar.unpacked\node_modules\@napi-rs\keyring-win32-x64-msvc"
if not exist "%ZCS_ADDON_DIR%\keyring.win32-x64-msvc.node" goto :eof
if exist "%ZCS_ADDON_DIR%\vcruntime140.dll" goto :eof
set "ZCS_AUTOFIX=1"
echo [zcode-sync] keyring addon lacks the VC++ runtime - attempting auto-repair . . .
goto :eof
