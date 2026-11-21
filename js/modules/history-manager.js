/**
 * Watch History Manager (Phase 3 Feature 1).
 *
 * Tracks recently played audio/video items, playback position, completion status
 * (auto-marked at >=92% watched or toggled manually), search, individual removal,
 * full clear, and pause-recording privacy mode.
 */

export const MAX_HISTORY_ENTRIES = 200;
export const AUTO_COMPLETE_RATIO = 0.92;

export function buildHistoryId(item) {
  if (!item) return '';
  if (item.fullPath) return `path:${String(item.fullPath).replace(/\\/g, '/').toLowerCase()}`;
  if (item.relPath) return `rel:${String(item.relPath).replace(/\\/g, '/').toLowerCase()}`;
  return `name:${String(item.name || item.title || '').toLowerCase()}`;
}

export function createHistoryManager({ getStore, persist, isRecordingEnabled }) {
  function getEntries() {
    const store = getStore();
    if (!Array.isArray(store.watchHistory)) store.watchHistory = [];
    return store.watchHistory;
  }

  function recordPlay(track, currentTime = 0, duration = 0) {
    if (typeof isRecordingEnabled === 'function' && !isRecordingEnabled()) return null;
    if (!track) return null;

    const id = buildHistoryId(track);
    if (!id) return null;

    const list = getEntries();
    const existingIdx = list.findIndex((entry) => entry.id === id);
    const existing = existingIdx >= 0 ? list[existingIdx] : null;

    const safeTime = Math.max(0, Number(currentTime) || 0);
    const safeDur =
      Number.isFinite(Number(duration)) && Number(duration) > 0
        ? Number(duration)
        : existing && existing.duration > 0
          ? existing.duration
          : Number(track.duration) || 0;

    const autoCompleted =
      safeDur > 10 && safeTime / safeDur >= AUTO_COMPLETE_RATIO;

    const updated = {
      id,
      title: String(track.title || track.name || 'Untitled').slice(0, 260),
      name: String(track.name || track.title || 'Untitled').slice(0, 260),
      kind: track.kind === 'audio' ? 'audio' : 'video',
      fullPath: track.fullPath || (existing ? existing.fullPath : null),
      relPath: track.relPath || (existing ? existing.relPath : null),
      folderPath: track.folderPath || (existing ? existing.folderPath : null),
      lastTime: safeTime,
      duration: safeDur,
      completed: autoCompleted || Boolean(existing && existing.completed && safeTime < 2),
      lastPlayedAt: Date.now(),
    };

    if (existingIdx >= 0) {
      list.splice(existingIdx, 1);
    }
    list.unshift(updated);
    if (list.length > MAX_HISTORY_ENTRIES) {
      list.length = MAX_HISTORY_ENTRIES;
    }

    persist();
    return updated;
  }

  function updateProgress(track, currentTime, duration) {
    if (typeof isRecordingEnabled === 'function' && !isRecordingEnabled()) return null;
    if (!track) return null;
    const id = buildHistoryId(track);
    if (!id) return null;

    const list = getEntries();
    const entry = list.find((e) => e.id === id);
    if (!entry) {
      return recordPlay(track, currentTime, duration);
    }

    const safeTime = Math.max(0, Number(currentTime) || 0);
    const safeDur = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : entry.duration;

    entry.lastTime = safeTime;
    if (safeDur > 0) entry.duration = safeDur;
    entry.lastPlayedAt = Date.now();
    if (safeDur > 10 && safeTime / safeDur >= AUTO_COMPLETE_RATIO) {
      entry.completed = true;
    }

    persist();
    return entry;
  }

  function toggleCompleted(id, forceValue) {
    const list = getEntries();
    const entry = list.find((e) => e.id === id);
    if (!entry) return null;
    entry.completed = typeof forceValue === 'boolean' ? forceValue : !entry.completed;
    persist();
    return entry;
  }

  function removeEntry(id) {
    const list = getEntries();
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    persist();
    return true;
  }

  function clearAll() {
    const store = getStore();
    store.watchHistory = [];
    persist();
  }

  function query({ search = '', filter = 'all' } = {}) {
    const q = String(search || '').trim().toLowerCase();
    return getEntries().filter((entry) => {
      if (filter === 'completed' && !entry.completed) return false;
      if (filter === 'in-progress' && entry.completed) return false;
      if (filter === 'audio' && entry.kind !== 'audio') return false;
      if (filter === 'video' && entry.kind !== 'video') return false;
      if (q) {
        const hay = `${entry.title} ${entry.name} ${entry.relPath || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  return {
    getEntries,
    recordPlay,
    updateProgress,
    toggleCompleted,
    removeEntry,
    clearAll,
    query,
  };
}
