@echo off
setlocal
set "ZCODE_BIN=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
if not exist "%ZCODE_BIN%" (
  echo [zcode-sync] ZCode.exe not found; set ZCODE_EXE or install ZCode.
  exit /b 4
)
set "ELECTRON_RUN_AS_NODE=1"
"%ZCODE_BIN%" "%~dp0test\run-all.cjs"
exit /b %ERRORLEVEL%
