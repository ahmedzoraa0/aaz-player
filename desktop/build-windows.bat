@echo off
title AAZ Player — Build Windows Rust/Tauri App
echo ============================================================
echo   AAZ Player — Building Lightweight Rust + Tauri Windows App
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/4] Preparing frontend HTML, version & icons...
node scripts\prepare-ci.cjs
if errorlevel 1 (
  echo [ERROR] prepare-ci failed! Make sure Node.js is installed.
  pause
  exit /b 1
)

echo [2/4] Installing Tauri CLI...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed!
  pause
  exit /b 1
)

echo [3/4] Generating multi-resolution app icons...
call npx @tauri-apps/cli icon assets\icon.png -o src-tauri\icons
if errorlevel 1 (
  echo [ERROR] Icon generation failed!
  pause
  exit /b 1
)

echo [4/4] Compiling Rust backend & building Windows NSIS Installer + Portable EXE...
call npx @tauri-apps/cli build --bundles nsis
if errorlevel 1 (
  echo [ERROR] Tauri build failed! Make sure Rust toolchain (rustup) is installed.
  pause
  exit /b 1
)

echo.
echo [DONE] Lightweight Rust installers are ready inside:
echo   desktop\src-tauri\target\release\bundle\nsis\
echo   desktop\src-tauri\target\release\aaz-player.exe (Portable!)
echo.
pause
