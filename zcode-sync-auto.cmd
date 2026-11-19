@echo off
rem ============================================================================
rem zcode-sync-auto.cmd - double-click helper that auto-detects this machine.
rem
rem   Source machine (ZCode login present) -> zcode-sync.cmd export
rem   Target machine (no ZCode login)      -> zcode-sync.cmd import BUNDLE
rem
rem The role is decided with "zcode-sync.cmd status":
rem   exit 0 -> credentials decrypt -> source
rem   exit 3 -> not logged in        -> target
rem Other exit codes abort with a doctor hint instead of guessing wrong.
rem
rem On a target machine the bundle is chosen in this order:
rem   1) a .zcs path passed on the command line / dropped onto this script
rem   2) the only .zcs file in this folder (automatic)
rem   3) otherwise prompt for a path
rem
rem The passphrase is read by zcode-sync-passphrase.ps1 (hidden input) and
rem handed to the CLI with --passphrase-file, because the bundled Electron
rem launcher does not expose a TTY on stdin when started by double-click.
rem The temporary passphrase file is deleted as soon as the CLI exits.
rem
rem Escape hatches (no menu is shown):
rem   set ZCS_FORCE_ROLE=source    force export
rem   set ZCS_FORCE_ROLE=target    force import
rem   set ZCS_PASSPHRASE=...       skip the prompt (CLI warns about this)
rem   zcode-sync-auto.cmd <bundle.zcs>          import that bundle
rem   zcode-sync-auto.cmd <other CLI arguments> forwarded to zcode-sync.cmd
rem
rem Quit ZCode completely (including the tray icon) before export/import.
rem ============================================================================
setlocal EnableExtensions
set "HERE=%~dp0"
set "CLI=%HERE%zcode-sync.cmd"
set "PS1=%HERE%zcode-sync-passphrase.ps1"
set "IS_DOUBLE=0"

rem Keep the console open only when launched from Explorer (double-click).
echo "%CMDCMDLINE%" | find /i "%~f0" >nul 2>nul && set "IS_DOUBLE=1"

pushd "%HERE%" 2>nul
if not exist "%CLI%" goto missing_cli

rem Explicit arguments: import a .zcs, otherwise behave like the CLI.
if "%~1"=="" goto detect
if not "%~2"=="" goto passthrough
if /i "%~x1"==".zcs" goto import_arg
goto passthrough

:passthrough
call "%CLI%" %*
set "RC=%ERRORLEVEL%"
goto finish

:import_arg
set "BUNDLE=%~f1"
echo [zcode-sync] Importing bundle: "%BUNDLE%"
echo [zcode-sync] ZCode must be closed completely before importing.
echo.
call :make_passphrase import
if not "%PASS_OK%"=="1" goto passphrase_failed
call :run_import
set "RC=%ERRORLEVEL%"
call :cleanup_passphrase
echo.
if "%RC%"=="0" (
  echo [zcode-sync] Import completed. Start ZCode and verify that you are signed in.
) else (
  echo [zcode-sync] Import failed - exit code %RC%.
)
goto finish

:detect
if /i "%ZCS_FORCE_ROLE%"=="source" goto source
if /i "%ZCS_FORCE_ROLE%"=="target" goto target

echo [zcode-sync] Detecting machine role . . .
call "%CLI%" status >nul 2>nul
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto source
if "%RC%"=="3" goto target

echo.
echo [zcode-sync] Could not determine the machine role (status exit code %RC%).
echo [zcode-sync] Run "zcode-sync.cmd doctor" for details, or force the role:
echo [zcode-sync]   set ZCS_FORCE_ROLE=source
echo [zcode-sync]   set ZCS_FORCE_ROLE=target
set "RC=1"
goto finish

:source
echo [zcode-sync] Detected: SOURCE machine (ZCode login found).
echo [zcode-sync] ZCode should be closed completely before exporting.
echo.
call :make_passphrase export
if not "%PASS_OK%"=="1" goto passphrase_failed
call :run_export
set "RC=%ERRORLEVEL%"
call :cleanup_passphrase
echo.
if "%RC%"=="0" goto source_ok
echo [zcode-sync] Export failed - exit code %RC%.
if "%RC%"=="3" echo [zcode-sync] No login found; sign in to ZCode and retry.
if "%RC%"=="4" echo [zcode-sync] Keyring unavailable; run "zcode-sync.cmd doctor".
if "%RC%"=="6" echo [zcode-sync] Credentials could not be decrypted.
goto finish

:source_ok
echo [zcode-sync] Export completed. Copy the .zcs bundle to the target machine
echo [zcode-sync] through a trusted channel, and send the passphrase separately.
goto finish

:target
echo [zcode-sync] Detected: TARGET machine (no ZCode login found).
echo [zcode-sync] ZCode must be closed completely before importing.
echo.
call :find_bundle
if "%COUNT%"=="1" goto target_single
if "%COUNT%"=="0" goto target_ask
echo [zcode-sync] Multiple .zcs bundles found in this folder:
for %%F in ("%HERE%*.zcs") do echo   "%%~fF"
echo.
goto target_ask

