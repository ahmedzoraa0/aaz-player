/**
 * Pure time formatting, byte formatting, and subtitle SRT/VTT conversion helpers.
 */

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

export function formatRelativeDate(timestampMs, lang = 'en') {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  const isAr = lang === 'ar';
  if (diffSec < 60) return isAr ? 'الآن' : 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return isAr ? `منذ ${diffMin} د` : `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return isAr ? `منذ ${diffHr} س` : `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return isAr ? `منذ ${diffDay} يوم` : `${diffDay}d ago`;
  try {
    return new Date(timestampMs).toLocaleDateString(isAr ? 'ar' : 'en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

export function formatVttTimestamp(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0);
  const ms = Math.round((clamped % 1) * 1000);
  const totalSec = Math.floor(clamped);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function parseVttTimestamp(raw) {
  const parts = String(raw || '').trim().replace(',', '.').split(':');
  if (parts.length === 3) {
    const h = parseFloat(parts[0]) || 0;
    const m = parseFloat(parts[1]) || 0;
    const s = parseFloat(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const m = parseFloat(parts[0]) || 0;
    const s = parseFloat(parts[1]) || 0;
    return m * 60 + s;
  }
  return 0;
}

export function srtToWebVtt(rawText, offsetSeconds = 0) {
  let text = String(rawText || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const isAlreadyVtt = /^\s*WEBVTT/i.test(text);
  if (isAlreadyVtt) {
    text = text.replace(/^\s*WEBVTT[^\n]*\n+/i, '');
  }
  const timeRegex =
    /(\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}/g;

  const shifted = text.replace(timeRegex, (match) => {
    const [startStr, endStr] = match.split('-->').map((s) => s.trim());
    const startSec = Math.max(0, parseVttTimestamp(startStr) + offsetSeconds);
    const endSec = Math.max(startSec + 0.05, parseVttTimestamp(endStr) + offsetSeconds);
    return `${formatVttTimestamp(startSec)} --> ${formatVttTimestamp(endSec)}`;
  });

  return `WEBVTT\n\n${shifted}`;
}
