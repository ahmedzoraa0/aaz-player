# AAZ Player — Android Architecture Record

**Baseline commit:** `ed785b4` (AAZ Player `v1.7.0`)
**Last updated:** 2026-11-23
**Status:** Phases 1–4 implemented (final Phase 4 adds all 16 Dark/Light themes with dynamic Android status/navigation bar syncing, native LAN/DLNA Cast + Wi-Fi HTML5 receiver with `WifiManager.MulticastLock` & RFC1918 SSRF guard, fail-closed SHA-256 direct APK self-updater via `FileProvider`, scoped Phase 4 permissions audit with zero `MANAGE_EXTERNAL_STORAGE`, final mobile-first UI polish, and signed ARM64 APK release pipeline in `.github/workflows/release.yml`). Phase 4 GitHub Actions release build and physical-device acceptance checks remain **PENDING** until executed on GitHub Actions and Android hardware.

---

## 1. Binding Architecture & Product Decisions (D1–D10)

| ID | Decision | Rationale |
| --- | --- | --- |
| **D1** | Same repository (`desktop/` + `desktop/src-tauri/gen/android`) | Keeps the shared frontend, 27-group JS test suite, and Windows CI in lockstep with Android releases. |
| **D2** | Shared Tauri v2 shell + native Kotlin Media3/ExoPlayer core | Media3 owns foreground/background decoding, MediaSession, media notification, and wake locks; web frontend owns UI, library, playlists, themes, i18n, gestures, and settings over a typed bridge with zero duplicated playback state. Fallback: full-screen native `PlayerView` with equivalent native controls + native subtitle renderer if WebView surface layering fails `V2`. |
| **D3** | Phones & tablets in Phases 1–4; Android TV excluded | Phone portrait, phone landscape, and tablet two-pane ship in Phase 1; Android TV leanback/D-pad is deferred to a later version. Casting *from* phone *to* TV ships in Phase 4. |
| **D4** | `minSdkVersion` 24 (Android 7.0) with runtime feature gates | Matches Tauri default floor; PiP gated to API 26+, granular media permissions to API 33+, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` to targetSdk 34+. |
| **D5** | Keep brand `"AAZ Player"`, package `com.aaz.player`, synced version | Avoids package ID churn; `versionCode = major * 10000 + minor * 100 + patch` (`1.7.0` → `10700`). New release signing keystore generated in Phase 4. |
| **D6** | Basic green theme (dark + light) first; remaining 15 themes in Phase 4 | Reduces layout verification surface during Phases 1–3; CSS theme studio ports intact in Phase 4. |
| **D7** | Phased file discovery: SAF manual picking (Phase 1) + optional MediaStore scan (Phase 2) | Zero runtime permissions needed for Phase 1 SAF picking; optional MediaStore scan adds `READ_MEDIA_AUDIO`/`READ_MEDIA_VIDEO` (API 33+) or `READ_EXTERNAL_STORAGE` (API ≤ 32) with rationale. `MANAGE_EXTERNAL_STORAGE` is never requested. |
| **D8** | Open from other apps (`ACTION_VIEW`, `ACTION_SEND`/`ACTION_SEND_MULTIPLE`) in Phase 1 | Routes incoming `content://` URIs (and restricted `file://` URIs carrying explicit read grants) through `MediaRef`. |
| **D9** | Direct signed APK from GitHub Releases first; Play Store later | Reuses existing SHA-256 + Minisign updater architecture for direct APK self-updates; Play Store AAB track is documented but out of scope for Phases 1–4. |
| **D10** | Strictly offline & private | Zero accounts, telemetry, analytics, ads, or third-party hosts; network used only for user-initiated LAN casting and update checks. |

---

## 2. Phase Boundaries

1. **Phase 1 (Core):** Toolchain/CI (`R1–R4`), Rust/Tauri Android portability (`R5–R9`), `MediaRef` (`R10`), Kotlin SAF + fd + Media3 bridge skeleton (`R11–R16`), mobile/tablet responsive RTL/LTR layout & touch gestures (`R17–R26`), `ACTION_VIEW`/`ACTION_SEND` intents (`R27`), `versionCode`/icon sync (`R28`).
2. **Phase 2 (Subtitles & Library):** SAF/MediaStore nearby subtitle matching (`R29–R31`), MediaStore optional scan (`R32`), saved playlists/favorites/bookmarks/history on `MediaRef` (`R33`), SAF playlist import/export (`R34`).
3. **Phase 3 (Background, PiP, EQ, Backup):** Full Media3 `MediaSessionService` + foreground notification & lock-screen controls (`R35–R38`), Picture-in-Picture (`R39`), `android.media.audiofx` EQ & Visualizer (`R40`), SAF JSON backup/restore (`R41`).
4. **Phase 4 (Themes, Casting, Release):** All 16 dark/light themes (`R42`), `WifiManager.MulticastLock` + LAN/DLNA cast (`R43–R46`), permission & privacy audit (`R47`), direct APK updater & release signing/CI (`R48–R50`).