:target_single
echo [zcode-sync] Bundle: "%BUNDLE%"
goto target_run

:target_ask
set "BUNDLE="
set /p "BUNDLE=Bundle path (empty to cancel): "
call :trim BUNDLE
if not defined BUNDLE goto cancelled
if not exist "%BUNDLE%" (
  echo [zcode-sync] File not found: "%BUNDLE%"
  goto target_ask
)

:target_run
echo.
call :make_passphrase import
if not "%PASS_OK%"=="1" goto passphrase_failed
call :run_import
set "RC=%ERRORLEVEL%"
call :cleanup_passphrase
echo.
if "%RC%"=="0" goto target_ok
echo [zcode-sync] Import failed - exit code %RC%.
if "%RC%"=="4" echo [zcode-sync] Keyring unavailable; run "zcode-sync.cmd doctor".
if "%RC%"=="5" echo [zcode-sync] ZCode is still running; quit it completely and retry.
if "%RC%"=="6" echo [zcode-sync] Wrong passphrase or corrupted bundle.
goto finish

:target_ok
echo [zcode-sync] Import completed. Start ZCode and verify that you are signed in.
goto finish

:cancelled
echo [zcode-sync] Cancelled.
set "RC=130"
goto finish

:passphrase_failed
echo.
echo [zcode-sync] Passphrase entry failed or was cancelled; nothing was written.
set "RC=130"
goto finish

:missing_cli
echo [zcode-sync] zcode-sync.cmd was not found next to this script.
echo [zcode-sync] Keep both files in the project root.
set "RC=4"

:finish
if "%IS_DOUBLE%"=="1" (
  echo.
  set /p "DUMMY=Press Enter to close this window . . . "
)
popd 2>nul
exit /b %RC%

rem ----------------------------------------------------------------------------
rem Build a temporary passphrase file for the CLI. Sets PASSFILE and PASS_OK.
rem When ZCS_PASSPHRASE is already set, no prompt is shown and PASSFILE stays
rem empty; the CLI reads the environment variable itself.
rem Usage: call :make_passphrase export|import
rem ----------------------------------------------------------------------------
:make_passphrase
set "PASSFILE="
set "PASS_OK=0"
if defined ZCS_PASSPHRASE goto make_passphrase_skip
if not exist "%PS1%" goto make_passphrase_missing
set "PASSFILE=%TEMP%\zcode-sync-pass-%RANDOM%-%RANDOM%.txt"
del /f /q "%PASSFILE%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Mode "%~1" -OutFile "%PASSFILE%"
if errorlevel 1 goto make_passphrase_failed
if not exist "%PASSFILE%" goto make_passphrase_failed
set "PASS_OK=1"
exit /b 0

:make_passphrase_skip
echo [zcode-sync] ZCS_PASSPHRASE is set; skipping the passphrase prompt.
set "PASS_OK=1"
exit /b 0

:make_passphrase_missing
echo [zcode-sync] Missing helper: "%PS1%"
echo [zcode-sync] Keep zcode-sync-passphrase.ps1 next to this script.
exit /b 0

:make_passphrase_failed
if defined PASSFILE del /f /q "%PASSFILE%" >nul 2>nul
set "PASSFILE="
exit /b 0

:cleanup_passphrase
if defined PASSFILE del /f /q "%PASSFILE%" >nul 2>nul
set "PASSFILE="
exit /b 0

:run_export
if not defined PASSFILE goto run_export_plain
call "%CLI%" export --passphrase-file "%PASSFILE%"
exit /b %ERRORLEVEL%

:run_export_plain
call "%CLI%" export
exit /b %ERRORLEVEL%

:run_import
if not defined PASSFILE goto run_import_plain
call "%CLI%" import "%BUNDLE%" --passphrase-file "%PASSFILE%"
exit /b %ERRORLEVEL%

:run_import_plain
call "%CLI%" import "%BUNDLE%"
exit /b %ERRORLEVEL%

rem ----------------------------------------------------------------------------
rem Find the only .zcs bundle in this folder. Sets COUNT and BUNDLE.
rem ----------------------------------------------------------------------------
:find_bundle
set "BUNDLE="
set "COUNT=0"
for %%F in ("%HERE%*.zcs") do call :count_bundle "%%~fF"
exit /b 0

:count_bundle
set /a COUNT+=1
if %COUNT%==1 set "BUNDLE=%~1"
exit /b 0

rem ----------------------------------------------------------------------------
rem Strip surrounding quotes and trailing spaces from a variable (drag-and-drop
rem inserts "path" plus one trailing space). Usage: call :trim VARNAME
rem ----------------------------------------------------------------------------
:trim
setlocal EnableDelayedExpansion
set "VALUE=!%~1!"
if not defined VALUE goto trim_done
set "VALUE=!VALUE:"=!"
for /l %%I in (1,1,64) do (
  if "!VALUE:~-1!"==" " set "VALUE=!VALUE:~0,-1!"
)
:trim_done
endlocal & set "%~1=%VALUE%"
exit /b 0
