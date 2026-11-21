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

// 1. Copy modular frontend (index.html + css/ + js/) into desktop/app/
fs.mkdirSync(appDir, { recursive: true });
fs.copyFileSync(path.join(rootDir, 'index.html'), path.join(appDir, 'index.html'));
copyDirClean(path.join(rootDir, 'css'), path.join(appDir, 'css'));
copyDirClean(path.join(rootDir, 'js'), path.join(appDir, 'js'));
console.log('[prepare-ci] Synced index.html, css/, and js/ -> desktop/app/');

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
console.log(`[prepare-ci] Synced Rust + Tauri version -> v${version}`);

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

// 4. Bind GitHub repository into compile-time Rust repo_config.json for auto-updater
const repoSlug = process.env.GITHUB_REPOSITORY || '';
const repoCfgPath = path.join(tauriDir, 'src', 'repo_config.json');
fs.writeFileSync(repoCfgPath, JSON.stringify({ repo: repoSlug }, null, 2) + '\n', 'utf8');
console.log(
  repoSlug
    ? `[prepare-ci] Bound Rust auto-updater to GitHub repo ${repoSlug}`
    : '[prepare-ci] GITHUB_REPOSITORY not set; local dev mode.'
);
