/**
 * Pure Playlist Import/Export serializer and parser for .XSPF, .M3U/.M3U8, and .PLS.
 * Works identically in browser WebView2 and Node.js unit tests.
 */

import { escapeXml, unescapeXml, getExtension, stripExtension, getBaseName } from '../utils/file-utils.js';

const RUNTIME_URL_RE = /^(?:blob:|data:|aazmedia:|https?:\/\/aazmedia\.localhost(?:\/|$))/i;

export function isRuntimeOnlyLocation(loc) {
  return RUNTIME_URL_RE.test(String(loc || '').trim());
}

/**
 * Encodes a filesystem path (Windows drive, UNC share, or POSIX) as an RFC 8089 `file://` URI
 * suitable for XSPF `<location>` (preserving Unicode, spaces, `#`, `%`, `&`, and UNC hosts).
 */
export function pathToFileUri(rawPath) {
  const s = String(rawPath || '').trim();
  if (!s) return '';
  if (/^file:\/\//i.test(s)) return s;

  // Strip Windows extended-length prefixes
  let cleaned = s;
  if (cleaned.startsWith('\\\\?\\UNC\\') || cleaned.startsWith('//?/UNC/')) {
    cleaned = '\\\\' + cleaned.slice(8);
  } else if (cleaned.startsWith('\\\\?\\') || cleaned.startsWith('//?/')) {
    cleaned = cleaned.slice(4);
  }

  const encodeSeg = (seg) =>
    encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  // UNC path: \\server\share\dir\file.mp4 -> file://server/share/dir/file.mp4
  if (cleaned.startsWith('\\\\') || cleaned.startsWith('//')) {
    const parts = cleaned.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
    if (parts.length >= 2 && parts[0]) {
      const host = parts[0];
      const rest = parts.slice(1).map(encodeSeg).join('/');
      return `file://${host}/${rest}`;
    }
  }

  // Windows drive path: C:\Dir\a #1.mp4 -> file:///C:/Dir/a%20%231.mp4
  if (/^[a-zA-Z]:[\\/]/.test(cleaned)) {
    const forward = cleaned.replace(/\\/g, '/');
    const drive = forward.slice(0, 2);
    const rest = forward
      .slice(3)
      .split('/')
      .map(encodeSeg)
      .join('/');
    return `file:///${drive}/${rest}`;
  }

  // POSIX absolute path: /home/user/clip.mp4 -> file:///home/user/clip.mp4
  if (cleaned.startsWith('/')) {
    const rest = cleaned
      .slice(1)
      .split('/')
      .map(encodeSeg)
      .join('/');
    return `file:///${rest}`;
  }

  // Relative path: encode segments cleanly without adding a fake root
  return cleaned
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => (seg === '.' || seg === '..' ? seg : encodeSeg(seg)))
    .join('/');
}

/**
 * Decodes a `file://` URI back into a native filesystem path (Windows drive, UNC, or POSIX).
 */
export function fileUriToPath(raw) {
  let loc = String(raw || '').trim();
  if (!loc) return '';
  if (!/^file:\/\//i.test(loc)) return loc;

  let after = loc.slice(7); // strip "file://"
  // Handle file://localhost/C:/...
  if (/^localhost\//i.test(after)) {
    after = after.slice('localhost'.length);
  }

  const decodeSafe = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  // file:///C:/... or file:///home/...
  if (after.startsWith('/')) {
    const decoded = decodeSafe(after);
    if (/^\/[a-zA-Z]:\//.test(decoded)) {
      return decoded.slice(1);
    }
    return decoded;
  }

  // UNC: file://server/share/... -> \\server\share\...
  const slashIdx = after.indexOf('/');
  if (slashIdx > 0) {
    const host = after.slice(0, slashIdx);
    const rest = decodeSafe(after.slice(slashIdx + 1)).replace(/\//g, '\\');
    return `\\\\${host}\\${rest}`;
  }

  return decodeSafe(after);
}

/**
 * Resolves a playlist entry location relative to the directory containing the playlist file.
 * Preserves absolute paths, UNC paths, and `http(s)://` URLs; rejects runtime-only URLs.
 */
export function resolvePlaylistLocation(rawLocation, playlistFilePath = '') {
  const decoded = fileUriToPath(rawLocation);
  if (!decoded || isRuntimeOnlyLocation(decoded)) return '';

  // Already absolute (Windows drive, UNC, POSIX root, or external HTTP(S))
  if (
    /^[a-zA-Z]:[\\/]/.test(decoded) ||
    decoded.startsWith('\\\\') ||
    decoded.startsWith('//') ||
    decoded.startsWith('/') ||
    /^https?:\/\//i.test(decoded)
  ) {
    return decoded;
  }

  const baseRaw = String(playlistFilePath || '').trim();
  if (!baseRaw) return decoded;

  const isWinBase = /^[a-zA-Z]:[\\/]/.test(baseRaw) || baseRaw.startsWith('\\\\');
  const isUncBase = baseRaw.startsWith('\\\\') || baseRaw.startsWith('//');
  const normBase = baseRaw.replace(/\\/g, '/');
  const lastSlash = normBase.lastIndexOf('/');
  if (lastSlash < 0) return decoded;

  const baseDir = normBase.slice(0, lastSlash);
  const relParts = decoded.replace(/\\/g, '/').split('/');

  let prefix = '';
  let stack = [];
  if (isUncBase) {
    const segs = baseDir.replace(/^\/+/, '').split('/').filter(Boolean);
    if (segs.length >= 2) {
      prefix = `\\\\${segs[0]}\\${segs[1]}`;
      stack = segs.slice(2);
    }
  } else if (/^[a-zA-Z]:/.test(baseDir)) {
    prefix = baseDir.slice(0, 2);
    stack = baseDir.slice(2).split('/').filter(Boolean);
  } else if (baseDir.startsWith('/')) {
    prefix = '/';
    stack = baseDir.slice(1).split('/').filter(Boolean);
  } else {
    stack = baseDir.split('/').filter(Boolean);
  }

  for (const part of relParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }

  if (isUncBase && prefix) {
    return stack.length > 0 ? `${prefix}\\${stack.join('\\')}` : prefix;
  }
  if (isWinBase && prefix) {
    return `${prefix}/${stack.join('/')}`;
  }
  if (prefix === '/') {
    return `/${stack.join('/')}`;
  }
  return stack.join('/');
}

function pickExportLocation(tr) {
  const candidates = [tr?.fullPath, tr?.relPath, tr?.key, tr?.name];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || isRuntimeOnlyLocation(trimmed)) continue;
    // Strip internal `fs:` / `rel:` identity prefixes if falling back to key
    if (trimmed.startsWith('fs:')) return trimmed.slice(3);
    if (trimmed.startsWith('rel:')) return trimmed.slice(4);
    return trimmed;
  }
  return '';
}

