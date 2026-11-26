// @ts-nocheck
/**
 * Configures the generated Tauri Android project (`desktop/src-tauri/gen/android`) after
 * `tauri android init` & `tauri icon` so that every CI build automatically receives:
 * 1. Crisp Android Adaptive Icon VectorDrawables (full-bleed dark foliage green background
 *    + properly centered 66dp safe-zone AZ0 ring-play emblem — zero cropping, zero white corners).
 * 2. Native Kotlin bridge sources (`AazContentServer.kt`, `AazMediaHelper.kt`, `MainActivity.kt`).
 * 3. `network_security_config.xml` permitting cleartext strictly for loopback `127.0.0.1` / `localhost`.
 * 4. `AndroidManifest.xml` patches: ACTION_VIEW/SEND intent filters, PiP, configChanges, scoped Phase 1+2 perms.
 * 5. R8 minification + resource shrinking + ProGuard keep rules in `app/build.gradle.kts` for ultra-lightweight APK.
 */
const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const nativeSrcDir = path.join(desktopDir, 'android-native');
const androidRoot = path.join(desktopDir, 'src-tauri', 'gen', 'android');
const appDir = path.join(androidRoot, 'app');
const mainDir = path.join(appDir, 'src', 'main');
const javaPkgDir = path.join(mainDir, 'java', 'com', 'aaz', 'player');
const resDir = path.join(mainDir, 'res');

if (!fs.existsSync(appDir)) {
  console.log('[configure-android] gen/android not initialized yet; skipping.');
  process.exit(0);
}

function writeFileEnsureDir(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
}

// 1. Copy native Kotlin sources into app/src/main/java/com/aaz/player/
fs.mkdirSync(javaPkgDir, { recursive: true });
for (const fileName of [
  'AazContentServer.kt',
  'AazMediaHelper.kt',
  'AazPlaybackService.kt',
  'AazCastHelper.kt',
  'AazUpdater.kt',
  'MainActivity.kt',
]) {
  const src = path.join(nativeSrcDir, fileName);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(javaPkgDir, fileName));
  }
}
console.log('[configure-android] Installed native Kotlin sources (AazContentServer, AazMediaHelper, AazPlaybackService, AazCastHelper, AazUpdater, MainActivity).');

// 2. Write crisp Adaptive Icon VectorDrawables (66dp safe-zone centered inside 108dp canvas)
const adaptiveBgXml = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- Hamza brand tile gradient (matches public/brand/hamza-icon.svg) -->
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:startX="0"
                android:startY="0"
                android:endX="108"
                android:endY="108"
                android:type="linear">
                <item android:color="#83E6B6" android:offset="0.0" />
                <item android:color="#14955F" android:offset="1.0" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
`;

const adaptiveFgXml = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- Hamza glyph (public/brand/hamza-icon.svg geometry, 1024-unit space) scaled into the 66dp adaptive safe zone -->
    <group
        android:pivotX="0"
        android:pivotY="0"
        android:scaleX="0.0794"
        android:scaleY="0.0794"
        android:translateX="15.73"
        android:translateY="15.16">
        <path
            android:pathData="M411.0,290.7 L759.0,290.7 L661.0,488.7 L759.0,687.7 L205.0,687.7 L317.0,553.7 L317.0,418.7 Z M459.0,415.7 L459.0,559.7 L661.0,488.7 Z"
            android:fillType="evenOdd">
            <aapt:attr name="android:fillColor">
                <gradient android:startX="0" android:startY="290" android:endX="0" android:endY="688" android:type="linear">
                    <item android:color="#FFFFFF" android:offset="0.0" />
                    <item android:color="#C0F2DE" android:offset="1.0" />
                </gradient>
            </aapt:attr>
        </path>
    </group>
</vector>
`;

const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

const iconBgColorXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#14955F</color>
</resources>
`;

// Clean any generated bitmap/v24 adaptive foreground files so our vector adaptive icon takes clean precedence
for (const staleRel of [
  path.join('drawable-v24', 'ic_launcher_foreground.xml'),
  path.join('drawable-v24', 'ic_launcher_background.xml'),
]) {
  const stalePath = path.join(resDir, staleRel);
  if (fs.existsSync(stalePath)) fs.rmSync(stalePath, { force: true });
}
for (const entry of fs.readdirSync(resDir, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith('mipmap-')) {
    for (const fgName of ['ic_launcher_foreground.png', 'ic_launcher_foreground.webp', 'ic_launcher_background.png']) {
      const p = path.join(resDir, entry.name, fgName);
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
  }
}

writeFileEnsureDir(path.join(resDir, 'drawable', 'ic_launcher_background.xml'), adaptiveBgXml);
writeFileEnsureDir(path.join(resDir, 'drawable', 'ic_launcher_foreground.xml'), adaptiveFgXml);
writeFileEnsureDir(path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptiveIconXml);
writeFileEnsureDir(path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptiveIconXml);
writeFileEnsureDir(path.join(resDir, 'values', 'ic_launcher_background.xml'), iconBgColorXml);
console.log('[configure-android] Wrote adaptive launcher vector icons (safe-zone centered, Hamza green gradient background).');

// 3. Write strict loopback-only network_security_config.xml
const netSecXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
    </domain-config>
</network-security-config>
`;
writeFileEnsureDir(path.join(resDir, 'xml', 'network_security_config.xml'), netSecXml);

// 3B. Write FileProvider path config for Phase 4 direct signed APK self-updater (R48-R50)
const filePathsXml = `<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="updates" path="updates/" />
</paths>
`;
writeFileEnsureDir(path.join(resDir, 'xml', 'file_paths.xml'), filePathsXml);

// 3C. Write res/values/aaz_config.xml binding GitHub Releases repo slug for AazUpdater.kt
let githubRepoSlug = String(process.env.GITHUB_REPOSITORY || '').trim();
const repoCfgPath = path.join(desktopDir, 'src-tauri', 'src', 'repo_config.json');
if (!githubRepoSlug && fs.existsSync(repoCfgPath)) {
  try {
    const parsedRepo = JSON.parse(fs.readFileSync(repoCfgPath, 'utf8'));
    if (parsedRepo && typeof parsedRepo.githubRepo === 'string') {
      githubRepoSlug = parsedRepo.githubRepo.trim();
    }
  } catch {
    // Ignore malformed repo_config.json
  }
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepoSlug)) {
  githubRepoSlug = '';
}
const aazConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="aaz_github_repo" translatable="false">${githubRepoSlug}</string>
</resources>
`;
writeFileEnsureDir(path.join(resDir, 'values', 'aaz_config.xml'), aazConfigXml);

// 3D. Launcher / app label: show the Arabic product name (productName stays ASCII for installer & file names)
const stringsXmlPath = path.join(resDir, 'values', 'strings.xml');
if (fs.existsSync(stringsXmlPath)) {
  let stringsXml = fs.readFileSync(stringsXmlPath, 'utf8');
  stringsXml = stringsXml.replace(/(<string name="(?:app_name|main_activity_title)">)[^<]*(<\/string>)/g, '$1همزة$2');
  fs.writeFileSync(stringsXmlPath, stringsXml, 'utf8');
  console.log('[configure-android] Set app label to همزة.');
}

// 4. Patch res/values/themes.xml dark background so startup has zero white flash
const themesXmlPath = path.join(resDir, 'values', 'themes.xml');
if (fs.existsSync(themesXmlPath)) {
  let themesXml = fs.readFileSync(themesXmlPath, 'utf8');
  if (!themesXml.includes('android:windowBackground')) {
    themesXml = themesXml.replace(
      /(<style[^>]*name="Theme\.[^"]*"[^>]*>)/,
      `$1\n        <item name="android:windowBackground">#060b08</item>\n        <item name="android:statusBarColor">#060b08</item>\n        <item name="android:navigationBarColor">#060b08</item>`
    );
    fs.writeFileSync(themesXmlPath, themesXml, 'utf8');
  }
}

