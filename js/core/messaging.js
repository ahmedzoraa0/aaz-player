/**
 * Hardened Cross-Window Messaging Layer (Phase 1 Security Hardening).
 *
 * Enforces:
 * - Explicit targetOrigin (never '*' when a real origin exists)
 * - Strict event.origin validation
 * - Strict event.source window identity validation
 * - Strict allowlist of message types
 * - Strict tabId matching and payload schema validation
 */

export const TAB_TO_SHELL_TYPES = Object.freeze(
  new Set([
    'aaz-tab-ready',
    'aaz-tab-state',
    'aaz-new-tab',
    'aaz-close-tab',
    'aaz-cycle-tab',
    'aaz-activate-index',
    'aaz-shell-fullscreen',
    'aaz-sync-prefs',
    'aaz-tab-mini-mode',
  ])
);

export const SHELL_TO_TAB_TYPES = Object.freeze(
  new Set([
    'aaz-open-external',
    'aaz-apply-prefs',
    'aaz-update-status',
    'aaz-shell-mini-state',
  ])
);

const ALLOWED_THEMES = new Set(['dark', 'light']);
const ALLOWED_LANGS = new Set(['en', 'ar']);
const ALLOWED_KINDS = new Set(['', 'audio', 'video']);

function sanitizeString(val, maxLen = 256) {
  if (typeof val !== 'string') return '';
  return val.slice(0, maxLen);
}

function sanitizeSubtitleStyle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  if (typeof raw.fontFamily === 'string') out.fontFamily = raw.fontFamily.slice(0, 120);
  if (typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)) {
    out.fontSize = Math.min(200, Math.max(50, raw.fontSize));
  }
  if (typeof raw.color === 'string') out.color = raw.color.slice(0, 32);
  if (typeof raw.bgColor === 'string') out.bgColor = raw.bgColor.slice(0, 32);
  if (typeof raw.bgOpacity === 'number' && Number.isFinite(raw.bgOpacity)) {
    out.bgOpacity = Math.min(1, Math.max(0, raw.bgOpacity));
  }
  if (typeof raw.edgeStyle === 'string') out.edgeStyle = raw.edgeStyle.slice(0, 32);
  if (typeof raw.bold === 'boolean') out.bold = raw.bold;
  if (typeof raw.italic === 'boolean') out.italic = raw.italic;
  if (typeof raw.position === 'number' && Number.isFinite(raw.position)) {
    out.position = Math.min(50, Math.max(0, raw.position));
  }
  return out;
}

/**
 * Computes a strict postMessage targetOrigin from the current location.
 * Avoids '*' for all HTTP/HTTPS/Tauri origins; only returns '' for opaque file:// origins.
 */
export function getTargetOrigin(loc = typeof window !== 'undefined' ? window.location : null) {
  if (!loc || typeof loc.origin !== 'string') return '';
  const origin = loc.origin.trim();
  if (!origin || origin === 'null') return '';
  return origin;
}

/**
 * Verifies that a MessageEvent came from the exact same trusted origin.
 */
export function isTrustedOrigin(eventOrigin, expectedOrigin = getTargetOrigin()) {
  if (typeof eventOrigin !== 'string') return false;
  if (!expectedOrigin) {
    return (
      eventOrigin === 'null' &&
      typeof window !== 'undefined' &&
      window.location &&
      window.location.protocol === 'file:'
    );
  }
  return eventOrigin === expectedOrigin;
}

/**
 * Validates and sanitizes a message sent from a Tab iframe to the Workspace Shell.
 */
