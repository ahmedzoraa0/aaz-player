# AAZ Player — Windows Desktop App (.exe)

This folder packages the single-file **AAZ Player** into a native Windows 11 desktop application with both an **Installer (`AAZ-Player-Setup-1.1.0.exe`)** and a **Portable executable (`AAZ-Player-Portable-1.1.0.exe`)**.

## Native Windows Features Included
- **Built-In Auto-Updates (`Check for Updates`):** Connected automatically to GitHub Releases via `electron-updater` and `.github/workflows/release.yml`.
- **Native Embedded AAZ Icon:** `scripts/afterPack.cjs` embeds the multi-resolution `assets/icon.ico` directly into `AAZ Player.exe` via `rcedit` so Desktop, Start Menu, and Taskbar icons always render crisply.
- **Reduced Footprint:** Strips ~55 unused Chromium locale packs (keeping only English & Arabic) and uses maximum ASAR compression.
- **Zero-Prompt Resume:** Reopening AAZ Player automatically remembers your exact Windows folder path, saved playlists, track, and timestamp.
- **Windows File Associations:** Open audio (`.mp3`, `.flac`, `.wav`, `.m4a`), video (`.mp4`, `.mkv`, `.webm`, `.mov`), and playlists (`.xspf`, `.m3u8`, `.pls`) directly with AAZ Player.

## Automatic Cloud Builds (GitHub Actions)
Push any version bump in `desktop/package.json` to `main` on GitHub and `.github/workflows/release.yml` automatically builds and publishes the new Windows Installer and update manifest (`latest.yml`) to GitHub Releases.

## Manual Local Build on Windows 11
Double-click `build-windows.bat` inside `desktop/`. Output files appear in `desktop\release\`.
