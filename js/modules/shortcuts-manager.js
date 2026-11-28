/**
 * Configurable Keyboard Shortcuts Manager (Phase 3 Feature 3).
 *
 * Features:
 * - Default keybindings for playback, seeking, volume, fullscreen, playlist navigation,
 *   subtitle delay, audio output selector, mini player, cast, and snapshots.
 * - Live key-combo normalization (e.g. "Space", "ArrowLeft", "Ctrl+Shift+M").
 * - Conflict detection across all actions.
 * - Individual and global reset to defaults.
 * - Safe guard to ignore shortcuts while typing in inputs, textareas, selects, or editable nodes.
 */

export const UNBOUND_SENTINEL = '__UNBOUND__';

export const DEFAULT_SHORTCUTS = Object.freeze([
  { id: 'playPause', defaultKey: 'Space', labelEn: 'Play / Pause', labelAr: 'تشغيل / إيقاف مؤقت' },
  { id: 'stop', defaultKey: 'S', labelEn: 'Stop Playback', labelAr: 'إيقاف التشغيل' },
  { id: 'seekBackward', defaultKey: 'ArrowLeft', labelEn: 'Seek Back 5s', labelAr: 'ترجيع 5 ثوانٍ' },
  { id: 'seekForward', defaultKey: 'ArrowRight', labelEn: 'Seek Forward 5s', labelAr: 'تقديم 5 ثوانٍ' },
  { id: 'volumeUp', defaultKey: 'ArrowUp', labelEn: 'Volume Up', labelAr: 'رفع الصوت' },
  { id: 'volumeDown', defaultKey: 'ArrowDown', labelEn: 'Volume Down', labelAr: 'خفض الصوت' },
  { id: 'mute', defaultKey: 'M', labelEn: 'Mute / Unmute', labelAr: 'كتم / إلغاء الكتم' },
  { id: 'fullscreen', defaultKey: 'F', labelEn: 'Toggle Fullscreen', labelAr: 'ملء الشاشة' },
  { id: 'pip', defaultKey: 'P', labelEn: 'Picture-in-Picture', labelAr: 'صورة داخل صورة' },
  { id: 'nextTrack', defaultKey: 'N', labelEn: 'Next Track', labelAr: 'المقطع التالي' },
  { id: 'prevTrack', defaultKey: 'Shift+P', labelEn: 'Previous Track', labelAr: 'المقطع السابق' },
  { id: 'subEarlier', defaultKey: 'G', labelEn: 'Subtitle Earlier (-0.25s)', labelAr: 'تقديم الترجمة (-0.25ث)' },
  { id: 'subLater', defaultKey: 'H', labelEn: 'Subtitle Later (+0.25s)', labelAr: 'تأخير الترجمة (+0.25ث)' },
  { id: 'audioOutput', defaultKey: 'Ctrl+Shift+A', labelEn: 'Audio Output Device', labelAr: 'جهاز إخراج الصوت' },
  { id: 'miniPlayer', defaultKey: 'Ctrl+Shift+M', labelEn: 'Toggle Mini Player', labelAr: 'المشغل المصغر' },
  { id: 'cast', defaultKey: 'C', labelEn: 'Cast to TV / Network', labelAr: 'البث إلى التلفاز' },
  { id: 'snapshot', defaultKey: 'Shift+S', labelEn: 'Capture Video Snapshot', labelAr: 'التقاط صورة للفيديو' },
  { id: 'abLoop', defaultKey: 'L', labelEn: 'A–B Section Loop', labelAr: 'تكرار مقطع A–B' },
  { id: 'bookmark', defaultKey: 'B', labelEn: 'Add Timestamp Bookmark', labelAr: 'إضافة علامة زمنية' },
  { id: 'speedFineUp', defaultKey: ']', labelEn: 'Speed Up Fine (+0.05x)', labelAr: 'زيادة السرعة الدقيقة (+0.05×)' },
  { id: 'speedFineDown', defaultKey: '[', labelEn: 'Speed Down Fine (-0.05x)', labelAr: 'خفض السرعة الدقيقة (-0.05×)' },
  { id: 'speedCoarseUp', defaultKey: '=', labelEn: 'Speed Up (+0.50x)', labelAr: 'زيادة السرعة (+0.50×)' },
  { id: 'speedCoarseDown', defaultKey: '-', labelEn: 'Speed Down (-0.50x)', labelAr: 'خفض السرعة (-0.50×)' },
  { id: 'vizCycle', defaultKey: 'V', labelEn: 'Next Visualizer Style', labelAr: 'شكل المرئيات التالي' },
  { id: 'settings', defaultKey: 'Ctrl+,', labelEn: 'Open Playback Settings', labelAr: 'فتح إعدادات التشغيل' },
]);

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
export const RESERVED_COMBOS = Object.freeze(
  new Set(['Ctrl+T', 'Ctrl+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Alt+F4', 'Ctrl+Q', 'Ctrl+N'])
);

