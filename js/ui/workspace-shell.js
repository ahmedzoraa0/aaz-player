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

export function initWorkspaceShell() {
  document.documentElement.classList.add('is-tab-shell');

  const workspaceShell = document.getElementById('workspaceShell');
  const tabStripBrand = document.getElementById('tabStripBrand');
  const tabStripTabs = document.getElementById('tabStripTabs');
  const newTabBtn = document.getElementById('newTabBtn');
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

  function updateWindowTitle() {
    const active = tabs.find((tb) => tb.id === activeTabId);
    document.title = active && active.title ? `${active.title} — AAZ Player` : 'AAZ Player';
  }

  function renderTabStrip() {
    if (!tabStripTabs) return;
    const frag = document.createDocumentFragment();
    const defaultLabel = shellLang === 'ar' ? 'تبويب جديد' : 'New Tab';

    tabs.forEach((tab, idx) => {
      const isActive = tab.id === activeTabId;
      const item = document.createElement('div');
      item.className = `workspace-tab${isActive ? ' is-active' : ''}`;
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
  }

  function activateTab(tabId) {
    const target = tabs.find((tb) => tb.id === tabId);
    if (!target) return;
    activeTabId = tabId;
    tabs.forEach((tb) => {
      tb.iframe.classList.toggle('is-active', tb.id === tabId);
    });
    renderTabStrip();
    updateWindowTitle();
    try {
      target.iframe.contentWindow?.focus();
    } catch {}
  }

  function createTab(options = {}) {
    const { externalPaths = null, initial = false } = options;
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
      kind: '',
      sinkLabel: '',
      ready: false,
      pendingExternalPaths: externalPaths ? [...externalPaths] : null,
    };
    tabs.push(tab);
    activateTab(id);
    return tab;
  }

  function closeTab(tabId) {
    const idx = tabs.findIndex((tb) => tb.id === tabId);
    if (idx === -1) return;
    const [removed] = tabs.splice(idx, 1);
    try {
      removed.iframe.src = 'about:blank';
    } catch {}
    removed.iframe.remove();

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
      return;
    }

    if (msg.type === 'aaz-tab-state') {
      tab.title = msg.title || '';
      tab.isPlaying = Boolean(msg.isPlaying);
      tab.hasMedia = Boolean(msg.hasMedia);
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
      return;
    }

    if (msg.type === 'aaz-tab-mini-mode') {
      applyShellMiniMode(msg.enabled, msg.alwaysOnTop).catch(() => {});
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
    if (shellDesktop.getLaunchFiles) {
      shellDesktop
        .getLaunchFiles()
        .then((paths) => {
          if (Array.isArray(paths) && paths.length > 0) routeExternalFilesToTab(paths);
        })
        .catch(() => {});
    }
  }

  applyShellPrefs(shellTheme, shellLang, shellSkin);
  createTab({ initial: true });
}
