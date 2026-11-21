# Changelog / سجل التغييرات

All notable changes to **AAZ Player** are documented in this file.

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
