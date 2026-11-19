@echo off
setlocal
set "HERE=%~dp0"
set "ZCODE_BIN="

if defined ZCODE_EXE set "ZCODE_BIN=%ZCODE_EXE%"
if not defined ZCODE_BIN if exist "%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" set "ZCODE_BIN=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
if not defined ZCODE_BIN if exist "%ProgramFiles%\ZCode\ZCode.exe" set "ZCODE_BIN=%ProgramFiles%\ZCode\ZCode.exe"
set "PF86=%ProgramFiles(x86)%"
if not defined ZCODE_BIN if defined PF86 if exist "%PF86%\ZCode\ZCode.exe" set "ZCODE_BIN=%PF86%\ZCode\ZCode.exe"

if defined ZCODE_BIN goto run_zcode

where node >nul 2>nul
if not errorlevel 1 goto run_node

echo [zcode-sync] ZCode.exe or Node.js not found.
echo [zcode-sync] Set ZCODE_EXE to ZCode.exe, or install Node.js 22+.
exit /b 4

:run_node
node "%HERE%zcode-sync.cjs" %*
exit /b %ERRORLEVEL%

:run_zcode
set "ELECTRON_RUN_AS_NODE=1"
"%ZCODE_BIN%" "%HERE%zcode-sync.cjs" %*
exit /b %ERRORLEVEL%
