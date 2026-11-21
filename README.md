<div align="center">
  <img src="desktop/assets/icon.png" alt="AAZ Player" width="96" height="96" />
  <h1>AAZ Player</h1>
  <p>
    <img src="https://img.shields.io/badge/v1.5.0-3dc479?style=for-the-badge" alt="v1.5.0" />
    <img src="https://img.shields.io/badge/Windows-0f2d1d?style=for-the-badge&logo=windows" alt="Windows" />
    <img src="https://img.shields.io/badge/Rust%20%2B%20Tauri%20v2-1f6f46?style=for-the-badge&logo=rust" alt="Rust + Tauri v2" />
    <img src="https://img.shields.io/badge/MIT-2ea05f?style=for-the-badge" alt="MIT" />
  </p>
</div>

---

<div dir="rtl" align="right">

## 🇪🇬 العربية

**مشغّل صوت وفيديو محلي خفيف وآمن لنظام ويندوز (Rust + Tauri v2)**

### المميزات
- تشغيل ملفات الصوت والفيديو والمجلدات المحلية مع نظام تبويبات ونوافذ مستقلة
- توجيه قناة صوت مستقلة لكل تبويب ولكل نافذة
- **المشغل المصغر (Mini Player)** مع تثبيت في الأعلى وحفظ موضع وحجم النافذة تلقائياً
- **مكتبة الوسائط** للمجلدات التي تختارها فقط مع بحث وفلترة وفرز (الاسم / التاريخ / المدة)
- **سجل المشاهدة** لاستئناف التشغيل وتحديد المكتمل مع وضع إيقاف السجل للخصوصية
- قوائم تشغيل احترافية (سحب وإفلات، كليك يمين، تشغيل تالٍ، حفظ، تكرار، بحث، تصدير `.XSPF` / `.M3U8` / `.PLS`)
- **اختصارات لوحة مفاتيح قابلة للتخصيص** مع كشف التعارضات و**لوحة إعدادات تشغيل** مع نسخ احتياطي واستعادة بصيغة JSON
- البث المباشر للشاشات والتلفزيون الذكي (DLNA / Wi-Fi) مع حماية الجلسة برمز أمان
- اكتشاف تلقائي للترجمة وتخصيص الخطوط والتوقيت
- تحكم كامل بالفيديو (الأبعاد، التكبير، القص، التنقل إطاراً بإطار، لقطات الشاشة، ملء الشاشة)
- معادل صوت 5 نطاقات و4 أنماط عرض صوتي، واجهة عربي/إنجليزي، خطوط مدمجة محلياً بدون اتصال خارجي، وضع داكن وفاتح، وتحديثات محمية ببصمة SHA-256 وتوقيع Minisign (تُرفض تلقائياً عند غياب التوقيع)

### التحميل
- **[تحميل أحدث إصدار لويندوز](../../releases/latest)**

</div>

---

## 🇬🇧 English

**Lightweight, security-hardened local audio & video player for Windows (Rust + Tauri v2)**

### Features
- Local audio, video & folder playback with a multi-tab workspace and independent windows
- Per-tab & per-window audio output routing (`setSinkId`)
- **Mini Player Mode** with always-on-top pinning and multi-monitor-safe window layout persistence
- **Media Library** for user-selected folders with instant search, type filters, and Name / Date / Duration sorting
- **Watch History** with automatic resume, completion tracking, search, and privacy pause toggle
- Pro playlists (drag-and-drop, right-click menu, Up Next, Save, Duplicate, Search, `.XSPF` / `.M3U8` / `.PLS` export)
- **Customizable Keyboard Shortcuts** with conflict detection & **Playback Settings** modal with JSON backup/restore
- Token-protected LAN streaming & private-network DLNA Smart TV casting
- Auto-detected subtitles with custom system fonts, styling studio & timing sync
- Full video controls (aspect ratio, zoom, crop, frame stepping, HD snapshots, fullscreen)
- 5-band audio equalizer, 4 live visualizers, Arabic/English UI, offline bundled fonts, Dark/Light Foliage themes & fail-closed SHA-256 + Minisign updater verification

### Updater Signing & Key Handling
The desktop updater enforces **fail-closed verification**: every release installer must provide both a valid SHA-256 checksum (`SHA256SUMS.txt` or GitHub asset digest) and a valid **Minisign** Ed25519 signature (`.minisig`) matching the public key compiled into the app. Unsigned releases or builds without a configured public key are refused automatically.

To enable signed releases in your repository:
1. Generate a Minisign keypair locally:
   ```bash
   minisign -G -p aaz-updater.pub -s aaz-updater.key
   ```
2. Keep `aaz-updater.key` private (never commit it). Add these GitHub Actions Secrets:
   - `AAZ_UPDATER_SIGNING_KEY`: full contents of `aaz-updater.key`
   - `AAZ_UPDATER_SIGNING_KEY_PASSWORD`: passphrase used when generating the key
3. Add the base64 public key line (from `aaz-updater.pub`, starting with `RW...`) as a GitHub Repository Variable or Secret named `AAZ_UPDATER_PUBLIC_KEY`.
4. `.github/workflows/release.yml` embeds `AAZ_UPDATER_PUBLIC_KEY` into the compiled binary at build time and signs `AAZ-Player-Setup-*.exe`, `AAZ-Player-Portable-*.exe`, and `SHA256SUMS.txt` with `.minisig` signatures before publishing.
5. **Key rotation**: publish a transitional release signed with the old key whose binary embeds the new public key before retiring the old secret key.

### Project Structure
- `index.html` — Semantic application shell and modals
- `css/styles.css` & `public/fonts/` — Foliage Green Dark & Light theme stylesheets and locally bundled WOFF2 fonts
- `js/core/` — Hardened cross-window messaging, Tauri desktop bridge, event bus
- `js/modules/` — Versioned storage (`v4`), playlist I/O, watch history, media library, shortcuts, settings, window layout
- `js/ui/` & `js/app/` — Multi-tab workspace shell, Phase 3 feature controller, core playback engine
- `desktop/src-tauri/` — Native Rust + Tauri v2 backend (media protocol, Cast/DLNA, fail-closed Minisign/SHA-256 updater, window management)
- `tests/` — Automated Node.js test suite (`node tests/run-tests.cjs`)

### Download
- **[Download Latest Windows Release](../../releases/latest)**
