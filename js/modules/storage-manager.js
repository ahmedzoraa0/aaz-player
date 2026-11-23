/**
 * Versioned State & Storage Management (Phase 2 Task 2).
 *
 * Schema v4:
 * - Preserves 100% of v1, v2, and v3 user data (savedPlaylists, progressByKey,
 *   bookmarksByKey, starredKeys, watchedKeys, EQ, volume, session resume, etc.).
 * - Automatically writes a pre-migration backup (`aaz_media_player_backup_v3`)
 *   before upgrading from an older key so user playlists/progress are never lost.
 * - Validates & sanitizes every loaded structure.
 * - Supports full JSON Backup Export & validated Restore.
 */

import { sanitizeSubtitleStyle } from './subtitle-style.js';

export const SCHEMA_VERSION = 4;
export const STORAGE_KEY = 'aaz_media_player_state_v4';
export const BACKUP_PRE_V4_KEY = 'aaz_media_player_backup_v3';
export const BACKUP_PRE_RESTORE_KEY = 'aaz_media_player_pre_restore_backup';
export const LEGACY_KEYS = Object.freeze([
  'aaz_media_player_state_v3',
  'aaz_media_player_state_v2',
  'aaz_media_player_state_v1',
]);

const MAX_BOOKMARK_SECONDS = 86400 * 14; // 14 days upper bound for finite timestamps
const MAX_BACKUP_JSON_BYTES = 8 * 1024 * 1024; // 8 MB backup safety cap

export const DEFAULT_PLAYBACK_SETTINGS = Object.freeze({
  defaultPlaybackRate: 1,
  defaultVolume: 0.85,
  resumePreviousPosition: true,
  defaultSubtitleLang: 'auto', // 'auto' | 'ar' | 'en'
  defaultAspectRatio: 'default', // 'default' | '16:9' | '4:3' | '21:9' | '16:10' | '1:1' | 'fill'
  recordWatchHistory: true,
  preferredAudioDeviceId: '',
});

export const DEFAULT_WINDOW_LAYOUT = Object.freeze({
  main: null, // { x, y, width, height, maximized }
  mini: {
    x: null,
    y: null,
    width: 420,
    height: 260,
    alwaysOnTop: true,
  },
});

export function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: SCHEMA_VERSION,
    updatedAt: Date.now(),
    // Existing v3 session & playback fields (preserved 100%)
    volume: 0.85,
    muted: false,
    playbackRate: 1,
    playlistMode: 'all',
    videoDisplayMode: 'video',
    sortMode: 'custom',
    shuffle: false,
    repeatMode: 'off',
    eqPreset: 'flat',
    eqGains: [0, 0, 0, 0, 0],
    preampGain: 1,
    starredKeys: [],
    watchedKeys: [],
    progressByKey: {},
    bookmarksByKey: {},
    savedPlaylists: [],
    // Optional active session fields
    trackKey: undefined,
    trackName: undefined,
    trackFullPath: undefined,
    folderName: undefined,
    nativeFolderPath: undefined,
    nativeTrackPaths: [],
    currentTime: undefined,
    activeSavedPlaylistId: undefined,
    // New v4 feature fields
    watchHistory: [],
    mediaLibrary: {
      folders: [],
    },
    playbackSettings: { ...DEFAULT_PLAYBACK_SETTINGS },
    customShortcuts: {},
    windowLayout: {
      main: null,
      mini: { ...DEFAULT_WINDOW_LAYOUT.mini },
    },
  };
}

function clamp(num, min, max, fallback) {
  const n = Number(num);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Unifies and sanitizes a track's timestamp bookmark list (F02).
 * Accepts both canonical `number[]` and legacy `{ time: number }[]` objects,
 * drops non-finite / negative / out-of-range values, deduplicates, and sorts ascending.
 */
export function sanitizeBookmarkList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const clean = [];
  for (const item of rawList) {
    let rawTime = NaN;
    if (typeof item === 'number') {
      rawTime = item;
    } else if (item && typeof item === 'object' && !Array.isArray(item) && item.time !== undefined) {
      rawTime = Number(item.time);
    }
    if (!Number.isFinite(rawTime) || rawTime < 0 || rawTime > MAX_BOOKMARK_SECONDS) continue;
    const sec = Math.floor(rawTime);
    if (seen.has(sec)) continue;
    seen.add(sec);
    clean.push(sec);
    if (clean.length >= 200) break;
  }
  clean.sort((a, b) => a - b);
  return clean;
}

