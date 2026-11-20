<div align="center">
  <img src="desktop/assets/icon.png" alt="AAZ Player Logo" width="112" height="112" />
  <h1>AAZ Player</h1>
  <p><strong>مشغّل الوسائط المحلي الاحترافي الخفيف والذكي لنظام ويندوز — مبني بلغة Rust + Tauri v2</strong></p>
  <p><em>Ultra-lightweight local audio & video playlist player for Windows — powered by Rust & Tauri v2</em></p>

  <p>
    <img src="https://img.shields.io/badge/Version-v1.4.0-3dc479?style=for-the-badge" alt="Version v1.4.0" />
    <img src="https://img.shields.io/badge/Platform-Windows%2010%2F11-0f2d1d?style=for-the-badge&logo=windows" alt="Windows 10/11" />
    <img src="https://img.shields.io/badge/Engine-Rust%20%2B%20Tauri%20v2-1f6f46?style=for-the-badge&logo=rust" alt="Rust + Tauri v2" />
    <img src="https://img.shields.io/badge/License-MIT-2ea05f?style=for-the-badge" alt="MIT License" />
  </p>

  <p>
    <a href="#-العربية">العربية</a> ·
    <a href="#-english">English</a> ·
    <a href="#-اختصارات-لوحة-المفاتيح">الاختصارات</a> ·
    <a href="#-التحميل-والتثبيت">التحميل والتثبيت</a> ·
    <a href="CHANGELOG.md">سجل التغييرات / Changelog</a>
  </p>
</div>

---

<div dir="rtl" align="right">

## 🇪🇬 العربية

**AAZ Player** هو مشغّل صوت وفيديو محلي فائق الخفّة وسريع الاستجابة لنظام **Windows**، مصمّم ليمنحك تجربة مشاهدة واستماع متكاملة بدون إعلانات، بدون استهلاك مرتفع للرام، ومع أقوى أدوات إدارة قوائم التشغيل، البث المباشر للشاشات الذكية، الترجمة الذكية، وتوجيه قنوات الصوت المستقل لكل تبويب.

---

### ✨ أبرز المميزات

#### 1. قائمة تشغيل خارقة — Playlist Powerhouse
- **إعادة الترتيب بالسحب والإفلات اليدوي**: اسحب أي ملف من مقبض الترتيب للأعلى أو للأسفل لترتيب قائمتك يدويًا بحرية كاملة، مع خط تحديد فوري وحفظ تلقائي للترتيب المخصص داخل قوائمك المحفوظة.
- **قائمة كليك يمين متكاملة لكل ملف**:
  - تشغيل الآن
  - **تشغيل كالتالي فورًا (Up Next)** مع شارات أولوية مرقّمة (`#1`, `#2`)
  - **إيقاف التشغيل بعد هذا الملف (Stop After)** لإيقاف القائمة تلقائيًا فور انتهاء ملف معيّن
  - نقل لأعلى القائمة / تحريك لأعلى (`Alt + ↑`) / تحريك لأسفل (`Alt + ↓`) / نقل لأسفل القائمة
  - إضافة أو إزالة من المفضلة، وتحديد كتمت مشاهدته أو لم يُشاهد، وإعادة التقدم للبداية، ونسخ اسم الملف
  - **حذف الملف من القائمة (`Delete`) مع زر تراجع فوري بضغطة واحدة (Undo)**
- **تتبع التقدم والمشاهدة التلقائي**: شريط تقدم مصغّر أسفل كل ملف يُظهر أين توقفت، ويُعلّم الملف تلقائيًا بعلامة ✓ عند مشاهدة 92% منه، مع استئناف تلقائي من آخر ثانية لكل ملف ولكل قائمة محفوظة.
- **أدوات القائمة السريعة**: إضافة ملفات أو مجلد جديد إلى القائمة الحالية بدون مسحها، خلط الترتيب اليدوي، إزالة المكررات، إزالة الملفات التي تمت مشاهدتها، ومسح طابور التشغيل التالي، مع عرض المدة الإجمالية وعدد الملفات المشاهَدة.
- **دعم استيراد وتصدير قوائم التشغيل**: متوافق بالكامل مع صيغ `.XSPF (VLC)` و `.M3U8` و `.PLS`.

