/**
 * Native Rust / Tauri v2 Desktop Bridge Adapter (window.aazDesktop).
 * Safely attaches desktop IPC commands when running inside Tauri v2 WebView2.
 */

export function attachDesktopBridge(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return null;
  if (win.aazDesktop && win.aazDesktop.isTauri) return win.aazDesktop;

  let tauriApi = null;
  try {
    if (win.__TAURI__ && win.__TAURI__.core && win.__TAURI__.core.invoke) {
      tauriApi = win.__TAURI__;
    } else if (
      win.parent &&
      win.parent !== win &&
      win.parent.__TAURI__ &&
      win.parent.__TAURI__.core &&
      win.parent.__TAURI__.core.invoke
    ) {
      tauriApi = win.parent.__TAURI__;
    }
  } catch {
    // Ignore cross-origin parent inspection errors
  }

  if (!tauriApi) return null;

  const invoke = (cmd, args = {}) => tauriApi.core.invoke(cmd, args);
  const listen = (eventName, cb) => {
    if (tauriApi.event && typeof tauriApi.event.listen === 'function') {
      return tauriApi.event
        .listen(eventName, (ev) => cb(ev ? ev.payload : null))
        .catch(() => () => {});
    }
    return Promise.resolve(() => {});
  };

  const bridge = {
    isElectron: true, // Legacy compatibility flag used across existing modules
    isTauri: true,
    openNewWindow: () => invoke('aaz_new_window'),
    getAppVersion: () => invoke('aaz_get_app_version'),
    getLaunchFiles: () => invoke('aaz_get_launch_files'),
    checkForUpdates: () => invoke('aaz_check_updates'),
    downloadUpdate: () => invoke('aaz_download_update'),
    installUpdate: () => invoke('aaz_install_update'),
    onUpdateStatus: (callback) => listen('aaz:update-status', callback),
    selectFolder: () => invoke('aaz_select_folder'),
    selectFiles: () => invoke('aaz_select_files'),
    readFolder: (folderPath) => invoke('aaz_read_folder', { folderPath }),
    readTextFile: (filePath) => invoke('aaz_read_text_file', { filePath }),
    findNearbySubtitle: (videoFullPath) =>
      invoke('aaz_find_nearby_subtitle', { videoFullPath }),
    inspectPaths: (paths) => invoke('aaz_inspect_paths', { paths }),
    setAlwaysOnTop: (enabled) => invoke('aaz_set_always_on_top', { enabled: Boolean(enabled) }),
    setWindowFullscreen: (enabled) => invoke('aaz_set_fullscreen', { enabled: Boolean(enabled) }),
    isWindowFullscreen: () => invoke('aaz_is_fullscreen'),
    minimizeWindow: () => invoke('aaz_win_minimize'),
    toggleMaximize: () => invoke('aaz_win_toggle_maximize'),
    isMaximized: () => invoke('aaz_win_is_maximized'),
    closeWindow: () => invoke('aaz_win_close'),
    startWindowDrag: () => invoke('aaz_win_start_drag'),
    getWindowGeometry: () => invoke('aaz_get_window_geometry'),
    applyWindowGeometry: ({ x, y, width, height, maximized }) =>
      invoke('aaz_apply_window_geometry', {
        x: Math.round(Number(x) || 0),
        y: Math.round(Number(y) || 0),
        width: Math.max(460, Math.round(Number(width) || 1220)),
        height: Math.max(540, Math.round(Number(height) || 780)),
        maximized: Boolean(maximized),
      }),
    setMiniMode: ({ enabled, x, y, width, height, alwaysOnTop, maximized }) =>
      invoke('aaz_set_mini_mode', {
        enabled: Boolean(enabled),
        x: typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : null,
        y: typeof y === 'number' && Number.isFinite(y) ? Math.round(y) : null,
        width: typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : null,
        height: typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : null,
        alwaysOnTop: typeof alwaysOnTop === 'boolean' ? alwaysOnTop : null,
        maximized: typeof maximized === 'boolean' ? maximized : null,
      }),
    updateTaskbarState: ({ hasMedia, isPlaying, canPrev, canNext, lang }) =>
      invoke('aaz_taskbar_update_state', {
        hasMedia: Boolean(hasMedia),
        isPlaying: Boolean(isPlaying),
        canPrev: Boolean(canPrev),
        canNext: Boolean(canNext),
        lang: lang === 'ar' ? 'ar' : 'en',
      }),
    onTaskbarAction: (callback) => listen('aaz:taskbar-action', callback),
    saveSnapshot: (dataBase64, suggestedName) =>
      invoke('aaz_save_snapshot', { dataBase64, suggestedName }),
    listSystemFonts: () => invoke('aaz_list_system_fonts'),
    castStartServer: (mediaPath, title, subtitleVtt = null) =>
      invoke('aaz_cast_start_server', { mediaPath, title, subtitleVtt }),
    castStopServer: () => invoke('aaz_cast_stop_server'),
    castDiscoverDevices: () => invoke('aaz_cast_discover_devices'),
    castToDlna: (controlUrl, mediaUrl, title, mimeType) =>
      invoke('aaz_cast_to_dlna', { controlUrl, mediaUrl, title, mimeType }),
    castDlnaControl: (controlUrl, action, seekTarget = null) =>
      invoke('aaz_cast_dlna_control', { controlUrl, action, seekTarget }),
    castOpenWindowsCast: () => invoke('aaz_cast_open_windows_cast'),
    onOpenExternal: (callback) => listen('aaz:open-external', callback),
    onFileDrop: (callback) => listen('tauri://drag-drop', callback),
  };

  win.aazDesktop = bridge;
  return bridge;
}