export function sanitizePlaybackSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const allowedRates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const rateNum = Number(src.defaultPlaybackRate);
  const defaultPlaybackRate = allowedRates.includes(rateNum)
    ? rateNum
    : DEFAULT_PLAYBACK_SETTINGS.defaultPlaybackRate;

  const allowedSubLang = new Set(['auto', 'ar', 'en']);
  const allowedAspect = new Set(['default', '16:9', '4:3', '21:9', '16:10', '1:1', 'fill']);

  return {
    defaultPlaybackRate,
    defaultVolume: clamp(src.defaultVolume, 0, 1, DEFAULT_PLAYBACK_SETTINGS.defaultVolume),
    resumePreviousPosition:
      typeof src.resumePreviousPosition === 'boolean'
        ? src.resumePreviousPosition
        : DEFAULT_PLAYBACK_SETTINGS.resumePreviousPosition,
    defaultSubtitleLang: allowedSubLang.has(src.defaultSubtitleLang)
      ? src.defaultSubtitleLang
      : DEFAULT_PLAYBACK_SETTINGS.defaultSubtitleLang,
    defaultAspectRatio: allowedAspect.has(src.defaultAspectRatio)
      ? src.defaultAspectRatio
      : DEFAULT_PLAYBACK_SETTINGS.defaultAspectRatio,
    recordWatchHistory:
      typeof src.recordWatchHistory === 'boolean'
        ? src.recordWatchHistory
        : DEFAULT_PLAYBACK_SETTINGS.recordWatchHistory,
    preferredAudioDeviceId:
      typeof src.preferredAudioDeviceId === 'string'
        ? src.preferredAudioDeviceId.slice(0, 200)
        : '',
  };
}

function sanitizeWindowRect(raw, minW, minH) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    x: Number.isFinite(x) ? Math.round(x) : 0,
    y: Number.isFinite(y) ? Math.round(y) : 0,
    width: Math.max(minW, Math.round(width)),
    height: Math.max(minH, Math.round(height)),
    maximized: Boolean(raw.maximized),
  };
}

