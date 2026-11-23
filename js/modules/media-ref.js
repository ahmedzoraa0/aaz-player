/**
 * Canonical Cross-Platform MediaRef Model (R10).
 *
 * Unifies desktop file paths (`path`), Android SAF document URIs (`contentUri`),
 * and Android MediaStore URIs (`mediaStoreUri`) across JS and Rust without
 * collapsing distinct items that share a filename.
 */

export const MEDIA_REF_KINDS = Object.freeze({
  PATH: 'path',
  CONTENT_URI: 'contentUri',
  MEDIA_STORE_URI: 'mediaStoreUri',
});

export function isContentUriValue(value) {
  return typeof value === 'string' && /^content:\/\//i.test(value.trim());
}

export function isMediaStoreUriValue(value) {
  return typeof value === 'string' && /^content:\/\/media\//i.test(value.trim());
}

export function detectMediaRefKind(rawValue, explicitKind = '') {
  if (
    explicitKind === MEDIA_REF_KINDS.PATH ||
    explicitKind === MEDIA_REF_KINDS.CONTENT_URI ||
    explicitKind === MEDIA_REF_KINDS.MEDIA_STORE_URI
  ) {
    return explicitKind;
  }
  if (isMediaStoreUriValue(rawValue)) return MEDIA_REF_KINDS.MEDIA_STORE_URI;
  if (isContentUriValue(rawValue)) return MEDIA_REF_KINDS.CONTENT_URI;
  return MEDIA_REF_KINDS.PATH;
}

export function createMediaRef({
  kind = '',
  value = '',
  displayName = '',
  size = null,
  mtimeMs = null,
  folderKey = null,
} = {}) {
  const cleanValue = String(value || '').trim();
  const resolvedKind = detectMediaRefKind(cleanValue, kind);
  const cleanName =
    String(displayName || '').trim() ||
    cleanValue.split(/[\\/]/).filter(Boolean).pop() ||
    'track';
  const ref = {
    kind: resolvedKind,
    value: cleanValue,
    displayName: cleanName,
  };
  if (Number.isFinite(size) && size >= 0) ref.size = Number(size);
  if (Number.isFinite(mtimeMs) && mtimeMs > 0) ref.mtimeMs = Number(mtimeMs);
  if (typeof folderKey === 'string' && folderKey.trim()) {
    ref.folderKey = folderKey.trim();
  }
  return ref;
}

export function mediaRefFromTrack(track) {
  if (!track || typeof track !== 'object') return null;
  if (track.mediaRef && typeof track.mediaRef === 'object' && track.mediaRef.value) {
    return createMediaRef(track.mediaRef);
  }
  const rawVal = track.contentUri || track.fullPath || '';
  if (!rawVal) return null;
  return createMediaRef({
    value: rawVal,
    displayName: track.name || track.title || '',
    size: track.size,
    mtimeMs: track.mtimeMs ?? track.lastModified,
    folderKey: track.folderKey || track.folderPath || null,
  });
}

export function mediaRefToCanonicalKey(ref, normalizePathFn) {
  if (!ref || !ref.value) return '';
  const cleanValue = String(ref.value).trim();
  const kind = detectMediaRefKind(cleanValue, ref.kind);
  if (kind === MEDIA_REF_KINDS.MEDIA_STORE_URI) {
    return `ms:${cleanValue}`;
  }
  if (kind === MEDIA_REF_KINDS.CONTENT_URI) {
    return `uri:${cleanValue}`;
  }
  const norm = typeof normalizePathFn === 'function' ? normalizePathFn(cleanValue) : cleanValue;
  return norm ? `fs:${norm}` : '';
}
