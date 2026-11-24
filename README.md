<div align="center">
  <img src="desktop/assets/icon.png" alt="AAZ Player" width="96" height="96" />
  <h1>AAZ Player</h1>
  <p>
    <img src="https://img.shields.io/badge/v1.8.0-3dc479?style=for-the-badge" alt="v1.8.0" />
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
- تشغيل ملفات الصوت والفيديو والمجلدات المحلية مع نظام تبويبات ونوافذ مستقلة واستئناف تلقائي لآخر جلسة
- توجيه قناة صوت مستقلة لكل تبويب ولكل نافذة
- **المشغل المصغر (Mini Player)** بشريط تقديم وتأخير مباشر، أحجام سريعة (`S` / `M` / `L`)، وضع شريط صوت مضغوط للملفات الصوتية، تثبيت في الأعلى، وحفظ تلقائي للموضع والحجم داخل حدود الشاشة
- **أزرار تحكم في شريط مهام ويندوز** (السابق / تشغيل وإيقاف / التالي) عند تمرير الفأرة على أيقونة البرنامج مع دعم أزرار الوسائط في لوحة المفاتيح
- **16 ثيم بهوية خضراء (32 وضع داكن وفاتح)** تشمل ماينكرافت وليجو وروبلوكس وأركيد وويندوز 95 الكلاسيكي وجيم بوي والمزيد عبر قائمة العرض
- **مكتبة الوسائط** للمجلدات التي تختارها فقط مع بحث وفلترة وفرز (الاسم / التاريخ / المدة)
- **سجل المشاهدة** داخل قائمة الوسائط (`فتح الأخيرة`) لاستئناف التشغيل وتحديد المكتمل مع وضع إيقاف السجل للخصوصية
- قوائم تشغيل احترافية (سحب وإفلات، كليك يمين، تشغيل تالٍ، حفظ، تكرار، بحث، تصدير `.XSPF` / `.M3U8` / `.PLS`)
- **اختصارات لوحة مفاتيح قابلة للتخصيص** مع كشف التعارضات و**لوحة إعدادات تشغيل** مع نسخ احتياطي واستعادة بصيغة JSON
- البث المباشر للشاشات والتلفزيون الذكي (DLNA / Wi-Fi) مع حماية الجلسة برمز أمان
- اكتشاف تلقائي للترجمة وتخصيص الخطوط والتوقيت
- تحكم كامل بالفيديو (الأبعاد، التكبير، القص، التنقل إطاراً بإطار، لقطات الشاشة، ملء الشاشة)
- معادل صوت 5 نطاقات و4 أنماط عرض صوتي، واجهة عربي/إنجليزي، خطوط مدمجة محلياً بدون اتصال خارجي، وتحديثات محمية ببصمة SHA-256 وتوقيع Minisign مع حماية ضد إعادة التشغيل (تُرفض تلقائياً عند غياب التوقيع)

### التحميل
- **[تحميل أحدث إصدار لويندوز](../../releases/latest)**

</div>

---

## 🇬🇧 English

**Lightweight, security-hardened local audio & video player for Windows (Rust + Tauri v2)**

### Features
- Local audio, video & folder playback with a multi-tab workspace, independent windows, and automatic desktop session resume
- Per-tab & per-window audio output routing (`setSinkId`)
- **Overhauled Mini Player Mode** with live scrubbable seek bar, `S`/`M`/`L` size presets, compact audio bar layout, crisp SVG controls, always-on-top pinning, and DPI/work-area-safe window layout persistence
- **Native Windows Taskbar Thumbnail Media Controls** (Previous / Play-Pause / Next via `ITaskbarList3`) plus OS media key integration (`navigator.mediaSession`)
- **16-Theme Green-Identity Studio (32 Dark & Light modes)** including Minecraft, LEGO, Roblox, Super Arcade 16-Bit, Classic OS 95, Game Boy LCD & more via `View -> Theme Style`
- **Media Library** for user-selected folders with instant search, type filters, and Name / Date / Duration sorting
- **Watch History** integrated cleanly under `Media -> Open Recent` with automatic resume, completion tracking, search, and privacy pause toggle
- Pro playlists (drag-and-drop, right-click menu, Up Next, Save, Duplicate, Search, `.XSPF` / `.M3U8` / `.PLS` export)
- **Customizable Keyboard Shortcuts** with conflict detection & **Playback Settings** modal with JSON backup/restore
- Token-protected LAN streaming & private-network DLNA Smart TV casting
- Auto-detected subtitles with custom system fonts, styling studio & timing sync
- Full video controls (aspect ratio, zoom, crop, frame stepping, HD snapshots, fullscreen)
- 5-band audio equalizer, 4 live visualizers, Arabic/English UI, offline bundled fonts, & fail-closed SHA-256 + Minisign updater verification

### Updater Signing & Key Handling
The desktop updater enforces **fail-closed verification**: every release installer must provide both a valid SHA-256 checksum (`SHA256SUMS.txt` or GitHub asset digest) and a valid **Minisign** Ed25519 signature (`.minisig`) whose trusted comment binds the exact release version, filename, and SHA-256 digest (`aaz-player|version=<ver>|file=<name>|sha256=<hash>`) to prevent replay or downgrade attacks. Unsigned releases or builds without a configured public key are refused automatically.

To enable signed releases in your repository:
1. Generate a Minisign keypair locally:
   ```bash
   minisign -G -p aaz-updater.pub -s aaz-updater.key
   ```
2. Keep `aaz-updater.key` private (never commit it). Add these GitHub Actions Secrets:
   - `AAZ_UPDATER_SIGNING_KEY`: full contents of `aaz-updater.key`
   - `AAZ_UPDATER_SIGNING_KEY_PASSWORD`: passphrase used when generating the key (leave empty if unprotected)
3. Add the base64 public key line (from `aaz-updater.pub`, starting with `RW...`) as a GitHub Repository Variable or Secret named `AAZ_UPDATER_PUBLIC_KEY`.
4. `.github/workflows/release.yml` fails closed on stable releases if either `AAZ_UPDATER_SIGNING_KEY` or `AAZ_UPDATER_PUBLIC_KEY` is missing (unless manually triggered via `workflow_dispatch` with `allow_unsigned_preview=true`). When configured, it embeds `AAZ_UPDATER_PUBLIC_KEY` at compile time and signs `AAZ-Player-Setup-*.exe`, `AAZ-Player-Portable-*.exe`, and `SHA256SUMS.txt` with version-bound `.minisig` signatures before publishing.
5. **Key rotation**: publish a transitional release signed with the old key whose binary embeds the new public key before retiring the old secret key.

### Project Structure
- `index.html` — Semantic application shell and modals
- `css/styles.css`, `css/themes.css` & `public/fonts/` — 16-theme Dark & Light stylesheets and locally bundled WOFF2 fonts
- `js/core/` — Hardened cross-window messaging, Tauri desktop bridge, event bus
- `js/modules/` — Versioned storage (`v4`), themes catalog, playlist I/O, watch history, media library, shortcuts, settings, window layout
- `js/ui/` & `js/app/` — Multi-tab workspace shell, Phase 3 feature controller, core playback engine
- `desktop/src-tauri/` — Native Rust + Tauri v2 backend (media protocol, Cast/DLNA, Windows taskbar thumbnail toolbar, fail-closed Minisign/SHA-256 updater, window management)
- `tests/` — Automated Node.js test suite (`node tests/run-tests.cjs`)

### Download
- **[Download Latest Windows Release](../../releases/latest)**