export function sanitizeState(raw) {
  const base = createEmptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  // Preserve unknown legacy keys safely first, then overwrite with validated fields
  const out = { ...raw, ...base };
  out.schemaVersion = SCHEMA_VERSION;
  out.version = SCHEMA_VERSION;
  out.updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now();

  out.volume = clamp(raw.volume, 0, 1, base.volume);
  out.muted = Boolean(raw.muted);
  out.playbackRate = clamp(raw.playbackRate, 0.25, 4, base.playbackRate);
  out.playlistMode = ['all', 'audio', 'video', 'starred'].includes(raw.playlistMode)
    ? raw.playlistMode
    : base.playlistMode;
  out.videoDisplayMode = ['video', 'audio'].includes(raw.videoDisplayMode)
    ? raw.videoDisplayMode
    : base.videoDisplayMode;
  out.sortMode = ['custom', 'asc', 'desc', 'type', 'duration'].includes(raw.sortMode)
    ? raw.sortMode
    : base.sortMode;
  out.shuffle = Boolean(raw.shuffle);
  out.repeatMode = ['off', 'all', 'one'].includes(raw.repeatMode) ? raw.repeatMode : base.repeatMode;
  out.eqPreset = typeof raw.eqPreset === 'string' ? raw.eqPreset.slice(0, 40) : base.eqPreset;
  out.eqGains =
    Array.isArray(raw.eqGains) && raw.eqGains.length === 5
      ? raw.eqGains.map((v) => clamp(v, -12, 12, 0))
      : [...base.eqGains];
  out.preampGain = clamp(raw.preampGain, 1, 1.5, base.preampGain);

  out.starredKeys = Array.isArray(raw.starredKeys)
    ? raw.starredKeys.filter((k) => typeof k === 'string').slice(0, 10000)
    : [];
  out.watchedKeys = Array.isArray(raw.watchedKeys)
    ? raw.watchedKeys.filter((k) => typeof k === 'string').slice(0, 10000)
    : [];

  if (raw.progressByKey && typeof raw.progressByKey === 'object' && !Array.isArray(raw.progressByKey)) {
    const cleanProg = {};
    let count = 0;
    for (const [k, v] of Object.entries(raw.progressByKey)) {
      if (count >= 10000) break;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_BOOKMARK_SECONDS) {
        cleanProg[k] = v;
        count += 1;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        const t = Number(v.time);
        const d = Number(v.duration);
        if (Number.isFinite(t) && t >= 0 && t <= MAX_BOOKMARK_SECONDS) {
          cleanProg[k] = {
            time: t,
            duration: Number.isFinite(d) && d >= 0 && d <= MAX_BOOKMARK_SECONDS ? d : 0,
            updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : Date.now(),
          };
          count += 1;
        }
      }
    }
    out.progressByKey = cleanProg;
  }

  if (raw.bookmarksByKey && typeof raw.bookmarksByKey === 'object' && !Array.isArray(raw.bookmarksByKey)) {
    const cleanBm = {};
    let count = 0;
    for (const [k, list] of Object.entries(raw.bookmarksByKey)) {
      if (count >= 5000) break;
      const sanitizedList = sanitizeBookmarkList(list);
      if (sanitizedList.length > 0) {
        cleanBm[k] = sanitizedList;
        count += 1;
      }
    }
    out.bookmarksByKey = cleanBm;
  }

  // Optional active session fields
  if (typeof raw.trackKey === 'string') out.trackKey = raw.trackKey.slice(0, 1024);
  else delete out.trackKey;
  if (typeof raw.trackName === 'string') out.trackName = raw.trackName.slice(0, 260);
  else delete out.trackName;
  if (typeof raw.trackFullPath === 'string' && raw.trackFullPath.trim()) {
    out.trackFullPath = raw.trackFullPath.slice(0, 1024);
  } else {
    delete out.trackFullPath;
  }
  if (typeof raw.folderName === 'string') out.folderName = raw.folderName.slice(0, 260);
  else delete out.folderName;
  if (typeof raw.nativeFolderPath === 'string') out.nativeFolderPath = raw.nativeFolderPath.slice(0, 1024);
  else delete out.nativeFolderPath;
  if (Array.isArray(raw.nativeTrackPaths)) {
    out.nativeTrackPaths = raw.nativeTrackPaths
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.slice(0, 1024))
      .slice(0, 500);
  } else {
    out.nativeTrackPaths = [];
  }
  if (typeof raw.currentTime === 'number' && Number.isFinite(raw.currentTime)) {
    out.currentTime = Math.max(0, Math.min(MAX_BOOKMARK_SECONDS, raw.currentTime));
  } else {
    delete out.currentTime;
  }
  if (typeof raw.activeSavedPlaylistId === 'string') {
    out.activeSavedPlaylistId = raw.activeSavedPlaylistId.slice(0, 128);
  } else {
    delete out.activeSavedPlaylistId;
  }

  // Saved playlists
  if (Array.isArray(raw.savedPlaylists)) {
    out.savedPlaylists = raw.savedPlaylists
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string')
      .slice(0, 250)
      .map((p) => ({
        ...p,
        id: p.id.slice(0, 128),
        name: p.name.slice(0, 200),
      }));
  }

  // Watch history
  if (Array.isArray(raw.watchHistory)) {
    out.watchHistory = raw.watchHistory
      .filter((h) => h && typeof h === 'object' && typeof h.id === 'string' && typeof h.title === 'string')
      .slice(0, 200)
      .map((h) => ({
        id: h.id.slice(0, 512),
        title: h.title.slice(0, 260),
        name: typeof h.name === 'string' ? h.name.slice(0, 260) : h.title.slice(0, 260),
        kind: h.kind === 'audio' ? 'audio' : 'video',
        fullPath: typeof h.fullPath === 'string' ? h.fullPath.slice(0, 1024) : null,
        relPath: typeof h.relPath === 'string' ? h.relPath.slice(0, 1024) : null,
        folderPath: typeof h.folderPath === 'string' ? h.folderPath.slice(0, 1024) : null,
        lastTime: Math.max(0, Number(h.lastTime) || 0),
        duration: Math.max(0, Number(h.duration) || 0),
        completed: Boolean(h.completed),
        lastPlayedAt: Number.isFinite(Number(h.lastPlayedAt)) ? Number(h.lastPlayedAt) : Date.now(),
      }));
  }

  // Media library
  if (raw.mediaLibrary && typeof raw.mediaLibrary === 'object' && Array.isArray(raw.mediaLibrary.folders)) {
    out.mediaLibrary = {
      folders: raw.mediaLibrary.folders
        .filter((f) => f && typeof f === 'object' && typeof f.path === 'string' && f.path.trim())
        .slice(0, 60)
        .map((f) => ({
          path: f.path.slice(0, 1024),
          name: typeof f.name === 'string' && f.name.trim() ? f.name.slice(0, 200) : f.path,
          addedAt: Number.isFinite(Number(f.addedAt)) ? Number(f.addedAt) : Date.now(),
          lastScannedAt: Number.isFinite(Number(f.lastScannedAt)) ? Number(f.lastScannedAt) : Date.now(),
          items: Array.isArray(f.items)
            ? f.items
                .filter((it) => it && typeof it === 'object' && typeof it.name === 'string')
                .slice(0, 5000)
                .map((it) => ({
                  name: it.name.slice(0, 260),
                  title: typeof it.title === 'string' ? it.title.slice(0, 260) : it.name.slice(0, 260),
                  kind: it.kind === 'audio' ? 'audio' : 'video',
                  fullPath: typeof it.fullPath === 'string' ? it.fullPath.slice(0, 1024) : null,
                  relPath: typeof it.relPath === 'string' ? it.relPath.slice(0, 1024) : it.name.slice(0, 260),
                  size: Math.max(0, Number(it.size) || 0),
                  mtimeMs: Math.max(0, Number(it.mtimeMs) || 0),
                  duration:
                    Number.isFinite(Number(it.duration)) && Number(it.duration) > 0
                      ? Number(it.duration)
                      : null,
                }))
            : [],
        })),
    };
  }

  // Playback settings
  out.playbackSettings = sanitizePlaybackSettings(raw.playbackSettings);

  // Custom shortcuts
  out.customShortcuts = {};
  if (raw.customShortcuts && typeof raw.customShortcuts === 'object' && !Array.isArray(raw.customShortcuts)) {
    for (const [actionId, combo] of Object.entries(raw.customShortcuts)) {
      if (typeof actionId === 'string' && typeof combo === 'string' && combo.length <= 40) {
        out.customShortcuts[actionId.slice(0, 64)] = combo.trim();
      }
    }
  }

  // Window layout
  out.windowLayout = {
    main: null,
    mini: { ...DEFAULT_WINDOW_LAYOUT.mini },
  };
  if (raw.windowLayout && typeof raw.windowLayout === 'object') {
    out.windowLayout.main = sanitizeWindowRect(raw.windowLayout.main, 460, 540);
    if (raw.windowLayout.mini && typeof raw.windowLayout.mini === 'object') {
      const m = raw.windowLayout.mini;
      out.windowLayout.mini = {
        x: typeof m.x === 'number' && Number.isFinite(m.x) ? Math.round(m.x) : null,
        y: typeof m.y === 'number' && Number.isFinite(m.y) ? Math.round(m.y) : null,
        width: clamp(m.width, 300, 1000, DEFAULT_WINDOW_LAYOUT.mini.width),
        height: clamp(m.height, 150, 720, DEFAULT_WINDOW_LAYOUT.mini.height),
        alwaysOnTop:
          typeof m.alwaysOnTop === 'boolean' ? m.alwaysOnTop : DEFAULT_WINDOW_LAYOUT.mini.alwaysOnTop,
      };
    }
  }

  return out;
}

