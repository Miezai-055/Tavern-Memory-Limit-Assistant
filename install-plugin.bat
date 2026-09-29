@echo off
rem Launcher for install-plugin.ps1 (all Chinese output comes from the .ps1,
rem because cmd.exe mis-parses non-ASCII batch files under chcp 65001).
title Tavern Memory Limit Assistant - Install Server Plugin
cd /d "%~dp0"

echo.
echo Installing the Tavern Memory Limit Assistant server plugin...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-plugin.ps1"

echo.
pause
