/**
 * Playback Settings Manager (Phase 3 Feature 7).
 *
 * Exposes real, supported settings persisted via StorageManager plus a live
 * read-only WebGL/GPU hardware acceleration status detector.
 */

import { DEFAULT_PLAYBACK_SETTINGS, sanitizePlaybackSettings } from './storage-manager.js';

export function detectHardwareAcceleration() {
  if (typeof document === 'undefined') {
    return { available: false, renderer: 'Unknown', backend: 'Unavailable' };
  }
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      return { available: false, renderer: 'Software / No WebGL', backend: 'CPU' };
    }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'WebGL GPU')
      : 'WebGL GPU';
    const isSoftware = /swiftshader|llvmpipe|software|microsoft basic render/i.test(renderer);
    return {
      available: !isSoftware,
      renderer: renderer.slice(0, 100),
      backend: gl instanceof (typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : Object)
        ? 'WebGL2'
        : 'WebGL',
    };
  } catch {
    return { available: false, renderer: 'Unavailable', backend: 'Fallback' };
  }
}

export function createSettingsManager({ getStore, persist }) {
  function get() {
    const store = getStore();
    store.playbackSettings = sanitizePlaybackSettings(store.playbackSettings);
    return store.playbackSettings;
  }

  function update(patch) {
    const store = getStore();
    const merged = { ...get(), ...(patch && typeof patch === 'object' ? patch : {}) };
    store.playbackSettings = sanitizePlaybackSettings(merged);
    persist();
    return store.playbackSettings;
  }

  function reset() {
    const store = getStore();
    store.playbackSettings = { ...DEFAULT_PLAYBACK_SETTINGS };
    persist();
    return store.playbackSettings;
  }

  return {
    get,
    update,
    reset,
    detectHardwareAcceleration,
  };
}
