#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

function walkJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
    _raw: map,
  };
}

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.stack ? err.stack : err}`);
  }
}

async function main() {
  console.log('\nHamza Automated Test Suite\n================================');

  const messaging = await import(pathToFileURL(path.join(ROOT, 'js/core/messaging.js')).href);
  const fileUtils = await import(pathToFileURL(path.join(ROOT, 'js/utils/file-utils.js')).href);
  const timeUtils = await import(pathToFileURL(path.join(ROOT, 'js/utils/time-utils.js')).href);
  const errorHandlerMod = await import(pathToFileURL(path.join(ROOT, 'js/utils/error-handler.js')).href);
  const playlistIo = await import(pathToFileURL(path.join(ROOT, 'js/modules/playlist-io.js')).href);
  const storageMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/storage-manager.js')).href);
  const themesCatalog = await import(pathToFileURL(path.join(ROOT, 'js/modules/themes-catalog.js')).href);
  const historyMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/history-manager.js')).href);
  const libraryMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/library-manager.js')).href);
  const shortcutsMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/shortcuts-manager.js')).href);
  const settingsMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/settings-manager.js')).href);
  const subtitleStyleMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/subtitle-style.js')).href);
  const trackIdMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/track-identity.js')).href);
  const subMatcherMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/subtitle-matcher.js')).href);
  const mediaRefMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/media-ref.js')).href);
  const desktopBridgeMod = await import(pathToFileURL(path.join(ROOT, 'js/core/desktop-bridge.js')).href);
  const mobileGesturesMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/mobile-gestures.js')).href);

  // 1. JS Syntax Validation
  await runTest('All ES module files in js/ pass Node syntax check', () => {
    const files = walkJsFiles(path.join(ROOT, 'js'));
    assert.ok(files.length >= 10, `Expected >=10 JS modules, got ${files.length}`);
    for (const f of files) {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    }
  });

  // 2. Security: No wildcard postMessage in app/ui and strict CSP in tauri.conf.json
  await runTest('Security: Zero wildcard postMessage in app/ui & strict CSP in tauri.conf.json', () => {
    const shellCode = fs.readFileSync(path.join(ROOT, 'js/ui/workspace-shell.js'), 'utf8');
    const appCode = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.equal(shellCode.includes("postMessage("), false, 'workspace-shell must use sendSafeMessage');
    assert.equal(appCode.includes("postMessage("), false, 'player-app must use sendSafeMessage');

    const tauriConf = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8')
    );
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const desktopPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8'));
    const cargoToml = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/Cargo.toml'), 'utf8');
    const cargoVerMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
    assert.ok(cargoVerMatch, 'Cargo.toml must declare a version');
    assert.match(desktopPkg.version, /^\d+\.\d+\.\d+$/, 'Version must follow semver');
    assert.equal(rootPkg.version, desktopPkg.version, 'Root package.json version must match desktop/package.json');
    assert.equal(tauriConf.version, desktopPkg.version, 'tauri.conf.json version must match desktop/package.json');
    assert.equal(cargoVerMatch[1], desktopPkg.version, 'Cargo.toml version must match desktop/package.json');
    const csp = tauriConf.app?.security?.csp;
    assert.equal(typeof csp, 'string', 'CSP must be a non-null string');
    assert.ok(csp.includes("script-src 'self'"), 'CSP must enforce script-src self');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'CSP script-src must not allow unsafe-inline');
    assert.ok(csp.includes("object-src 'none'"), 'CSP must disable object-src');
    assert.ok(csp.includes('http://aazmedia.localhost'), 'CSP must allow aazmedia protocol');

    // Verify zero inline event handlers in index.html
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'index.html must not have inline on*= handlers');
    assert.ok(html.includes('href="./css/styles.css"'), 'index.html must link external CSS');
    assert.ok(html.includes('src="./js/main.js"'), 'index.html must load ES module main.js');
  });

  // 3. Cross-Window Messaging Hardening PoC
  await runTest('Security: messaging.js blocks untrusted origin, unknown source, spoofed tabId & invalid types', () => {
    const origin = 'http://tauri.localhost';
    const fakeIframeWin = { id: 'iframe1' };
    const attackerWin = { id: 'evil' };
    const parentWin = { id: 'parent' };
    const resolveTab = (src) => (src === fakeIframeWin ? { id: 'tab_1' } : null);

    // Reject wrong origin
    assert.equal(
      messaging.receiveTabMessage(
        { origin: 'https://evil.example', source: fakeIframeWin, data: { type: 'aaz-tab-ready', tabId: 'tab_1' } },
        resolveTab,
        origin
      ),
      null
    );

    // Reject wrong source window
    assert.equal(
      messaging.receiveTabMessage(
        { origin, source: attackerWin, data: { type: 'aaz-tab-ready', tabId: 'tab_1' } },
        resolveTab,
        origin
      ),
      null
    );

    // Reject spoofed tabId
    assert.equal(
      messaging.receiveTabMessage(
        { origin, source: fakeIframeWin, data: { type: 'aaz-close-tab', tabId: 'tab_999' } },
        resolveTab,
        origin
      ),
      null
    );

    // Reject unknown message type
    assert.equal(
      messaging.receiveTabMessage(
        { origin, source: fakeIframeWin, data: { type: 'aaz-exec-shell', tabId: 'tab_1' } },
        resolveTab,
        origin
      ),
      null
    );

    // Accept valid Tab -> Shell message
    const okTab = messaging.receiveTabMessage(
      {
        origin,
        source: fakeIframeWin,
        data: { type: 'aaz-tab-state', tabId: 'tab_1', title: 'Movie', isPlaying: true, hasMedia: true, kind: 'video' },
      },
      resolveTab,
      origin
    );
    assert.ok(okTab && okTab.message.title === 'Movie' && okTab.message.isPlaying === true);

    // Reject Shell -> Tab from wrong source
    assert.equal(
      messaging.receiveShellMessage(
        { origin, source: attackerWin, data: { type: 'aaz-open-external', paths: ['C:/video.mp4'] } },
        parentWin,
        origin
      ),
      null
    );

    // Accept valid Shell -> Tab message
    const okShell = messaging.receiveShellMessage(
      { origin, source: parentWin, data: { type: 'aaz-open-external', paths: ['C:/video.mp4'] } },
      parentWin,
      origin
    );
    assert.deepEqual(okShell, { type: 'aaz-open-external', paths: ['C:/video.mp4'] });
  });

  // 4. Storage Migrations (v3 -> v4) & Backup/Restore
  await runTest('Storage: non-destructive v3 -> v4 migration with pre-migration backup & JSON backup/restore', () => {
    const v3Legacy = {
      volume: 0.72,
      playbackRate: 1.25,
      starredKeys: ['track_a.mp4'],
      progressByKey: { 'track_a.mp4': { time: 45, duration: 300 } },
      savedPlaylists: [{ id: 'pl_1', name: 'Favorites', trackCount: 2 }],
    };
    const mem = createMemoryStorage({
      aaz_media_player_state_v3: JSON.stringify(v3Legacy),
    });
    const sm = storageMod.createStorageManager(mem);
    const loaded = sm.load();

    assert.equal(loaded.schemaVersion, 4);
    assert.equal(loaded.volume, 0.72);
    assert.equal(loaded.playbackSettings.defaultPlaybackRate, 1.25);
    assert.deepEqual(loaded.starredKeys, ['track_a.mp4']);
    assert.equal(loaded.savedPlaylists.length, 1);
    assert.equal(loaded.savedPlaylists[0].name, 'Favorites');
    // Pre-migration backup created automatically
    assert.ok(mem.getItem(storageMod.BACKUP_PRE_V4_KEY), 'Pre-migration v3 backup must exist');

    // Backup export & restore into fresh storage
    const backupJson = sm.exportBackupJson({ theme: 'light', lang: 'ar' });
    const freshMem = createMemoryStorage();
    const sm2 = storageMod.createStorageManager(freshMem);
    const res = sm2.importBackupJson(backupJson);
    assert.equal(res.ok, true);
    assert.equal(res.state.savedPlaylists[0].name, 'Favorites');
    assert.equal(res.prefs.lang, 'ar');

    // Malformed backup rejected cleanly
    assert.equal(sm2.importBackupJson('{not valid json').ok, false);
    assert.equal(sm2.importBackupJson('{"foo":"bar"}').ok, false);
  });

  // 5. Playlist Import / Export Round-Trip (.XSPF, .M3U8, .PLS)
  await runTest('Playlist I/O: XSPF, M3U8, and PLS round-trip export & import + malformed safety', () => {
    const tracks = [
      { title: 'Episode 1 & Intro', fullPath: 'C:/Videos/ep1.mp4', duration: 120 },
      { title: 'Soundtrack', fullPath: 'C:/Music/theme.mp3', duration: 245 },
    ];

    for (const fmt of ['xspf', 'm3u8', 'pls']) {
      const exported = playlistIo.buildPlaylistExport(tracks, fmt, 'Test Mix');
      const parsed = playlistIo.parsePlaylistText(exported.content, `mix.${exported.ext}`);
      assert.equal(parsed.length, 2, `${fmt} should parse 2 entries`);
      assert.equal(parsed[0].location, 'C:/Videos/ep1.mp4');
      assert.equal(parsed[0].title, 'Episode 1 & Intro');
      assert.equal(parsed[1].location, 'C:/Music/theme.mp3');
    }

    assert.deepEqual(playlistIo.parsePlaylistText('', 'empty.m3u8'), []);
    assert.deepEqual(playlistIo.parsePlaylistText('### comment only', 'empty.m3u8'), []);
  });

  // 6. Subtitle SRT -> VTT + Timing Shift + Cast Query Param Joining
  await runTest('Subtitles & URL utils: SRT->VTT shift & Cast ?token=...&t=... safe joining', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,500\nHello World\n';
    const vtt = timeUtils.srtToWebVtt(srt, 1.5);
    assert.ok(vtt.startsWith('WEBVTT'));
    assert.ok(vtt.includes('00:00:02.500 --> 00:00:05.000'));

    const authedUrl = 'http://192.168.1.10:51234/media?token=abcdef123456';
    const busted = fileUtils.appendQueryParam(authedUrl, 't', 999);
    assert.equal(busted, 'http://192.168.1.10:51234/media?token=abcdef123456&t=999');

    const plainUrl = 'http://192.168.1.10:51234/media';
    assert.equal(fileUtils.appendQueryParam(plainUrl, 't', 999), 'http://192.168.1.10:51234/media?t=999');
  });

  // 7. Watch History (Record, Auto-Complete >=92%, Search, Remove, Clear, Privacy Pause)
  await runTest('Watch History: record, auto-complete >=92%, search, toggle, remove, clear & privacy pause', () => {
    const store = storageMod.createEmptyState();
    let recording = true;
    const hm = historyMod.createHistoryManager({
      getStore: () => store,
      persist: () => {},
      isRecordingEnabled: () => recording,
    });

    const entry = hm.recordPlay({ title: 'Inception', name: 'Inception.mp4', kind: 'video', fullPath: 'D:/Movies/Inception.mp4' }, 30, 100);
    assert.equal(entry.completed, false);
    assert.equal(hm.getEntries().length, 1);

    // Auto-complete at >=92%
    hm.updateProgress({ fullPath: 'D:/Movies/Inception.mp4' }, 94, 100);
    assert.equal(hm.getEntries()[0].completed, true);

    // Privacy pause stops new recordings
    recording = false;
    hm.recordPlay({ title: 'Private Clip', name: 'priv.mp4', kind: 'video', fullPath: 'D:/priv.mp4' }, 10, 50);
    assert.equal(hm.getEntries().length, 1);

    // Search & filter
    assert.equal(hm.query({ search: 'incep', filter: 'completed' }).length, 1);
    assert.equal(hm.query({ search: 'incep', filter: 'in-progress' }).length, 0);

    // Remove & clear
    assert.equal(hm.removeEntry(entry.id), true);
    assert.equal(hm.getEntries().length, 0);
    recording = true;
    hm.recordPlay({ title: 'Song', name: 'song.mp3', kind: 'audio' }, 5, 180);
    hm.clearAll();
    assert.equal(hm.getEntries().length, 0);
  });

  // 8. Media Library (User Folders, Search, Type Filter, Sort)
  await runTest('Media Library: add/remove folders, search, type filter & Name/Date/Duration sort', () => {
    const store = storageMod.createEmptyState();
    const lm = libraryMod.createLibraryManager({
      getStore: () => store,
      persist: () => {},
    });

    lm.addOrUpdateFolder('D:/Media', 'Media', [
      { name: 'b_clip.mp4', kind: 'video', fullPath: 'D:/Media/b_clip.mp4', mtimeMs: 1000, duration: 50 },
      { name: 'a_song.mp3', kind: 'audio', fullPath: 'D:/Media/a_song.mp3', mtimeMs: 5000, duration: 220 },
    ]);

    assert.equal(lm.getFolders().length, 1);
    assert.equal(lm.queryItems({ type: 'audio' }).length, 1);
    assert.equal(lm.queryItems({ search: 'clip' }).length, 1);
    assert.equal(lm.queryItems({ sortBy: 'name' })[0].name, 'a_song.mp3');
    assert.equal(lm.queryItems({ sortBy: 'date' })[0].name, 'a_song.mp3');
    assert.equal(lm.queryItems({ sortBy: 'duration' })[0].name, 'a_song.mp3');

    lm.updateItemDuration('D:/Media/b_clip.mp4', 900);
    assert.equal(lm.queryItems({ sortBy: 'duration' })[0].name, 'b_clip.mp4');

    assert.equal(lm.removeFolder('D:/Media'), true);
    assert.equal(lm.getFolders().length, 0);
  });

  // 9. Keyboard Shortcuts (Rebind, Conflict Detection, Reset, Input Exclusion)
  await runTest('Shortcuts: defaults, rebind, conflict detection, override, reset & input-field exclusion', () => {
    const store = storageMod.createEmptyState();
    const sm = shortcutsMod.createShortcutsManager({
      getStore: () => store,
      persist: () => {},
    });

    assert.equal(sm.getBinding('playPause'), 'Space');
    assert.equal(sm.matchAction({ key: ' ', code: 'Space', target: { tagName: 'BODY' } }), 'playPause');
    // Must ignore when typing in an input
    assert.equal(sm.matchAction({ key: ' ', code: 'Space', target: { tagName: 'INPUT' } }), null);

    // Conflict detection ('M' is already Mute)
    const conflict = sm.setBinding('fullscreen', 'M', { allowOverride: false });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'conflict');
    assert.equal(conflict.conflict.id, 'mute');

    // Rebind to unused combo
    const ok = sm.setBinding('fullscreen', 'Ctrl+Shift+F');
    assert.equal(ok.ok, true);
    assert.equal(sm.getBinding('fullscreen'), 'Ctrl+Shift+F');

    sm.resetAll();
    assert.equal(sm.getBinding('fullscreen'), 'F');
  });

  // 10. Playback Settings & Error Handler
  await runTest('Settings & Error Handler: clamping, persistence & bilingual user-safe errors', () => {
    const store = storageMod.createEmptyState();
    const setMgr = settingsMod.createSettingsManager({
      getStore: () => store,
      persist: () => {},
    });
    const updated = setMgr.update({ defaultVolume: 99, defaultPlaybackRate: 1.5, defaultSubtitleLang: 'ar' });
    assert.equal(updated.defaultVolume, 2, 'volume domain is 0..2 (200% overdrive)');
    assert.equal(updated.defaultPlaybackRate, 1.5);
    assert.equal(updated.defaultSubtitleLang, 'ar');

    const enErr = errorHandlerMod.formatUserError(
      errorHandlerMod.ErrorCategory.UPDATE,
      new Error('SHA-256 digest mismatch'),
      'en'
    );
    const arErr = errorHandlerMod.formatUserError(
      errorHandlerMod.ErrorCategory.NETWORK_DLNA,
      new Error('Not a private LAN address'),
      'ar'
    );
    assert.ok(enErr.includes('SHA-256'));
    assert.ok(arErr.includes('الشبكة المحلية'));

    // Bilingual NO_LAN_IP, Minisign signature refusal, and AUDIO_OUTPUT fallback notices
    const noLanEn = errorHandlerMod.formatUserError(
      errorHandlerMod.ErrorCategory.NETWORK_DLNA,
      new Error('NO_LAN_IP: No private local network IPv4 address was detected'),
      'en'
    );
    const noLanAr = errorHandlerMod.formatUserError(
      errorHandlerMod.ErrorCategory.NETWORK_DLNA,
      new Error('NO_LAN_IP: No private local network IPv4 address was detected'),
      'ar'
    );
    assert.ok(noLanEn.toLowerCase().includes('local network'));
    assert.ok(noLanAr.includes('شبكة محلية'));

    const sigEn = errorHandlerMod.formatUserError(
      errorHandlerMod.ErrorCategory.UPDATE,
      new Error('Update refused: missing cryptographic signature (.minisig)'),
      'en'
    );
    const sigAr = errorHandlerMod.formatUserError(
      errorHandlerMod.ErrorCategory.UPDATE,
      new Error('Update refused: missing cryptographic signature (.minisig)'),
      'ar'
    );
    assert.ok(sigEn.toLowerCase().includes('signature'));
    assert.ok(sigAr.includes('توقيع رقمي'));

    const audioOutEn = errorHandlerMod.formatUserError(
      errorHandlerMod.ErrorCategory.AUDIO_OUTPUT,
      new Error('NotFoundError'),
      'en'
    );
    const audioOutAr = errorHandlerMod.formatUserError(
      errorHandlerMod.ErrorCategory.AUDIO_OUTPUT,
      new Error('NotFoundError'),
      'ar'
    );
    assert.ok(audioOutEn.includes('System Default Output'));
    assert.ok(audioOutAr.includes('النظام الافتراضي'));

    const logged = [];
    const origWarn = console.warn;
    console.warn = (...args) => logged.push(args);
    try {
      const eh = errorHandlerMod.createErrorHandler({ showToast: () => {}, getLang: () => 'en' });
      eh.log('audio.ctx.setSinkId', new Error('sink unavailable'));
    } finally {
      console.warn = origWarn;
    }
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], '[AAZ:audio.ctx.setSinkId]');
  });

  // 11. Offline Bundled Fonts, CSP & File Associations (.ts excluded)
  await runTest('Packaging & Privacy: local WOFF2 fonts bundled, zero Google Fonts in HTML/CSP & .ts removed from associations', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.equal(/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(html), false, 'index.html must not reference Google Fonts');
    assert.ok(html.includes('href="./fonts/fonts.css"'), 'index.html must link local ./fonts/fonts.css');

    const fontsCssPath = path.join(ROOT, 'public/fonts/fonts.css');
    assert.ok(fs.existsSync(fontsCssPath), 'public/fonts/fonts.css must exist');
    const fontsCss = fs.readFileSync(fontsCssPath, 'utf8');
    assert.equal(/https?:\/\//i.test(fontsCss), false, 'fonts.css must not contain external URLs');
    assert.ok(fontsCss.includes("'Cairo'"), 'fonts.css must declare Cairo');
    assert.ok(fontsCss.includes("'JetBrains Mono'"), 'fonts.css must declare JetBrains Mono');
    assert.ok(fontsCss.includes("'Plus Jakarta Sans'"), 'fonts.css must declare Plus Jakarta Sans');

    const woffMatches = [...fontsCss.matchAll(/url\(\.\/([^)]+\.woff2)\)/g)];
    assert.ok(woffMatches.length >= 6, 'fonts.css must reference bundled local .woff2 files');
    for (const m of woffMatches) {
      assert.ok(
        fs.existsSync(path.join(ROOT, 'public/fonts', m[1])),
        `Missing bundled font file public/fonts/${m[1]}`
      );
    }

    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
    const csp = tauriConf.app?.security?.csp || '';
    assert.equal(/googleapis|gstatic/i.test(csp), false, 'CSP must not allow googleapis or gstatic');

    const videoAssoc = (tauriConf.bundle?.fileAssociations || []).find((a) => a.name === 'Hamza Video File');
    assert.ok(videoAssoc, 'Hamza Video File association must exist');
    assert.equal(videoAssoc.ext.includes('ts'), false, 'ts extension must be removed from Windows file associations');
  });

  // 12. No Silent Catch Blocks in player-app.js & Updater Fail-Closed Invariants
  await runTest('Reliability & Security: zero silent catches in player-app.js & fail-closed updater/LAN checks in Rust', () => {
    const appCode = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.equal(/catch\s*\{\s*\}/.test(appCode), false, 'player-app.js must have zero empty catch {} blocks');
    assert.equal(/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(appCode), false, 'player-app.js must have zero silent .catch(() => {}) blocks');
    assert.ok(appCode.includes('handleAudioSinkFallback('), 'player-app.js must handle setSinkId failures with fallback');
    assert.ok(appCode.includes('ErrorCategory.AUDIO_OUTPUT'), 'player-app.js must notify bilingual AUDIO_OUTPUT fallback errors');

    const libRs = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/src/lib.rs'), 'utf8');
    assert.ok(libRs.includes('expected_sha256: &str'), 'verify_file_integrity must require non-optional expected_sha256');
    assert.ok(libRs.includes('fn verify_file_minisign('), 'Rust updater must verify Minisign signatures');
    assert.ok(libRs.includes('fn detect_local_lan_ip() -> Result<String, String>'), 'detect_local_lan_ip must return Result and refuse 127.0.0.1 fallback');
    assert.ok(libRs.includes('NO_LAN_IP'), 'detect_local_lan_ip must return NO_LAN_IP error when offline');
  });

  // 13. UI Consistency & Desktop Auto-Resume Session Persistence
  await runTest('UI & Session Resume: 3 sidebar tabs, Media Open Recent submenu, unified Library & nativeTrackPaths persistence', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.equal(html.includes('id="tabHistoryBtn"'), false, 'History tab button must be removed from sidebar');
    assert.equal(html.includes('id="panelHistory"'), false, 'History sidebar panel must be removed');
    assert.ok(html.includes('id="mediaRecentSubmenu"'), 'Watch History must be placed in Media Open Recent submenu');
    assert.ok(html.includes('id="recentHistoryList"'), 'Recent History submenu list must exist');
    assert.ok(html.includes('lib-mode-tabs'), 'Library panel must use unified segmented mode-tabs');
    assert.ok(html.includes('id="libSortBtn"'), 'Library panel must use unified sort cycle button');
    assert.ok(html.includes('id="libMeta"'), 'Library panel header must include unified meta subtitle');

    const mem = createMemoryStorage();
    const sm = storageMod.createStorageManager(mem);
    sm.save({
      trackKey: 'ep1.mp4',
      trackName: 'ep1.mp4',
      trackFullPath: 'D:/Shows/ep1.mp4',
      nativeTrackPaths: ['D:/Shows/ep1.mp4', 'D:/Shows/ep2.mp4'],
      currentTime: 128.5,
    });
    const reloaded = sm.load();
    assert.equal(reloaded.trackFullPath, 'D:/Shows/ep1.mp4');
    assert.deepEqual(reloaded.nativeTrackPaths, ['D:/Shows/ep1.mp4', 'D:/Shows/ep2.mp4']);
  });

  // 14. 16-Theme Green-Identity Skin System (Dark + Light) & Release Version Sync
  await runTest('Theme Studio & Release Sync: 16 skins (incl. Minecraft, LEGO, Roblox) with Dark/Light CSS pairs & synced versions', () => {
    assert.ok(themesCatalog.SKINS.length >= 16, 'Theme Studio must define at least 16 distinct skins');
    const seenIds = new Set();
    for (const skin of themesCatalog.SKINS) {
      assert.ok(skin.id && !seenIds.has(skin.id), `Duplicate or empty skin id: ${skin.id}`);
      seenIds.add(skin.id);
      assert.ok(skin.nameEn && skin.nameAr, `Skin ${skin.id} must have EN & AR names`);
      assert.ok(skin.descEn && skin.descAr, `Skin ${skin.id} must have EN & AR descriptions`);
    }
    for (const requiredId of ['minecraft', 'lego', 'roblox', 'mario', 'retro95', 'arcade']) {
      assert.ok(seenIds.has(requiredId), `Missing expected iconic theme: ${requiredId}`);
    }

    const themesCss = fs.readFileSync(path.join(ROOT, 'css/themes.css'), 'utf8');
    assert.equal(/https?:\/\//i.test(themesCss), false, 'themes.css must not reference external URLs');
    for (const skin of themesCatalog.SKINS) {
      if (skin.id === themesCatalog.DEFAULT_SKIN) continue;
      assert.ok(
        themesCss.includes(`:root[data-skin="${skin.id}"]`),
        `themes.css missing Dark Mode tokens for skin "${skin.id}"`
      );
      assert.ok(
        themesCss.includes(`:root[data-skin="${skin.id}"][data-theme="light"]`),
        `themes.css missing Light Mode tokens for skin "${skin.id}"`
      );
    }

    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(html.includes('href="./css/themes.css"'), 'index.html must link ./css/themes.css');
    assert.ok(html.includes('id="themeGalleryModal"'), 'index.html must include #themeGalleryModal');
    assert.ok(html.includes('data-cmd="open-themes"'), 'View menu must include data-cmd="open-themes"');
    assert.equal(html.includes('id="openThemesBtn"'), false, 'Topbar must not include separate #openThemesBtn icon');

    // Messaging allowlist validation for skin
    const validSync = messaging.validateTabToShellMessage(
      { type: 'aaz-sync-prefs', tabId: 'tab_1', theme: 'light', skin: 'minecraft' },
      'tab_1'
    );
    assert.equal(validSync?.skin, 'minecraft');
    const badSync = messaging.validateTabToShellMessage(
      { type: 'aaz-sync-prefs', tabId: 'tab_1', skin: 'malicious_skin' },
      'tab_1'
    );
    assert.equal(badSync?.skin, undefined);
    const validApply = messaging.validateShellToTabMessage({
      type: 'aaz-apply-prefs',
      skin: 'lego',
      theme: 'dark',
    });
    assert.equal(validApply?.skin, 'lego');

    // Release version sync across root, desktop, Tauri & Cargo manifests
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deskPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8'));
    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
    const cargoToml = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/Cargo.toml'), 'utf8');
    assert.equal(rootPkg.version, deskPkg.version, 'Root package.json and desktop/package.json versions must match');
    assert.equal(tauriConf.version, deskPkg.version, 'tauri.conf.json version must match desktop/package.json');
    assert.ok(
      cargoToml.includes(`version = "${deskPkg.version}"`),
      'Cargo.toml version must match desktop/package.json'
    );
  });

  // 15. Shortcuts v1.7.0: UNBOUND_SENTINEL override, range input allowance & unified defaults
  await runTest('Shortcuts v1.7.0: overridden binding stays unbound, range input allows shortcuts & defaults unified', () => {
    const store = storageMod.createEmptyState();
    const sm = shortcutsMod.createShortcutsManager({
      getStore: () => store,
      persist: () => {},
    });

    assert.equal(sm.getBinding('pip'), 'P');
    assert.equal(sm.getBinding('prevTrack'), 'Shift+P');
    assert.equal(sm.getBinding('nextTrack'), 'N');
    assert.equal(sm.getBinding('cast'), 'C');

    // Overriding 'M' (Mute) onto fullscreen must leave 'mute' unbound (''), NOT default 'M'
    const res = sm.setBinding('fullscreen', 'M', { allowOverride: true });
    assert.equal(res.ok, true);
    assert.equal(sm.getBinding('fullscreen'), 'M');
    assert.equal(sm.getBinding('mute'), '', 'Overridden action must remain unbound');
    assert.equal(sm.matchAction({ key: 'm', code: 'KeyM', target: { tagName: 'BODY' } }), 'fullscreen');

    // Resetting without override detects conflict with fullscreen ('M')
    const resetBlocked = sm.resetBinding('mute');
    assert.equal(resetBlocked.ok, false);
    assert.equal(resetBlocked.reason, 'conflict');
    assert.equal(resetBlocked.conflict.id, 'fullscreen');
    assert.equal(sm.getBinding('mute'), '');

    // Resetting with allowOverride restores default and unbinds conflicting action
    const resetOk = sm.resetBinding('mute', { allowOverride: true });
    assert.equal(resetOk.ok, true);
    assert.equal(sm.getBinding('mute'), 'M');
    assert.equal(sm.getBinding('fullscreen'), '');

    // Range/button/checkbox/radio inputs must NOT block playback shortcuts; text/empty inputs MUST block
    assert.equal(
      sm.matchAction({ key: ' ', code: 'Space', target: { tagName: 'INPUT', type: 'range' } }),
      'playPause'
    );
    assert.equal(
      sm.matchAction({ key: ' ', code: 'Space', target: { tagName: 'INPUT', type: 'checkbox' } }),
      'playPause'
    );
    assert.equal(
      sm.matchAction({ key: ' ', code: 'Space', target: { tagName: 'INPUT', type: 'text' } }),
      null
    );
    assert.equal(
      sm.matchAction({ key: ' ', code: 'Space', target: { tagName: 'INPUT' } }),
      null
    );
  });

  // 16. Messaging v1.7.0: aaz-window-action, aaz-taskbar-action & canPrev/canNext
  await runTest('Messaging v1.7.0: aaz-window-action clamping, aaz-taskbar-action & tab-state canPrev/canNext', () => {
    const tabState = messaging.validateTabToShellMessage(
      {
        type: 'aaz-tab-state',
        tabId: 'tab_1',
        title: 'Clip',
        isPlaying: true,
        hasMedia: true,
        canPrev: true,
        canNext: false,
        kind: 'video',
      },
      'tab_1'
    );
    assert.equal(tabState?.canPrev, true);
    assert.equal(tabState?.canNext, false);

    const miniPreset = messaging.validateTabToShellMessage(
      { type: 'aaz-window-action', tabId: 'tab_1', action: 'mini-preset', width: 9999, height: 10 },
      'tab_1'
    );
    assert.equal(miniPreset?.action, 'mini-preset');
    assert.equal(miniPreset?.width, 960);
    assert.equal(miniPreset?.height, 150);

    const invalidWinAct = messaging.validateTabToShellMessage(
      { type: 'aaz-window-action', tabId: 'tab_1', action: 'exec-cmd' },
      'tab_1'
    );
    assert.equal(invalidWinAct, null);

    const taskbarAct = messaging.validateShellToTabMessage({
      type: 'aaz-taskbar-action',
      action: 'toggle-play',
    });
    assert.deepEqual(taskbarAct, { type: 'aaz-taskbar-action', action: 'toggle-play' });
    assert.equal(
      messaging.validateShellToTabMessage({ type: 'aaz-taskbar-action', action: 'reboot' }),
      null
    );
  });

  // 17. Mini Player Overhaul & Subtitle Hint Consistency
  await runTest('Mini Player & UI v1.7.0: SVG-only Mini Player HUD with seek/presets/controls & synced hints', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const deskPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8'));
    assert.ok(html.includes(`همزة v${deskPkg.version}`), 'Menu version label must match desktop/package.json');
    assert.ok(html.includes('id="miniSeekSlider"'), 'Mini Player must include #miniSeekSlider');
    assert.ok(html.includes('id="miniTimeLabel"'), 'Mini Player must include #miniTimeLabel');
    assert.ok(html.includes('id="miniSizeBtn"'), 'Mini Player must include #miniSizeBtn');
    assert.ok(html.includes('id="miniMinBtn"'), 'Mini Player must include #miniMinBtn');
    assert.ok(html.includes('id="miniCloseBtn"'), 'Mini Player must include #miniCloseBtn');
    assert.ok(html.includes('id="miniVolIcon"') && html.includes('id="miniMuteIcon"'), 'Mini Player must use SVG volume icons');

    const hudStart = html.indexOf('id="miniPlayerHud"');
    const hudEnd = html.indexOf('</aside>', hudStart);
    assert.ok(hudStart > 0 && hudEnd > hudStart, 'Mini Player HUD block must exist');
    const hudHtml = html.slice(hudStart, hudEnd);
    for (const emoji of ['📌', '⤢', '⏮', '⏭', '🔊', '🔇']) {
      assert.equal(hudHtml.includes(emoji), false, `Mini Player HUD must not contain raw emoji ${emoji}`);
    }

    assert.ok(html.includes('(-0.25s)') && html.includes('(+0.25s)'), 'Subtitle menu hints must reflect +-0.25s step');

    const stylesCss = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
    assert.ok(stylesCss.includes('html.is-mini-player.is-mini-audio'), 'CSS must support compact audio Mini Player mode');
    const themesCss = fs.readFileSync(path.join(ROOT, 'css/themes.css'), 'utf8');
    assert.ok(themesCss.includes('prefers-reduced-transparency: reduce'), 'themes.css must support prefers-reduced-transparency');
  });

  // 18. Session Clear, MediaSession & Single-Load Resume Invariants
  await runTest('Player App v1.7.0: clearSessionOnly clears native paths, MediaSession wired & no double-load', () => {
    const appCode = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.ok(appCode.includes('delete current.trackFullPath;'), 'clearSessionOnly must delete trackFullPath');
    assert.ok(appCode.includes('delete current.nativeTrackPaths;'), 'clearSessionOnly must delete nativeTrackPaths');
    assert.ok(appCode.includes('navigator.mediaSession'), 'player-app.js must integrate navigator.mediaSession');
    assert.ok(appCode.includes("msg.type === 'aaz-taskbar-action'"), 'player-app.js must handle aaz-taskbar-action');
    assert.ok(appCode.includes('startTime:'), 'openExternalPathAtTime must pass startTime directly to avoid double-load');
    assert.ok(appCode.includes('invalidateStoreCache'), 'player-app.js must invalidate phase3 store cache on storage sync');

    const settingsCode = fs.readFileSync(path.join(ROOT, 'js/modules/settings-manager.js'), 'utf8');
    assert.ok(settingsCode.includes('WEBGL_lose_context'), 'detectHardwareAcceleration must release WebGL probe context');
    assert.ok(settingsCode.includes('cachedHwInfo'), 'detectHardwareAcceleration must memoize GPU probe');
  });

  // 19. Rust Backend v1.7.0: Taskbar Controls, Updater Replay Protection & Bounded Scanners
  await runTest('Rust Backend v1.7.0: taskbar.rs wired, replay-protected Minisign, work_area & bounded dir scan', () => {
    const taskbarPath = path.join(ROOT, 'desktop/src-tauri/src/taskbar.rs');
    assert.ok(fs.existsSync(taskbarPath), 'desktop/src-tauri/src/taskbar.rs must exist');
    const taskbarRs = fs.readFileSync(taskbarPath, 'utf8');
    assert.ok(taskbarRs.includes('ITaskbarList3'), 'taskbar.rs must implement Windows ITaskbarList3');
    assert.ok(taskbarRs.includes('TaskbarButtonCreated'), 'taskbar.rs must recover after Explorer restart');
    assert.ok(taskbarRs.includes('aaz:taskbar-action'), 'taskbar.rs must emit aaz:taskbar-action');
    assert.ok(taskbarRs.includes('DestroyIcon'), 'taskbar.rs must dispose HICON handles');

    const libRs = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/src/lib.rs'), 'utf8');
    assert.ok(libRs.includes('mod taskbar;'), 'lib.rs must declare mod taskbar');
    assert.ok(libRs.includes('aaz_taskbar_update_state'), 'lib.rs must expose aaz_taskbar_update_state');
    assert.ok(libRs.includes('attach_taskbar_controls'), 'lib.rs must attach taskbar controls on window creation');
    assert.ok(libRs.includes('validate_minisign_trusted_comment'), 'lib.rs must validate Minisign trusted comments against replay');
    assert.ok(libRs.includes('update_downloading'), 'lib.rs must guard concurrent update downloads');
    assert.ok(libRs.includes('sweep_old_update_installers'), 'lib.rs must clean up old staged update installers');
    assert.ok(libRs.includes('work_area()'), 'lib.rs must clamp window geometry to monitor work_area()');
    assert.ok(libRs.includes('MAX_DIR_SCAN_DEPTH'), 'lib.rs must bound recursive directory scan depth');
    assert.ok(libRs.includes('MAX_DIR_SCAN_ENTRIES'), 'lib.rs must bound recursive directory scan entries');
    assert.ok(libRs.includes('MAX_TEXT_FILE_BYTES'), 'lib.rs must bound playlist/subtitle text reads');
  });

  // 20. Release Workflow Fail-Closed Signing & Docs/Changelog Version Parity
  await runTest('Release & Docs v1.7.0: fail-closed release.yml signing, trusted comments & README/CHANGELOG version sync', () => {
    const deskPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8'));
    const releaseYml = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    assert.ok(releaseYml.includes('allow_unsigned_preview'), 'release.yml must gate unsigned builds behind explicit allow_unsigned_preview');
    assert.ok(releaseYml.includes('Release blocked (fail-closed)'), 'release.yml must fail closed when signing keys are missing');
    assert.ok(releaseYml.includes('aaz-player|version=$ver|file=$fileName|sha256=$fileHash'), 'release.yml must pass replay-resistant trusted comments to minisign');

    const ciYml = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.ok(ciYml.includes('npm run lint') && ciYml.includes('npm run build'), 'ci.yml must run TypeScript lint and production build');

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes(`v${deskPkg.version}`), `README.md badge must match v${deskPkg.version}`);

    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.includes(`## [${deskPkg.version}]`), `CHANGELOG.md must contain section ## [${deskPkg.version}]`);
  });

  // 21. F01: Atomic Storage Updates, Deleting Last Playlist & Storage-Full Safety
  await runTest('F01: atomic storage updates preserve concurrent domains, honor last-playlist delete & report quota errors', () => {
    const mem = createMemoryStorage();
    const sm = storageMod.createStorageManager(mem);
    let notifyCount = 0;
    const unsub = sm.subscribe(() => {
      notifyCount += 1;
    });

    // Simulate player saving a playlist + session + bookmark
    const r1 = sm.update({
      trackKey: 'c:/a/movie.mp4',
      currentTime: 45,
      savedPlaylists: [{ id: 'pl_1', name: 'Watchlist', trackCount: 1, trackKeys: ['c:/a/movie.mp4'] }],
      bookmarksByKey: { 'c:/a/movie.mp4': [12, 45] },
    });
    assert.equal(r1.ok, true);

    // Simulate Phase 3 domain update (history) via domain-scoped atomic persist
    let phase3Snap = sm.load();
    const hm = historyMod.createHistoryManager({
      getStore: () => {
        phase3Snap = sm.load();
        return phase3Snap;
      },
      persist: () => sm.update({ watchHistory: phase3Snap.watchHistory }),
      isRecordingEnabled: () => true,
    });
    hm.recordPlay({ title: 'Movie', name: 'movie.mp4', kind: 'video', fullPath: 'C:/A/movie.mp4' }, 45, 300);

    const afterHistory = sm.load();
    assert.equal(afterHistory.savedPlaylists.length, 1, 'History write must not wipe savedPlaylists');
    assert.equal(afterHistory.trackKey, 'c:/a/movie.mp4', 'History write must not wipe session trackKey');
    assert.equal(afterHistory.currentTime, 45, 'History write must not wipe currentTime');
    assert.deepEqual(afterHistory.bookmarksByKey['c:/a/movie.mp4'], [12, 45]);
    assert.equal(afterHistory.watchHistory.length, 1);

    // Delete last playlist, then write settings — deleted playlist must NOT resurrect
    sm.update({ savedPlaylists: [] });
    sm.update((latest) => {
      latest.playbackSettings.defaultPlaybackRate = 1.5;
    });
    const afterDelete = sm.load();
    assert.equal(afterDelete.savedPlaylists.length, 0, 'Deleted last playlist must not resurrect');
    assert.equal(afterDelete.playbackSettings.defaultPlaybackRate, 1.5);
    assert.ok(notifyCount >= 4, 'Storage subscribers should be notified on updates');
    unsub();

    // QuotaExceededError must return ok: false without throwing
    const quotaStorage = {
      getItem: (k) => mem.getItem(k),
      setItem: () => {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      },
      removeItem: (k) => mem.removeItem(k),
    };
    const smQuota = storageMod.createStorageManager(quotaStorage);
    const failedSave = smQuota.update({ volume: 0.3 });
    assert.equal(failedSave.ok, false, 'Storage quota failure must return ok: false');
  });

  // 22. F02: Bookmarks Sanitization, Legacy Object Migration & Backup Rollback
  await runTest('F02: bookmarks preserve number[], migrate {time}[] objects, dedupe/sort & survive backup/rollback', () => {
    const mem = createMemoryStorage();
    const sm = storageMod.createStorageManager(mem);

    const sanitized = storageMod.sanitizeState({
      bookmarksByKey: {
        'c:/a/ep1.mp4': [45, 12, 12.0001, -5, NaN, Infinity, 9999999, 30.5],
        'c:/b/ep2.mp4': [{ time: 80 }, { time: 15.25 }, { time: -2 }, { label: 'bad' }],
      },
    });
    assert.deepEqual(sanitized.bookmarksByKey['c:/a/ep1.mp4'], [12, 30, 45]);
    assert.deepEqual(sanitized.bookmarksByKey['c:/b/ep2.mp4'], [15, 80]);

    sm.update({ bookmarksByKey: { 'c:/a/ep1.mp4': [12, 45] } });
    const backup = sm.exportBackupJson({ lang: 'ar', theme: 'dark' });

    // Overwrite state, then restore backup, then verify rollback recovers pre-restore state
    sm.update({ bookmarksByKey: { 'c:/a/ep1.mp4': [99] } });
    const imported = sm.importBackupJson(backup);
    assert.equal(imported.ok, true);
    assert.deepEqual(sm.load().bookmarksByKey['c:/a/ep1.mp4'], [12, 45]);

    const rolledBack = sm.rollbackLastRestore();
    assert.equal(rolledBack.ok, true);
    assert.deepEqual(sm.load().bookmarksByKey['c:/a/ep1.mp4'], [99]);
  });

  // 23. F03: Canonical Track Identity for Same-Name Files in Different Folders
  await runTest('F03: distinct files with identical basename & size keep independent canonical keys & lookup', () => {
    const k1 = trackIdMod.buildCanonicalTrackKey({ fullPath: 'C:\\FolderA\\movie.mp4', name: 'movie.mp4', size: 1024 });
    const k2 = trackIdMod.buildCanonicalTrackKey({ fullPath: 'C:/FolderB/movie.mp4', name: 'movie.mp4', size: 1024 });
    const k1Upper = trackIdMod.buildCanonicalTrackKey({ fullPath: 'c:/foldera/MOVIE.MP4', name: 'MOVIE.MP4', size: 1024 });
    assert.notEqual(k1, k2, 'Same-name files in different folders must have distinct keys');
    assert.equal(k1, k1Upper, 'Windows path normalization must be case- and slash-insensitive');

    const tracks = [
      { key: k1, name: 'movie.mp4', fullPath: 'C:\\FolderA\\movie.mp4', size: 1024 },
      { key: k2, name: 'movie.mp4', fullPath: 'C:\\FolderB\\movie.mp4', size: 1024 },
    ];
    // Deduplication must NOT collapse distinct fullPaths that share name & size
    const dedup = trackIdMod.deduplicateTracksSafely([
      tracks[0],
      tracks[1],
      { key: k1Upper, name: 'MOVIE.MP4', fullPath: 'c:/foldera/MOVIE.MP4', size: 1024 },
    ]);
    assert.equal(dedup.kept.length, 2);
    assert.equal(dedup.removed.length, 1);

    // Safe lookup must select the exact matching folder, not first basename hit
    assert.equal(trackIdMod.findTrackSafely(tracks, { key: k2 })?.fullPath, 'C:\\FolderB\\movie.mp4');
    // Ambiguous basename-only lookup must refuse to guess when 2 files share the name
    assert.equal(trackIdMod.findTrackSafely(tracks, { name: 'movie.mp4' }), null);
    // Legacy basename fallback must only apply when unambiguous (not when 2 files share name)
    assert.equal(trackIdMod.lookupLegacyKeyFallback(tracks[0], tracks), null);
    assert.equal(trackIdMod.lookupLegacyKeyFallback(tracks[0], [tracks[0]]), 'movie.mp4');
  });

  // 24. F08: Unified Subtitle Style Contract Across Tab <-> Shell
  await runTest('F08: full 14-field subtitle style survives messaging round-trip, sanitizes CSS injection & migrates legacy', () => {
    const fullStyle = {
      fontFamily: 'Cairo, sans-serif',
      fontSize: 34,
      fontWeight: '800',
      italic: true,
      textColor: '#aaffcc',
      outlineColor: '#000000',
      outlineWidth: 3,
      bgColor: '#112233',
      bgOpacity: 75,
      borderColor: '#3dc479',
      borderWidth: 2,
      borderRadius: 12,
      shadowBlur: 8,
      bottomOffset: 16,
    };
    const toShell = messaging.validateTabToShellMessage(
      { type: 'aaz-sync-prefs', tabId: 'tab_1', subtitleStyle: fullStyle },
      'tab_1'
    );
    assert.deepEqual(toShell?.subtitleStyle, fullStyle);

    const toTab = messaging.validateShellToTabMessage({
      type: 'aaz-apply-prefs',
      subtitleStyle: toShell.subtitleStyle,
    });
    assert.deepEqual(toTab?.subtitleStyle, fullStyle);

    // Legacy fields migrate cleanly
    const migrated = subtitleStyleMod.sanitizeSubtitleStyle({
      color: '#ff00aa',
      bold: true,
      bgOpacity: 0.5,
      position: 22,
    });
    assert.equal(migrated.textColor, '#ff00aa');
    assert.equal(migrated.fontWeight, '700');
    assert.equal(migrated.bgOpacity, 50);
    assert.equal(migrated.bottomOffset, 22);

    // Malicious CSS strings are rejected back to safe defaults
    const hardened = subtitleStyleMod.sanitizeSubtitleStyle({
      fontFamily: 'Arial; background: url(javascript:alert(1))',
      textColor: 'expression(alert(1))',
    });
    assert.equal(hardened.fontFamily, subtitleStyleMod.SUBTITLE_STYLE_DEFAULTS.fontFamily);
    assert.equal(hardened.textColor, subtitleStyleMod.SUBTITLE_STYLE_DEFAULTS.textColor);
  });

  // 25. F10 & F11: Playlist Paths (Windows/UNC/Unicode/Relative), Runtime URL Blocking & Strict Saved Filter
  await runTest('F10 & F11: playlist round-trip handles UNC/Unicode/special chars/relative paths, blocks blob: & enforces strict filter', () => {
    const tracks = [
      { title: 'Z Last First', fullPath: 'D:\\مسلسلات\\Show #1 & 100%\\ep 02.mp4', duration: 300 },
      { title: 'A Second', fullPath: '\\\\NAS-SERVER\\Media Share\\Film (2026)\\clip.mkv', duration: 600 },
      { title: 'Transient Blob', url: 'blob:http://tauri.localhost/abc-123', duration: 50 },
      { title: 'Transient Stream', url: 'http://aazmedia.localhost/stream?id=1', duration: 50 },
    ];
    for (const fmt of ['xspf', 'm3u8', 'pls']) {
      const exported = playlistIo.buildPlaylistExport(tracks, fmt, 'Unicode Mix');
      assert.equal(exported.skippedCount, 2, `${fmt} must skip blob: and aazmedia.localhost entries`);
      const parsed = playlistIo.parsePlaylistText(
        exported.content,
        `mix.${exported.ext}`,
        `D:/Playlists/mix.${exported.ext}`
      );
      assert.equal(parsed.length, 2, `${fmt} must preserve only durable entries`);
      assert.equal(
        parsed[0].location.replace(/\\/g, '/'),
        'D:/مسلسلات/Show #1 & 100%/ep 02.mp4',
        `${fmt} must preserve order and special chars`
      );
      assert.equal(parsed[1].location, '\\\\NAS-SERVER\\Media Share\\Film (2026)\\clip.mkv', `${fmt} must preserve UNC path`);
    }

    // Relative path resolution against playlist file path
    const relParsed = playlistIo.parsePlaylistText(
      '#EXTM3U\n../Videos/ep1.mp4\n',
      'list.m3u8',
      'D:/Media/Playlists/list.m3u8'
    );
    assert.equal(relParsed[0].location.replace(/\\/g, '/'), 'D:/Media/Videos/ep1.mp4');

    // F11: strict filter with 0 matches must return [] (never fall back to full track list)
    const filtered = playlistIo.filterTracksBySavedPlaylist(
      [
        { key: 'd:/a.mp4', name: 'a.mp4' },
        { key: 'd:/b.mp4', name: 'b.mp4' },
      ],
      ['d:/missing.mp4'],
      true
    );
    assert.deepEqual(filtered, [], 'Strict saved playlist filter must return [] when 0 tracks match');
  });

  // 26. F12 & F13: Subtitle Auto-Match Episode/Lang Guard & Carry-Safe WebVTT Timestamps
  await runTest('F12 & F13: subtitle matcher guards episodes & honors lang; VTT shift handles carry boundaries & clamps', () => {
    const track = {
      key: 'd:/shows/show.s01e01.mp4',
      name: 'Show.S01E01.mp4',
      fullPath: 'D:/Shows/Show.S01E01.mp4',
    };
    const subMap = new Map([
      ['d:/shows/show.s01e02.ar', { name: 'Show.S01E02.ar.srt', key: 's01e02_ar', fullPath: 'D:/Shows/Show.S01E02.ar.srt' }],
      ['d:/shows/show.s01e01.en', { name: 'Show.S01E01.en.srt', key: 's01e01_en', fullPath: 'D:/Shows/Show.S01E01.en.srt' }],
      ['d:/shows/show.s01e01.ar', { name: 'Show.S01E01.ar.srt', key: 's01e01_ar', fullPath: 'D:/Shows/Show.S01E01.ar.srt' }],
    ]);
    // With defaultSubtitleLang='en', must pick English S01E01
    const enPick = subMatcherMod.selectBestSubtitleCandidate(track, subMap, {
      preferredLang: 'en',
      uiLang: 'ar',
    });
    assert.equal(enPick?.key, 's01e01_en');

    // With defaultSubtitleLang='auto' and uiLang='ar', must pick Arabic S01E01
    const arPick = subMatcherMod.selectBestSubtitleCandidate(track, subMap, {
      preferredLang: 'auto',
      uiLang: 'ar',
    });
    assert.equal(arPick?.key, 's01e01_ar');

    // Episode mismatch must NEVER match S01E02 to S01E01 even if it is the only candidate
    const wrongEpMap = new Map([
      ['d:/shows/show.s01e02.ar', { name: 'Show.S01E02.ar.srt', key: 's01e02_ar', fullPath: 'D:/Shows/Show.S01E02.ar.srt' }],
    ]);
    const wrongEp = subMatcherMod.selectBestSubtitleCandidate(track, wrongEpMap, {
      preferredLang: 'ar',
      uiLang: 'ar',
    });
    assert.equal(wrongEp, null, 'Must never match subtitle from a different episode');

    // F13: Carry-safe VTT timestamps (no :60.000 or .1000)
    assert.equal(timeUtils.formatVttTimestamp(0), '00:00:00.000');
    assert.equal(timeUtils.formatVttTimestamp(0.9998), '00:00:01.000');
    assert.equal(timeUtils.formatVttTimestamp(59.9998), '00:01:00.000');
    assert.equal(timeUtils.formatVttTimestamp(3599.9998), '01:00:00.000');

    // Negative shift clamps start >= 0 and enforces end >= start + 0.05
    const shifted = timeUtils.shiftWebVtt('WEBVTT\n\n00:00:01.000 --> 00:00:01.200\nLine 1\n', -5);
    assert.ok(shifted.includes('00:00:00.000 --> 00:00:00.050'), `Unexpected shifted VTT: ${shifted}`);
  });

  // 27. F14: Reserved Combos, Canonical Modifiers, Arabic Layout & Stored Conflict Normalization
  await runTest('F14: shortcuts block reserved combos, canonicalize modifiers, support Arabic layout & heal stored conflicts', () => {
    const store = storageMod.createEmptyState();
    store.customShortcuts = { playPause: 'X', mute: 'X' };
    const sm = shortcutsMod.createShortcutsManager({
      getStore: () => store,
      persist: () => {},
    });

    // Reserved combos must be rejected
    const resW = sm.setBinding('mute', 'Ctrl+W');
    assert.equal(resW.ok, false);
    assert.equal(resW.reason, 'reserved');
    assert.equal(sm.setBinding('mute', 'Ctrl+T').reason, 'reserved');

    // Canonical modifier ordering
    assert.equal(shortcutsMod.normalizeKeyCombo('Shift+Ctrl+p'), 'Ctrl+Shift+P');
    // Stored conflicts must be healed cleanly so two actions never share the same combo
    const healed = sm.normalizeStoredConflicts();
    assert.equal(healed, true);
    assert.notEqual(sm.getBinding('playPause'), sm.getBinding('mute'));

    // Arabic keyboard layout KeyM maps via physical code to default Mute ('M')
    sm.resetAll();
    assert.equal(
      sm.matchAction({ key: 'ة', code: 'KeyM', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: { tagName: 'BODY' } }),
      'mute',
      'Arabic keyboard layout KeyM must trigger mute'
    );
  });

  // 28. Android Phase 1: Architecture Record, Rust/Tauri Portability, CI Job & Gitignore Invariants
  await runTest('Android Phase 1 (R2, R4-R8, R28): arch record, Cargo cfg gating, minSdk 24, media_core.rs & Android CI job', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/android-architecture.md')), 'docs/android-architecture.md must exist');
    assert.ok(fs.existsSync(path.join(ROOT, 'desktop/src-tauri/src/media_core.rs')), 'media_core.rs must exist');

    const cargoToml = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/Cargo.toml'), 'utf8');
    assert.ok(
      cargoToml.includes('[target.\'cfg(not(target_os = "android"))\'.dependencies]'),
      'Cargo.toml must gate desktop-only crates behind cfg(not(target_os = "android"))'
    );
    const androidGateIdx = cargoToml.indexOf('[target.\'cfg(not(target_os = "android"))\'.dependencies]');
    assert.ok(cargoToml.indexOf('rfd =') > androidGateIdx, 'rfd must be gated out on Android');
    assert.ok(
      cargoToml.indexOf('tauri-plugin-single-instance =') > androidGateIdx,
      'tauri-plugin-single-instance must be gated out on Android'
    );

    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(tauriConf.identifier, 'com.aaz.player');
    assert.equal(tauriConf.bundle?.android?.minSdkVersion, 24);

    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('keystore.properties'), '.gitignore must exclude keystore.properties');
    assert.ok(gitignore.includes('local.properties'), '.gitignore must exclude local.properties');

    const ciYml = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.ok(ciYml.includes('android-debug-build:'), 'ci.yml must include android-debug-build job');
    assert.ok(
      ciYml.includes('tauri android build --apk --target aarch64'),
      'ci.yml must build lightweight stripped Android ARM64 release APK'
    );
    assert.ok(ciYml.includes('node scripts/configure-android.cjs'), 'ci.yml must run configure-android.cjs');
    assert.ok(ciYml.includes('apksigner" sign'), 'ci.yml must sign preview APK with apksigner');

    const libRs = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/src/lib.rs'), 'utf8');
    assert.ok(libRs.includes('mod media_core;'), 'lib.rs must wire platform-neutral media_core');
    assert.ok(libRs.includes('aaz_get_platform_info'), 'lib.rs must expose aaz_get_platform_info');
  });

  // 29. Android Phase 1 (R10): MediaRef & Collision-Free SAF/MediaStore Track Identity
  await runTest('Android Phase 1 (R10): MediaRef & track-identity preserve contentUri/mediaStoreUri without path mangling', () => {
    const uriA = 'content://com.android.externalstorage.documents/document/primary%3AFolderA%2Fmovie.mp4';
    const uriB = 'content://com.android.externalstorage.documents/document/primary%3AFolderB%2Fmovie.mp4';
    const msUri = 'content://media/external/video/media/42';

    const refA = mediaRefMod.createMediaRef({ value: uriA, displayName: 'movie.mp4', size: 2048 });
    const refB = mediaRefMod.createMediaRef({ value: uriB, displayName: 'movie.mp4', size: 2048 });
    const refMs = mediaRefMod.createMediaRef({ value: msUri, displayName: 'clip.mp4' });

    assert.equal(refA.kind, 'contentUri');
    assert.equal(refMs.kind, 'mediaStoreUri');

    const keyA = trackIdMod.buildCanonicalTrackKey({ mediaRef: refA });
    const keyB = trackIdMod.buildCanonicalTrackKey({ mediaRef: refB });
    const keyMs = trackIdMod.buildCanonicalTrackKey({ mediaRef: refMs });

    assert.equal(keyA, `uri:${uriA}`);
    assert.notEqual(keyA, keyB, 'Distinct SAF content URIs with identical filename must have distinct keys');
    assert.equal(keyMs, `ms:${msUri}`);

    const tracks = [
      { key: keyA, name: 'movie.mp4', mediaRef: refA, fullPath: uriA },
      { key: keyB, name: 'movie.mp4', mediaRef: refB, fullPath: uriB },
    ];
    assert.equal(trackIdMod.findTrackSafely(tracks, { mediaRef: refB })?.key, keyB);
    assert.equal(trackIdMod.deduplicateTracksSafely(tracks).kept.length, 2);
  });

  // 30. Android Phase 1 (R6, R17): Desktop Bridge Platform Detection & Capability Gating
  await runTest('Android Phase 1 (R6, R17): desktop-bridge detects Android UA and gates desktop-only capabilities', () => {
    const androidWin = {
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' },
      __TAURI__: {
        core: { invoke: async () => ({}) },
        event: { listen: async () => () => {} },
      },
    };
    const bridge = desktopBridgeMod.attachDesktopBridge(androidWin);
    assert.equal(bridge.isAndroid, true);
    assert.equal(bridge.isDesktop, false);
    assert.equal(bridge.capabilities.windowing, false);
    assert.equal(bridge.capabilities.taskbar, false);
    assert.equal(bridge.capabilities.setSinkId, false);
    assert.equal(bridge.capabilities.directoryPicker, false);
    assert.equal(bridge.capabilities.safPicker, true);
    assert.equal(bridge.capabilities.touchGestures, true);
    assert.equal(bridge.capabilities.nativeMedia3, true);
    assert.equal(typeof bridge.playerLoad, 'function');

    const winCaps = desktopBridgeMod.buildPlatformCapabilities(false);
    assert.equal(winCaps.windowing, true);
    assert.equal(winCaps.setSinkId, true);
  });

  // 31. Android Phase 1 (R20-R22): Mobile Gestures, Touch-Slop, Screen Lock & Back Stack
  await runTest('Android Phase 1 (R20-R22): touch-slop, double-tap seek, edge brightness/volume, lock & back stack', () => {
    assert.equal(mobileGesturesMod.decideGestureAxis(5, 6), 'none');
    assert.equal(mobileGesturesMod.decideGestureAxis(4, 30), 'vertical');
    assert.equal(mobileGesturesMod.decideGestureAxis(32, 5), 'horizontal');

    const events = [];
    const ctrl = mobileGesturesMod.createMobileGestureController({
      onSeekDelta: (d) => events.push(['seek', d]),
      onTogglePlay: () => events.push(['play']),
      onBrightnessChange: (b) => events.push(['brightness', b]),
      onVolumeChange: (v, sys) => events.push(['volume', v, sys]),
      onCloseTopModal: () => events.push(['close-modal']),
      onExitFullscreenOrPip: () => events.push(['exit-fs']),
      onNavigateBack: () => events.push(['nav-back']),
      onConfirmExit: () => events.push(['confirm-exit']),
    });

    // Double-tap left (-10s), right (+10s), center (play/pause)
    assert.equal(ctrl.handleTap(0.15, 100).action, 'single-tap');
    assert.equal(ctrl.handleTap(0.15, 250).deltaSeconds, -10);
    ctrl.handleTap(0.85, 500);
    assert.equal(ctrl.handleTap(0.85, 620).deltaSeconds, 10);
    ctrl.handleTap(0.5, 900);
    assert.equal(ctrl.handleTap(0.5, 1050).action, 'toggle-play');

    // Edge vertical swipes: left = brightness, right = player volume / system stream
    const bRes = ctrl.handleVerticalSwipe({ relativeXRatio: 0.1, deltaY: -60, stageHeight: 400 });
    assert.equal(bRes.action, 'brightness');
    assert.ok(bRes.value > 0.7);
    ctrl.setVolumeMode('system');
    const vRes = ctrl.handleVerticalSwipe({ relativeXRatio: 0.9, deltaY: 60, stageHeight: 400, currentVolume: 0.8 });
    assert.equal(vRes.action, 'volume');
    assert.equal(vRes.mode, 'system');
    assert.ok(vRes.value < 0.8);

    // Screen lock blocks taps & swipes until unlocked
    ctrl.toggleLock();
    assert.equal(ctrl.isLocked(), true);
    assert.equal(ctrl.handleTap(0.5, 1500).action, 'blocked-locked');
    assert.equal(ctrl.handleVerticalSwipe({ relativeXRatio: 0.1, deltaY: -40 }).action, 'blocked-locked');
    ctrl.toggleLock();
    assert.equal(ctrl.isLocked(), false);

    // Back-button priority stack (R22)
    assert.equal(ctrl.handleBackAction({ hasOpenModal: true, isFullscreen: true, isPlaying: true }), 'closed-modal');
    assert.equal(ctrl.handleBackAction({ isFullscreen: true, isPlaying: true }), 'exited-fullscreen');
    assert.equal(ctrl.handleBackAction({ hasInternalBackView: true, isPlaying: true }), 'navigated-back');
    assert.equal(ctrl.handleBackAction({ isPlaying: true }), 'confirm-exit');
    assert.equal(ctrl.handleBackAction({ isPlaying: false }), 'allow-exit');
  });

  // 32. Android Phase 2: Native Kotlin Core, Adaptive Icon, Mobile Shell & MediaStore Bridge
  await runTest('Android Phase 2: Kotlin SAF/MediaStore/Range core, vector adaptive icon, mobile DOM & bridge routing', async () => {
    const nativeDir = path.join(ROOT, 'desktop/android-native');
    for (const file of ['AazContentServer.kt', 'AazMediaHelper.kt', 'MainActivity.kt']) {
      assert.ok(fs.existsSync(path.join(nativeDir, file)), `Missing desktop/android-native/${file}`);
    }
    const serverKt = fs.readFileSync(path.join(nativeDir, 'AazContentServer.kt'), 'utf8');
    assert.ok(serverKt.includes('127.0.0.1'), 'AazContentServer must bind strictly to loopback 127.0.0.1');
    assert.ok(serverKt.includes('206 Partial Content'), 'AazContentServer must support HTTP Range 206 streaming');

    const configScript = fs.readFileSync(path.join(ROOT, 'desktop/scripts/configure-android.cjs'), 'utf8');
    assert.ok(configScript.includes('ic_launcher_foreground.xml'), 'configure-android.cjs must install vector adaptive icon foreground');
    assert.ok(configScript.includes('isMinifyEnabled = true'), 'configure-android.cjs must enable R8 minification for lightweight APK');
    assert.ok(!configScript.includes('MANAGE_EXTERNAL_STORAGE'), 'configure-android.cjs must never request MANAGE_EXTERNAL_STORAGE (D7)');

    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
    const csp = tauriConf.app?.security?.csp || '';
    assert.ok(csp.includes('http://127.0.0.1:*'), 'CSP must permit loopback Android content server media streaming');

    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="mobileBottomNav"'), 'index.html must include #mobileBottomNav');
    assert.ok(indexHtml.includes('id="mobileMiniNowBar"'), 'index.html must include #mobileMiniNowBar');
    assert.ok(indexHtml.includes('id="libScanDeviceBtn"'), 'index.html must include #libScanDeviceBtn');

    // Verify Android native bridge callback routing without Tauri desktop invoke
    const calls = [];
    const fakeAndroidWin = {
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' },
      AAZAndroid: {
        isAvailable: () => true,
        scanDeviceMedia(cbId) {
          calls.push('scanDeviceMedia');
          fakeAndroidWin.__aazResolveAndroidCallback(cbId, {
            permissionDenied: false,
            folders: [{ folderPath: 'mediastore://Music', folderName: 'Music', entries: [] }],
          });
        },
        saveTextFile(cbId, fileName) {
          calls.push(`saveTextFile:${fileName}`);
          fakeAndroidWin.__aazResolveAndroidCallback(cbId, { saved: true });
        },
        enterPictureInPicture() {
          calls.push('enterPictureInPicture');
          return true;
        },
      },
      __TAURI__: {
        core: { invoke: async () => ({}) },
        event: { listen: async () => () => {} },
      },
    };
    const bridge = desktopBridgeMod.attachDesktopBridge(fakeAndroidWin);
    assert.equal(bridge.isAndroid, true);
    assert.equal(bridge.capabilities.mediaStoreScan, true);
    const scanRes = await bridge.scanDeviceMedia();
    assert.equal(scanRes.folders.length, 1);
    const saveRes = await bridge.saveTextFile('test.m3u8', '#EXTM3U', 'audio/x-mpegurl');
    assert.equal(saveRes.saved, true);
    assert.equal(await bridge.enterPictureInPicture(), true);
    assert.deepEqual(calls, ['scanDeviceMedia', 'saveTextFile:test.m3u8', 'enterPictureInPicture']);
  });

  // 33. Phase 3: Foreground Service, VLC Sensor Rotation + Lock, Hold-to-2x Boost, & 100x Speed Shortcuts
  await runTest('Phase 3: Foreground playback service, VLC sensor orientation lock, Hold-to-2x boost & 100x speed shortcuts', async () => {
    const nativeDir = path.join(ROOT, 'desktop/android-native');
    const svcPath = path.join(nativeDir, 'AazPlaybackService.kt');
    assert.ok(fs.existsSync(svcPath), 'Missing desktop/android-native/AazPlaybackService.kt');
    const svcKt = fs.readFileSync(svcPath, 'utf8');
    assert.ok(svcKt.includes('FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK'), 'AazPlaybackService must declare mediaPlayback FGS type');
    assert.ok(svcKt.includes('Notification.MediaStyle'), 'AazPlaybackService must build MediaStyle notification');
    assert.ok(svcKt.includes('ACTION_AUDIO_BECOMING_NOISY'), 'AazPlaybackService must pause on headphone disconnect');
    assert.ok(svcKt.includes('PARTIAL_WAKE_LOCK'), 'AazPlaybackService must hold partial WakeLock while playing');

    const mainKt = fs.readFileSync(path.join(nativeDir, 'MainActivity.kt'), 'utf8');
    assert.ok(mainKt.includes('OrientationEventListener'), 'MainActivity must force sensor rotation via OrientationEventListener');
    assert.ok(mainKt.includes('fun toggleOrientationLock()'), 'MainActivity must expose toggleOrientationLock()');
    assert.ok(mainKt.includes('fun rotateScreenNow()'), 'MainActivity must expose rotateScreenNow()');
    assert.ok(mainKt.includes('fun setVideoMode('), 'MainActivity must expose setVideoMode()');
    assert.ok(mainKt.includes('override fun onUserLeaveHint()'), 'MainActivity must support auto-PiP on user leave');

    const cfgScript = fs.readFileSync(path.join(ROOT, 'desktop/scripts/configure-android.cjs'), 'utf8');
    assert.ok(cfgScript.includes('AazPlaybackService.kt'), 'configure-android.cjs must copy AazPlaybackService.kt');
    assert.ok(cfgScript.includes('FOREGROUND_SERVICE_MEDIA_PLAYBACK'), 'configure-android.cjs must add FOREGROUND_SERVICE_MEDIA_PLAYBACK');
    assert.ok(cfgScript.includes('android:name=".AazPlaybackService"'), 'configure-android.cjs must register AazPlaybackService in manifest');

    // Verify keyboard speed shortcuts (Arabic/English physical codes + Shift+= '+' normalization)
    const shortcutsMod = await import('../js/modules/shortcuts-manager.js');
    assert.equal(shortcutsMod.normalizeKeyCombo({ key: 'د', code: 'BracketRight' }), ']', 'Arabic د (BracketRight) must normalize to ]');
    assert.equal(shortcutsMod.normalizeKeyCombo({ key: 'ج', code: 'BracketLeft' }), '[', 'Arabic ج (BracketLeft) must normalize to [');
    assert.equal(shortcutsMod.normalizeKeyCombo({ key: '+', code: 'Equal', shiftKey: true }), '=', 'Shift+= (+) must normalize to =');
    assert.equal(shortcutsMod.normalizeKeyCombo({ key: '+', code: 'NumpadAdd' }), '=', 'NumpadAdd must normalize to =');
    assert.equal(shortcutsMod.normalizeKeyCombo({ key: '-', code: 'Minus' }), '-', 'Minus must normalize to -');

    const mgr = shortcutsMod.createShortcutsManager({ getStore: () => ({}), persist: () => true });
    assert.equal(mgr.matchAction({ key: 'د', code: 'BracketRight', target: {} }), 'speedFineUp');
    assert.equal(mgr.matchAction({ key: 'ج', code: 'BracketLeft', target: {} }), 'speedFineDown');
    assert.equal(mgr.matchAction({ key: '+', code: 'Equal', shiftKey: true, target: {} }), 'speedCoarseUp');
    assert.equal(mgr.matchAction({ key: '-', code: 'Minus', target: {} }), 'speedCoarseDown');

    // Verify player-app, index.html, and CSS wiring
    const appJs = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.ok(appJs.includes('MAX_KEYBOARD_PLAYBACK_RATE = 100'), 'player-app.js must allow keyboard speed up to 100x');
    assert.ok(appJs.includes('function tickTurboSpeedLoop'), 'player-app.js must include turbo loop for rates > 16x');
    assert.ok(appJs.includes("startSpeedBoost('mouse')"), 'player-app.js must support desktop mouse hold-to-2x');
    assert.ok(appJs.includes("startSpeedBoost('space')"), 'player-app.js must support desktop Spacebar hold-to-2x');
    assert.ok(appJs.includes("startSpeedBoost('touch')"), 'player-app.js must support Android touch hold-to-2x');
    assert.ok(appJs.includes('toggleOrientationLock'), 'player-app.js must wire Android orientation lock button');

    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="speedBoostBadge"'), 'index.html must include #speedBoostBadge');
    assert.ok(indexHtml.includes('id="rotateVideoBtn"'), 'index.html must include #rotateVideoBtn');
    assert.ok(indexHtml.includes('id="orientLockBtn"'), 'index.html must include #orientLockBtn');
    assert.ok(indexHtml.includes('id="fsOrientLockBtn"'), 'index.html must include #fsOrientLockBtn');
    assert.ok(indexHtml.includes('id="mobileStageCta"'), 'index.html must include #mobileStageCta');

    // Verify desktop-bridge exposes Phase 3 orientation & PiP methods
    const bridgeCalls = [];
    let orientCb = null;
    const fakeWin3 = {
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' },
      AAZAndroid: {
        isAvailable: () => true,
        setVideoMode(active) { bridgeCalls.push(`videoMode:${active}`); },
        toggleOrientationLock() { bridgeCalls.push('toggleLock'); return true; },
        rotateScreenNow() { bridgeCalls.push('rotateNow'); return true; },
      },
      __TAURI__: { core: { invoke: async () => ({}) }, event: { listen: async () => () => {} } },
    };
    const b3 = desktopBridgeMod.attachDesktopBridge(fakeWin3);
    assert.equal(b3.capabilities.foregroundPlayback, true);
    assert.equal(b3.capabilities.sensorRotation, true);
    await b3.onOrientationChange((p) => { orientCb = p; });
    fakeWin3.__aazOnAndroidEvent('orientation-change', { locked: true, landscape: true });
    assert.deepEqual(orientCb, { locked: true, landscape: true });
    await b3.setVideoMode(true);
    assert.equal(await b3.toggleOrientationLock(), true);
    assert.equal(await b3.rotateScreenNow(), true);
    assert.deepEqual(bridgeCalls, ['videoMode:true', 'toggleLock', 'rotateNow']);
  });

  // 34. Phase 4: All 16 Themes System Bar Sync, LAN/DLNA Cast, Direct Signed APK Updater, & Release CI
  await runTest('Phase 4: 16-theme system bar sync, Android LAN/DLNA Cast, fail-closed APK self-updater & release CI', async () => {
    const nativeDir = path.join(ROOT, 'desktop/android-native');
    const castKtPath = path.join(nativeDir, 'AazCastHelper.kt');
    const updaterKtPath = path.join(nativeDir, 'AazUpdater.kt');
    assert.ok(fs.existsSync(castKtPath), 'Missing desktop/android-native/AazCastHelper.kt');
    assert.ok(fs.existsSync(updaterKtPath), 'Missing desktop/android-native/AazUpdater.kt');

    const castKt = fs.readFileSync(castKtPath, 'utf8');
    assert.ok(castKt.includes('createMulticastLock'), 'AazCastHelper must acquire WifiManager.MulticastLock');
    assert.ok(castKt.includes('multicastLock.release()'), 'AazCastHelper must release MulticastLock in finally');
    assert.ok(castKt.includes('isPrivateLanIp'), 'AazCastHelper must enforce RFC1918/link-local SSRF guard');
    assert.ok(castKt.includes('206 Partial Content'), 'AazCastHelper must stream LAN media with HTTP Range 206');
    assert.ok(castKt.includes('/receiver'), 'AazCastHelper must host Wi-Fi HTML5 /receiver page');
    assert.ok(castKt.includes('SetAVTransportURI'), 'AazCastHelper must send UPnP AVTransport SetAVTransportURI SOAP');

    const updaterKt = fs.readFileSync(updaterKtPath, 'utf8');
    assert.ok(updaterKt.includes('HttpsURLConnection'), 'AazUpdater must enforce HTTPS-only connections');
    assert.ok(updaterKt.includes('api.github.com'), 'AazUpdater must target GitHub Releases API allowlist');
    assert.ok(updaterKt.includes('SHA-256'), 'AazUpdater must verify APK SHA-256 checksum fail-closed');
    assert.ok(updaterKt.includes('FileProvider.getUriForFile'), 'AazUpdater must install APK via FileProvider');
    assert.ok(updaterKt.includes('canRequestPackageInstalls'), 'AazUpdater must handle API 26+ unknown-apps permission gate');

    const mainKt = fs.readFileSync(path.join(nativeDir, 'MainActivity.kt'), 'utf8');
    assert.ok(mainKt.includes('fun setSystemBarStyle('), 'MainActivity must expose setSystemBarStyle() for all 16 themes');
    assert.ok(mainKt.includes('fun castDiscoverDevices('), 'MainActivity must expose castDiscoverDevices()');
    assert.ok(mainKt.includes('fun castStartServer('), 'MainActivity must expose castStartServer()');
    assert.ok(mainKt.includes('fun checkForUpdates('), 'MainActivity must expose checkForUpdates()');
    assert.ok(mainKt.includes('fun downloadUpdate('), 'MainActivity must expose downloadUpdate()');
    assert.ok(mainKt.includes('fun installUpdate('), 'MainActivity must expose installUpdate()');

    const cfgScript = fs.readFileSync(path.join(ROOT, 'desktop/scripts/configure-android.cjs'), 'utf8');
    assert.ok(cfgScript.includes('AazCastHelper.kt'), 'configure-android.cjs must copy AazCastHelper.kt');
    assert.ok(cfgScript.includes('AazUpdater.kt'), 'configure-android.cjs must copy AazUpdater.kt');
    assert.ok(cfgScript.includes('file_paths.xml'), 'configure-android.cjs must write FileProvider file_paths.xml');
    assert.ok(cfgScript.includes('androidx.core.content.FileProvider'), 'configure-android.cjs must register FileProvider');
    assert.ok(cfgScript.includes('aaz_config.xml'), 'configure-android.cjs must write aaz_github_repo config');
    assert.ok(cfgScript.includes('CHANGE_WIFI_MULTICAST_STATE'), 'configure-android.cjs must declare CHANGE_WIFI_MULTICAST_STATE');
    assert.ok(cfgScript.includes('REQUEST_INSTALL_PACKAGES'), 'configure-android.cjs must declare REQUEST_INSTALL_PACKAGES');
    assert.ok(!cfgScript.includes('MANAGE_EXTERNAL_STORAGE'), 'configure-android.cjs must NEVER request MANAGE_EXTERNAL_STORAGE (R47)');

    const stylesCss = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
    assert.ok(!stylesCss.includes('html.is-android #videoCastBtn'), 'Cast button must be re-enabled on Android in Phase 4');
    assert.ok(stylesCss.includes('html.is-android .modal-card::before'), 'Mobile modals must include native bottom-sheet drag handle');

    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="openThemesQuickBtn"'), 'index.html must include mobile Theme Studio quick button');
    assert.ok(indexHtml.includes('id="setCheckUpdatesBtn"'), 'index.html must include Settings Check-for-Updates button');
    assert.ok(indexHtml.includes('id="castWindowsBtn" data-desktop-only="true"'), 'Windows Miracast button must be hidden on Android');

    const appJs = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.ok(appJs.includes('function syncAndroidSystemBars()'), 'player-app.js must sync Android status/nav bars on theme/skin change');

    const releaseYml = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    assert.ok(releaseYml.includes('build-android:'), 'release.yml must include build-android release job');
    assert.ok(releaseYml.includes('ANDROID_KEYSTORE_BASE64'), 'release.yml must support signed release keystore');
    assert.ok(releaseYml.includes('Hamza-Android-arm64-'), 'release.yml must publish named ARM64 APK & .sha256');

    // Verify desktop-bridge Phase 4 Android routing (system bars, cast, updater + error propagation)
    const p4Calls = [];
    let updateEvt = null;
    const fakeWin4 = {
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' },
      AAZAndroid: {
        isAvailable: () => true,
        getAppVersion: () => '1.7.0',
        setSystemBarStyle(hex, isLight) { p4Calls.push(`bars:${hex}:${isLight}`); },
        castDiscoverDevices(cbId) {
          p4Calls.push('discover');
          fakeWin4.__aazResolveAndroidCallback(cbId, [{ id: 'tv1', name: 'Living Room TV', controlUrl: 'http://192.168.1.50:8080/ctrl' }]);
        },
        castStartServer(cbId, mediaPath) {
          p4Calls.push(`start:${mediaPath}`);
          fakeWin4.__aazResolveAndroidCallback(cbId, {
            mediaUrl: 'http://192.168.1.10:45000/media?token=abc',
            receiverUrl: 'http://192.168.1.10:45000/receiver?token=abc',
          });
        },
        castStopServer() { p4Calls.push('stop'); },
        castToDlna(cbId) {
          p4Calls.push('dlna');
          fakeWin4.__aazResolveAndroidCallback(cbId, { ok: true });
        },
        castDlnaControl(cbId, _url, action) {
          p4Calls.push(`ctrl:${action}`);
          fakeWin4.__aazResolveAndroidCallback(cbId, { ok: true });
        },
        checkForUpdates(cbId) {
          p4Calls.push('checkUpdates');
          fakeWin4.__aazResolveAndroidCallback(cbId, { status: 'available', version: '1.8.0' });
        },
        downloadUpdate(cbId) {
          p4Calls.push('downloadUpdate');
          fakeWin4.__aazResolveAndroidCallback(cbId, { __aazError: 'SHA-256 mismatch' });
        },
      },
      __TAURI__: { core: { invoke: async () => ({}) }, event: { listen: async () => () => {} } },
    };
    const b4 = desktopBridgeMod.attachDesktopBridge(fakeWin4);
    assert.equal(b4.capabilities.lanCast, true);
    assert.equal(b4.capabilities.directApkUpdater, true);
    assert.equal(b4.capabilities.dynamicSystemBars, true);
    assert.equal(b4.capabilities.allThemes16, true);
    assert.equal(await b4.getAppVersion(), '1.7.0');
    await b4.setSystemBarStyle('#f2f7f3', true);
    const devs = await b4.castDiscoverDevices();
    assert.equal(devs.length, 1);
    const srv = await b4.castStartServer('content://media/1', 'Movie', '');
    assert.ok(srv.receiverUrl.includes('/receiver?token='));
    await b4.castToDlna(devs[0].controlUrl, srv.mediaUrl, 'Movie', 'video/mp4');
    await b4.castDlnaControl(devs[0].controlUrl, 'pause');
    await b4.castStopServer();
    await b4.onUpdateStatus((p) => { updateEvt = p; });
    fakeWin4.__aazOnAndroidEvent('update-status', { status: 'downloading', percent: 55 });
    assert.deepEqual(updateEvt, { status: 'downloading', percent: 55 });
    const chk = await b4.checkForUpdates();
    assert.equal(chk.version, '1.8.0');
    await assert.rejects(() => b4.downloadUpdate(), /SHA-256 mismatch/);
    assert.deepEqual(p4Calls, [
      'bars:#f2f7f3:true',
      'discover',
      'start:content://media/1',
      'dlna',
      'ctrl:pause',
      'stop',
      'checkUpdates',
      'downloadUpdate',
    ]);
  });

  // 35. Hold-to-Speed pins at exactly 2.0x (behavioral, all triggers + cancellation rules)
  await runTest('Hold-to-2x: exact 2.0x pin from any base, per-source restore & all cancellation rules', async () => {
    const { createSpeedBoostController, SPEED_BOOST_PIN_RATE } = await import('../js/modules/speed-boost.js');
    assert.equal(SPEED_BOOST_PIN_RATE, 2, 'pin rate must be exactly 2.0x');

    const makeRig = (initialBase) => {
      let base = initialBase;
      const applied = [];
      const events = [];
      const ctrl = createSpeedBoostController({
        getBaseRate: () => base,
        applyRate: (r) => applied.push(r),
        onChange: (snap) => events.push(snap),
      });
      return { ctrl, applied, events, setBase: (v) => { base = v; }, getBase: () => base };
    };

    // Pin from every base: 1.0, 1.5, 2.0, 3.0 and 100x turbo all go to EXACTLY 2.0x
    for (const baseRate of [1, 1.5, 2, 3, 100]) {
      for (const source of ['touch', 'mouse', 'space']) {
        const rig = makeRig(baseRate);
        assert.equal(rig.ctrl.start(source), true, `start must succeed from base ${baseRate}`);
        assert.equal(rig.ctrl.state.boostedRate, 2, `boosted must be exactly 2.0x from base ${baseRate}`);
        assert.deepEqual(rig.applied, [2], `must apply exactly 2.0x from base ${baseRate} via ${source}`);
        assert.equal(rig.ctrl.stop(source), true);
        assert.deepEqual(rig.applied, [2, baseRate], `release must restore exact base ${baseRate}`);
        assert.equal(rig.ctrl.state.active, false);
      }
    }

    // Same-source re-press is a no-op; cross-source cannot corrupt the stored base rate
    {
      const rig = makeRig(1.5);
      rig.ctrl.start('touch');
      assert.equal(rig.ctrl.start('touch'), true, 'same-source re-press is a no-op');
      assert.equal(rig.ctrl.state.baseRate, 1.5);
      assert.equal(rig.ctrl.start('mouse'), false, 'cross-source press is refused while active');
      assert.equal(rig.ctrl.state.baseRate, 1.5, 'stored base rate must survive the cross-source press');
      assert.equal(rig.ctrl.state.source, 'touch');
      assert.equal(rig.ctrl.stop('mouse'), false, 'wrong source cannot stop the boost');
      assert.equal(rig.ctrl.state.active, true);
      rig.ctrl.stop('touch');
      assert.deepEqual(rig.applied, [2, 1.5]);
    }

    // Cancellation paths (blur/background/touchcancel/multitouch/pause/track change)
    // all share cancel(): restore base rate, never leave a stuck boost
    for (const baseRate of [1, 1.5, 3, 100]) {
      const rig = makeRig(baseRate);
      rig.ctrl.start('touch');
      assert.equal(rig.ctrl.cancel(), true);
      assert.equal(rig.ctrl.state.active, false, 'cancel must end the boost');
      assert.deepEqual(rig.applied, [2, baseRate], `cancel must restore base ${baseRate}`);
    }
    {
      const rig = makeRig(1);
      assert.equal(rig.ctrl.cancel(), false, 'cancel with no active boost is a no-op');
    }

    // Menu speed change during a hold updates the restore target coherently
    {
      const rig = makeRig(1);
      rig.ctrl.start('space');
      rig.setBase(0.75); // user picked 0.75x from the menu mid-hold
      rig.ctrl.setBaseRate(0.75);
      rig.ctrl.stop('space');
      assert.deepEqual(rig.applied, [2, 0.75], 'release must restore the menu-chosen rate');
    }
    {
      // Choosing 2.0x from the menu during a hold stays coherent (no rate jump on release)
      const rig = makeRig(1.5);
      rig.ctrl.start('touch');
      rig.setBase(2);
      rig.ctrl.setBaseRate(2);
      rig.ctrl.stop('touch');
      assert.deepEqual(rig.applied, [2, 2]);
    }
    {
      // Turbo base restored exactly after hold
      const rig = makeRig(100);
      rig.ctrl.start('mouse');
      rig.ctrl.stop('mouse');
      assert.deepEqual(rig.applied, [2, 100], 'turbo 100x must be restored exactly');
    }

    // player-app wiring: all three triggers route through the controller and
    // blur/visibility cancellation listeners are registered
    const appJs = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.ok(appJs.includes('createSpeedBoostController'), 'player-app must use the shared controller');
    assert.ok(!/base \* 2/.test(appJs), 'no base*2 multiplication may remain');
    assert.ok(appJs.includes("window.addEventListener('blur', () => boostController.cancel())"), 'blur must cancel an active hold');
    assert.ok(appJs.includes('visibilitychange'), 'backgrounding must cancel an active hold');
    assert.ok(appJs.includes('boostController.setBaseRate(chosen)'), 'menu speed change must update the restore target');
  });

  // 36. Volume 200% overdrive (behavioral: staging math, persistence, headroom)
  await runTest('Volume overdrive: real 0..200% staging, 100% default, persistence & tested peak ceiling', async () => {
    const od = await import('../js/modules/volume-overdrive.js');
    assert.equal(od.MAX_VOLUME, 2);

    // Staging math: <=100% element-only, >100% element at 1.0 + real gain
    assert.deepEqual(od.resolveVolumeStages(0.5), { clamped: 0.5, elementVolume: 0.5, gain: 1, overdrive: false });
    assert.deepEqual(od.resolveVolumeStages(1), { clamped: 1, elementVolume: 1, gain: 1, overdrive: false });
    assert.deepEqual(od.resolveVolumeStages(1.5), { clamped: 1.5, elementVolume: 1, gain: 1.5, overdrive: true });
    assert.deepEqual(od.resolveVolumeStages(2), { clamped: 2, elementVolume: 1, gain: 2, overdrive: true });
    assert.deepEqual(od.resolveVolumeStages(3.7).clamped, 2, 'values above 200% clamp to 2');
    assert.equal(od.clampVolume(-4), 0);
    assert.equal(od.clampVolume(NaN), 0);

    // Peak headroom: synthesized representative material through the exact
    // shaper curve at 200% must never exceed the defined ceiling
    const sampleRate = 8000;
    const seconds = 0.25;
    const n = Math.floor(sampleRate * seconds);
    const materials = {
      fullScaleSine: (i) => Math.sin((2 * Math.PI * 440 * i) / sampleRate),
      hotNoise: (i) => 0.95 * (Math.sin(i * 12.9898) * 43758.5453 % 1),
      quietSine: (i) => 0.1 * Math.sin((2 * Math.PI * 220 * i) / sampleRate),
    };
    for (const gain of [1.25, 1.5, 2]) {
      const curve = od.makeOverdriveCurve(gain);
      assert.ok(curve instanceof Float32Array);
      // Curve endpoints stay within the ceiling (WaveShaper clamps input to them)
      assert.ok(Math.abs(curve[0]) <= od.OVERDRIVE_CEILING + 1e-6);
      assert.ok(Math.abs(curve[curve.length - 1]) <= od.OVERDRIVE_CEILING + 1e-6);
      for (const [name, gen] of Object.entries(materials)) {
        let peak = 0;
        for (let i = 0; i < n; i++) {
          const x = gen(i);
          // emulate WaveShaper: gain then curve lookup with input clamp
          const pre = Math.max(-1, Math.min(1, x));
          const y = od.applyOverdriveCurve(pre, gain);
          peak = Math.max(peak, Math.abs(y));
        }
        assert.ok(peak <= od.OVERDRIVE_CEILING + 1e-6, `${name} at ${gain * 100}% must never exceed the ceiling (peak ${peak})`);
      }
    }
    // Real amplification: quiet material at 200% gets ~2x louder (small-signal gain)
    {
      let inPeak = 0;
      let outPeak = 0;
      for (let i = 0; i < n; i++) {
        const x = materials.quietSine(i);
        inPeak = Math.max(inPeak, Math.abs(x));
        outPeak = Math.max(outPeak, Math.abs(od.applyOverdriveCurve(x, 2)));
      }
      const ratio = outPeak / inPeak;
      assert.ok(ratio > 1.9 && ratio <= 2.01, `quiet material at 200% must really be amplified ~2x (got ${ratio.toFixed(3)}x)`);
    }

    // Storage: fresh default is 100%, persisted 150%/200% round-trip, legacy clamp healed to 0..2
    const fresh = storageMod.createEmptyState();
    assert.equal(fresh.volume, 1, 'fresh installs must default to 100%');
    const roundTrip = storageMod.sanitizeState({ volume: 1.5 });
    assert.equal(roundTrip.volume, 1.5, '150% must survive the storage round-trip');
    const roundTrip2 = storageMod.sanitizeState({ volume: 2 });
    assert.equal(roundTrip2.volume, 2, '200% must survive the storage round-trip');
    const legacyClamped = storageMod.sanitizeState({ volume: 9 });
    assert.equal(legacyClamped.volume, 2, 'stored volume clamps to the 0..2 domain');

    // Wiring: slider max=2 default 1, setVolume uses the staging module, UI marks overdrive
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="volumeSlider" class="range-input volume-slider" min="0" max="2"'), 'slider must reach 200%');
    const appJs = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.ok(appJs.includes('resolveVolumeStages'), 'setVolume must use the shared staging math');
    assert.ok(appJs.includes('is-overdrive'), 'UI must mark volume above 100%');
    assert.ok(appJs.includes('setOverdrive'), 'Web Audio overdrive stage must be wired');
    const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
    assert.ok(css.includes('.volume-readout.is-overdrive'), 'CSS must style the >100% indicator');
  });

  // 37. Android hierarchical library navigation (behavioral state machine + native wiring)
  await runTest('Android library: file-manager hierarchy, breadcrumbs, Back & lazy one-level SAF listing', async () => {
    const { createLibraryNavigator } = await import('../js/modules/library-navigation.js');
    const nav = createLibraryNavigator();

    // Root listing shows granted folders, not their contents
    nav.setRoots([
      { treeUri: 'content://tree/a', name: 'Music' },
      { treeUri: 'content://tree/b', name: 'Movies' },
    ]);
    assert.equal(nav.isBrowsing(), false);
    assert.equal(nav.getRoots().length, 2);
    assert.equal(nav.getCurrentDocId(), null, 'no docId in roots view');
    assert.equal(nav.canGoUp(), false, 'Back at roots view is not consumed');

    // Enter a root, descend two levels
    assert.equal(nav.enterRoot('content://tree/a'), true);
    assert.equal(nav.getCurrentDocId(), '', 'tree root lists with blank docId');
    assert.equal(nav.openFolder({ docId: 'a:Rock', name: 'Rock' }), true);
    assert.equal(nav.openFolder({ docId: 'a:Rock/Live', name: 'Live' }), true);
    assert.equal(nav.getCurrentDocId(), 'a:Rock/Live');
    assert.deepEqual(
      nav.getBreadcrumbs().map((b) => b.name),
      ['Music', 'Rock', 'Live'],
      'breadcrumb path must track the descent'
    );

    // Back climbs one level at a time, then returns to roots
    assert.equal(nav.goUp(), true);
    assert.equal(nav.getCurrentDocId(), 'a:Rock');
    assert.equal(nav.goUp(), true);
    assert.equal(nav.isBrowsing(), true, 'one level up from a subfolder stays inside the tree root');
    assert.equal(nav.goUp(), true);
    assert.equal(nav.isBrowsing(), false, 'Back from the tree root returns to the roots view');
    assert.equal(nav.goUp(), false, 'Back at roots view is left to the app back stack');

    // Breadcrumb jump
    nav.enterRoot('content://tree/b');
    nav.openFolder({ docId: 'b:Action', name: 'Action' });
    nav.openFolder({ docId: 'b:Action/2026', name: '2026' });
    assert.equal(nav.jumpToDepth(0), true);
    assert.equal(nav.getCurrentDocId(), '', 'jumping to the first crumb lands on the tree root');

    // Removing the active root resets browsing
    nav.openFolder({ docId: 'b:Action', name: 'Action' });
    nav.setRoots([{ treeUri: 'content://tree/a', name: 'Music' }]);
    assert.equal(nav.isBrowsing(), false, 'revoked root resets to the roots view');

    // Level ordering: subfolders first, then files, each alphabetical
    const sorted = nav.sortLevel(
      [{ name: 'Zeta' }, { name: 'alpha' }],
      [{ name: 'b.mp3' }, { name: 'A.mp4' }]
    );
    assert.deepEqual(sorted.folders.map((f) => f.name), ['alpha', 'Zeta']);
    assert.deepEqual(sorted.files.map((f) => f.name), ['A.mp4', 'b.mp3']);

    // Kotlin: lazy one-level SAF listing exists and uses buildChildDocumentsUriUsingTree
    const helperKt = fs.readFileSync(path.join(ROOT, 'desktop/android-native/AazMediaHelper.kt'), 'utf8');
    assert.ok(helperKt.includes('fun listSafChildren('), 'AazMediaHelper must expose one-level SAF listing');
    assert.ok(helperKt.includes('fun describeSafTree('), 'AazMediaHelper must expose shallow grant describe');
    const listFn = helperKt.slice(helperKt.indexOf('fun listSafChildren('));
    assert.ok(listFn.includes('buildChildDocumentsUriUsingTree'), 'one-level listing must use DocumentsContract children URI');
    assert.ok(!listFn.slice(0, listFn.indexOf('fun scanSafTree')).includes('scanTreeNode'), 'one-level listing must not recurse');
    const mainKt = fs.readFileSync(path.join(ROOT, 'desktop/android-native/MainActivity.kt'), 'utf8');
    assert.ok(mainKt.includes('fun listSafChildren(callbackId: String'), 'MainActivity must bridge listSafChildren to JS');
    assert.ok(mainKt.includes('fun selectFolderShallow(callbackId: String'), 'MainActivity must support shallow grants');
    assert.ok(mainKt.includes('takePersistableUriPermission'), 'grants must persist across restarts');

    // Bridge + UI wiring
    const bridgeJs = fs.readFileSync(path.join(ROOT, 'js/core/desktop-bridge.js'), 'utf8');
    assert.ok(bridgeJs.includes('listSafChildren'), 'desktop-bridge must expose listSafChildren');
    assert.ok(bridgeJs.includes('selectFolderShallow'), 'desktop-bridge must expose selectFolderShallow');
    const p3 = fs.readFileSync(path.join(ROOT, 'js/ui/phase3-controller.js'), 'utf8');
    assert.ok(p3.includes('createLibraryNavigator'), 'phase3 must use the navigator');
    assert.ok(p3.includes('libraryHandleBack'), 'phase3 must expose libraryHandleBack');
    const appJs = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.ok(appJs.includes('phase3.libraryHandleBack()'), 'Android Back must consult the library navigator first');
  });

  // 38. Mobile top bar: logo-only on Android/narrow layouts, wordmark kept on desktop
  await runTest('Mobile top bar: logo-only branding on Android & narrow widths, desktop wordmark preserved', () => {
    const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
    assert.ok(css.includes('html.is-android .tabstrip-brand > span'), 'Android must hide the header wordmark');
    assert.ok(css.includes('@media (max-width: 768px)'), 'narrow layouts must hide the header wordmark');
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('tabstrip-brand'), 'brand block must remain (logo SVG)');
  });


  // 39. Hamza rebrand: old-brand backup still imports, renamed release assets still match updater predicates, identity preserved
  await runTest('Hamza rebrand: legacy AAZ backup import, renamed-asset updater matching & identity preservation', () => {
    // (a) Backup exported by AAZ Player 1.8.0 (app tag "AAZ Player") must still restore
    const legacyBackup = JSON.stringify({
      app: 'AAZ Player',
      backupFormat: 'aaz-backup-v1',
      schemaVersion: 4,
      exportedAt: '2026-11-20T00:00:00.000Z',
      state: { savedPlaylists: [{ id: 'pl_old', name: 'Old Brand Playlist', trackCount: 1 }] },
      prefs: { theme: 'dark', skin: 'foliage', lang: 'ar' },
    });
    const memLegacy = createMemoryStorage();
    const smLegacy = storageMod.createStorageManager(memLegacy);
    const resLegacy = smLegacy.importBackupJson(legacyBackup);
    assert.equal(resLegacy.ok, true, 'legacy AAZ Player backup must import');
    assert.equal(resLegacy.state.savedPlaylists[0].name, 'Old Brand Playlist');
    // New exports carry the Hamza tag while keeping the aaz-backup-v1 format key
    const newExport = smLegacy.exportBackupJson({});
    assert.ok(newExport.includes('"app": "همزة"'), 'new exports must be tagged همزة');
    assert.ok(newExport.includes('"backupFormat": "aaz-backup-v1"'), 'backup format key must stay aaz-backup-v1');

    // (b) Renamed release assets still satisfy both updater selection predicates
    const releaseYml = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    assert.ok(releaseYml.includes('Hamza-Setup-$ver.exe'), 'Windows setup asset renamed to Hamza');
    assert.ok(releaseYml.includes('Hamza-Portable-$ver.exe'), 'Windows portable asset renamed to Hamza');
    assert.ok(releaseYml.includes('Hamza-Android-arm64-${REL_VERSION}.apk'), 'Android APK asset renamed to Hamza');
    assert.ok(releaseYml.includes('"aaz-player|version='), 'Minisign trusted-comment protocol prefix must stay aaz-player|');
    assert.ok(releaseYml.includes('"${FINAL_NAME}.sha256"'), 'APK sha256 companion must use exact APK name');
    // Windows predicate (lib.rs): .exe && contains("setup"), fallback excludes "portable"
    const winSetup = 'Hamza-Setup-1.9.0.exe'.toLowerCase();
    const winPortable = 'Hamza-Portable-1.9.0.exe'.toLowerCase();
    assert.ok(winSetup.endsWith('.exe') && winSetup.includes('setup'), 'Hamza setup asset matches Windows updater predicate');
    assert.ok(!(winPortable.endsWith('.exe') && !winPortable.includes('portable')), 'Hamza portable must stay excluded from fallback selection');
    // Android predicate (AazUpdater.kt): .apk with arm64/aarch64 preferred, sha file name matches
    const apkName = 'Hamza-Android-arm64-1.9.0.apk'.toLowerCase();
    assert.ok(apkName.endsWith('.apk') && (apkName.includes('arm64') || apkName.includes('aarch64')), 'Hamza APK matches Android updater predicate');
    assert.equal(`${apkName}.sha256`, 'hamza-android-arm64-1.9.0.apk.sha256', 'sha companion naming stays consistent');

    // (c) Installed-app identity & user data continuity preserved
    const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(tauriConf.identifier, 'com.aaz.player', 'Tauri identifier must stay com.aaz.player');
    assert.equal(tauriConf.productName, 'Hamza', 'productName becomes Hamza');
    const storageSrc = fs.readFileSync(path.join(ROOT, 'js/modules/storage-manager.js'), 'utf8');
    assert.ok(storageSrc.includes('aaz_media_player_state'), 'localStorage keys must stay aaz_*');
    const libRs = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/src/lib.rs'), 'utf8');
    assert.ok(libRs.includes('aaz-player|'), 'Rust updater must keep aaz-player| signature prefix');

    // (d) No user-visible AAZ Player strings remain in shipped UI surfaces
    const surfaces = [
      'index.html', 'js/app/player-app.js', 'js/ui/phase3-controller.js', 'js/ui/workspace-shell.js',
      'js/utils/error-handler.js', 'js/modules/playlist-io.js', 'js/modules/storage-manager.js',
      'desktop/android-native/AazCastHelper.kt', 'desktop/android-native/AazPlaybackService.kt',
      'desktop/android-native/MainActivity.kt', 'desktop/android-native/AazMediaHelper.kt',
      'desktop/android-native/AazUpdater.kt',
    ];
    for (const rel of surfaces) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!src.includes('AAZ Player'), `${rel} must not contain user-visible 'AAZ Player'`);
    }
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('<title>همزة</title>'), 'document title must be همزة');
  });

  // 41. Hamza brand assets + floating auto-dismiss toast
  await runTest('Hamza brand & toasts: icon asset wired everywhere, floating auto-dismiss notice, accent-text token on light skins', () => {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(fs.existsSync(path.join(ROOT, 'public/brand/hamza-icon.svg')), 'Hamza icon SVG must ship in public/brand');
    assert.ok(!fs.existsSync(path.join(ROOT, 'public/brand/az0-icon.svg')), 'old AZ0 brand assets must be gone');
    assert.ok(indexHtml.includes('./brand/hamza-icon.svg'), 'index.html must reference the Hamza icon (favicon + header)');
    assert.ok(indexHtml.includes('<span class="brand-wordmark">همزة</span>'), 'header wordmark must read همزة');
    const icoSize = fs.statSync(path.join(ROOT, 'desktop/assets/icon.ico')).size;
    assert.ok(icoSize > 4000, 'desktop icon.ico must be a real multi-size icon');
    const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
    const noticeBlock = css.slice(css.indexOf('.status-notice {'), css.indexOf('.status-notice.is-showing'));
    assert.ok(/position:\s*fixed/.test(noticeBlock), 'status notice must float (position: fixed) so it never takes video space');
    const app = fs.readFileSync(path.join(ROOT, 'js/app/player-app.js'), 'utf8');
    assert.ok(app.includes('scheduleNoticeHide(ms)'), 'showNotice must schedule an auto-dismiss');
    assert.ok(app.includes('function noticeDurationMs'), 'notice duration must be computed (errors/undo stay longer)');
    assert.ok(app.includes("document.fullscreenElement"), 'toast must re-host inside the fullscreen element');
    const themes = fs.readFileSync(path.join(ROOT, 'css/themes.css'), 'utf8');
    const lightBlocks = themes.match(/:root\[data-skin="[a-z0-9]+"\]\[data-theme="light"\]\s*\{[^}]*\}/g) || [];
    assert.ok(lightBlocks.length >= 14, 'light skin blocks must be present');
    assert.ok(css.includes('var(--accent-text, var(--accent))'), 'accent-coloured text must use --accent-text with accent fallback');
  });

  // 40. Arabic init regression: Phase 3 UI must apply translations during startup, not only on language toggle
  await runTest('Arabic init: phase3 applyTranslations runs at startup (Scan Device/Library/Player localized on fresh load)', () => {
    const p3 = fs.readFileSync(path.join(ROOT, 'js/ui/phase3-controller.js'), 'utf8');
    const bindIdx = p3.indexOf('bindEvents();');
    const retIdx = p3.lastIndexOf('return {');
    assert.ok(bindIdx !== -1 && retIdx !== -1, 'phase3 factory structure must be locatable');
    const initRegion = p3.slice(bindIdx, retIdx);
    assert.ok(initRegion.includes('applyTranslations();'), 'applyTranslations() must run during phase3 init (fresh Arabic load must localize p3 strings)');
    // Arabic strings must exist for the mobile shell keys that previously stayed English
    for (const key of ['libScanDevice', 'navPlayer', 'tabLibrary']) {
      const arMatch = p3.match(new RegExp('ar:[\\s\\S]*?' + key + ": '([^']+)'"));
      assert.ok(arMatch, key + ' must have an Arabic translation');
      assert.ok(/[\u0600-\u06FF]/.test(arMatch[1]), key + ' Arabic translation must contain Arabic script');
    }
    // index.html p3-i18n hooks must exist for the mobile scan button
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('data-p3-i18n="libScanDevice"'), 'mobile scan button must carry the p3 i18n hook');
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
