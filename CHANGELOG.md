# Changelog / سجل التغييرات

All notable changes to **AAZ Player** are documented in this file.

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