#### 2. البث المباشر للشاشة والتلفزيون — Cast to TV
- **اكتشاف تلقائي للشاشات الذكية عبر Wi-Fi (`DLNA / UPnP`)**: يكتشف شاشات Samsung و LG و Sony و Android TV و Xbox المتصلة على نفس الشبكة ويبث الملفات المحلية إليها مباشرة مع ريموت تحكم (تشغيل / إيقاف مؤقت / إيقاف).
- **خادم بث محلي مدمج على شبكة Wi-Fi**: يبث الفيديو والترجمة المزامَنة عبر رابط محلي سريع (`HTTP Range Streaming`) يمكنك فتحه من متصفح أي شاشة ذكية أو هاتف على نفس الشبكة.
- **دعم شاشات Windows اللاسلكية (`Miracast`)** و **بث المتصفح (`Chromecast / Remote Playback`)**.

#### 3. تبويبات متعددة وتوجيه مستقل لقناة الصوت
- **واجهة تبويبات حديثة بلا شريط ويندوز مزدوج**: افتح أكثر من فيديو أو مجلد في تبويبات مستقلة داخل نفس النافذة أو افتح نافذة جديدة (`Ctrl + Shift + N`).
- **اختيار قناة صوت مستقلة لكل تبويب ولكل نافذة**: شغّل التبويب الأول على السماعة الخارجية والتبويب الثاني على سماعة الرأس في نفس الوقت بدون تعارض.

#### 4. محرك ترجمة ذكي واستوديو تنسيق خطوط كامل
- **اكتشاف تلقائي ذكي للترجمة**: عند فتح أي فيديو (حتى بالضغط المزدوج من ويندوز)، يبحث البرنامج تلقائيًا عن ملف الترجمة المطابق أو المشابه في نفس المجلد والمجلدات القريبة مع أولوية للترجمة العربية، ويدعم الترميز العربي (`UTF-8` و `Windows-1256`).
- **استوديو تخصيص الترجمة**: تحكم كامل في الخط من جميع خطوط جهازك المثبتة، الحجم، السماكة، المائل، لون النص، الحد الخارجي، الخلفية والشفافية، الإطار، الظل، وموضع الترجمة مع معاينة حية ثابتة.
- **تقديم وتأخير الترجمة فورًا**: اضبط تزامن الترجمة بدقة بضغطة زر أو عبر اختصارات `G` و `H`.

#### 5. تحكم سينمائي بالفيديو واستوديو صوت احترافي
- **تحكم كامل بالفيديو**: نسبة العرض (`Aspect Ratio`)، التكبير (`Zoom`)، القص (`Crop`)، التنقل إطارًا بإطار (`,` و `.`)، التقاط صورة عالية الدقة (`Shift + S`)، وضع صورة داخل صورة (`PiP`)، ووضع ملء الشاشة مع إخفاء تلقائي للأزرار والمؤشر.
- **معادل صوت 5 نطاقات (`5-Band Equalizer`) ومضخم Preamp**: مع قوالب جاهزة (`Flat`, `Bass`, `Vocal`, `Acoustic`, `Night`, `Cinema`) و 4 أنماط للعارض الصوتي التفاعلي (`Spectrum`, `Wave`, `Orb`, `LED`).
- **علامات زمنية (`Bookmarks`)، تكرار مقطع (`A–B Loop`)، مؤقت النوم (`Sleep Timer`)، والتحكم بالسرعة (`0.75x – 2.0x`)**.

#### 6. أداء خارق بحجم صغير جدًا
- مبني بمحرك **Rust + Tauri v2** الأصلي (حجم المثبّت حوالي **4 إلى 6 ميجابايت فقط** واستهلاك رام منخفض جدًا مقارنة بمشغلات Electron التقليدية).
- **واجهة ثنائية اللغة (عربي RTL / إنجليزي LTR)** مع الوضع الداكن والفاتح وتحديثات تلقائية مباشرة من GitHub Releases.

---

### ⌨️ اختصارات لوحة المفاتيح

