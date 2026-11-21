/**
 * Media Library Manager (Phase 3 Feature 6).
 *
 * Manages user-selected folders only (never scans the computer automatically).
 * Persists folder paths + cached file metadata, supports rescanning, folder removal,
 * search by filename, filter by media type (all/audio/video), and sort by
 * name, modification date (mtimeMs), or duration.
 */

import { stripExtension, normalizeFsPath } from '../utils/file-utils.js';

export function createLibraryManager({ getStore, persist }) {
  function getLibrary() {
    const store = getStore();
    if (!store.mediaLibrary || typeof store.mediaLibrary !== 'object') {
      store.mediaLibrary = { folders: [] };
    }
    if (!Array.isArray(store.mediaLibrary.folders)) {
      store.mediaLibrary.folders = [];
    }
    return store.mediaLibrary;
  }

  function normalizeScannedItems(rawEntries, folderPath) {
    if (!Array.isArray(rawEntries)) return [];
    const items = [];
    for (const entry of rawEntries) {
      if (!entry || !entry.name) continue;
      if (entry.kind !== 'audio' && entry.kind !== 'video') continue;
      items.push({
        name: String(entry.name),
        title: stripExtension(entry.name),
        kind: entry.kind,
        fullPath: entry.fullPath || null,
        relPath: entry.relPath || entry.name,
        folderPath: folderPath || null,
        size: Math.max(0, Number(entry.size) || 0),
        mtimeMs: Math.max(0, Number(entry.mtimeMs) || 0),
        duration:
          Number.isFinite(Number(entry.duration)) && Number(entry.duration) > 0
            ? Number(entry.duration)
            : null,
      });
    }
    return items;
  }

  function addOrUpdateFolder(folderPath, folderName, rawEntries) {
    const cleanPath = String(folderPath || '').trim();
    if (!cleanPath) return null;

    const lib = getLibrary();
    const normTarget = normalizeFsPath(cleanPath);
    const existing = lib.folders.find((f) => normalizeFsPath(f.path) === normTarget);

    // Preserve known durations across rescans
    const durationMap = new Map();
    if (existing && Array.isArray(existing.items)) {
      for (const it of existing.items) {
        if (it.fullPath && it.duration) {
          durationMap.set(normalizeFsPath(it.fullPath), it.duration);
        }
      }
    }

    const items = normalizeScannedItems(rawEntries, cleanPath).map((it) => {
      if (!it.duration && it.fullPath) {
        const cachedDur = durationMap.get(normalizeFsPath(it.fullPath));
        if (cachedDur) it.duration = cachedDur;
      }
      return it;
    });

    const now = Date.now();
    if (existing) {
      existing.name = folderName || existing.name || cleanPath;
      existing.lastScannedAt = now;
      existing.items = items;
      persist();
      return existing;
    }

    const folderObj = {
      path: cleanPath,
      name: folderName || cleanPath.split(/[\\/]/).filter(Boolean).pop() || cleanPath,
      addedAt: now,
      lastScannedAt: now,
      items,
    };
    lib.folders.push(folderObj);
    persist();
    return folderObj;
  }

  function removeFolder(folderPath) {
    const lib = getLibrary();
    const normTarget = normalizeFsPath(folderPath);
    const idx = lib.folders.findIndex((f) => normalizeFsPath(f.path) === normTarget);
    if (idx === -1) return false;
    lib.folders.splice(idx, 1);
    persist();
    return true;
  }

  function updateItemDuration(fullPath, durationSec) {
    if (!fullPath || !Number.isFinite(durationSec) || durationSec <= 0) return false;
    const norm = normalizeFsPath(fullPath);
    const lib = getLibrary();
    let changed = false;
    for (const folder of lib.folders) {
      for (const item of folder.items) {
        if (item.fullPath && normalizeFsPath(item.fullPath) === norm) {
          if (Math.abs((item.duration || 0) - durationSec) > 0.5) {
            item.duration = durationSec;
            changed = true;
          }
        }
      }
    }
    if (changed) persist();
    return changed;
  }

  function getFolders() {
    return getLibrary().folders;
  }

  function queryItems({ search = '', type = 'all', sortBy = 'name', folderPath = '' } = {}) {
    const q = String(search || '').trim().toLowerCase();
    const normFolder = folderPath ? normalizeFsPath(folderPath) : '';
    const lib = getLibrary();

    const results = [];
    for (const folder of lib.folders) {
      if (normFolder && normalizeFsPath(folder.path) !== normFolder) continue;
      for (const item of folder.items) {
        if (type === 'audio' && item.kind !== 'audio') continue;
        if (type === 'video' && item.kind !== 'video') continue;
        if (q) {
          const hay = `${item.title} ${item.name} ${folder.name}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        results.push({
          ...item,
          folderPath: folder.path,
          folderName: folder.name,
        });
      }
    }

    if (sortBy === 'date') {
      results.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    } else if (sortBy === 'duration') {
      results.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    } else {
      results.sort((a, b) =>
        String(a.title || a.name).localeCompare(String(b.title || b.name), undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );
    }

    return results;
  }

  return {
    getFolders,
    addOrUpdateFolder,
    removeFolder,
    updateItemDuration,
    queryItems,
  };
}