/**
 * Safely migrates v1 / v2 / v3 persisted objects into v4 schema without losing data.
 */
export function migrateStateObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createEmptyState();
  }
  const cloned = JSON.parse(JSON.stringify(raw));

  // If upgrading from v1-v3, seed playbackSettings from legacy volume/rate if not already set
  if (!cloned.playbackSettings) {
    cloned.playbackSettings = {
      ...DEFAULT_PLAYBACK_SETTINGS,
      defaultVolume: Number.isFinite(cloned.volume) ? cloned.volume : DEFAULT_PLAYBACK_SETTINGS.defaultVolume,
      defaultPlaybackRate: Number.isFinite(cloned.playbackRate)
        ? cloned.playbackRate
        : DEFAULT_PLAYBACK_SETTINGS.defaultPlaybackRate,
    };
  }

  return sanitizeState(cloned);
}

/**
 * Creates a Storage Manager bound to a Storage-like backend (defaults to window.localStorage).
 *
 * Uses read-latest-modify-write (`update`) and same-document subscriber notification
 * so independent controllers (player-app, phase3-controller, window-layout) never
 * overwrite each other's changes with a stale full-state snapshot (F01).
 */
export function createStorageManager(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  const listeners = new Set();

  function safeGetItem(key) {
    try {
      return storage ? storage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  function safeSetItem(key, val) {
    if (!storage || typeof storage.setItem !== 'function') {
      return false;
    }
    try {
      storage.setItem(key, val);
      return true;
    } catch {
      return false;
    }
  }

  function notifyListeners(cleanState, changedKeys) {
    for (const fn of listeners) {
      try {
        fn(cleanState, changedKeys);
      } catch {
        // Isolate subscriber failures
      }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function load() {
    // 1. Try current v4 key
    const v4Raw = safeGetItem(STORAGE_KEY);
    if (v4Raw) {
      try {
        return sanitizeState(JSON.parse(v4Raw));
      } catch {
        // Fall through to legacy recovery if v4 was corrupted
      }
    }

    // 2. Non-destructive migration from v3 / v2 / v1
    for (const legacyKey of LEGACY_KEYS) {
      const legacyRaw = safeGetItem(legacyKey);
      if (!legacyRaw) continue;
      try {
        const parsed = JSON.parse(legacyRaw);
        if (!safeGetItem(BACKUP_PRE_V4_KEY)) {
          safeSetItem(BACKUP_PRE_V4_KEY, legacyRaw);
        }
        const migrated = migrateStateObject(parsed);
        safeSetItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      } catch {
        // Try next older key
      }
    }

    return createEmptyState();
  }

  function save(data) {
    const clean = sanitizeState(data);
    clean.updatedAt = Date.now();
    const ok = safeSetItem(STORAGE_KEY, JSON.stringify(clean));
    if (ok) {
      notifyListeners(clean, null);
    }
    return ok;
  }

  /**
   * Atomically loads the freshest snapshot from storage, applies a partial object patch
   * or targeted mutator function to ONLY the fields owned by the caller, and writes back.
   * Prevents stale caches from wiping unrelated domains (playlists, bookmarks, history, settings, geometry).
   */
  function update(patchOrMutator) {
    const latest = load();
    let next = latest;
    let changedKeys = null;

    if (typeof patchOrMutator === 'function') {
      const result = patchOrMutator(latest);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        next = result;
      }
    } else if (patchOrMutator && typeof patchOrMutator === 'object' && !Array.isArray(patchOrMutator)) {
      changedKeys = Object.keys(patchOrMutator);
      next = { ...latest, ...patchOrMutator };
    } else {
      return { ok: false, state: latest, error: 'Invalid update payload' };
    }

    const clean = sanitizeState(next);
    clean.updatedAt = Date.now();
    const ok = safeSetItem(STORAGE_KEY, JSON.stringify(clean));
    if (ok) {
      notifyListeners(clean, changedKeys);
      return { ok: true, state: clean };
    }
    return { ok: false, state: latest, error: 'Storage quota exceeded or unavailable' };
  }

  function exportBackupJson(extraPrefs = {}) {
    const state = load();
    const cleanSubStyle = extraPrefs.subtitleStyle
      ? sanitizeSubtitleStyle(extraPrefs.subtitleStyle)
      : null;
    const payload = {
      app: 'AAZ Player',
      backupFormat: 'aaz-backup-v1',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      state,
      prefs: {
        theme: extraPrefs.theme === 'light' ? 'light' : (safeGetItem('aaz_theme') || 'dark'),
        skin: typeof extraPrefs.skin === 'string' ? extraPrefs.skin : (safeGetItem('aaz_skin') || 'foliage'),
        lang: extraPrefs.lang === 'ar' ? 'ar' : (safeGetItem('aaz_lang') || 'en'),
        subtitleStyle: cleanSubStyle,
      },
    };
    return JSON.stringify(payload, null, 2);
  }

  function importBackupJson(jsonText) {
    const rawText = String(jsonText || '');
    if (rawText.length > MAX_BACKUP_JSON_BYTES) {
      return { ok: false, error: 'Backup file exceeds maximum supported size (8 MB)' };
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, error: 'Invalid JSON syntax' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Backup payload is not an object' };
    }

    const rawState =
      parsed.backupFormat === 'aaz-backup-v1' && parsed.state && typeof parsed.state === 'object'
        ? parsed.state
        : parsed.savedPlaylists || parsed.progressByKey || parsed.watchHistory || parsed.mediaLibrary
          ? parsed
          : null;

    if (!rawState) {
      return { ok: false, error: 'Unrecognized AAZ Player backup structure' };
    }

    // Save a pre-restore rollback snapshot before replacing user state
    const existingRaw = safeGetItem(STORAGE_KEY);
    if (existingRaw) {
      safeSetItem(BACKUP_PRE_RESTORE_KEY, existingRaw);
    }

    const sanitized = migrateStateObject(rawState);
    const saved = save(sanitized);
    if (!saved) {
      return { ok: false, error: 'Storage quota exceeded or unavailable' };
    }

    let cleanPrefs = null;
    if (parsed.prefs && typeof parsed.prefs === 'object' && !Array.isArray(parsed.prefs)) {
      cleanPrefs = {
        theme: parsed.prefs.theme === 'light' ? 'light' : parsed.prefs.theme === 'dark' ? 'dark' : undefined,
        skin: typeof parsed.prefs.skin === 'string' ? parsed.prefs.skin.slice(0, 40) : undefined,
        lang: parsed.prefs.lang === 'ar' ? 'ar' : parsed.prefs.lang === 'en' ? 'en' : undefined,
        subtitleStyle: parsed.prefs.subtitleStyle
          ? sanitizeSubtitleStyle(parsed.prefs.subtitleStyle)
          : undefined,
      };
    }

    return {
      ok: true,
      state: sanitized,
      prefs: cleanPrefs,
      rollbackKey: existingRaw ? BACKUP_PRE_RESTORE_KEY : null,
    };
  }

  function rollbackLastRestore() {
    const prevRaw = safeGetItem(BACKUP_PRE_RESTORE_KEY);
    if (!prevRaw) return { ok: false, error: 'No pre-restore backup available' };
    try {
      const prevState = sanitizeState(JSON.parse(prevRaw));
      const ok = save(prevState);
      return ok
        ? { ok: true, state: prevState }
        : { ok: false, error: 'Storage quota exceeded or unavailable' };
    } catch {
      return { ok: false, error: 'Pre-restore backup is corrupted' };
    }
  }

  return {
    load,
    save,
    update,
    subscribe,
    exportBackupJson,
    importBackupJson,
    rollbackLastRestore,
  };
}