export function buildPlaylistExport(tracks, format, playlistName = 'AZ0 Playlist') {
  const fmt = String(format || 'xspf').toLowerCase();
  const safeList = Array.isArray(tracks) ? tracks : [];
  let exportedCount = 0;
  let skippedCount = 0;

  if (fmt === 'm3u8' || fmt === 'm3u') {
    const lines = ['#EXTM3U', `#PLAYLIST:${String(playlistName || 'AZ0 Playlist').replace(/[\r\n]+/g, ' ')}`];
    for (const tr of safeList) {
      const loc = pickExportLocation(tr);
      if (!loc) {
        skippedCount += 1;
        continue;
      }
      const dur = Number.isFinite(tr.duration) && tr.duration > 0 ? Math.round(tr.duration) : -1;
      const title = String(tr.displayName || tr.title || tr.name || 'Track').replace(/[\r\n]+/g, ' ');
      lines.push(`#EXTINF:${dur},${title}`);
      lines.push(loc);
      exportedCount += 1;
    }
    return {
      content: lines.join('\n') + '\n',
      mime: 'audio/x-mpegurl;charset=utf-8',
      ext: fmt === 'm3u' ? 'm3u' : 'm3u8',
      exportedCount,
      skippedCount,
    };
  }

  if (fmt === 'pls') {
    const lines = ['[playlist]'];
    for (const tr of safeList) {
      const loc = pickExportLocation(tr);
      if (!loc) {
        skippedCount += 1;
        continue;
      }
      exportedCount += 1;
      const title = String(tr.displayName || tr.title || tr.name || 'Track').replace(/[\r\n]+/g, ' ');
      const dur = Number.isFinite(tr.duration) && tr.duration > 0 ? Math.round(tr.duration) : -1;
      lines.push(`File${exportedCount}=${loc}`);
      lines.push(`Title${exportedCount}=${title}`);
      lines.push(`Length${exportedCount}=${dur}`);
    }
    lines.push(`NumberOfEntries=${exportedCount}`);
    lines.push('Version=2');
    return {
      content: lines.join('\n') + '\n',
      mime: 'audio/x-scpls;charset=utf-8',
      ext: 'pls',
      exportedCount,
      skippedCount,
    };
  }

  // Default: XSPF with valid encoded file:// URIs for filesystem paths
  const trackBlocks = [];
  for (const tr of safeList) {
    const rawLoc = pickExportLocation(tr);
    if (!rawLoc) {
      skippedCount += 1;
      continue;
    }
    const loc = pathToFileUri(rawLoc);
    const title = tr.displayName || tr.title || tr.name || 'Track';
    const durMs =
      Number.isFinite(tr.duration) && tr.duration > 0 ? Math.round(tr.duration * 1000) : null;
    trackBlocks.push(
      [
        '    <track>',
        `      <location>${escapeXml(loc)}</location>`,
        `      <title>${escapeXml(title)}</title>`,
        durMs ? `      <duration>${durMs}</duration>` : '',
        '    </track>',
      ]
        .filter(Boolean)
        .join('\n')
    );
    exportedCount += 1;
  }

  const xspf = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
    `  <title>${escapeXml(playlistName || 'AZ0 Playlist')}</title>`,
    '  <trackList>',
    trackBlocks.join('\n'),
    '  </trackList>',
    '</playlist>',
    '',
  ].join('\n');

  return {
    content: xspf,
    mime: 'application/xspf+xml;charset=utf-8',
    ext: 'xspf',
    exportedCount,
    skippedCount,
  };
}

