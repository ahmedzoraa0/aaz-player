/**
 * Top-Level Multi-Tab Workspace Shell (Phase 1 Messaging Hardening + Phase 3 Window Layout & Mini Player).
 */

import {
  receiveTabMessage,
  sendSafeMessage,
} from '../core/messaging.js';
import { createStorageManager } from '../modules/storage-manager.js';
import { createWindowLayoutManager } from '../modules/window-layout.js';
import { DEFAULT_SKIN, SKIN_STORAGE_KEY, sanitizeSkin } from '../modules/themes-catalog.js';
import {
  SPLIT_PREFS_KEY,
  SPLIT_DIVIDER_PX,
  sanitizeSplitPrefs,
  resolveSplitOrientation,
  computeSplitLayout,
  ratioFromPointer,
  listSplitCandidates,
} from '../modules/split-view.js';

export function initWorkspaceShell() {
  document.documentElement.classList.add('is-tab-shell');

  const workspaceShell = document.getElementById('workspaceShell');
  const tabStripBrand = document.getElementById('tabStripBrand');
  const tabStripTabs = document.getElementById('tabStripTabs');
  const newTabBtn = document.getElementById('newTabBtn');
  const splitBtn = document.getElementById('splitBtn');
  const tabDragSpacer = document.getElementById('tabDragSpacer');
  const winControls = document.getElementById('winControls');
  const winMinBtn = document.getElementById('winMinBtn');
  const winMaxBtn = document.getElementById('winMaxBtn');
  const winMaxIcon = document.getElementById('winMaxIcon');
  const winRestoreIcon = document.getElementById('winRestoreIcon');
  const winCloseBtn = document.getElementById('winCloseBtn');
  const tabFramesHost = document.getElementById('tabFramesHost');
  const shellDesktop =
    window.aazDesktop && window.aazDesktop.isElectron ? window.aazDesktop : null;

  const storageManager = createStorageManager();
  const windowLayout = createWindowLayoutManager({
    storageManager,
    desktopBridge: shellDesktop,
  });

  if (workspaceShell) workspaceShell.hidden = false;

  // Disable native browser/WebView2 context menu on frameless shell chrome
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea, [contenteditable="true"]')) {
      e.preventDefault();
    }
  });

  let shellTheme = 'dark';
  let shellLang = 'en';
  let shellSkin = DEFAULT_SKIN;
  let shellIsMaximized = false;
  try {
    shellTheme = localStorage.getItem('aaz_theme') || 'dark';
    shellLang = localStorage.getItem('aaz_lang') || 'en';
    shellSkin = sanitizeSkin(localStorage.getItem(SKIN_STORAGE_KEY));
  } catch {}

  function syncWinMaxIcons(isMax) {
    shellIsMaximized = Boolean(isMax);
    if (winMaxIcon) winMaxIcon.style.display = shellIsMaximized ? 'none' : '';
    if (winRestoreIcon) winRestoreIcon.style.display = shellIsMaximized ? '' : 'none';
    if (winMaxBtn) {
      const lbl =
        shellLang === 'ar'
          ? shellIsMaximized
            ? 'استعادة الحجم'
            : 'تكبير النافذة'
          : shellIsMaximized
            ? 'Restore'
            : 'Maximize';
      winMaxBtn.title = lbl;
      winMaxBtn.setAttribute('aria-label', lbl);
    }
  }

  const tabs = [];
  let activeTabId = null;
  let tabSeq = 0;

  function getTabBaseUrl() {
    return window.location.href.split('#')[0].split('?')[0];
  }

  let lastTaskbarSig = '';
  function syncTaskbarControls() {
    if (!shellDesktop || typeof shellDesktop.updateTaskbarState !== 'function') return;
    const active = tabs.find((tb) => tb.id === activeTabId);
    const payload = {
      hasMedia: Boolean(active && active.hasMedia),
      isPlaying: Boolean(active && active.isPlaying),
      canPrev: Boolean(active && active.canPrev),
      canNext: Boolean(active && active.canNext),
      lang: shellLang === 'ar' ? 'ar' : 'en',
    };
    const sig = `${payload.hasMedia ? 1 : 0}|${payload.isPlaying ? 1 : 0}|${payload.canPrev ? 1 : 0}|${payload.canNext ? 1 : 0}|${payload.lang}`;
    if (sig === lastTaskbarSig) return;
    lastTaskbarSig = sig;
    shellDesktop.updateTaskbarState(payload).catch(() => {});
  }

  function updateWindowTitle() {
    const active = tabs.find((tb) => tb.id === activeTabId);
    document.title = active && active.title ? `${active.title} — همزة` : 'همزة';
    syncTaskbarControls();
  }

  function renderTabStrip() {
    if (!tabStripTabs) return;
    const frag = document.createDocumentFragment();
    const defaultLabel = shellLang === 'ar' ? 'تبويب جديد' : 'New Tab';

    tabs.forEach((tab, idx) => {
      const isActive = tab.id === activeTabId;
      const item = document.createElement('div');
      item.className = `workspace-tab${isActive ? ' is-active' : ''}${isInSplit(tab.id) ? ' in-split' : ''}`;
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(isActive));
      item.title = tab.sinkLabel
        ? `${tab.title || defaultLabel} — ${tab.sinkLabel}`
        : tab.title || `${defaultLabel} ${idx + 1}`;

      if (tab.isPlaying) {
        const eq = document.createElement('span');
        eq.className = 'tab-eq-anim';
        eq.innerHTML = '<span></span><span></span><span></span>';
        item.appendChild(eq);
      } else {
        const dot = document.createElement('span');
        dot.className = 'tab-status-dot';
        item.appendChild(dot);
      }

      const lbl = document.createElement('span');
      lbl.className = 'tab-label';
      lbl.textContent = tab.title || `${defaultLabel} ${idx + 1}`;
      item.appendChild(lbl);

      if (tab.sinkLabel) {
        const badge = document.createElement('span');
        badge.className = 'tab-sink-badge';
        badge.title = tab.sinkLabel;
        badge.innerHTML =
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
        item.appendChild(badge);
      }

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tab-close-btn';
      closeBtn.textContent = '×';
      closeBtn.title = shellLang === 'ar' ? 'إغلاق التبويب (Ctrl+W)' : 'Close Tab (Ctrl+W)';
      closeBtn.setAttribute('aria-label', closeBtn.title);
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(tab.id);
      });
      item.appendChild(closeBtn);

      item.addEventListener('click', () => activateTab(tab.id));
      item.addEventListener('auxclick', (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          closeTab(tab.id);
        }
      });

      frag.appendChild(item);
    });

    tabStripTabs.replaceChildren(frag);
  }

  function applyShellPrefs(theme, lang, skin = shellSkin) {
    shellTheme = theme === 'light' ? 'light' : 'dark';
    shellLang = lang === 'ar' ? 'ar' : 'en';
    shellSkin = sanitizeSkin(skin);
    if (shellTheme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    if (shellSkin !== DEFAULT_SKIN) document.documentElement.setAttribute('data-skin', shellSkin);
    else document.documentElement.removeAttribute('data-skin');
    document.documentElement.lang = shellLang;
    document.documentElement.dir = shellLang === 'ar' ? 'rtl' : 'ltr';
    if (newTabBtn) {
      newTabBtn.title = shellLang === 'ar' ? 'تبويب جديد (Ctrl+T)' : 'New Tab (Ctrl+T)';
    }
    if (winMinBtn) {
      const minLbl = shellLang === 'ar' ? 'تصغير' : 'Minimize';
      winMinBtn.title = minLbl;
      winMinBtn.setAttribute('aria-label', minLbl);
    }
    if (winCloseBtn) {
      const closeLbl = shellLang === 'ar' ? 'إغلاق' : 'Close';
      winCloseBtn.title = closeLbl;
      winCloseBtn.setAttribute('aria-label', closeLbl);
    }
    syncWinMaxIcons(shellIsMaximized);
    renderTabStrip();
    renderSplitButtonState();
    syncSplitDividerLabels();
    syncTaskbarControls();
  }


  /* =======================================================================
     Split View: two tabs shown side by side (stacked on phones / narrow windows).
     Each side is a full player in its own iframe (own controls); the focused side
     owns the keyboard shortcuts, taskbar/media keys and the window title.
     ======================================================================= */
  const split = { active: false, firstId: null, secondId: null, fullscreenTabId: null };
  let splitPrefs = sanitizeSplitPrefs(null);
  try {
    const rawSplit = localStorage.getItem(SPLIT_PREFS_KEY);
    if (rawSplit) splitPrefs = sanitizeSplitPrefs(JSON.parse(rawSplit));
  } catch {}
  let splitDivider = null;
  let splitMenu = null;
  let splitDragShield = null;

  function saveSplitPrefs() {
    try {
      localStorage.setItem(SPLIT_PREFS_KEY, JSON.stringify(splitPrefs));
    } catch {}
  }

  function splitTr(en, ar) {
    return shellLang === 'ar' ? ar : en;
  }

  function isInSplit(tabId) {
    return split.active && (tabId === split.firstId || tabId === split.secondId);
  }

  function getSplitTabs() {
    const first = tabs.find((tb) => tb.id === split.firstId);
    const second = tabs.find((tb) => tb.id === split.secondId);
    return { first, second };
  }

  function clearSplitFrameStyles(tb) {
    if (!tb || !tb.iframe) return;
    tb.iframe.classList.remove('is-split', 'split-focus', 'split-fs');
    tb.iframe.style.left = '';
    tb.iframe.style.top = '';
    tb.iframe.style.width = '';
    tb.iframe.style.height = '';
    tb.iframe.style.inset = '';
  }

  function ensureSplitDivider() {
    if (splitDivider) return splitDivider;
    const div = document.createElement('div');
    div.className = 'split-divider';
    div.setAttribute('role', 'separator');
    div.tabIndex = 0;
    div.innerHTML =
      '<div class="split-handle">' +
      '<button type="button" class="split-handle-btn" data-split-act="swap"></button>' +
      '<button type="button" class="split-handle-btn" data-split-act="rotate"></button>' +
      '<button type="button" class="split-handle-btn is-close" data-split-act="close"></button>' +
      '</div>';
    const icons = {
      swap: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 20l4-4-4-4"/><path d="M21 16H7"/></svg>',
      rotate:
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
      close:
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>',
    };
    div.querySelectorAll('.split-handle-btn').forEach((btn) => {
      btn.innerHTML = icons[btn.dataset.splitAct];
      btn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        runSplitAction(btn.dataset.splitAct);
      });
    });
    splitDragShield = document.createElement('div');
    splitDragShield.className = 'split-drag-shield';
    splitDragShield.hidden = true;
    tabFramesHost.appendChild(splitDragShield);
    tabFramesHost.appendChild(div);
    splitDivider = div;

    let dragging = false;
    const hostPoint = (ev) => {
      const r = tabFramesHost.getBoundingClientRect();
      const orientation = div.dataset.orientation === 'v' ? 'v' : 'h';
      return {
        pointer: orientation === 'v' ? ev.clientY - r.top : ev.clientX - r.left,
        hostWidth: r.width,
        hostHeight: r.height,
        orientation,
      };
    };
    div.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      try {
        div.setPointerCapture(ev.pointerId);
      } catch {}
      splitDragShield.hidden = false;
      div.classList.add('is-dragging');
      ev.preventDefault();
    });
    div.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      splitPrefs.ratio = ratioFromPointer(hostPoint(ev));
      layoutSplit();
    });
    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      try {
        div.releasePointerCapture(ev.pointerId);
      } catch {}
      splitDragShield.hidden = true;
      div.classList.remove('is-dragging');
      saveSplitPrefs();
      focusSplitSide(split.focusId || split.firstId);
    };
    div.addEventListener('pointerup', endDrag);
    div.addEventListener('pointercancel', endDrag);
    div.addEventListener('dblclick', () => {
      splitPrefs.ratio = 0.5;
      saveSplitPrefs();
      layoutSplit();
    });
    div.addEventListener('keydown', (ev) => {
      const vertical = div.dataset.orientation === 'v';
      const dec = vertical ? 'ArrowUp' : 'ArrowLeft';
      const inc = vertical ? 'ArrowDown' : 'ArrowRight';
      if (ev.key !== dec && ev.key !== inc && ev.key !== 'Home') return;
      ev.preventDefault();
      if (ev.key === 'Home') splitPrefs.ratio = 0.5;
      else splitPrefs.ratio = sanitizeSplitPrefs({ ratio: splitPrefs.ratio + (ev.key === inc ? 0.02 : -0.02) }).ratio;
      saveSplitPrefs();
      layoutSplit();
    });
    return div;
  }

  function syncSplitDividerLabels() {
    if (!splitDivider) return;
    const labels = {
      swap: splitTr('Swap sides', 'تبديل الجانبين'),
      rotate: splitTr('Switch layout (side by side / stacked)', 'تغيير الترتيب (جنبًا إلى جنب / فوق بعض)'),
      close: splitTr('Close split view', 'إغلاق تقسيم الشاشة'),
    };
    splitDivider.querySelectorAll('.split-handle-btn').forEach((btn) => {
      const lbl = labels[btn.dataset.splitAct];
      btn.title = lbl;
      btn.setAttribute('aria-label', lbl);
    });
    splitDivider.setAttribute('aria-label', splitTr('Resize split view', 'تغيير حجم الشاشتين'));
  }

  function broadcastSplitState() {
    // While another tab is in front the split is suspended: panes behave like normal tabs again.
    const visible = isInSplit(activeTabId);
    tabs.forEach((tb) => {
      const inPair = visible && isInSplit(tb.id);
      sendSafeMessage(tb.iframe.contentWindow, {
        type: 'aaz-split-state',
        active: inPair,
        focused: inPair && tb.id === activeTabId,
        side: tb.id === split.secondId ? 'second' : 'first',
        soloAudio: Boolean(splitPrefs.soloAudio),
      });
    });
  }

  function layoutSplit() {
    const { first, second } = getSplitTabs();
    const showing = split.active && first && second && isInSplit(activeTabId);
    tabFramesHost.classList.toggle('is-split', Boolean(showing));
    if (!showing) {
      [first, second].forEach(clearSplitFrameStyles);
      if (splitDivider) splitDivider.hidden = true;
      return;
    }
    const hostRect = tabFramesHost.getBoundingClientRect();
    const orientation = resolveSplitOrientation(splitPrefs.orientation, hostRect.width);
    const L = computeSplitLayout({
      ratio: splitPrefs.ratio,
      orientation,
      hostWidth: hostRect.width,
      hostHeight: hostRect.height,
      dividerPx: SPLIT_DIVIDER_PX,
    });
    const place = (tb, rect, isFocused) => {
      tb.iframe.classList.add('is-split');
      tb.iframe.classList.toggle('split-focus', isFocused);
      tb.iframe.style.inset = 'auto';
      tb.iframe.style.left = `${rect.x}px`;
      tb.iframe.style.top = `${rect.y}px`;
      tb.iframe.style.width = `${rect.w}px`;
      tb.iframe.style.height = `${rect.h}px`;
    };
    const fsId = split.fullscreenTabId;
    if (fsId && (fsId === first.id || fsId === second.id)) {
      // A side is in (pseudo-)fullscreen: let it cover the whole host, hide the divider.
      const fsTab = fsId === first.id ? first : second;
      const other = fsTab === first ? second : first;
      place(fsTab, { x: 0, y: 0, w: hostRect.width, h: hostRect.height }, true);
      fsTab.iframe.classList.add('split-fs');
      clearSplitFrameStyles(other);
      if (splitDivider) splitDivider.hidden = true;
      return;
    }
    first.iframe.classList.remove('split-fs');
    second.iframe.classList.remove('split-fs');
    place(first, L.first, activeTabId === first.id);
    place(second, L.second, activeTabId === second.id);
    const div = ensureSplitDivider();
    div.hidden = false;
    div.dataset.orientation = L.orientation;
    div.setAttribute('aria-orientation', L.orientation === 'v' ? 'horizontal' : 'vertical');
    div.setAttribute('aria-valuenow', String(Math.round(splitPrefs.ratio * 100)));
    div.style.left = `${L.divider.x}px`;
    div.style.top = `${L.divider.y}px`;
    div.style.width = `${L.divider.w}px`;
    div.style.height = `${L.divider.h}px`;
    syncSplitDividerLabels();
  }

  function startSplit(firstId, secondId, focusId = secondId) {
    if (!firstId || !secondId || firstId === secondId) return false;
    if (!tabs.some((tb) => tb.id === firstId) || !tabs.some((tb) => tb.id === secondId)) return false;
    if (windowLayout.isMiniActive()) return false;
    if (split.active) {
      // replacing an existing split: release the old pair first
      [split.firstId, split.secondId].forEach((id) => {
        if (id !== firstId && id !== secondId) clearSplitFrameStyles(tabs.find((tb) => tb.id === id));
      });
    }
    split.active = true;
    split.firstId = firstId;
    split.secondId = secondId;
    split.fullscreenTabId = null;
    ensureSplitDivider();
    activateTab(focusId);
    renderSplitButtonState();
    return true;
  }

  function endSplit(keepTabId = null) {
    if (!split.active && !split.firstId) return;
    const ids = [split.firstId, split.secondId];
    split.active = false;
    split.firstId = null;
    split.secondId = null;
    split.fullscreenTabId = null;
    ids.forEach((id) => clearSplitFrameStyles(tabs.find((tb) => tb.id === id)));
    tabFramesHost.classList.remove('is-split');
    if (splitDivider) splitDivider.hidden = true;
    broadcastSplitState();
    const keep = tabs.find((tb) => tb.id === keepTabId) || tabs.find((tb) => tb.id === activeTabId) || tabs[0];
    if (keep) activateTab(keep.id);
    renderSplitButtonState();
  }

  function focusSplitSide(tabId) {
    if (!isInSplit(tabId)) return;
    if (activeTabId !== tabId) activateTab(tabId);
    else {
      try {
        tabs.find((tb) => tb.id === tabId)?.iframe.contentWindow?.focus();
      } catch {}
    }
  }

  function swapSplitSides() {
    if (!split.active) return;
    const a = split.firstId;
    split.firstId = split.secondId;
    split.secondId = a;
    layoutSplit();
    broadcastSplitState();
  }

  function rotateSplitLayout() {
    const hostW = tabFramesHost.getBoundingClientRect().width;
    const current = resolveSplitOrientation(splitPrefs.orientation, hostW);
    splitPrefs.orientation = current === 'h' ? 'v' : 'h';
    saveSplitPrefs();
    layoutSplit();
  }

  function setSoloAudio(on) {
    splitPrefs.soloAudio = Boolean(on);
    saveSplitPrefs();
    broadcastSplitState();
  }

  function createSplitPartner(options = {}) {
    const current = tabs.find((tb) => tb.id === activeTabId);
    if (!current) return null;
    const partner = createTab({ initial: false, activate: false, ...options });
    startSplit(split.active && isInSplit(current.id) ? current.id : current.id, partner.id, partner.id);
    return partner;
  }

  function runSplitAction(action, payload = {}) {
    switch (action) {
      case 'toggle':
        if (split.active) endSplit();
        else createSplitPartner();
        break;
      case 'new':
        createSplitPartner();
        break;
      case 'new-picker':
        createSplitPartner({ openPicker: true });
        break;
      case 'swap':
        swapSplitSides();
        break;
      case 'rotate':
        rotateSplitLayout();
        break;
      case 'close':
        endSplit();
        break;
      case 'focus': {
        if (!split.active) break;
        const target = activeTabId === split.firstId ? split.secondId : split.firstId;
        focusSplitSide(target);
        break;
      }
      case 'open-paths':
        createSplitPartner({ externalPaths: payload.paths || null });
        break;
      case 'open-files':
        createSplitPartner({ pendingFiles: payload.files || null });
        break;
      default:
        break;
    }
  }

  function renderSplitButtonState() {
    if (splitBtn) {
      splitBtn.classList.toggle('is-on', split.active);
      const lbl = splitTr('Split view', 'تقسيم الشاشة');
      splitBtn.title = lbl;
      splitBtn.setAttribute('aria-label', lbl);
      splitBtn.setAttribute('aria-pressed', String(split.active));
    }
  }

  function closeSplitMenu() {
    if (splitMenu) {
      splitMenu.remove();
      splitMenu = null;
    }
    if (splitBtn) splitBtn.setAttribute('aria-expanded', 'false');
  }

  function openSplitMenu() {
    closeSplitMenu();
    if (!splitBtn) return;
    const menu = document.createElement('div');
    menu.className = 'split-menu';
    menu.setAttribute('role', 'menu');
    const addItem = (label, onClick, opts = {}) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `split-menu-item${opts.checked ? ' is-checked' : ''}`;
      item.setAttribute('role', opts.checkbox ? 'menuitemcheckbox' : 'menuitem');
      if (opts.checkbox) item.setAttribute('aria-checked', String(Boolean(opts.checked)));
      item.textContent = label;
      item.addEventListener('click', () => {
        closeSplitMenu();
        onClick();
      });
      menu.appendChild(item);
    };
    const addSep = (title) => {
      const sep = document.createElement('div');
      sep.className = 'split-menu-sep';
      sep.textContent = title || '';
      menu.appendChild(sep);
    };

    const currentInSplit = isInSplit(activeTabId);
    if (split.active && currentInSplit) {
      addItem(splitTr('Swap sides', 'تبديل الجانبين'), () => swapSplitSides());
      addItem(splitTr('Switch layout (side by side / stacked)', 'تغيير الترتيب (جنبًا إلى جنب / فوق بعض)'), () => rotateSplitLayout());
      addItem(splitTr('Only the active side plays sound', 'الصوت من الجانب النشط فقط'), () => setSoloAudio(!splitPrefs.soloAudio), {
        checkbox: true,
        checked: splitPrefs.soloAudio,
      });
      addItem(splitTr('Close split view', 'إغلاق تقسيم الشاشة'), () => endSplit());
      addSep();
    }
    addItem(splitTr('Open a file beside this tab…', 'فتح ملف بجانب هذا التبويب…'), () => runSplitAction('new-picker'));
    addItem(splitTr('Split with a new empty tab', 'تقسيم مع تبويب جديد فارغ'), () => runSplitAction('new'));
    const others = listSplitCandidates(tabs, activeTabId);
    if (others.length > 0) {
      addSep(splitTr('Show another tab beside this one', 'عرض تبويب آخر بجانب هذا'));
      const defaultLabel = splitTr('New Tab', 'تبويب جديد');
      others.forEach((tb) => {
        const idx = tabs.indexOf(tb) + 1;
        addItem(tb.title || `${defaultLabel} ${idx}`, () => startSplit(activeTabId, tb.id, tb.id));
      });
    }
    document.body.appendChild(menu);
    const r = splitBtn.getBoundingClientRect();
    const menuW = menu.offsetWidth;
    const rtl = document.documentElement.dir === 'rtl';
    let left = rtl ? r.right - menuW : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${r.bottom + 6}px`;
    splitMenu = menu;
    splitBtn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('button');
    if (first) first.focus();
  }

  function setupSplitUi() {
    if (!splitBtn) return;
    splitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (splitMenu) closeSplitMenu();
      else openSplitMenu();
    });
    document.addEventListener('click', (ev) => {
      if (splitMenu && !splitMenu.contains(ev.target)) closeSplitMenu();
    });
    window.addEventListener('blur', () => closeSplitMenu());
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && splitMenu) {
        closeSplitMenu();
        splitBtn.focus();
      }
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => layoutSplit()).observe(tabFramesHost);
    }
    // Clicking inside an iframe moves focus there: the shell sees its own window blur.
    window.addEventListener('blur', () => {
      const activeEl = document.activeElement;
      const hit = tabs.find((tb) => tb.iframe === activeEl);
      if (hit && isInSplit(hit.id) && hit.id !== activeTabId) activateTab(hit.id);
    });
    renderSplitButtonState();
  }

  function activateTab(tabId) {
    const target = tabs.find((tb) => tb.id === tabId);
    if (!target) return;
    activeTabId = tabId;
    tabs.forEach((tb) => {
      tb.iframe.classList.toggle('is-active', tb.id === tabId);
    });
    layoutSplit();
    broadcastSplitState();
    renderTabStrip();
    updateWindowTitle();
    try {
      target.iframe.contentWindow?.focus();
    } catch {}
  }

  function createTab(options = {}) {
    const { externalPaths = null, initial = false, activate = true, openPicker = false, pendingFiles = null } = options;
    tabSeq += 1;
    const id = `tab_${Date.now().toString(36)}_${tabSeq}`;

    const iframe = document.createElement('iframe');
    iframe.className = 'tab-frame';
    iframe.setAttribute(
      'allow',
      'fullscreen *; autoplay *; speaker-selection *; picture-in-picture *; microphone *; local-fonts *'
    );
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.src = `${getTabBaseUrl()}?aaz_tab=${encodeURIComponent(id)}${initial ? '&aaz_init=1' : ''}`;
    tabFramesHost.appendChild(iframe);

    const tab = {
      id,
      iframe,
      title: '',
      isPlaying: false,
      hasMedia: false,
      canPrev: false,
      canNext: false,
      kind: '',
      sinkLabel: '',
      ready: false,
      pendingExternalPaths: externalPaths ? [...externalPaths] : null,
      pendingOpenPicker: Boolean(openPicker),
      pendingFiles: Array.isArray(pendingFiles) && pendingFiles.length > 0 ? [...pendingFiles] : null,
    };
    tabs.push(tab);
    if (activate) activateTab(id);
    else renderTabStrip();
    return tab;
  }

  function closeTab(tabId) {
    const idx = tabs.findIndex((tb) => tb.id === tabId);
    if (idx === -1) return;
    const wasInSplit = isInSplit(tabId);
    const partnerId = wasInSplit ? (tabId === split.firstId ? split.secondId : split.firstId) : null;
    const [removed] = tabs.splice(idx, 1);
    try {
      removed.iframe.src = 'about:blank';
    } catch {}
    removed.iframe.remove();
    if (wasInSplit) {
      // The surviving side becomes a normal full-size tab again.
      const ids = [split.firstId, split.secondId];
      split.active = false;
      split.firstId = null;
      split.secondId = null;
      split.fullscreenTabId = null;
      ids.forEach((id) => clearSplitFrameStyles(tabs.find((tb) => tb.id === id)));
      tabFramesHost.classList.remove('is-split');
      if (splitDivider) splitDivider.hidden = true;
      renderSplitButtonState();
      broadcastSplitState();
      if (tabs.length > 0) {
        const keepId = tabs.some((tb) => tb.id === partnerId) ? partnerId : tabs[Math.min(idx, tabs.length - 1)].id;
        activateTab(keepId);
        return;
      }
    }

    if (tabs.length === 0) {
      createTab({ initial: false });
      return;
    }
    if (activeTabId === tabId) {
      const nextIdx = Math.min(idx, tabs.length - 1);
      activateTab(tabs[nextIdx].id);
    } else {
      renderTabStrip();
    }
  }

  function cycleTab(dir = 1) {
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((tb) => tb.id === activeTabId);
    const nextIdx = (idx + dir + tabs.length) % tabs.length;
    activateTab(tabs[nextIdx].id);
  }

  function routeExternalFilesToTab(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    const active = tabs.find((tb) => tb.id === activeTabId);
    if (tabs.length === 1 && active && !active.hasMedia && !active.pendingExternalPaths) {
      if (active.ready) {
        sendSafeMessage(active.iframe.contentWindow, {
          type: 'aaz-open-external',
          paths,
        });
      } else {
        active.pendingExternalPaths = [...paths];
      }
    } else {
      createTab({ externalPaths: paths, initial: false });
    }
  }

  async function applyShellMiniMode(enabled, alwaysOnTop) {
    if (enabled && split.active) endSplit();
    const result = await windowLayout.setMiniMode(enabled, alwaysOnTop);
    document.documentElement.classList.toggle('is-shell-mini', Boolean(result.enabled));
    tabs.forEach((tb) => {
      sendSafeMessage(tb.iframe.contentWindow, {
        type: 'aaz-shell-mini-state',
        enabled: Boolean(result.enabled),
        alwaysOnTop: Boolean(result.alwaysOnTop),
      });
    });
  }

  if (newTabBtn) {
    newTabBtn.addEventListener('click', () => createTab({ initial: false }));
  }
  if (!shellDesktop) {
    const strip = document.getElementById('tabStrip');
    if (strip) {
      strip.addEventListener('dblclick', (e) => {
        if (e.target === tabStripTabs || e.target === tabDragSpacer || e.target === strip) {
          createTab({ initial: false });
        }
      });
    }
  }

  // Hardened cross-window message listener (validates origin, source iframe, message type, tabId, and schema)
  window.addEventListener('message', (e) => {
    const received = receiveTabMessage(e, (sourceWin) =>
      tabs.find((tb) => tb.iframe && tb.iframe.contentWindow === sourceWin)
    );
    if (!received) return;

    const { tab, message: msg } = received;

    if (msg.type === 'aaz-tab-ready') {
      tab.ready = true;
      if (tab.pendingExternalPaths && tab.pendingExternalPaths.length > 0) {
        const queued = tab.pendingExternalPaths;
        tab.pendingExternalPaths = null;
        sendSafeMessage(tab.iframe.contentWindow, {
          type: 'aaz-open-external',
          paths: queued,
        });
      }
      if (windowLayout.isMiniActive()) {
        const miniPrefs = windowLayout.loadLayout().mini;
        sendSafeMessage(tab.iframe.contentWindow, {
          type: 'aaz-shell-mini-state',
          enabled: true,
          alwaysOnTop: Boolean(miniPrefs?.alwaysOnTop),
        });
      }
      if (tab.pendingFiles && tab.pendingFiles.length > 0) {
        const queuedFiles = tab.pendingFiles;
        tab.pendingFiles = null;
        sendSafeMessage(tab.iframe.contentWindow, { type: 'aaz-open-files', files: queuedFiles });
      } else if (tab.pendingOpenPicker) {
        tab.pendingOpenPicker = false;
        // Native file dialogs need no user gesture in the desktop app; browsers show the pane's own buttons instead.
        if (shellDesktop) sendSafeMessage(tab.iframe.contentWindow, { type: 'aaz-open-picker' });
      }
      broadcastSplitState();
      return;
    }

    if (msg.type === 'aaz-split-focus') {
      if (isInSplit(tab.id) && tab.id !== activeTabId) activateTab(tab.id);
      return;
    }

    if (msg.type === 'aaz-split-request') {
      if (tab.id !== activeTabId && !isInSplit(tab.id)) activateTab(tab.id);
      else if (isInSplit(tab.id) && tab.id !== activeTabId) activateTab(tab.id);
      runSplitAction(msg.action, { paths: msg.paths, files: msg.files });
      return;
    }

    if (msg.type === 'aaz-tab-state') {
      tab.title = msg.title || '';
      tab.isPlaying = Boolean(msg.isPlaying);
      tab.hasMedia = Boolean(msg.hasMedia);
      tab.canPrev = Boolean(msg.canPrev);
      tab.canNext = Boolean(msg.canNext);
      tab.kind = msg.kind || '';
      tab.sinkLabel = msg.sinkLabel || '';
      renderTabStrip();
      if (tab.id === activeTabId) updateWindowTitle();
      return;
    }

    if (msg.type === 'aaz-new-tab') {
      createTab({ initial: false });
      return;
    }

    if (msg.type === 'aaz-close-tab') {
      closeTab(tab.id);
      return;
    }

    if (msg.type === 'aaz-cycle-tab') {
      cycleTab(msg.dir === -1 ? -1 : 1);
      return;
    }

    if (msg.type === 'aaz-activate-index') {
      const target = tabs[msg.index];
      if (target) activateTab(target.id);
      return;
    }

    if (msg.type === 'aaz-shell-fullscreen') {
      document.documentElement.classList.toggle('is-shell-fullscreen', Boolean(msg.active));
      split.fullscreenTabId = msg.active && isInSplit(tab.id) ? tab.id : null;
      layoutSplit();
      return;
    }

    if (msg.type === 'aaz-tab-mini-mode') {
      applyShellMiniMode(msg.enabled, msg.alwaysOnTop).catch(() => {});
      return;
    }

    if (msg.type === 'aaz-window-action') {
      if (msg.action === 'minimize') {
        shellDesktop?.minimizeWindow?.().catch(() => {});
      } else if (msg.action === 'close') {
        windowLayout.captureAndSaveCurrentGeometry().finally(() => {
          shellDesktop?.closeWindow?.().catch(() => {});
        });
      } else if (msg.action === 'mini-preset' && msg.width && msg.height) {
        windowLayout.resizeMiniPreset(msg.width, msg.height).catch(() => {});
      } else if (msg.action === 'mini-drag-end') {
        windowLayout.scheduleGeometrySave(300);
      }
      return;
    }

    if (msg.type === 'aaz-sync-prefs') {
      if (msg.theme || msg.lang || msg.skin) {
        applyShellPrefs(msg.theme || shellTheme, msg.lang || shellLang, msg.skin || shellSkin);
      }
      tabs.forEach((tb) => {
        if (tb.id !== tab.id && tb.iframe.contentWindow) {
          sendSafeMessage(tb.iframe.contentWindow, {
            type: 'aaz-apply-prefs',
            theme: msg.theme,
            lang: msg.lang,
            skin: msg.skin,
            subtitleStyle: msg.subtitleStyle,
          });
        }
      });
    }
  });

  // Synchronize theme, visual skin, and language changes across separate windows
  window.addEventListener('storage', (e) => {
    if (e.key === 'aaz_theme' || e.key === 'aaz_lang' || e.key === SKIN_STORAGE_KEY) {
      let nextTheme = shellTheme;
      let nextLang = shellLang;
      let nextSkin = shellSkin;
      try {
        nextTheme = localStorage.getItem('aaz_theme') || 'dark';
        nextLang = localStorage.getItem('aaz_lang') || 'en';
        nextSkin = sanitizeSkin(localStorage.getItem(SKIN_STORAGE_KEY));
      } catch {}
      applyShellPrefs(nextTheme, nextLang, nextSkin);
      tabs.forEach((tb) => {
        if (tb.iframe && tb.iframe.contentWindow) {
          sendSafeMessage(tb.iframe.contentWindow, {
            type: 'aaz-apply-prefs',
            theme: nextTheme,
            lang: nextLang,
            skin: nextSkin,
          });
        }
      });
    }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      createTab({ initial: false });
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (activeTabId) closeTab(activeTabId);
    } else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (shellDesktop && shellDesktop.openNewWindow) shellDesktop.openNewWindow();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '\\') {
      e.preventDefault();
      runSplitAction('toggle');
    } else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      runSplitAction('focus');
    } else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
      const targetIdx = Number(e.key) - 1;
      if (tabs[targetIdx]) {
        e.preventDefault();
        activateTab(tabs[targetIdx].id);
      }
    }
  });

  if (shellDesktop) {
    if (winControls) winControls.hidden = false;

    // Restore persisted window geometry safely across connected monitors
    windowLayout.restoreMainWindowOnStartup().catch(() => {});

    if (winMinBtn) {
      winMinBtn.addEventListener('click', () => {
        shellDesktop.minimizeWindow?.().catch(() => {});
      });
    }
    if (winMaxBtn) {
      winMaxBtn.addEventListener('click', () => {
        shellDesktop.toggleMaximize?.().then((isMax) => {
          syncWinMaxIcons(isMax);
          windowLayout.scheduleGeometrySave(200);
        }).catch(() => {});
      });
    }
    if (winCloseBtn) {
      winCloseBtn.addEventListener('click', async () => {
        await windowLayout.captureAndSaveCurrentGeometry();
        shellDesktop.closeWindow?.().catch(() => {});
      });
    }

    let lastMaxToggleAt = 0;
    const safeToggleMaximize = () => {
      const now = Date.now();
      if (now - lastMaxToggleAt < 350) return;
      lastMaxToggleAt = now;
      shellDesktop.toggleMaximize?.().then((isMax) => {
        syncWinMaxIcons(isMax);
        windowLayout.scheduleGeometrySave(200);
      }).catch(() => {});
    };

    const bindWindowDrag = (elNode, onlySelf = false) => {
      if (!elNode) return;
      let dragArmed = null;

      const cleanupDrag = () => {
        dragArmed = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', cleanupDrag);
        window.removeEventListener('blur', cleanupDrag);
      };

      const onMove = (ev) => {
        if (!dragArmed) return;
        if ((ev.buttons & 1) === 0) {
          cleanupDrag();
          return;
        }
        const dx = ev.screenX - dragArmed.x;
        const dy = ev.screenY - dragArmed.y;
        if (Math.hypot(dx, dy) >= 5) {
          cleanupDrag();
          shellDesktop.startWindowDrag?.().then(() => {
            windowLayout.scheduleGeometrySave(450);
          }).catch(() => {});
        }
      };

      elNode.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (onlySelf && e.target !== elNode) return;
        if (e.detail >= 2) {
          cleanupDrag();
          return;
        }
        dragArmed = { x: e.screenX, y: e.screenY };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', cleanupDrag);
        window.addEventListener('blur', cleanupDrag);
      });

      elNode.addEventListener('dblclick', (e) => {
        if (onlySelf && e.target !== elNode) return;
        e.preventDefault();
        e.stopPropagation();
        cleanupDrag();
        safeToggleMaximize();
      });
    };

    bindWindowDrag(tabDragSpacer, false);
    bindWindowDrag(tabStripBrand, false);
    bindWindowDrag(tabStripTabs, true);

    let resizeSyncTimer = null;
    const refreshMaximizedState = () => {
      shellDesktop.isMaximized?.().then(syncWinMaxIcons).catch(() => {});
    };
    refreshMaximizedState();
    window.addEventListener('resize', () => {
      clearTimeout(resizeSyncTimer);
      resizeSyncTimer = setTimeout(() => {
        refreshMaximizedState();
        windowLayout.scheduleGeometrySave(300);
      }, 80);
    });

    window.addEventListener('beforeunload', () => {
      windowLayout.captureAndSaveCurrentGeometry().catch(() => {});
    });

    if (shellDesktop.onOpenExternal) {
      shellDesktop.onOpenExternal((paths) => routeExternalFilesToTab(paths));
    }
    if (shellDesktop.onFileDrop) {
      shellDesktop.onFileDrop((payload) => {
        const paths = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.paths)
            ? payload.paths
            : [];
        if (paths.length === 0) return;
        const active = tabs.find((tb) => tb.id === activeTabId);
        if (active && active.ready && active.iframe.contentWindow) {
          sendSafeMessage(active.iframe.contentWindow, {
            type: 'aaz-open-external',
            paths,
          });
        } else {
          routeExternalFilesToTab(paths);
        }
      });
    }
    if (shellDesktop.onUpdateStatus) {
      shellDesktop.onUpdateStatus((payload) => {
        tabs.forEach((tb) => {
          sendSafeMessage(tb.iframe.contentWindow, {
            type: 'aaz-update-status',
            payload,
          });
        });
      });
    }
    if (shellDesktop.onTaskbarAction) {
      shellDesktop.onTaskbarAction((action) => {
        if (action !== 'prev' && action !== 'toggle-play' && action !== 'next') return;
        const active = tabs.find((tb) => tb.id === activeTabId);
        if (active && active.iframe && active.iframe.contentWindow) {
          sendSafeMessage(active.iframe.contentWindow, {
            type: 'aaz-taskbar-action',
            action,
          });
        }
      });
    }
    if (shellDesktop.getLaunchFiles) {
      shellDesktop
        .getLaunchFiles()
        .then((paths) => {
          if (Array.isArray(paths) && paths.length > 0) routeExternalFilesToTab(paths);
        })
        .catch(() => {});
    }
  }

  setupSplitUi();
  applyShellPrefs(shellTheme, shellLang, shellSkin);
  createTab({ initial: true });
}
