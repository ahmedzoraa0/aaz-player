/**
 * Pure Playlist Import/Export serializer and parser for .XSPF, .M3U/.M3U8, and .PLS.
 * Works identically in browser WebView2 and Node.js unit tests.
 */

import { escapeXml, unescapeXml, getExtension, stripExtension, getBaseName } from '../utils/file-utils.js';

export function buildPlaylistExport(tracks, format, playlistName = 'AAZ Playlist') {
  const fmt = String(format || 'xspf').toLowerCase();
  const safeList = Array.isArray(tracks) ? tracks : [];

  if (fmt === 'm3u8' || fmt === 'm3u') {
    const lines = ['#EXTM3U', `#PLAYLIST:${String(playlistName || 'AAZ Playlist').replace(/[\r\n]+/g, ' ')}`];
    for (const tr of safeList) {
      const dur = Number.isFinite(tr.duration) && tr.duration > 0 ? Math.round(tr.duration) : -1;
      const title = String(tr.title || tr.name || 'Track').replace(/[\r\n]+/g, ' ');
      const loc = tr.fullPath || tr.relPath || tr.name || '';
      lines.push(`#EXTINF:${dur},${title}`);
      lines.push(loc);
    }
    return {
      content: lines.join('\n') + '\n',
      mime: 'audio/x-mpegurl;charset=utf-8',
      ext: fmt === 'm3u' ? 'm3u' : 'm3u8',
    };
  }

  if (fmt === 'pls') {
    const lines = ['[playlist]'];
    safeList.forEach((tr, idx) => {
      const n = idx + 1;
      const loc = tr.fullPath || tr.relPath || tr.name || '';
      const title = String(tr.title || tr.name || 'Track').replace(/[\r\n]+/g, ' ');
      const dur = Number.isFinite(tr.duration) && tr.duration > 0 ? Math.round(tr.duration) : -1;
      lines.push(`File${n}=${loc}`);
      lines.push(`Title${n}=${title}`);
      lines.push(`Length${n}=${dur}`);
    });
    lines.push(`NumberOfEntries=${safeList.length}`);
    lines.push('Version=2');
    return {
      content: lines.join('\n') + '\n',
      mime: 'audio/x-scpls;charset=utf-8',
      ext: 'pls',
    };
  }

  // Default: XSPF
  const trackXml = safeList
    .map((tr) => {
      const loc = tr.fullPath || tr.relPath || tr.name || '';
      const title = tr.title || tr.name || 'Track';
      const durMs =
        Number.isFinite(tr.duration) && tr.duration > 0 ? Math.round(tr.duration * 1000) : null;
      return [
        '    <track>',
        `      <location>${escapeXml(loc)}</location>`,
        `      <title>${escapeXml(title)}</title>`,
        durMs ? `      <duration>${durMs}</duration>` : '',
        '    </track>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const xspf = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
    `  <title>${escapeXml(playlistName || 'AAZ Playlist')}</title>`,
    '  <trackList>',
    trackXml,
    '  </trackList>',
    '</playlist>',
    '',
  ].join('\n');

  return {
    content: xspf,
    mime: 'application/xspf+xml;charset=utf-8',
    ext: 'xspf',
  };
}

function decodeLocation(raw) {
  let loc = String(raw || '').trim();
  if (!loc) return '';
  if (/^file:\/\//i.test(loc)) {
    loc = loc.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
    try {
      loc = decodeURIComponent(loc);
    } catch {
      // Keep original if percent-encoding is malformed
    }
  }
  return loc;
}

function parseXspfRegexFallback(rawText) {
  const entries = [];
  const trackRegex = /<track\b[^>]*>([\s\S]*?)<\/track>/gi;
  let match;
  while ((match = trackRegex.exec(rawText)) !== null) {
    const block = match[1];
    const locMatch = block.match(/<location\b[^>]*>([\s\S]*?)<\/location>/i);
    const titleMatch = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const durMatch = block.match(/<duration\b[^>]*>([\s\S]*?)<\/duration>/i);

    const loc = decodeLocation(unescapeXml(locMatch ? locMatch[1] : ''));
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

export function parsePlaylistText(rawText, fileName = 'playlist.m3u8') {
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
            const loc = decodeLocation(locEl ? locEl.textContent : '');
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
    return parseXspfRegexFallback(text);
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
      if (key === 'file') item.location = decodeLocation(val);
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
    const loc = decodeLocation(line);
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