// 5. Patch AndroidManifest.xml (networkSecurityConfig, scoped Phase 1+2 perms, PiP, ACTION_VIEW/SEND)
const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');

  const requiredPerms = [
    `<uses-permission android:name="android.permission.INTERNET" />`,
    `<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />`,
    `<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />`,
    `<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />`,
    `<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />`,
    `<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />`,
    `<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />`,
    `<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />`,
    `<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />`,
    `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />`,
    `<uses-permission android:name="android.permission.WAKE_LOCK" />`,
    `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`,
    `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`,
  ];
  for (const perm of requiredPerms) {
    const nameMatch = perm.match(/android:name="([^"]+)"/);
    if (nameMatch && !manifest.includes(nameMatch[1])) {
      manifest = manifest.replace(/<application(?=\s|>)/, `${perm}\n    <application`);
    }
  }

  if (!manifest.includes('android:networkSecurityConfig=')) {
    manifest = manifest.replace(
      /<application(?=\s|>)/,
      '<application\n        android:networkSecurityConfig="@xml/network_security_config"'
    );
  }

  // Patch MainActivity attributes individually without duplicating attributes Tauri already emitted (e.g. launchMode)
  manifest = manifest.replace(/<activity\b[^>]*android:name="\.MainActivity"[^>]*>/, (activityTag) => {
    let updated = activityTag;
    if (!/\bandroid:supportsPictureInPicture\s*=/.test(updated)) {
      updated = updated.replace(
        'android:name=".MainActivity"',
        'android:name=".MainActivity"\n            android:supportsPictureInPicture="true"'
      );
    }
    if (!/\bandroid:launchMode\s*=/.test(updated)) {
      updated = updated.replace(
        'android:name=".MainActivity"',
        'android:name=".MainActivity"\n            android:launchMode="singleTask"'
      );
    }
    return updated;
  });

  // Add ACTION_VIEW & ACTION_SEND / ACTION_SEND_MULTIPLE intent filters (D8 / R27)
  if (!manifest.includes('android.intent.action.VIEW')) {
    const intentFilters = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" />
                <data android:scheme="file" />
                <data android:mimeType="audio/*" />
                <data android:mimeType="video/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="audio/*" />
                <data android:mimeType="video/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="audio/*" />
                <data android:mimeType="video/*" />
            </intent-filter>`;
    manifest = manifest.replace('</activity>', `${intentFilters}\n        </activity>`);
  }

  // Register Phase 3 Foreground Media Playback Service (R35-R38)
  if (!manifest.includes('android:name=".AazPlaybackService"')) {
    const svcXml = `
        <service
            android:name=".AazPlaybackService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />`;
    manifest = manifest.replace('</application>', `${svcXml}\n    </application>`);
  }

  // Register Phase 4 FileProvider for verified APK self-updates (R48-R50)
  if (!manifest.includes('androidx.core.content.FileProvider')) {
    const providerXml = `
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>`;
    manifest = manifest.replace('</application>', `${providerXml}\n    </application>`);
  }

  // Self-check: ensure no XML opening tag contains duplicate attributes before Gradle parses it
  const tagRegex = /<([A-Za-z0-9_:-]+)(\s[^>]*?)?\/?>/g;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(manifest)) !== null) {
    const tagName = tagMatch[1];
    const attrsBody = tagMatch[2] || '';
    const seen = new Set();
    const attrRegex = /([A-Za-z0-9_:-]+)\s*=\s*"[^"]*"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrsBody)) !== null) {
      const attrName = attrMatch[1];
      if (seen.has(attrName)) {
        throw new Error(`[configure-android] Duplicate XML attribute "${attrName}" on <${tagName}> in AndroidManifest.xml`);
      }
      seen.add(attrName);
    }
  }

  fs.writeFileSync(manifestPath, manifest, 'utf8');
  console.log('[configure-android] Patched & validated AndroidManifest.xml (PiP, ACTION_VIEW/SEND, scoped perms, loopback config).');
}

// 6. Enable R8 shrinking & add ProGuard keep rules for compact APK (~5 MB)
const proguardPath = path.join(appDir, 'proguard-rules.pro');
const extraKeepRules = `
# AZ0 — keep JS bridge and Tauri runtime reflection targets
-keepattributes *Annotation*
-keep class com.aaz.player.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class app.tauri.** { *; }
`;
const existingProguard = fs.existsSync(proguardPath) ? fs.readFileSync(proguardPath, 'utf8') : '';
if (!existingProguard.includes('com.aaz.player.**')) {
  fs.writeFileSync(proguardPath, existingProguard + '\n' + extraKeepRules, 'utf8');
}

const buildGradlePath = path.join(appDir, 'build.gradle.kts');
if (fs.existsSync(buildGradlePath)) {
  let gradle = fs.readFileSync(buildGradlePath, 'utf8');
  if (!gradle.includes('isShrinkResources')) {
    if (/isMinifyEnabled\s*=\s*(true|false)/.test(gradle)) {
      gradle = gradle.replace(
        /isMinifyEnabled\s*=\s*(true|false)/,
        'isMinifyEnabled = true\n            isShrinkResources = true'
      );
    } else {
      gradle = gradle.replace(
        /getByName\("release"\)\s*\{/,
        'getByName("release") {\n            isMinifyEnabled = true\n            isShrinkResources = true'
      );
    }
    fs.writeFileSync(buildGradlePath, gradle, 'utf8');
    console.log('[configure-android] Enabled R8 minification & resource shrinking in app/build.gradle.kts.');
  }
}