function decodeLocation(raw, baseFilePath = '') {
  return resolvePlaylistLocation(raw, baseFilePath);
}

function parseXspfRegexFallback(rawText, baseFilePath = '') {
  const entries = [];
  const trackRegex = /<track\b[^>]*>([\s\S]*?)<\/track>/gi;
  let match;
  while ((match = trackRegex.exec(rawText)) !== null) {
    const block = match[1];
    const locMatch = block.match(/<location\b[^>]*>([\s\S]*?)<\/location>/i);
    const titleMatch = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const durMatch = block.match(/<duration\b[^>]*>([\s\S]*?)<\/duration>/i);

    const loc = decodeLocation(unescapeXml(locMatch ? locMatch[1] : ''), baseFilePath);
    const title = unescapeXml(titleMatch ? titleMatch[1] : '').trim();
    const durMs = durMatch ? Number(durMatch[1].trim()) : NaN;
    if (loc) {
      entries.push({
        location: loc,
        title: title || stripExtension(getBaseName(loc)),
        duration: Number.isFinite(durMs) && durMs > 0 ? durMs / 1000 : null,
      });
    }
  }
  return entries;
}

export function parsePlaylistText(rawText, fileName = 'playlist.m3u8', baseFilePath = '') {
  const text = String(rawText || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return [];
  const ext = getExtension(fileName);

  // XSPF
  if (ext === 'xspf' || /<playlist\b/i.test(text)) {
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (!doc.querySelector('parsererror')) {
          const nodes = Array.from(doc.getElementsByTagName('track'));
          const parsed = [];
          for (const node of nodes) {
            const locEl = node.getElementsByTagName('location')[0];
            const titleEl = node.getElementsByTagName('title')[0];
            const durEl = node.getElementsByTagName('duration')[0];
            const loc = decodeLocation(locEl ? locEl.textContent : '', baseFilePath);
            if (!loc) continue;
            const title = (titleEl ? titleEl.textContent : '').trim();
            const durMs = durEl ? Number(durEl.textContent) : NaN;
            parsed.push({
              location: loc,
              title: title || stripExtension(getBaseName(loc)),
              duration: Number.isFinite(durMs) && durMs > 0 ? durMs / 1000 : null,
            });
          }
          return parsed;
        }
      } catch {
        // Fall through to regex parser
      }
    }
    return parseXspfRegexFallback(text, baseFilePath);
  }

  // PLS
  if (ext === 'pls' || /^\s*\[playlist\]/im.test(text)) {
    const map = new Map();
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const m = line.match(/^(File|Title|Length)(\d+)\s*=\s*(.*)$/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const idx = Number(m[2]);
      const val = m[3].trim();
      if (!map.has(idx)) map.set(idx, { location: '', title: '', duration: null });
      const item = map.get(idx);
      if (key === 'file') item.location = decodeLocation(val, baseFilePath);
      else if (key === 'title') item.title = val;
      else if (key === 'length') {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) item.duration = n;
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => ({
        location: item.location,
        title: item.title || stripExtension(getBaseName(item.location)),
        duration: item.duration,
      }))
      .filter((item) => Boolean(item.location));
  }

  // M3U / M3U8
  const lines = text.split(/\r?\n/);
  const entries = [];
  let pendingTitle = '';
  let pendingDuration = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const rest = line.slice(8);
      const commaIdx = rest.indexOf(',');
      if (commaIdx >= 0) {
        const dur = Number(rest.slice(0, commaIdx).trim());
        pendingDuration = Number.isFinite(dur) && dur > 0 ? dur : null;
        pendingTitle = rest.slice(commaIdx + 1).trim();
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    const loc = decodeLocation(line, baseFilePath);
    if (!loc) continue;
    entries.push({
      location: loc,
      title: pendingTitle || stripExtension(getBaseName(loc)),
      duration: pendingDuration,
    });
    pendingTitle = '';
    pendingDuration = null;
  }

  return entries;
}

/**
 * Filters and orders tracks according to a saved playlist's trackKeys (F11).
 * When `strictFilter` is true, returns ONLY matched tracks (including `[]` if zero match).
 */
export function filterTracksBySavedPlaylist(tracks, savedKeys, strictFilter = false) {
  const safeTracks = Array.isArray(tracks) ? tracks : [];
  if (!Array.isArray(savedKeys) || savedKeys.length === 0) {
    return strictFilter ? [] : safeTracks;
  }
  const byKey = new Map(safeTracks.map((tr) => [tr.key, tr]));
  const ordered = [];
  for (const k of savedKeys) {
    const found = byKey.get(k);
    if (found) {
      ordered.push(found);
      byKey.delete(k);
    }
  }
  if (strictFilter) return ordered;
  for (const rem of byKey.values()) ordered.push(rem);
  return ordered;
}
