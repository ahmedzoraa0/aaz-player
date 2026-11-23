/**
 * Shared Subtitle Styling Schema & Sanitizer (F08).
 *
 * Single source of truth used by:
 * - js/app/player-app.js (defaults, UI, DOM rendering, localStorage persistence)
 * - js/core/messaging.js (cross-tab & shell message sanitization)
 * - js/modules/storage-manager.js (backup export & restore validation)
 */

export const SUBTITLE_STYLE_DEFAULTS = Object.freeze({
  fontFamily: 'Cairo',
  fontSize: 28,
  fontWeight: '700',
  italic: false,
  textColor: '#ffffff',
  outlineColor: '#000000',
  outlineWidth: 2,
  bgColor: '#040a06',
  bgOpacity: 62,
  borderColor: '#3dc479',
  borderWidth: 0,
  borderRadius: 8,
  shadowBlur: 6,
  bottomOffset: 8,
});

const ALLOWED_FONT_WEIGHTS = new Set(['400', '500', '600', '700', '800', '900']);
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function clampNum(val, min, max, fallback, step = null) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  if (step && step > 0) {
    return Math.round(clamped / step) * step;
  }
  return clamped;
}

function sanitizeHexColor(val, fallback) {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  if (!HEX_COLOR_RE.test(trimmed)) return fallback;
  if (trimmed.length === 4) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return trimmed.toLowerCase();
}

function sanitizeFontFamily(val, fallback) {
  if (typeof val !== 'string') return fallback;
  if (/[;:(){}<>\\]/.test(val)) return fallback;
  const cleaned = val
    .replace(/[\r\n\t"']/g, '')
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

/**
 * Sanitizes a full or partial subtitle style object.
 * - Preserves all 14 canonical player fields within exact UI bounds.
 * - Migrates legacy messaging keys (`color`, `bold`, `position`, 0..1 `bgOpacity`) safely.
 * - Rejects malformed strings, CSS injection characters, NaN, and Infinity.
 *
 * @param {unknown} raw
 * @param {{ partial?: boolean }} [options]
 */
export function sanitizeSubtitleStyle(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return partial ? undefined : { ...SUBTITLE_STYLE_DEFAULTS };
  }

  const out = partial ? {} : { ...SUBTITLE_STYLE_DEFAULTS };

  if (raw.fontFamily !== undefined) {
    out.fontFamily = sanitizeFontFamily(raw.fontFamily, SUBTITLE_STYLE_DEFAULTS.fontFamily);
  }

  if (raw.fontSize !== undefined) {
    const n = Number(raw.fontSize);
    if (Number.isFinite(n)) {
      out.fontSize = clampNum(n, 14, 72, SUBTITLE_STYLE_DEFAULTS.fontSize, 1);
    }
  }

  if (raw.fontWeight !== undefined) {
    const w = String(raw.fontWeight).trim();
    if (ALLOWED_FONT_WEIGHTS.has(w)) {
      out.fontWeight = w;
    } else if (!partial) {
      out.fontWeight = SUBTITLE_STYLE_DEFAULTS.fontWeight;
    }
  } else if (typeof raw.bold === 'boolean') {
    out.fontWeight = raw.bold ? '700' : '400';
  }

  if (typeof raw.italic === 'boolean') {
    out.italic = raw.italic;
  }

  const rawTextColor = raw.textColor !== undefined ? raw.textColor : raw.color;
  if (rawTextColor !== undefined) {
    const c = sanitizeHexColor(rawTextColor, '');
    if (c) out.textColor = c;
  }

  if (raw.outlineColor !== undefined) {
    const c = sanitizeHexColor(raw.outlineColor, '');
    if (c) out.outlineColor = c;
  }

  if (raw.outlineWidth !== undefined) {
    const n = Number(raw.outlineWidth);
    if (Number.isFinite(n)) {
      out.outlineWidth = clampNum(n, 0, 6, SUBTITLE_STYLE_DEFAULTS.outlineWidth, 0.5);
    }
  }

  if (raw.bgColor !== undefined) {
    const c = sanitizeHexColor(raw.bgColor, '');
    if (c) out.bgColor = c;
  }

  if (raw.bgOpacity !== undefined) {
    let n = Number(raw.bgOpacity);
    if (Number.isFinite(n)) {
      // Legacy messaging schema used 0..1 float opacity while player UI uses 0..100%
      if (n > 0 && n < 1) {
        n = Math.round(n * 100);
      }
      out.bgOpacity = clampNum(n, 0, 100, SUBTITLE_STYLE_DEFAULTS.bgOpacity, 1);
    }
  }

  if (raw.borderColor !== undefined) {
    const c = sanitizeHexColor(raw.borderColor, '');
    if (c) out.borderColor = c;
  }

  if (raw.borderWidth !== undefined) {
    const n = Number(raw.borderWidth);
    if (Number.isFinite(n)) {
      out.borderWidth = clampNum(n, 0, 5, SUBTITLE_STYLE_DEFAULTS.borderWidth, 0.5);
    }
  }

  if (raw.borderRadius !== undefined) {
    const n = Number(raw.borderRadius);
    if (Number.isFinite(n)) {
      out.borderRadius = clampNum(n, 0, 22, SUBTITLE_STYLE_DEFAULTS.borderRadius, 1);
    }
  }

  if (raw.shadowBlur !== undefined) {
    const n = Number(raw.shadowBlur);
    if (Number.isFinite(n)) {
      out.shadowBlur = clampNum(n, 0, 16, SUBTITLE_STYLE_DEFAULTS.shadowBlur, 1);
    }
  }

  const rawBottom = raw.bottomOffset !== undefined ? raw.bottomOffset : raw.position;
  if (rawBottom !== undefined) {
    const n = Number(rawBottom);
    if (Number.isFinite(n)) {
      out.bottomOffset = clampNum(n, 2, 40, SUBTITLE_STYLE_DEFAULTS.bottomOffset, 1);
    }
  }

  if (partial && Object.keys(out).length === 0) return undefined;
  return out;
}