| الاختصار | الوظيفة |
| :--- | :--- |
| `Space` | تشغيل / إيقاف مؤقت |
| `←` / `→` | تقديم أو ترجيع 5 ثوانٍ |
| `↑` / `↓` | رفع أو خفض الصوت |
| `M` | كتم الصوت |
| `F` أو دبل كليك | ملء الشاشة |
| `P` | صورة داخل صورة (PiP) |
| `C` | فتح نافذة البث للتلفزيون (Cast to TV) |
| `,` / `.` | التنقل إطارًا للخلف / للأمام |
| `Shift + S` | التقاط لقطة شاشة من الفيديو |
| `0` | إعادة ضبط أبعاد وتكبير وقص الفيديو |
| `G` / `H` | تقديم أو تأخير الترجمة بمقدار 0.25 ثانية |
| `L` | تكرار مقطع (A–B Loop) |
| `B` | إضافة علامة زمنية (Bookmark) |
| `S` | تمييز الملف بنجمة (مفضلة) |
| `Alt + ↑` / `Alt + ↓` | تحريك الملف المحدد في قائمة التشغيل لأعلى أو لأسفل |
| `Delete` | حذف الملف المحدد من قائمة التشغيل (مع تراجع فوري) |
| `Ctrl + O` / `Ctrl + Shift + O` | فتح مجلد / فتح ملفات |
| `Ctrl + S` | حفظ قائمة التشغيل الحالية في المكتبة |
| `Ctrl + T` / `Ctrl + W` | تبويب جديد / إغلاق التبويب الحالي |
| `Ctrl + Tab` / `Ctrl + 1..9` | التنقل بين التبويبات |
| `Ctrl + Shift + N` | فتح نافذة مستقلة جديدة |
| `?` | عرض جميع الاختصارات |

---

### 📥 التحميل والتثبيت

1. انتقل إلى صفحة **[الإصدارات (Releases)](../../releases/latest)** في المستودع.
2. حمّل ملف التثبيت لنظام Windows (`AAZ-Player_1.4.0_x64-setup.exe`) أو النسخة المحمولة (`AAZ-Player.exe`).
3. شغّل المثبّت، وسيدعم البرنامج تلقائيًا فتح ملفات الصوت والفيديو وقوائم التشغيل والتحديثات التلقائية من داخل البرنامج (**مساعدة ← التحقق من وجود تحديثات**).

---

### 🛠️ البناء للمطورين

```bash
# تثبيت الاعتماديات
npm install

# تشغيل نسخة الويب للتطوير (على المنفذ 3000)
npm run dev

# تجهيز وبناء تطبيق سطح المكتب (Rust + Tauri v2)
node desktop/scripts/prepare-ci.cjs
cd desktop && npm install && npm run tauri:build
```

</div>

---

## 🇬🇧 English

**AAZ Player** is an ultra-lightweight, zero-bloat local audio & video playlist player for **Windows**, engineered with **Rust + Tauri v2**. Built for speed, crystal-clear playback, and effortless media library control — featuring a full **Playlist Powerhouse**, **Cast to TV**, **Multi-Tab Per-Tab Audio Output Routing**, **Smart Auto-Subtitles & Font Studio**, and a **5-Band Audio Equalizer**.

---

### ✨ Key Features

#### 1. Playlist Powerhouse
- **Manual Drag-and-Drop Reordering**: Grab any track row by its handle and drag it anywhere in your queue with a live emerald drop indicator. Manual order is automatically preserved inside Saved Playlists.
- **Full Right-Click Track Context Menu**:
  - Play Now
  - **Play Next (`Up Next` Priority Queue)** with live `#1`, `#2` priority badges
  - **Stop After This Track** amber flag to automatically pause once a chosen track completes
  - Move to Top / Move Up (`Alt + ↑`) / Move Down (`Alt + ↓`) / Move to Bottom
  - Star / Unstar, Mark as Watched / Unwatched, Reset Resume Position, Copy Filename
  - **Remove from Playlist (`Delete`) with instant 1-click Undo**
- **Per-Track Resume Progress & Watched Tracking**: Subtle bottom progress indicator on partially played tracks, automatic ✓ watched badge at ≥92% playback, and automatic per-track & per-playlist resume.
- **Playlist Power Tools**: Append files or folders without clearing the current queue, shuffle manual order, remove duplicates, remove watched items, clear Up Next queue, and inspect total playlist duration + watched count.
- **Import & Export**: Seamless compatibility with `.XSPF (VLC)`, `.M3U8`, and `.PLS` playlists.

#### 2. Cast to TV & Smart Screens
- **Auto-Discover Smart TVs on Wi-Fi (`DLNA / UPnP`)**: Native Rust SSDP discovery finds Samsung, LG, Sony, Android TV, Xbox, and DLNA renderers on your local network and casts local media directly with Play / Pause / Stop remote controls.
- **Built-In Wi-Fi LAN Streaming Server**: Streams local media (full HTTP 206 Partial Content Range support) + synced `.VTT` subtitles to a dark cinema receiver page accessible from any Smart TV browser or mobile device on the same Wi-Fi.
- **Windows Wireless Display (`Miracast`)** launcher & **Browser Remote Playback (`Chromecast`)** support.

