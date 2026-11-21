/**
 * AAZ Player Main ES Module Entry Point.
 * Attaches the native Tauri v2 Desktop Bridge and bootstraps either:
 * - The Top-Level Multi-Tab Workspace Shell, OR
 * - An independent Tab Player Instance.
 */

import { attachDesktopBridge } from './core/desktop-bridge.js';
import { initWorkspaceShell } from './ui/workspace-shell.js';
import { initPlayerApp } from './app/player-app.js';

attachDesktopBridge(window);

const urlParams = new URLSearchParams(window.location.search);
const currentTabId = urlParams.get('aaz_tab');
const isInitialTab = urlParams.get('aaz_init') === '1';
const isTabFrame = Boolean(currentTabId) && window.parent && window.parent !== window;

if (!currentTabId) {
  initWorkspaceShell();
} else {
  initPlayerApp({
    currentTabId,
    isInitialTab,
    isTabFrame,
  });
}