export function normalizeKeyCombo(eventLike) {
  if (!eventLike) return '';
  if (typeof eventLike === 'string') {
    const parts = eventLike
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean);
    const modSet = new Set();
    let key = '';
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low === 'ctrl' || low === 'control') {
        modSet.add('Ctrl');
      } else if (low === 'alt') {
        modSet.add('Alt');
      } else if (low === 'shift') {
        modSet.add('Shift');
      } else if (low === 'meta' || low === 'cmd') {
        modSet.add('Meta');
      } else {
        key = canonicalKeyName(p);
      }
    }
    if (!key) return '';
    const mods = MODIFIER_ORDER.filter((m) => modSet.has(m));
    return [...mods, key].join('+');
  }

  const rawKey = eventLike.key;
  if (!rawKey || MODIFIER_KEYS.has(rawKey)) return '';

  const key = canonicalKeyName(rawKey, eventLike.code);
  if (!key) return '';

  const mods = [];
  if (eventLike.ctrlKey) mods.push('Ctrl');
  if (eventLike.altKey) mods.push('Alt');
  // Pressing '+' on standard keyboards requires Shift+=; normalize '+' to '=' without Shift
  const ignoreShiftForPlus = key === '=' && (rawKey === '+' || eventLike.code === 'Equal');
  if (eventLike.shiftKey && !ignoreShiftForPlus) mods.push('Shift');
  if (eventLike.metaKey) mods.push('Meta');

  return [...mods, key].join('+');
}

function canonicalKeyName(key, code = '') {
  if (key === ' ' || key === 'Spacebar' || key === 'Space' || code === 'Space') return 'Space';
  if (key === 'Esc' || key === 'Escape') return 'Escape';
  if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
    return key;
  }
  if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  // Map physical Latin & punctuation keys via event.code when user keyboard layout is Arabic/non-Latin
  if (typeof code === 'string') {
    if (/^Key([A-Z])$/.test(code)) return code.slice(3);
    if (code === 'BracketRight') return ']';
    if (code === 'BracketLeft') return '[';
    if (code === 'Equal' || code === 'NumpadAdd') return '=';
    if (code === 'Minus' || code === 'NumpadSubtract') return '-';
  }
  if (key === '+') return '=';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(target.type || '').toLowerCase();
    if (type === 'range' || type === 'button' || type === 'checkbox' || type === 'radio') {
      return false;
    }
    return true;
  }
  if (target.isContentEditable) return true;
  return false;
}