---

## 3. Canonical `MediaRef` Model (`R10`)

Shared across Rust (`desktop/src-tauri/src/media_core.rs`) and JS (`js/modules/media-ref.js`, `js/modules/track-identity.js`):

```json
{
  "kind": "path | contentUri | mediaStoreUri",
  "value": "C:/Videos/ep1.mp4 | content://com.android.externalstorage.documents/...",
  "displayName": "ep1.mp4",
  "size": 104857600,
  "mtimeMs": 1732000000000,
  "folderKey": "optional parent folder or SAF tree URI"
}
```

Canonical identity key rules:
- `kind === "path"` → `fs:<normalized-windows-or-posix-path>` (preserves existing desktop keys verbatim).
- `kind === "contentUri"` → `uri:<exact-content-uri>` (disambiguated by `folderKey` only if identical URI appears across roots; never mangled with Windows path normalization).
- `kind === "mediaStoreUri"` → `ms:<exact-mediastore-uri>`.

---

## 4. Permission Plan by Phase

| Phase | Permissions | Scope / Gate |
| --- | --- | --- |
| **Phase 1** | `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion="28"`) | Legacy PNG snapshot save on API 24–28 only; API 29+ uses `MediaStore.Images` with no permission. SAF picking needs zero runtime permissions. |
| **Phase 2** | `READ_MEDIA_AUDIO`, `READ_MEDIA_VIDEO` (API 33+); `READ_EXTERNAL_STORAGE` (`maxSdkVersion="32"`) | Optional device-media library scan only; designed denied state falls back to SAF. |
| **Phase 3** | `FOREGROUND_SERVICE` (API 28+), `FOREGROUND_SERVICE_MEDIA_PLAYBACK` (targetSdk 34+), `WAKE_LOCK`, `POST_NOTIFICATIONS` (API 33+ runtime) | Background audio/video playback service and media notification controls. |
| **Phase 4** | `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_WIFI_MULTICAST_STATE`, `REQUEST_INSTALL_PACKAGES` | User-initiated LAN/DLNA casting (with `MulticastLock`) and direct-track APK self-updates. |

---

## 5. Verification & Acceptance Ledger

> **Honesty rule:** No item may be marked `PASS` without recorded execution evidence. Items requiring Android SDK/NDK, emulator, or physical devices remain `PENDING` until executed on target hardware or Android CI.

| Check | Scope | Status | Evidence / Notes |
| --- | --- | --- | --- |
| **T3 (JS/Web)** | `npm run lint`, `npm run build`, `prepare-ci.cjs`, `node tests/run-tests.cjs` | `PASS` | Executed locally in Node v22 container (38 test groups green, incl. new hold-to-2x, volume-overdrive, library-navigation groups) at v1.8.0. |
| **v1.8.0 (hold-to-2x pin, 200% overdrive, hierarchical library, logo-only mobile bar)** | JS modules + Kotlin bridge + CSS | `PENDING` | Behavioral Node tests + headless-Chrome renders at 320/390/768/1440px executed locally; Kotlin compiles only on CI; on-device acceptance (touch hold-2x, 200% audible output, SAF browsing across restart) still requires a physical Android device. |
| **T3 (Windows Rust)** | `cargo fmt -- --check`, `cargo clippy`, `cargo test`, Windows CI | `PASS` | Confirmed green on GitHub Actions Windows runner (Phase 1); re-run required on next push. |
| **R4 (Android CI — Phases 1–3)** | `.github/workflows/ci.yml` `android-debug-build` job (`ubuntu-latest`) | `PASS` | Built ARM64 preview APKs on GitHub Actions; user installed & verified Phases 1–3 on physical Android phone. |
| **R42–R50 (Android CI — Phase 4)** | All 16 Dark/Light themes + system bars, `AazCastHelper` LAN/DLNA Cast, `AazUpdater` SHA-256 APK updater, `build-android` job in `release.yml` | `PENDING` | Native Kotlin, JS, CSS, manifest config, and release CI implemented; awaits GitHub Actions build + user physical device check. |
| **T1–T2, T4–T12** | Full Android acceptance suite | `PENDING` | Tracked per phase gate; awaits on-device Phase 4 verification (DLNA Smart TV cast, Wi-Fi receiver, 16 Dark/Light themes, signed APK self-update). |

---

## 6. Activated Fallbacks

- None activated yet. Any fallback triggered during `V1`, `V2`, `R40`, or `T7` will be documented here with root cause and device/API evidence.
