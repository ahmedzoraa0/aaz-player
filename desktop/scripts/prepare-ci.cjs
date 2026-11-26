// @ts-nocheck
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const desktopDir = path.resolve(__dirname, '..');
const appDir = path.join(desktopDir, 'app');
const tauriDir = path.join(desktopDir, 'src-tauri');
const tauriIconsDir = path.join(tauriDir, 'icons');

function copyDirClean(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

// 1. Copy modular frontend (index.html + css/ + js/ + public/fonts/) into desktop/app/
fs.mkdirSync(appDir, { recursive: true });
fs.copyFileSync(path.join(rootDir, 'index.html'), path.join(appDir, 'index.html'));
copyDirClean(path.join(rootDir, 'css'), path.join(appDir, 'css'));
copyDirClean(path.join(rootDir, 'js'), path.join(appDir, 'js'));
copyDirClean(path.join(rootDir, 'public', 'fonts'), path.join(appDir, 'fonts'));
copyDirClean(path.join(rootDir, 'public', 'brand'), path.join(appDir, 'brand'));
console.log('[prepare-ci] Synced index.html, css/, js/, fonts/, and brand/ -> desktop/app/');

// 2. Sync version from desktop/package.json -> tauri.conf.json & Cargo.toml
const pkgPath = path.join(desktopDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;

const tauriConfPath = path.join(tauriDir, 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = version;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');

const cargoPath = path.join(tauriDir, 'Cargo.toml');
const cargoRaw = fs.readFileSync(cargoPath, 'utf8');
const cargoUpdated = cargoRaw.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
fs.writeFileSync(cargoPath, cargoUpdated, 'utf8');

function computeAndroidVersionCode(semver) {
  const m = String(semver || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return 1;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

const androidVersionCode = computeAndroidVersionCode(version);
const androidPropsPath = path.join(tauriDir, 'gen', 'android', 'app', 'tauri.properties');
if (fs.existsSync(path.dirname(androidPropsPath))) {
  let props = fs.existsSync(androidPropsPath) ? fs.readFileSync(androidPropsPath, 'utf8') : '';
  const setProp = (src, key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(src)) return src.replace(re, `${key}=${val}`);
    const prefix = src.length > 0 && !src.endsWith('\n') ? '\n' : '';
    return `${src}${prefix}${key}=${val}\n`;
  };
  props = setProp(props, 'tauri.android.versionName', version);
  props = setProp(props, 'tauri.android.versionCode', String(androidVersionCode));
  fs.writeFileSync(androidPropsPath, props, 'utf8');
}
console.log(
  `[prepare-ci] Synced Rust + Tauri version -> v${version} (Android versionCode: ${androidVersionCode})`
);

// 3. Ensure base icons exist in src-tauri/icons/
fs.mkdirSync(tauriIconsDir, { recursive: true });
const srcIco = path.join(desktopDir, 'assets', 'icon.ico');
const srcPng = path.join(desktopDir, 'assets', 'icon.png');
if (fs.existsSync(srcIco)) {
  fs.copyFileSync(srcIco, path.join(tauriIconsDir, 'icon.ico'));
}
if (fs.existsSync(srcPng)) {
  fs.copyFileSync(srcPng, path.join(tauriIconsDir, 'icon.png'));
}

// 4. Bind GitHub repository & Minisign public key into compile-time Rust repo_config.json
const repoSlug = process.env.GITHUB_REPOSITORY || '';
const repoCfgPath = path.join(tauriDir, 'src', 'repo_config.json');
let existingPubKey = '';
if (fs.existsSync(repoCfgPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(repoCfgPath, 'utf8'));
    if (typeof existing.updaterPublicKey === 'string') {
      existingPubKey = existing.updaterPublicKey.trim();
    }
  } catch {
    existingPubKey = '';
  }
}
const updaterPublicKey = (process.env.AAZ_UPDATER_PUBLIC_KEY || existingPubKey || '').trim();
fs.writeFileSync(
  repoCfgPath,
  JSON.stringify({ repo: repoSlug, updaterPublicKey }, null, 2) + '\n',
  'utf8'
);
console.log(
  repoSlug
    ? `[prepare-ci] Bound Rust auto-updater to GitHub repo ${repoSlug} (minisign pubkey: ${updaterPublicKey ? 'configured' : 'not set'})`
    : '[prepare-ci] GITHUB_REPOSITORY not set; local dev mode.'
);
