@echo off
REM Double-click this, or run:  push.bat "your commit message"
REM
REM Thin wrapper only. The real work lives in scripts\push.ps1, because batch is a poor
REM language for branch logic and version bumping.
REM
REM NOTE: this file must keep CRLF line endings. cmd.exe mis-parses LF-only batch files
REM and splits tokens mid-word (REM becomes M).

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\push.ps1" %*

REM Keep the window open when launched by double-click so errors stay readable.
if "%~1"=="" pause
