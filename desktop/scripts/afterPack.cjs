// @ts-nocheck
const fs = require('fs');
const path = require('path');

/**
 * Runs after electron-builder unpacks the app, before NSIS/Portable packaging:
 * 1. Embeds assets/icon.ico and Windows version metadata directly into AAZ Player.exe
 *    using rcedit (avoids winCodeSign symlink failures on Windows 11 while ensuring
 *    the Desktop shortcut, Start Menu, and Taskbar ALWAYS show the real AAZ icon).
 * 2. Strips ~55 unused Chromium locale .pak files (keeping only en-US & ar) and
 *    redundant license dumps to significantly reduce installed disk size.
 */
exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const appVersion = context.packager.appInfo.version;

  // 1. Strip unused Chromium locales (keep only English US & Arabic)
  const localesDir = path.join(appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    const keep = new Set(['en-US.pak', 'ar.pak']);
    let removedCount = 0;
    for (const file of fs.readdirSync(localesDir)) {
      if (!keep.has(file)) {
        try {
          fs.unlinkSync(path.join(localesDir, file));
          removedCount++;
        } catch {
          // Non-fatal
        }
      }
    }
    console.log(`[afterPack] Pruned ${removedCount} unused Chromium locale packs (kept en-US & ar).`);
  }

  // Remove oversized Chromium license HTML (~10 MB) from unpacked app
  const chromiumLicenses = path.join(appOutDir, 'LICENSES.chromium.html');
  if (fs.existsSync(chromiumLicenses)) {
    try {
      fs.unlinkSync(chromiumLicenses);
      console.log('[afterPack] Removed LICENSES.chromium.html to reduce install footprint.');
    } catch {
      // Non-fatal
    }
  }

  // 2. Embed multi-resolution AAZ icon & version metadata directly into the .exe
  if (context.electronPlatformName === 'win32') {
    const exePath = path.join(appOutDir, `${productFilename}.exe`);
    const iconPath = path.resolve(__dirname, '..', 'assets', 'icon.ico');

    if (fs.existsSync(exePath) && fs.existsSync(iconPath)) {
      try {
        const rceditMod = require('rcedit');
        const rceditFn = typeof rceditMod === 'function' ? rceditMod : rceditMod.rcedit;
        await rceditFn(exePath, {
          icon: iconPath,
          'file-version': appVersion,
          'product-version': appVersion,
          'version-string': {
            ProductName: 'AAZ Player',
            FileDescription: 'AAZ Player',
            CompanyName: 'AAZ',
            OriginalFilename: `${productFilename}.exe`,
            InternalName: 'AAZ Player'
          }
        });
        console.log(`[afterPack] Embedded assets/icon.ico & metadata into ${productFilename}.exe`);
      } catch (err) {
        console.warn('[afterPack] rcedit warning (non-fatal):', err && err.message ? err.message : err);
      }
    }
  }
};
