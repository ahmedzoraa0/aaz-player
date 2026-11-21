/**
 * Window Layout Persistence & Mini Player Coordinator (Phase 3 Features 4 & 5).
 *
 * Persists:
 * - Main window geometry (x, y, width, height, maximized) safely clamped on restore
 *   by the Rust backend across monitor configurations.
 * - Mini player window geometry (x, y, width, height, alwaysOnTop).
 */

import { DEFAULT_WINDOW_LAYOUT } from './storage-manager.js';

export function createWindowLayoutManager({ storageManager, desktopBridge }) {
  let isMiniActive = false;
  let preMiniMainRect = null;
  let saveTimer = null;

  function loadLayout() {
    const state = storageManager.load();
    return {
      main: state.windowLayout?.main || null,
      mini: {
        ...DEFAULT_WINDOW_LAYOUT.mini,
        ...(state.windowLayout?.mini || {}),
      },
    };
  }

  function persistLayout(updater) {
    const state = storageManager.load();
    if (!state.windowLayout) {
      state.windowLayout = {
        main: null,
        mini: { ...DEFAULT_WINDOW_LAYOUT.mini },
      };
    }
    updater(state.windowLayout);
    storageManager.save(state);
  }

  async function restoreMainWindowOnStartup() {
    if (!desktopBridge || typeof desktopBridge.applyWindowGeometry !== 'function') return false;
    const layout = loadLayout();
    if (!layout.main) return false;
    try {
      await desktopBridge.applyWindowGeometry(layout.main);
      return true;
    } catch {
      return false;
    }
  }

  async function captureAndSaveCurrentGeometry() {
    if (!desktopBridge || typeof desktopBridge.getWindowGeometry !== 'function') return null;
    try {
      const geo = await desktopBridge.getWindowGeometry();
      if (!geo || !Number.isFinite(geo.width) || !Number.isFinite(geo.height)) return null;

      if (isMiniActive) {
        persistLayout((wl) => {
          wl.mini = {
            ...DEFAULT_WINDOW_LAYOUT.mini,
            ...(wl.mini || {}),
            x: geo.x,
            y: geo.y,
            width: Math.max(300, geo.width),
            height: Math.max(190, geo.height),
          };
        });
      } else {
        persistLayout((wl) => {
          if (geo.maximized) {
            wl.main = {
              x: wl.main ? wl.main.x : geo.x,
              y: wl.main ? wl.main.y : geo.y,
              width: wl.main ? wl.main.width : Math.max(460, geo.width),
              height: wl.main ? wl.main.height : Math.max(540, geo.height),
              maximized: true,
            };
          } else {
            wl.main = {
              x: geo.x,
              y: geo.y,
              width: Math.max(460, geo.width),
              height: Math.max(540, geo.height),
              maximized: false,
            };
          }
        });
      }
      return geo;
    } catch {
      return null;
    }
  }

  function scheduleGeometrySave(delayMs = 350) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      captureAndSaveCurrentGeometry().catch(() => {});
    }, delayMs);
  }

  async function setMiniMode(enabled, alwaysOnTopOverride) {
    const next = Boolean(enabled);
    const layout = loadLayout();
    const miniPrefs = { ...DEFAULT_WINDOW_LAYOUT.mini, ...(layout.mini || {}) };

    if (typeof alwaysOnTopOverride === 'boolean') {
      miniPrefs.alwaysOnTop = alwaysOnTopOverride;
      persistLayout((wl) => {
        wl.mini = { ...miniPrefs };
      });
    }

    if (next && !isMiniActive) {
      // Save current main window bounds right before shrinking to mini player
      if (desktopBridge && typeof desktopBridge.getWindowGeometry === 'function') {
        try {
          const geo = await desktopBridge.getWindowGeometry();
          if (geo) {
            preMiniMainRect = {
              x: geo.x,
              y: geo.y,
              width: Math.max(460, geo.width),
              height: Math.max(540, geo.height),
              maximized: Boolean(geo.maximized),
            };
            persistLayout((wl) => {
              if (!geo.maximized) {
                wl.main = preMiniMainRect;
              }
            });
          }
        } catch {}
      }

      isMiniActive = true;
      if (desktopBridge && typeof desktopBridge.setMiniMode === 'function') {
        try {
          await desktopBridge.setMiniMode({
            enabled: true,
            x: miniPrefs.x,
            y: miniPrefs.y,
            width: miniPrefs.width,
            height: miniPrefs.height,
            alwaysOnTop: miniPrefs.alwaysOnTop,
          });
        } catch {}
      }
    } else if (!next && isMiniActive) {
      // Save mini window bounds before expanding back
      await captureAndSaveCurrentGeometry();
      isMiniActive = false;

      const restoreTarget = preMiniMainRect || loadLayout().main;
      if (desktopBridge && typeof desktopBridge.setMiniMode === 'function') {
        try {
          await desktopBridge.setMiniMode({
            enabled: false,
            x: restoreTarget ? restoreTarget.x : null,
            y: restoreTarget ? restoreTarget.y : null,
            width: restoreTarget ? restoreTarget.width : 1220,
            height: restoreTarget ? restoreTarget.height : 780,
            alwaysOnTop: false,
          });
          if (restoreTarget && restoreTarget.maximized && desktopBridge.applyWindowGeometry) {
            await desktopBridge.applyWindowGeometry(restoreTarget);
          }
        } catch {}
      }
    } else if (next && isMiniActive && typeof alwaysOnTopOverride === 'boolean') {
      if (desktopBridge && typeof desktopBridge.setAlwaysOnTop === 'function') {
        try {
          await desktopBridge.setAlwaysOnTop(alwaysOnTopOverride);
        } catch {}
      }
    }

    return { enabled: isMiniActive, alwaysOnTop: miniPrefs.alwaysOnTop };
  }

  return {
    isMiniActive: () => isMiniActive,
    loadLayout,
    restoreMainWindowOnStartup,
    captureAndSaveCurrentGeometry,
    scheduleGeometrySave,
    setMiniMode,
  };
}
