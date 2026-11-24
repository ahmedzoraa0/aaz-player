# Changelog / سجل التغييرات

All notable changes to **AAZ Player** are documented in this file.

---

## [1.9.1] - 2026-11-24

### Fixed
- Android launcher icon on legacy devices (API 24-25): generated icon bitmaps now run after `android init` in the release workflow, so the AZ0 mark replaces the Tauri default icon everywhere. Adaptive icon (API 26+) was already correct in 1.9.0.

## [1.9.0] - 2026-11-24

### AZ0 Rebrand
- **New Name and Mark**: The player is now **AZ0** (previously AAZ Player) across the Windows and Android interfaces, the window title, and the installer/portable/APK asset names (`AZ0-Setup`, `AZ0-Portable`, `AZ0-Android-arm64`). A new shaped transparent logo (play intertwined with the lettering) replaces the boxed mark in the app, the README, and all generated taskbar and launcher icons on both platforms.
- **Updater Continuity Preserved**: The app identifier (`com.aaz.player`), update signature prefix (`aaz-player|`), storage keys (`aaz_*`), and the Minisign public key are unchanged, so existing installs keep their settings and continue to receive signed updates; both updater asset-selection predicates accept the new asset names (covered by automated tests).
- **Arabic Startup Fix**: A fresh launch with Arabic saved as the interface language now applies the Arabic strings immediately; previously the Scan Device, Library and Player surfaces opened in English until the language was toggled (regression test added).
- **Presentation**: README refreshed with a natural core-strengths intro, an 8-theme readable montage of real theme UI, and a fully-Arabic Android mockup of the current UI.

---

## [1.8.0] - 2026-11-24

### Android App (New Platform)
- **Native Android Player**: Full Android build via Tauri 2 (`desktop/android-native/`, Kotlin): loopback content server for SAF media, foreground playback service with MediaStyle notification, audio-focus and becoming-noisy handling, sensor orientation lock, auto-PiP, system-bar theming across all 16 skins, LAN/DLNA casting, and a fail-closed signed APK self-updater.
- **Mobile Touch-First Layout**: Dedicated phone UI with touch-slop gesture handling, double-tap seek, edge brightness/volume swipes, pinch zoom, screen lock, structured Back stack, and a bottom navigation bar (Player / Queue / Library / Saved).

### Playback Fixes & Improvements
- **Hold-to-Speed Pins at Exactly 2.0x**: Long-press (touch), mouse hold, and Space hold now pin playback at exactly 2.0x whatever the base rate was (1.0x, 1.5x, 3.0x, or even 100x turbo all go to 2.0x) instead of multiplying the base rate by two; releasing restores the exact previous speed. Holds can never get stuck on: touchcancel/pointercancel, window blur, app backgrounding, a second finger landing, swipe/slop movement, pause, track end, and track change all cancel the hold and restore the base rate, and changing speed from the menu mid-hold updates the restore target coherently.
- **Volume up to 200%, Default 100%**: The volume slider now reaches 200% with real amplification through a Web Audio gain stage (`HTMLMediaElement.volume` is capped at 100% by the platform), using a conservative soft-limited curve whose peak ceiling is verified in automated tests with synthesized audio; the readout clearly marks levels above 100%. Above 100% the sound can distort depending on the source material and can be uncomfortably loud on headphones — this is not hearing protection. Fresh installs default to 100%; previously saved volumes are preserved on upgrade. If the gain path is unavailable on a platform, volume clamps visibly at 100% instead of pretending.

