@echo off
setlocal enabledelayedexpansion
rem wb-token-export - export WorkBuddy's sign-in as JSON for magpie's workbuddy plugin.
rem ASCII only: cmd.exe reads this file as ANSI, non-ASCII comments break parsing.
rem Uses system node when available, else WorkBuddy's bundled Electron as node.

set "SCRIPT=%~dp0wb-token-export.cjs"
set "CODE=1"

if not exist "%SCRIPT%" (
  echo [x] missing %SCRIPT%
  goto :done
)

where node >nul 2>nul
if not errorlevel 1 (
  node "%SCRIPT%" %*
  set "CODE=!errorlevel!"
  goto :done
)

set "WB=%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe"
if not exist "%WB%" if exist "%ProgramFiles%\WorkBuddy\WorkBuddy.exe" set "WB=%ProgramFiles%\WorkBuddy\WorkBuddy.exe"
if not exist "%WB%" (
  echo [x] Node.js not found, and WorkBuddy.exe is not at the default location.
  echo     Install Node.js, or run: node wb-token-export.cjs --exe "C:\path\to\WorkBuddy.exe"
  goto :done
)

set ELECTRON_RUN_AS_NODE=1
"%WB%" "%SCRIPT%" %*
set "CODE=!errorlevel!"

:done
exit /b !CODE!
