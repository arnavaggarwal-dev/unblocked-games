@echo off
REM Double-click this, or run:  push.bat "your commit message"
REM
REM Thin wrapper only. The real work lives in scripts\push.ps1, because batch is a poor
REM language for branch logic and version bumping.
REM
REM NOTE: this file must keep CRLF line endings. cmd.exe mis-parses LF-only batch files
REM and splits tokens mid-word (REM becomes M).

REM cd into the script's own folder first, then use a RELATIVE path to the .ps1.
REM Passing "%~dp0scripts\push.ps1" works from cmd and Explorer, but Git Bash re-quotes
REM arguments on the way through and splits this project's path at "OneDrive - NUS".
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\push.ps1" %*
popd

REM Keep the window open when launched by double-click so errors stay readable.
if "%~1"=="" pause
