/**
 * Pure file extension, path normalization, XML escaping, and URL query utilities.
 */

export const AUDIO_EXTENSIONS = Object.freeze(
  new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'weba'])
);

export const VIDEO_EXTENSIONS = Object.freeze(
  new Set(['mp4', 'webm', 'mkv', 'mov', 'ogv', 'm4v', 'avi'])
);

export const SUBTITLE_EXTENSIONS = Object.freeze(new Set(['vtt', 'srt']));

export const PLAYLIST_EXTENSIONS = Object.freeze(new Set(['xspf', 'm3u', 'm3u8', 'pls']));

export function getExtension(filename) {
  const str = String(filename || '');
  const idx = str.lastIndexOf('.');
  return idx >= 0 ? str.slice(idx + 1).toLowerCase() : '';
}

export function stripExtension(filename) {
  const str = String(filename || '');
  const idx = str.lastIndexOf('.');
  return idx > 0 ? str.slice(0, idx) : str;
}

export function getBaseName(filePath) {
  const str = String(filePath || '');
  const parts = str.split(/[\\/]/);
  return parts[parts.length - 1] || str;
}

export function classifyFile(file) {
  const name = typeof file === 'string' ? file : (file && file.name) || '';
  const mime = typeof file === 'object' && file ? String(file.type || '').toLowerCase() : '';
  const ext = getExtension(name);
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle';
  if (PLAYLIST_EXTENSIONS.has(ext)) return 'playlist';
  if (VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/')) return 'video';
  if (AUDIO_EXTENSIONS.has(ext) || mime.startsWith('audio/')) return 'audio';
  return 'unknown';
}

export function normalizeFsPath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

export function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Safely appends a query parameter to a URL that may already contain query parameters
 * (for example, authenticated Cast URLs like http://192.168.1.5:1234/media?token=...).
 */
export function appendQueryParam(url, key, value) {
  const base = String(url || '');
  if (!base) return '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}

export function sanitizeFileName(name, fallback = 'playlist') {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}
