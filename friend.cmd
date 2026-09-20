@echo off
REM ============================================================
REM  Friend launcher (batch shell)
REM
REM  Why this exists:
REM  Windows defaults to the Restricted execution policy, so running a
REM  .ps1 directly is refused ("running scripts is disabled on this system").
REM  Batch files are NOT covered by that policy, so this shell invokes the
REM  real PowerShell script with -ExecutionPolicy Bypass.
REM
REM  IMPORTANT: keep this file ASCII-only.
REM  cmd.exe reads .bat/.cmd using the system ANSI codepage (GBK on a Chinese
REM  Windows), NOT UTF-8. Non-ASCII bytes here get mangled and break parsing.
REM  All Chinese output lives in start-friend.ps1, which handles UTF-8 fine.
REM
REM  Usage:
REM    friend.cmd            show status and help (safe, never starts anything)
REM    friend.cmd status     show status
REM    friend.cmd start      start in foreground (shows logs)
REM    friend.cmd bg         start in background
REM    friend.cmd install    register autostart (UAC prompt appears)
REM    friend.cmd uninstall  remove autostart (UAC prompt appears)
REM
REM  Note: in PowerShell you must type  .\friend.cmd  (with the dot-slash),
REM  because PowerShell does not search the current directory for programs.
REM ============================================================

setlocal

REM Work from the folder this script lives in (double-click may start elsewhere)
cd /d "%~dp0"

set "PS1=%~dp0start-friend.ps1"
if not exist "%PS1%" (
  echo.
  echo   start-friend.ps1 not found next to this file.
  echo.
  pause
  exit /b 1
)

REM Map the short argument to the switch start-friend.ps1 expects.
REM No argument means "status": it is the safe default -- starting a second
REM instance would just collide on the port and confuse people.
set "ARG=-Status"
set "KNOWN=1"
if /i "%~1"=="status"    set "ARG=-Status"
if /i "%~1"=="start"     set "ARG="
if /i "%~1"=="bg"        set "ARG=-Background"
if /i "%~1"=="background" set "ARG=-Background"
if /i "%~1"=="install"   set "ARG=-Install"
if /i "%~1"=="uninstall" set "ARG=-Uninstall"

REM -NoProfile for faster startup, -ExecutionPolicy Bypass to dodge the policy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %ARG%

REM When run with no argument (double-click) or after status, keep the window
REM open so the result is readable. The service is unaffected either way.
if "%~1"=="" (
  echo   Available:  friend.cmd status ^| start ^| bg ^| install ^| uninstall
  echo   Press any key to close this window.
  pause >nul
)

endlocal
