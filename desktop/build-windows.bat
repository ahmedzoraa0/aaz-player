@echo off
title AAZ Player — Windows Installer Builder
echo ====================================================
echo   Building AAZ Player (.exe) for Windows 11
echo ====================================================
echo.

set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed. Download LTS from https://nodejs.org
  pause
  exit /b 1
)

if not exist "app" mkdir "app"
copy /Y "..\index.html" "app\index.html" >nul
if %errorlevel% neq 0 (
  echo [ERROR] Could not copy ..\index.html into desktop\app\index.html
  pause
  exit /b 1
)

if exist "release" rmdir /S /Q "release"

echo [1/2] Installing Electron, Auto-Updater, and rcedit...
call npm install
if %errorlevel% neq 0 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
echo [2/2] Building Windows Installer (AAZ-Player-Setup) and Portable...
call npm run dist
if %errorlevel% neq 0 (
  echo [ERROR] Build failed. Check the message above for details.
  pause
  exit /b 1
)

echo.
echo ====================================================
echo   SUCCESS! Both .exe files are ready in:
echo   desktop\release\
echo ====================================================
explorer "release"
pause
