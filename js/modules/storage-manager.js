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

export const SCHEMA_VERSION = 4;
export const STORAGE_KEY = 'aaz_media_player_state_v4';
export const BACKUP_PRE_V4_KEY = 'aaz_media_player_backup_v3';
export const LEGACY_KEYS = Object.freeze([
  'aaz_media_player_state_v3',
  'aaz_media_player_state_v2',
  'aaz_media_player_state_v1',
]);

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
    folderName: undefined,
    nativeFolderPath: undefined,
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
    for (const [k, v] of Object.entries(raw.progressByKey)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        cleanProg[k] = v;
      } else if (v && typeof v === 'object') {
        cleanProg[k] = v;
      }
    }
    out.progressByKey = cleanProg;
  }

  if (raw.bookmarksByKey && typeof raw.bookmarksByKey === 'object' && !Array.isArray(raw.bookmarksByKey)) {
    const cleanBm = {};
    for (const [k, list] of Object.entries(raw.bookmarksByKey)) {
      if (!Array.isArray(list)) continue;
      cleanBm[k] = list
        .filter((b) => b && typeof b === 'object' && Number.isFinite(Number(b.time)))
        .slice(0, 200);
    }
    out.bookmarksByKey = cleanBm;
  }

  // Optional active session fields
  if (typeof raw.trackKey === 'string') out.trackKey = raw.trackKey;
  else delete out.trackKey;
  if (typeof raw.trackName === 'string') out.trackName = raw.trackName;
  else delete out.trackName;
  if (typeof raw.folderName === 'string') out.folderName = raw.folderName;
  else delete out.folderName;
  if (typeof raw.nativeFolderPath === 'string') out.nativeFolderPath = raw.nativeFolderPath;
  else delete out.nativeFolderPath;
  if (typeof raw.currentTime === 'number' && Number.isFinite(raw.currentTime)) {
    out.currentTime = Math.max(0, raw.currentTime);
  } else {
    delete out.currentTime;
  }
  if (typeof raw.activeSavedPlaylistId === 'string') {
    out.activeSavedPlaylistId = raw.activeSavedPlaylistId;
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
        height: clamp(m.height, 190, 720, DEFAULT_WINDOW_LAYOUT.mini.height),
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
 */
export function createStorageManager(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  function safeGetItem(key) {
    try {
      return storage ? storage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  function safeSetItem(key, val) {
    try {
      if (storage) storage.setItem(key, val);
      return true;
    } catch {
      return false;
    }
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
    return safeSetItem(STORAGE_KEY, JSON.stringify(clean));
  }

  function exportBackupJson(extraPrefs = {}) {
    const state = load();
    const payload = {
      app: 'AAZ Player',
      backupFormat: 'aaz-backup-v1',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      state,
      prefs: {
        theme: extraPrefs.theme || safeGetItem('aaz_theme') || 'dark',
        lang: extraPrefs.lang || safeGetItem('aaz_lang') || 'en',
        subtitleStyle: extraPrefs.subtitleStyle || null,
      },
    };
    return JSON.stringify(payload, null, 2);
  }

  function importBackupJson(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(String(jsonText || ''));
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

    const sanitized = migrateStateObject(rawState);
    const saved = save(sanitized);
    if (!saved) {
      return { ok: false, error: 'Storage quota exceeded or unavailable' };
    }

    return {
      ok: true,
      state: sanitized,
      prefs: parsed.prefs && typeof parsed.prefs === 'object' ? parsed.prefs : null,
    };
  }

  return {
    load,
    save,
    exportBackupJson,
    importBackupJson,
  };
}