export function createShortcutsManager({ getStore, persist }) {
  function getCustomMap() {
    const store = getStore();
    if (!store.customShortcuts || typeof store.customShortcuts !== 'object') {
      store.customShortcuts = {};
    }
    return store.customShortcuts;
  }

  function getBinding(actionId) {
    const custom = getCustomMap();
    if (custom[actionId] === UNBOUND_SENTINEL) {
      return '';
    }
    if (typeof custom[actionId] === 'string' && custom[actionId]) {
      return normalizeKeyCombo(custom[actionId]);
    }
    const def = DEFAULT_SHORTCUTS.find((s) => s.id === actionId);
    return def ? normalizeKeyCombo(def.defaultKey) : '';
  }

  function getAllBindings() {
    const custom = getCustomMap();
    return DEFAULT_SHORTCUTS.map((def) => {
      const key = getBinding(def.id);
      const isCustom =
        custom[def.id] === UNBOUND_SENTINEL ||
        Boolean(
          custom[def.id] &&
            normalizeKeyCombo(custom[def.id]) !== normalizeKeyCombo(def.defaultKey)
        );
      return {
        ...def,
        key,
        isCustom,
      };
    });
  }

  function findConflict(actionId, combo) {
    const norm = normalizeKeyCombo(combo);
    if (!norm) return null;
    for (const def of DEFAULT_SHORTCUTS) {
      if (def.id === actionId) continue;
      if (getBinding(def.id) === norm) {
        return def;
      }
    }
    return null;
  }

  function setBinding(actionId, combo, { allowOverride = false } = {}) {
    const def = DEFAULT_SHORTCUTS.find((s) => s.id === actionId);
    if (!def) return { ok: false, reason: 'unknown_action' };

    const norm = normalizeKeyCombo(combo);
    if (!norm) return { ok: false, reason: 'invalid_key' };
    if (RESERVED_COMBOS.has(norm)) {
      return { ok: false, reason: 'reserved', key: norm };
    }

    const conflict = findConflict(actionId, norm);
    if (conflict && !allowOverride) {
      return { ok: false, reason: 'conflict', conflict, key: norm };
    }

    const custom = getCustomMap();
    if (conflict && allowOverride) {
      // Explicitly mark overridden binding as unbound so it never reverts to its default
      custom[conflict.id] = UNBOUND_SENTINEL;
    }

    if (norm === normalizeKeyCombo(def.defaultKey)) {
      delete custom[actionId];
    } else {
      custom[actionId] = norm;
    }
    const saved = persist();
    if (saved === false) return { ok: false, reason: 'persist_failed' };
    return { ok: true, key: norm };
  }

  function resetBinding(actionId, { allowOverride = false } = {}) {
    const def = DEFAULT_SHORTCUTS.find((s) => s.id === actionId);
    if (!def) return { ok: false, reason: 'unknown_action' };
    const defaultCombo = normalizeKeyCombo(def.defaultKey);

    const conflict = findConflict(actionId, defaultCombo);
    if (conflict && !allowOverride) {
      return { ok: false, reason: 'conflict', conflict, key: defaultCombo };
    }

    const custom = getCustomMap();
    if (conflict && allowOverride) {
      custom[conflict.id] = UNBOUND_SENTINEL;
    }
    delete custom[actionId];
    const saved = persist();
    if (saved === false) return { ok: false, reason: 'persist_failed' };
    return { ok: true, key: getBinding(actionId) };
  }

  /**
   * Resolves any duplicate combos that may exist from legacy or imported backups
   * by giving explicit custom bindings priority and marking conflicting defaults unbound.
   */
  function normalizeStoredConflicts() {
    const custom = getCustomMap();
    const claimed = new Map();
    let changed = false;

    // Pass 1: explicit non-default custom bindings win
    for (const def of DEFAULT_SHORTCUTS) {
      const raw = custom[def.id];
      if (typeof raw === 'string' && raw && raw !== UNBOUND_SENTINEL) {
        const norm = normalizeKeyCombo(raw);
        if (!norm || RESERVED_COMBOS.has(norm) || claimed.has(norm)) {
          custom[def.id] = UNBOUND_SENTINEL;
          changed = true;
        } else {
          if (norm !== raw) {
            custom[def.id] = norm;
            changed = true;
          }
          claimed.set(norm, def.id);
        }
      }
    }

    // Pass 2: default bindings that collide with an already claimed custom combo become unbound
    for (const def of DEFAULT_SHORTCUTS) {
      if (custom[def.id] !== undefined) continue;
      const defNorm = normalizeKeyCombo(def.defaultKey);
      if (claimed.has(defNorm)) {
        custom[def.id] = UNBOUND_SENTINEL;
        changed = true;
      } else {
        claimed.set(defNorm, def.id);
      }
    }

    if (changed) persist();
    return changed;
  }

  function resetAll() {
    const store = getStore();
    store.customShortcuts = {};
    persist();
  }

  function matchAction(keyboardEvent) {
    if (!keyboardEvent) return null;
    if (isTypingTarget(keyboardEvent.target)) return null;
    const combo = normalizeKeyCombo(keyboardEvent);
    if (!combo) return null;

    for (const def of DEFAULT_SHORTCUTS) {
      const bound = getBinding(def.id);
      if (bound && bound === combo) {
        return def.id;
      }
    }
    return null;
  }

  return {
    getBinding,
    getAllBindings,
    findConflict,
    setBinding,
    resetBinding,
    resetAll,
    normalizeStoredConflicts,
    matchAction,
  };
}
