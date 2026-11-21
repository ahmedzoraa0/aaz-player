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
  console.log('\nAAZ Player Automated Test Suite\n================================');

  const messaging = await import(pathToFileURL(path.join(ROOT, 'js/core/messaging.js')).href);
  const fileUtils = await import(pathToFileURL(path.join(ROOT, 'js/utils/file-utils.js')).href);
  const timeUtils = await import(pathToFileURL(path.join(ROOT, 'js/utils/time-utils.js')).href);
  const errorHandlerMod = await import(pathToFileURL(path.join(ROOT, 'js/utils/error-handler.js')).href);
  const playlistIo = await import(pathToFileURL(path.join(ROOT, 'js/modules/playlist-io.js')).href);
  const storageMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/storage-manager.js')).href);
  const historyMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/history-manager.js')).href);
  const libraryMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/library-manager.js')).href);
  const shortcutsMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/shortcuts-manager.js')).href);
  const settingsMod = await import(pathToFileURL(path.join(ROOT, 'js/modules/settings-manager.js')).href);

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
    assert.equal(updated.defaultVolume, 1);
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
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