#### 3. Browser-Style Multi-Tab Workspace & Per-Tab Audio Output
- **Frameless Integrated Tab Strip**: Open multiple videos, folders, or playlists in isolated tabs or independent windows (`Ctrl + Shift + N`).
- **Per-Tab & Per-Window Audio Output Channel**: Route Tab 1 to headphones and Tab 2 to speakers simultaneously.

#### 4. Smart Subtitle Engine & Font Studio
- **Automatic Fuzzy & Nearby Subtitle Detection**: Automatically detects and attaches matching `.SRT` / `.VTT` subtitles in the same or nearby folders (including `Subs/`), with smart UTF-8 & Windows-1256 Arabic encoding support.
- **Live Subtitle Style Studio**: Pick any font installed on Windows, customize size, weight, italic, color, stroke outline, background opacity, border, drop shadow, and vertical position with a pinned live preview.
- **Instant Timing Sync**: Shift subtitle delay earlier/later on the fly (`G` / `H`).

#### 5. Cinema Video Controls & Audio Studio
- **Video Adjustments**: Cascading submenus for Aspect Ratio, Zoom, Crop, frame-by-frame stepping (`,` / `.`), high-resolution PNG snapshots (`Shift + S`), Picture-in-Picture (`PiP`), and 2-second auto-hiding Fullscreen HUD.
- **5-Band Equalizer & Preamp**: Built-in presets (`Flat`, `Bass`, `Vocal`, `Acoustic`, `Night`, `Cinema`) + 4 real-time visualizers (`Spectrum`, `Wave`, `Orb`, `LED`).
- **Timestamp Bookmarks, A–B Section Loop, Sleep Timer & Variable Speed (`0.75x – 2.0x`)**.

#### 6. Featherweight Native Rust Architecture
- Powered by **Rust + Tauri v2** (~4–6 MB installer footprint, tiny memory usage, instant startup).
- Full **English (LTR) & Arabic (RTL)** interface, Dark & Light themes, and built-in GitHub Releases auto-updater.

---

### ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` | Play / Pause |
| `←` / `→` | Skip backward / forward 5 seconds |
| `↑` / `↓` | Volume Up / Down |
| `M` | Mute / Unmute |
| `F` or Double-Click | Toggle Fullscreen |
| `P` | Picture-in-Picture (PiP) |
| `C` | Cast to TV / Smart Screen |
| `,` / `.` | Step backward / forward 1 frame |
| `Shift + S` | Capture Video Snapshot |
| `0` | Reset Video Aspect Ratio, Zoom & Crop |
| `G` / `H` | Subtitle Sync −0.25s / +0.25s |
| `L` | Cycle A–B Section Loop |
| `B` | Add Timestamp Bookmark |
| `S` | Star / Unstar Current Track |
| `Alt + ↑` / `Alt + ↓` | Reorder focused playlist track up / down |
| `Delete` | Remove focused track from playlist (with 1-click Undo) |
| `Ctrl + O` / `Ctrl + Shift + O` | Open Folder / Open Files |
| `Ctrl + S` | Save Current Playlist to Library |
| `Ctrl + T` / `Ctrl + W` | New Tab / Close Tab |
| `Ctrl + Tab` / `Ctrl + 1..9` | Switch Tabs |
| `Ctrl + Shift + N` | Open New Independent Window |
| `?` | Show All Shortcuts |

---

### 📥 Download & Installation

1. Visit the **[Latest Release](../../releases/latest)** page.
2. Download the Windows NSIS installer (`AAZ-Player_1.4.0_x64-setup.exe`) or the portable executable (`AAZ-Player.exe`).
3. Built-in auto-updates keep you on the latest release via **Help → Check for Updates**.

---

### 🛠️ Building from Source

```bash
# Install root dependencies
npm install

# Run web preview dev server (port 3000)
npm run dev

# Build native Windows Rust + Tauri v2 desktop app
node desktop/scripts/prepare-ci.cjs
cd desktop && npm install && npm run tauri:build
```

---

### 📄 License

Released under the [MIT License](LICENSE).