### Android Media Library: File-Manager Browsing
- **Hierarchical Folder Browsing**: The Android library now behaves like a file manager: granted folders appear as roots, tapping a folder shows its immediate children (subfolders first, then that folder's media files only), with a breadcrumb path bar and one-level-at-a-time SAF listing via `DocumentsContract.buildChildDocumentsUriUsingTree` so large folders open fast. Android Back climbs one folder level before leaving the library. Granted folders keep their persisted URI permissions across restarts. Desktop keeps its existing library UX.

### Mobile UX
- **Logo-Only Top Bar on Mobile**: On phone-width layouts (and Android generally) the header shows the AAZ logo only — the "AAZ Player" wordmark no longer crowds the mobile top bar; the full wordmark remains on desktop.

### Housekeeping
- Removed three unreferenced bundled text artifacts from `public/assets/aistudio/` that were shipping inside the Windows installer and Android APK.

---

## [1.7.0] - 2026-11-22

### Native Windows Taskbar & Media Session
- **Windows Taskbar Thumbnail Media Controls**: Added native `ITaskbarList3` thumbnail toolbar (`Previous`, `Play/Pause`, `Next`) with programmatic 24×24 BGRA icons, `TaskbarButtonCreated` Explorer-restart recovery, live enabled/disabled and localized tooltip sync, and clean GDI resource disposal on window destroy.
- **OS Media Keys (`navigator.mediaSession`)**: Wired metadata, playback state, and play/pause/previous/next/seek action handlers for keyboard media keys and Windows media flyouts.

### Mini Player Overhaul
- **Crisp SVG Controls & Seek Bar**: Replaced emoji icons in the Mini Player HUD with crisp inline SVGs, added a live scrubbable seek bar with elapsed/remaining time display, `S` (360×202) / `M` (480×270) / `L` (640×360) quick size presets, and Minimize / Close buttons.
- **Audio Compact Mode & Frameless Resize Polish**: Added always-visible HUD mode when playing audio or paused, 5px edge clearance so Windows frameless resize handles remain effortless to grab, drag-threshold + double-click to return to full player, and DPI/work-area-safe geometry clamping with single-step maximized restore.
- **Accessibility**: Added `@media (prefers-reduced-transparency: reduce)` fallback for Glass skin and Mini Player HUD, and included Mini Player transitions in `prefers-reduced-motion`.

### Updater Security & Reliability Hardening
- **Replay & Downgrade Protection**: Bound Minisign trusted comments to exact release version, filename, and SHA-256 (`aaz-player|version=<ver>|file=<name>|sha256=<hash>`) and verified them in Rust before accepting an installer.
- **Private Update Staging & Concurrency Guard**: Moved downloaded installers into app-private `app_cache_dir/updates` with unique nonces, automatic cleanup of old installers, an RAII concurrency lock preventing overlapping downloads, and explicit `aaz:update-status` error reporting on installer launch failure.
- **Fail-Closed Release Workflow**: Updated `.github/workflows/release.yml` to block stable releases when `AAZ_UPDATER_SIGNING_KEY` or `AAZ_UPDATER_PUBLIC_KEY` is missing (with an explicit opt-in `allow_unsigned_preview` prerelease flag on manual `workflow_dispatch`) and to pull release notes directly from `CHANGELOG.md`.

### Bug Fixes & Stability
- **Keyboard Shortcuts**: Fixed overridden shortcuts reverting to their default key via an explicit unbound sentinel, allowed shortcuts while range/button/checkbox/radio inputs are focused, unified menu hints (`Previous Track: Shift+P`, `Next Track: N`, `PiP: P`, `Cast: C`), and unified subtitle timing steps to `±0.25s`.
- **Session Resume & Watch History**: Fixed `Clear Saved Session` leaving stale desktop paths (`trackFullPath` / `nativeTrackPaths`), eliminated double-loading and wrong-track seeking in `openExternalPathAtTime`, fixed the Watch History remove tooltip and added an indicator when more than 20 entries exist.
- **Cross-Window & Backend Hardening**: Synced theme, skin, and language changes across independent windows via `storage` events, memoized WebGL GPU detection with explicit context disposal, bounded Rust directory scans (`MAX_DIR_SCAN_DEPTH = 24`, `MAX_DIR_SCAN_ENTRIES = 25,000`) and text file reads, enforced authorization in `aaz_find_nearby_subtitle`, added fallback window recovery in single-instance handling, and fixed Vite ESM `__dirname` usage.

---

## [1.6.0] - 2026-11-21

### Theme Studio & UI Consolidation
- **16-Theme Green-Identity Studio (32 Dark & Light Modes)**: Added 16 distinct visual themes preserving AAZ Player's green identity—including Minecraft, LEGO, Roblox, Super Arcade 16-Bit, Classic OS 95, Game Boy LCD, Blueprint CAD, Glassmorphism, Comic Pop, Terminal CRT, Paper Editorial, and more—accessible via `View -> Theme Style`.
- **Unified Sidebar & Open Recent History**: Moved Watch History into `Media -> Open Recent` submenu, unified the Library tab layout with Queue and Saved Playlists, and added automatic desktop session resume without re-prompting Windows Explorer.
- **Offline Fonts & Hardened Packaging**: Bundled Cairo, JetBrains Mono, and Plus Jakarta Sans WOFF2 fonts locally (zero external font requests), removed `.ts` from Windows file associations, added bilingual `NO_LAN_IP` and audio output fallback notices, and replaced silent catch blocks with structured error logging.

---

## [1.5.0] - 2026-11-21

### Security Hardening (Phase 1)
- **Custom Media Protocol (`aazmedia://`)**: Added canonical path resolution, user-authorized media path allowlisting, extension & regular-file enforcement, and strict HTTP Range parsing.
- **Local Cast & DLNA/UPnP Server**: Bound Cast HTTP streaming to the detected private LAN IP (fallback `127.0.0.1`), added 256-bit per-session token authentication with constant-time comparison, restricted DLNA SOAP/XML requests to discovered RFC 1918 LAN devices with bounded 256 KB reads, and ensured clean server shutdown on exit.
- **Content Security Policy**: Replaced `"csp": null` in `tauri.conf.json` with a restrictive CSP enforcing `script-src 'self'` (no inline scripts).
- **Verified Auto-Updater**: Enforced strict GitHub HTTPS host/path allowlists (including redirect verification), 150 MB download cap, atomic `.part` download, PE `MZ` header validation, and SHA-256 checksum verification (`SHA256SUMS.txt` / GitHub asset digest) prior to installer execution.
- **Hardened Cross-Window Messaging**: Replaced wildcard `postMessage(..., '*')` with strict same-origin, source-window, `tabId`, message-type, and payload schema verification.

### Architecture & Stability (Phase 2)
- **Modular Frontend**: Extracted the monolithic inline script and stylesheet from `index.html` into `css/styles.css` and acyclic ES modules under `js/core/`, `js/utils/`, `js/modules/`, `js/ui/`, and `js/app/`.
- **Versioned Storage (`v4`)**: Added non-destructive `v1`/`v2`/`v3` -> `v4` migration with automatic pre-migration backup (`aaz_media_player_backup_v3`), schema validation, and JSON Backup/Restore.
- **Error Handling & Performance**: Added centralized bilingual user-facing error handling (`js/utils/error-handler.js`), debounced search filtering, and `DocumentFragment` rendering.
- **CI & Automated Testing**: Added `.github/workflows/ci.yml`, updated `.github/workflows/release.yml` to publish `SHA256SUMS.txt`, added `tests/run-tests.cjs` and Rust unit tests, removed unused template remnants, and updated `desktop/README.md` for Rust + Tauri v2.

### New Features (Phase 3)
- **Mini Player Mode**: Compact floating player HUD reusing the active playback engine with always-on-top pinning, Play/Pause, Prev/Next, Volume/Mute, drag-to-move, and Return to Full Player.
- **Window Layout Persistence**: Remembers main and mini-player window bounds and maximized state with multi-monitor safety clamping.
- **Watch History**: Dedicated History sidebar tab tracking recently played items, resume timestamps, auto/manual completion, search, individual removal, clear all, and pause-recording privacy toggle.
- **Media Library**: Dedicated Library sidebar tab for user-selected folders only with rescan, folder removal, search, audio/video filtering, and Name/Date/Duration sorting.
- **Advanced Saved Playlists**: Added live Saved Playlists search and Duplicate Saved Playlist action.
- **Customizable Keyboard Shortcuts**: Upgraded Shortcuts modal into an interactive editor with live key capture, conflict detection/override, and per-action / global reset.
- **Playback Settings & UX Polish**: Added Playback Settings modal (default speed, default volume, resume toggle, subtitle language preference, default aspect ratio, audio output preference, watch history toggle, live WebGL/GPU status, JSON backup/restore) plus stage buffering indicator.

---

## [1.4.2] - 2026-06-03

### Fixed & Improved
- **System Default Audio Output (Windows WebView2)**: Automatically resolves Windows' concrete hardware output device ID backing `System Default Output` (matching `groupId`/label) instead of leaving WebView2 on a silent virtual `""` sink, re-binds live on `devicechange`, and persists the user's chosen audio output device across restarts.
- **Saved Playlists Mix-Up Fix**: Fixed stale `nativeFolderPath` leaking across sessions/drops/imports/tabs and prioritized exact saved file paths (`nativeFilePaths` / `trackMeta.fullPath`) when opening Saved Playlists — also auto-healing previously affected saved playlists and preventing multi-tab `localStorage` overwrites.
- **Saved Playlists Full Management**: Added visible Delete icon button on every card (with 1-click Undo), Pointer-Events drag-and-drop reordering, and a right-click context menu (Open, Inline Rename, Move Top/Up/Down/Bottom, Export `.XSPF`/`.M3U8`/`.PLS`, Delete).
- **Native Tauri v2 Drag & Drop**: Wired `tauri://drag-drop` so files and folders dragged from Windows Explorer always carry real disk paths.

---

## [1.4.1] - 2026-06-02

### Fixed & Improved
- **Playlist Drag-and-Drop Reordering**: Replaced native HTML5 drag with a smooth Pointer-Events reorder engine with live drop indicator, floating ghost preview, and edge auto-scroll (fixes WebView2 blocked drag cursor).
- **Resizable Playlist Sidebar**: Added a draggable vertical split-pane handle between the player stage and playlist sidebar (LTR & RTL support, double-click to reset, persisted width).
- **Default Audio Output Auto-Play**: Fixed silent initial playback in WebView2 by keeping native audio output active until DSP/Visualizer is needed and binding the default WASAPI sink cleanly.
- **Top Bar Double-Click Maximize**: Removed conflicting native drag-region double-toggle and added a drag movement threshold + cooldown so double-clicking the top bar cleanly maximizes/restores.
- **Cast Button Placement**: Kept the Cast button exclusively in the top video toolbar (removed duplicate bottom dock button).
- **Concise README**: Streamlined repository README into clean scannable Arabic & English headlines.

---

## [1.4.0] - 2026-06-01

### Added — Playlist Powerhouse
- **Manual Drag-and-Drop Reordering**: Reorder tracks freely via drag handle with live insertion indicators; manual order persists across sessions and Saved Playlists.
- **Playlist Track Right-Click Context Menu**: Play Now, Play Next (`Up Next` priority queue with `#1`/`#2` badges), Stop After This Track, Move to Top / Up (`Alt+↑`) / Down (`Alt+↓`) / Bottom, Star/Unstar, Mark Watched/Unwatched, Reset Resume Position, Copy Filename, and Remove (`Delete`) with 1-click Undo.
- **Per-Track Resume Progress & Watched Tracking**: Mini resume progress bar on partially watched items, automatic ✓ watched detection at ≥92%, and total duration + watched count in the playlist header.
- **Playlist Power Tools Menu**: Append Files/Folder without clearing the queue, Shuffle Queue Order, Remove Duplicates, Remove Watched Items, Clear Up Next Queue, plus new `Manual` and `Length` sort modes.

### Added — Cast to TV & Smart Screens
- **Native Rust DLNA / UPnP Smart TV Discovery & Casting**: Discovers Samsung, LG, Sony, Android TV, Xbox, and DLNA renderers over local Wi-Fi and casts local media with Play/Pause/Stop remote controls.
- **Built-In Wi-Fi LAN HTTP Range Streaming Server**: Streams local media (HTTP 206) and timing-synced `.VTT` subtitles to any Smart TV browser or phone on the same Wi-Fi.
- **Windows Wireless Display (`Miracast`)** launcher and **Browser Remote Playback** support (`C` shortcut + Cast buttons in dock and video toolbar).

### Added — GitHub Documentation
- Bilingual `README.md` (Arabic RTL first, English below), `LICENSE` (MIT), and `CHANGELOG.md`.

---

## [1.3.1] - 2026-05-15

### Improved
- Replaced default OS scrollbars across menus and panels with sleek theme-matched scrollbars.
- Converted flat menu sections (Playback Speed, Sleep Timer, EQ Presets, Aspect Ratio, Zoom, Crop) into cascading flyout submenus with smart viewport flip and RTL support.
- Replaced native browser right-click menu with a full themed AAZ Player stage context menu.
- Switched to a frameless Windows Tauri v2 window with integrated tab-strip drag area and native Minimize / Maximize / Close controls.

---

## [1.3.0] - 2026-05-01

### Changed
- Migrated desktop shell from Electron to ultra-lightweight **Rust + Tauri v2** (~4–6 MB installer, instant startup, native `aazmedia://` HTTP Range protocol, native system font discovery, native fuzzy subtitle scanner, and native GitHub Releases updater).
- Added VLC-grade Video Controls (Aspect Ratio, Zoom, Crop, frame-by-frame stepping, and high-res PNG Snapshots).
- Fixed menu checkmark alignment for both LTR (English) and RTL (Arabic).

---

## [1.2.0] - 2026-04-15

### Added
- Multi-tab workspace with independent per-tab and per-window audio output channel selection (`setSinkId`).
- Smart auto-detection of nearby & fuzzy-matched `.SRT` / `.VTT` subtitles with automatic UTF-8 / Windows-1256 decoding.
- Subtitle Style & System Font Studio with pinned live preview and instant subtitle timing sync (`G` / `H`).
- Reliable double-click & button fullscreen toggle with Audio View ↔ Video View switching while in fullscreen.

---

## [1.0.0] - 2026-03-20

### Added
- Initial release of AAZ Player with local folder/file playback, 5-Band Equalizer, 4 visualizers, Saved Playlists Library, `.XSPF`/`.M3U8`/`.PLS` import & export, A–B loop, timestamp bookmarks, sleep timer, and bilingual Arabic/English Dark & Light UI.
