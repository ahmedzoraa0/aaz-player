/**
 * Canonical Track Identity & Safe Disambiguation Helpers (F03).
 *
 * Guarantees that distinct files sharing a basename (e.g. C:/A/movie.mp4 and C:/B/movie.mp4)
 * never collapse to the same key, while keeping displayName cleanly separated from identity.
 */

export function normalizeWindowsPath(rawPath) {
  let s = String(rawPath || '').trim();
  if (!s) return '';
  // Strip Windows extended-length prefixes (\\?\C:\... or \\?\UNC\server\share\...)
  if (s.startsWith('\\\\?\\UNC\\') || s.startsWith('//?/UNC/')) {
    s = '\\\\' + s.slice(8);
  } else if (s.startsWith('\\\\?\\') || s.startsWith('//?/')) {
    s = s.slice(4);
  }
  const isUnc = s.startsWith('\\\\') || s.startsWith('//');
  const forward = s.replace(/\\/g, '/').replace(/\/+/g, '/');
  const restored = isUnc ? '//' + forward.replace(/^\/+/, '') : forward;
  return restored.replace(/\/$/, '').toLowerCase();
}

export function extractParentFolderLabel(rawPath) {
  const norm = normalizeWindowsPath(rawPath);
  if (!norm) return '';
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return '';
  const dirPart = String(rawPath || '')
    .trim()
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/');
  const slashIdx = dirPart.lastIndexOf('/');
  if (slashIdx <= 0) return '';
  const parent = dirPart.slice(0, slashIdx);
  const segs = parent.split('/').filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : '';
}

/**
 * Computes a stable, collision-resistant canonical track key.
 * - Desktop paths: `fs:<normalized-full-path>`
 * - Browser folder scans / relative paths: `rel:<root>/<relative-path>` (or `<relative-path>` when root empty)
 * - Standalone browser File objects without path: disambiguated with size/mtime/occurrence index
 */
export function buildCanonicalTrackKey({
  fullPath = '',
  relPath = '',
  rootId = '',
  name = '',
  size = null,
  lastModified = null,
  usedKeys = null,
} = {}) {
  let candidate = '';
  const normFull = normalizeWindowsPath(fullPath);
  if (normFull) {
    candidate = `fs:${normFull}`;
  } else if (relPath) {
    const cleanRel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanRoot = String(rootId || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    candidate = cleanRoot ? `rel:${cleanRoot}/${cleanRel}` : cleanRel;
  } else {
    const cleanName = String(name || 'track').trim();
    const hasMeta =
      (Number.isFinite(size) && size > 0) || (Number.isFinite(lastModified) && lastModified > 0);
    candidate = hasMeta
      ? `file:${cleanName}#${Number(size) || 0}:${Number(lastModified) || 0}`
      : cleanName;
  }

  if (usedKeys instanceof Set) {
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
    let idx = 2;
    while (usedKeys.has(`${candidate}#${idx}`)) {
      idx += 1;
    }
    const unique = `${candidate}#${idx}`;
    usedKeys.add(unique);
    return unique;
  }

  return candidate;
}

/**
 * Safely finds a track in a queue by fullPath or exact key.
 * Never falls back to bare basename when multiple tracks share the same name
 * or when the caller explicitly supplied a different fullPath.
 */
export function findTrackSafely(tracks, query = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const qPath = query.fullPath ? normalizeWindowsPath(query.fullPath) : '';
  const qKey = typeof query.key === 'string' ? query.key : '';
  const qName = typeof query.name === 'string' ? query.name : '';

  if (qPath) {
    const byPath = tracks.find((tr) => tr && tr.fullPath && normalizeWindowsPath(tr.fullPath) === qPath);
    if (byPath) return byPath;
    // Caller specified a concrete disk path that does not match any track in queue —
    // do NOT fall back to a different file that happens to share the same filename.
    return null;
  }

  if (qKey) {
    const byKey = tracks.find((tr) => tr && tr.key === qKey);
    if (byKey) return byKey;
  }

  if (qName) {
    const matches = tracks.filter((tr) => tr && tr.name === qName);
    if (matches.length === 1) return matches[0];
  }

  return null;
}

/**
 * Deduplicates a list of tracks conservatively:
 * - Desktop tracks with fullPath: deduplicate strictly by normalized fullPath.
 * - Tracks without fullPath: deduplicate strictly by exact canonical key (never by bare name+size alone).
 */
export function deduplicateTracksSafely(tracks) {
  const kept = [];
  const removed = [];
  const seenPaths = new Set();
  const seenKeys = new Set();

  for (const tr of Array.isArray(tracks) ? tracks : []) {
    if (!tr) continue;
    const normPath = tr.fullPath ? normalizeWindowsPath(tr.fullPath) : '';
    if (normPath) {
      if (seenPaths.has(normPath)) {
        removed.push(tr);
        continue;
      }
      seenPaths.add(normPath);
      if (tr.key) seenKeys.add(tr.key);
      kept.push(tr);
      continue;
    }

    const key = tr.key || '';
    if (key && seenKeys.has(key)) {
      removed.push(tr);
      continue;
    }
    if (key) seenKeys.add(key);
    kept.push(tr);
  }

  return { kept, removed };
}

/**
 * Reads per-track map data (progress, bookmarks, starred/watched) preferring the
 * canonical key and safely supporting legacy bare-filename keys ONLY when
 * there is no ambiguity (i.e. unique basename in the current track list and
 * no canonical entry already exists).
 */
export function lookupLegacyKeyFallback(track, allTracks = []) {
  if (!track || !track.name) return null;
  const sameNameCount = Array.isArray(allTracks)
    ? allTracks.filter((t) => t && t.name === track.name).length
    : 1;
  if (sameNameCount > 1) return null;
  return track.name !== track.key ? track.name : null;
}