export function validateTabToShellMessage(data, expectedTabId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const type = typeof data.type === 'string' ? data.type : '';
  if (!TAB_TO_SHELL_TYPES.has(type)) return null;

  const tabId = typeof data.tabId === 'string' ? data.tabId.trim() : '';
  if (!tabId || tabId.length > 64) return null;
  if (expectedTabId && tabId !== expectedTabId) return null;

  switch (type) {
    case 'aaz-tab-ready':
    case 'aaz-new-tab':
    case 'aaz-close-tab':
      return { type, tabId };

    case 'aaz-tab-state': {
      const kind = typeof data.kind === 'string' && ALLOWED_KINDS.has(data.kind) ? data.kind : '';
      return {
        type,
        tabId,
        title: sanitizeString(data.title, 200),
        isPlaying: Boolean(data.isPlaying),
        hasMedia: Boolean(data.hasMedia),
        kind,
        sinkLabel: sanitizeString(data.sinkLabel, 120),
      };
    }

    case 'aaz-cycle-tab':
      return { type, tabId, dir: data.dir === -1 ? -1 : 1 };

    case 'aaz-activate-index': {
      const idx = Number.isInteger(data.index) ? data.index : -1;
      if (idx < 0 || idx > 99) return null;
      return { type, tabId, index: idx };
    }

    case 'aaz-shell-fullscreen':
      return { type, tabId, active: Boolean(data.active) };

    case 'aaz-sync-prefs': {
      const out = { type, tabId };
      if (ALLOWED_THEMES.has(data.theme)) out.theme = data.theme;
      if (ALLOWED_LANGS.has(data.lang)) out.lang = data.lang;
      const subStyle = sanitizeSubtitleStyle(data.subtitleStyle);
      if (subStyle) out.subtitleStyle = subStyle;
      return out;
    }

    case 'aaz-tab-mini-mode':
      return {
        type,
        tabId,
        enabled: Boolean(data.enabled),
        alwaysOnTop: typeof data.alwaysOnTop === 'boolean' ? data.alwaysOnTop : undefined,
      };

    default:
      return null;
  }
}

/**
 * Validates and sanitizes a message sent from the Workspace Shell to a Tab iframe.
 */
export function validateShellToTabMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const type = typeof data.type === 'string' ? data.type : '';
  if (!SHELL_TO_TAB_TYPES.has(type)) return null;

  switch (type) {
    case 'aaz-open-external': {
      if (!Array.isArray(data.paths)) return null;
      const paths = data.paths
        .filter((p) => typeof p === 'string' && p.trim().length > 0 && p.length <= 1024)
        .slice(0, 500);
      if (paths.length === 0) return null;
      return { type, paths };
    }

    case 'aaz-apply-prefs': {
      const out = { type };
      if (ALLOWED_THEMES.has(data.theme)) out.theme = data.theme;
      if (ALLOWED_LANGS.has(data.lang)) out.lang = data.lang;
      const subStyle = sanitizeSubtitleStyle(data.subtitleStyle);
      if (subStyle) out.subtitleStyle = subStyle;
      return out;
    }

    case 'aaz-update-status': {
      if (!data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) {
        return null;
      }
      const p = data.payload;
      const payload = {
        status: sanitizeString(p.status, 40),
        version: p.version ? sanitizeString(String(p.version), 40) : undefined,
        percent:
          typeof p.percent === 'number' && Number.isFinite(p.percent)
            ? Math.min(100, Math.max(0, p.percent))
            : undefined,
        message: p.message ? sanitizeString(String(p.message), 300) : undefined,
        notes: p.notes ? sanitizeString(String(p.notes), 2000) : undefined,
        verifiedSha256: typeof p.verifiedSha256 === 'boolean' ? p.verifiedSha256 : undefined,
      };
      return { type, payload };
    }

    case 'aaz-shell-mini-state':
      return {
        type,
        enabled: Boolean(data.enabled),
        alwaysOnTop: typeof data.alwaysOnTop === 'boolean' ? data.alwaysOnTop : undefined,
      };

    default:
      return null;
  }
}

/**
 * Sends a postMessage to a target window using a strict same-origin targetOrigin.
 */
export function sendSafeMessage(targetWindow, payload, expectedOrigin = getTargetOrigin()) {
  if (!targetWindow || typeof targetWindow.postMessage !== 'function') return false;
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return false;

  const targetOrigin =
    expectedOrigin ||
    (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:'
      ? '*'
      : '');

  if (!targetOrigin) return false;
  try {
    targetWindow.postMessage(payload, targetOrigin);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies a MessageEvent from a known tab iframe (used by Workspace Shell).
 */
export function receiveTabMessage(event, resolveTabBySource, expectedOrigin = getTargetOrigin()) {
  if (!event || !isTrustedOrigin(event.origin, expectedOrigin)) return null;
  if (!event.source || typeof resolveTabBySource !== 'function') return null;

  const tab = resolveTabBySource(event.source);
  if (!tab || !tab.id) return null;

  const validated = validateTabToShellMessage(event.data, tab.id);
  if (!validated) return null;

  return { tab, message: validated };
}

/**
 * Verifies a MessageEvent from window.parent (used by Tab Player).
 */
export function receiveShellMessage(
  event,
  parentWindow = typeof window !== 'undefined' ? window.parent : null,
  expectedOrigin = getTargetOrigin()
) {
  if (!event || !isTrustedOrigin(event.origin, expectedOrigin)) return null;
  if (!parentWindow || event.source !== parentWindow) return null;

  return validateShellToTabMessage(event.data);
}
