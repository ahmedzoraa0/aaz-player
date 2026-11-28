/**
 * Split View helpers (pure functions, no DOM): preferences, orientation and geometry.
 * The Workspace Shell applies the geometry to the two tab iframes and the divider.
 */

export const SPLIT_PREFS_KEY = 'aaz_split_prefs';
export const SPLIT_DIVIDER_PX = 8;
export const SPLIT_MIN_RATIO = 0.2;
export const SPLIT_MAX_RATIO = 0.8;
/** Below this host width the two sides are stacked (phones / narrow windows). */
export const SPLIT_STACK_BREAKPOINT = 760;
/** Side-by-side needs at least this much width, even when the user asked for it. */
export const SPLIT_MIN_SIDE_BY_SIDE = 520;

const ORIENTATIONS = new Set(['auto', 'h', 'v']);

export function clampSplitRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, n));
}

export function sanitizeSplitPrefs(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ratio: clampSplitRatio(src.ratio === undefined ? 0.5 : src.ratio),
    orientation: ORIENTATIONS.has(src.orientation) ? src.orientation : 'auto',
    // When true only the focused side is audible (the other one is auto-muted)
    soloAudio: src.soloAudio === true,
  };
}

/** 'h' = side by side, 'v' = stacked. `pref` may be 'auto' | 'h' | 'v'. */
export function resolveSplitOrientation(pref, hostWidth) {
  const w = Number(hostWidth);
  if (pref === 'v') return 'v';
  if (pref === 'h') return w < SPLIT_MIN_SIDE_BY_SIDE ? 'v' : 'h';
  return w < SPLIT_STACK_BREAKPOINT ? 'v' : 'h';
}

/**
 * Computes integer pixel rectangles for the first side, divider and second side.
 * Rectangles never overlap and always fill the host exactly.
 */
export function computeSplitLayout({ ratio, orientation, hostWidth, hostHeight, dividerPx = SPLIT_DIVIDER_PX }) {
  const w = Math.max(0, Math.floor(Number(hostWidth) || 0));
  const h = Math.max(0, Math.floor(Number(hostHeight) || 0));
  const r = clampSplitRatio(ratio);
  const dv = Math.max(0, Math.floor(dividerPx));
  if (orientation === 'v') {
    const usable = Math.max(0, h - dv);
    const firstH = Math.round(usable * r);
    return {
      orientation: 'v',
      first: { x: 0, y: 0, w, h: firstH },
      divider: { x: 0, y: firstH, w, h: dv },
      second: { x: 0, y: firstH + dv, w, h: usable - firstH },
    };
  }
  const usable = Math.max(0, w - dv);
  const firstW = Math.round(usable * r);
  return {
    orientation: 'h',
    first: { x: 0, y: 0, w: firstW, h },
    divider: { x: firstW, y: 0, w: dv, h },
    second: { x: firstW + dv, y: 0, w: usable - firstW, h },
  };
}

/** Converts a pointer position (relative to the host's top-left) into a clamped ratio, snapping to 50%. */
export function ratioFromPointer({ pointer, hostWidth, hostHeight, orientation, dividerPx = SPLIT_DIVIDER_PX }) {
  const total = orientation === 'v' ? hostHeight : hostWidth;
  const usable = Math.max(1, total - dividerPx);
  const raw = (Number(pointer) - dividerPx / 2) / usable;
  const clamped = clampSplitRatio(raw);
  return Math.abs(clamped - 0.5) < 0.02 ? 0.5 : clamped;
}

/** Tabs that can be shown beside `primaryId` (every other tab). */
export function listSplitCandidates(tabs, primaryId) {
  return (Array.isArray(tabs) ? tabs : []).filter((tb) => tb && tb.id !== primaryId);
}
