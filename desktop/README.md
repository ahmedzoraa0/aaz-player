# AAZ Player — Windows Desktop App (Rust + Tauri v2)

This directory packages the modular **AAZ Player** frontend (`index.html`, `css/`, `js/`, `public/fonts/`) into an ultra-lightweight native Windows 11 desktop application built with **Rust** and **Tauri v2**, producing both an **NSIS Installer (`AAZ-Player-Setup-1.7.0.exe`)** and a **Portable executable (`AAZ-Player-Portable-1.7.0.exe`)**.

## Architecture & Native Rust Capabilities
- **Custom Media Protocol (`aazmedia://`)**: Streams local audio and video directly from disk with strict canonical path checks, user-authorized path allowlisting, extension filtering, and HTTP 206 Range seeking.
- **Hardened Local Cast & DLNA/UPnP Server**: Binds strictly to a detected RFC 1918 / CGNAT LAN IPv4 adapter (returning a clear error if offline instead of silently binding `127.0.0.1`), protects stream routes with a 256-bit session token, enforces strictly bounded HTTP header parsing and immediate active-stream shutdown on stop, restricts CORS origins, caps concurrent connections, and restricts DLNA SOAP requests to discovered local LAN devices.
- **Fail-Closed Signed Auto-Updates**: Queries GitHub Releases over HTTPS, enforces strict GitHub host/path validation, checks PE headers, and requires **both** a valid SHA-256 digest (`SHA256SUMS.txt` or GitHub asset digest) **and** a valid **Minisign** Ed25519 signature (`.minisig`) with replay-protected trusted comments verified against `AAZ_UPDATER_PUBLIC_KEY`. Unsigned or unverified updates are refused before installation.
- **Offline Assets**: Bundles Cairo, JetBrains Mono, and Plus Jakarta Sans WOFF2 fonts locally with zero external font/CDN requests in CSP.
- **Native Window Management & Taskbar Controls**: Frameless Windows chrome, per-window Windows taskbar thumbnail media buttons (`ITaskbarList3`), Mini Player mode with always-on-top pinning, and multi-monitor-safe window geometry persistence.
- **Native Media Tooling**: System font discovery, nearby language-aware fuzzy subtitle auto-detection (UTF-8 / Windows-1256), high-resolution PNG snapshots, and window-scoped drag-and-drop (`tauri://drag-drop`).
- **Windows File Associations**: Registers audio, video (excluding `.ts` so TypeScript files are never hijacked; MPEG-TS remains openable via "Open With" and in-app pickers), and playlist files (`.xspf`, `.m3u8`, `.pls`).

## Frontend Asset Sync
Before building or testing Tauri locally, run:

```bash
node desktop/scripts/prepare-ci.cjs
```

This syncs root `index.html`, `css/`, `js/`, and `public/fonts/` into `desktop/app/` and keeps versions aligned across `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`, and `desktop/src-tauri/Cargo.toml`.

## Automated CI & Signed Releases
- `.github/workflows/ci.yml` runs frontend automated tests (`node tests/run-tests.cjs`) plus Rust `cargo fmt --check`, `cargo clippy`, and `cargo test`.
- `.github/workflows/release.yml` builds the Windows NSIS installer and Portable EXE, generates `SHA256SUMS.txt`, signs artifacts with Minisign when `AAZ_UPDATER_SIGNING_KEY` and `AAZ_UPDATER_PUBLIC_KEY` are configured in GitHub Secrets/Variables, and publishes all artifacts to GitHub Releases.

## Local Build on Windows 11
Ensure **Rust (stable)**, **Node.js 20+**, and **WebView2** are installed, then run `desktop/build-windows.bat` or:

```bash
node desktop/scripts/prepare-ci.cjs
cd desktop
npm install
npx @tauri-apps/cli build --bundles nsis
```
