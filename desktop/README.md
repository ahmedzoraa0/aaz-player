# AAZ Player — Windows Desktop App (Rust + Tauri v2)

This directory packages the modular **AAZ Player** frontend (`index.html`, `css/`, `js/`) into an ultra-lightweight native Windows 11 desktop application built with **Rust** and **Tauri v2**, producing both an **NSIS Installer (`AAZ-Player-Setup-1.4.2.exe`)** and a **Portable executable (`AAZ-Player-Portable-1.4.2.exe`)**.

## Architecture & Native Rust Capabilities
- **Custom Media Protocol (`aazmedia://`)**: Streams local audio and video directly from disk with strict canonical path checks, user-authorized path allowlisting, extension filtering, and HTTP 206 Range seeking.
- **Hardened Local Cast & DLNA/UPnP Server**: Binds to the detected private LAN interface (fallback `127.0.0.1`), protects stream routes with a per-session 256-bit token, and restricts DLNA SOAP requests to discovered private-LAN devices.
- **Verified Auto-Updates**: Queries GitHub Releases over HTTPS, enforces strict GitHub host/path validation, checks PE headers, and verifies SHA-256 digests (`SHA256SUMS.txt` / GitHub asset digest) before executing any installer.
- **Native Window Management**: Frameless Windows chrome, Mini Player mode with always-on-top pinning, and multi-monitor-safe window geometry persistence.
- **Native Media Tooling**: System font discovery, nearby fuzzy subtitle auto-detection (UTF-8 / Windows-1256), high-resolution PNG snapshots, and native drag-and-drop (`tauri://drag-drop`).
- **Windows File Associations**: Register and open audio, video, and playlist files (`.xspf`, `.m3u8`, `.pls`) directly in AAZ Player.

## Frontend Asset Sync
Before building or testing Tauri locally, run:

```bash
node desktop/scripts/prepare-ci.cjs
```

This syncs root `index.html`, `css/`, and `js/` into `desktop/app/` and keeps versions aligned across `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`, and `desktop/src-tauri/Cargo.toml`.

## Automated CI & Cloud Releases
- `.github/workflows/ci.yml` runs frontend automated tests (`node tests/run-tests.cjs`) plus Rust `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test`.
- `.github/workflows/release.yml` builds the Windows NSIS installer and Portable EXE, generates `SHA256SUMS.txt`, and publishes all artifacts to GitHub Releases when the version in `desktop/package.json` is bumped.

## Local Build on Windows 11
Ensure **Rust (stable)**, **Node.js 20+**, and **WebView2** are installed, then run `desktop/build-windows.bat` or:

```bash
node desktop/scripts/prepare-ci.cjs
cd desktop
npm install
npx @tauri-apps/cli build --bundles nsis
```
