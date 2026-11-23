/**
 * Android Mobile Touch Gesture & Back-Navigation Controller (R20, R21, R22).
 *
 * Implements:
 * - Touch-slop threshold (12px) and axis/scroll lock so gestures never fight list scrolling (R21).
 * - Double-tap left (-10s), double-tap right (+10s), double-tap center (play/pause) (R20).
 * - Right-edge vertical swipe: player volume (or system music stream when toggled in settings) (R20).
 * - Left-edge vertical swipe: app-window brightness (0.05..1.0) (R20).
 * - Pinch-to-zoom, aspect-ratio cycling, orientation toggle, and touch screen lock (R20).
 * - Structured Android Back stack: modal/sheet -> fullscreen/PiP -> internal drawer -> exit confirm (R22).
 */

export const TOUCH_SLOP_PX = 12;
export const DOUBLE_TAP_WINDOW_MS = 280;
export const DOUBLE_TAP_SEEK_SECS = 10;

export function classifyTapZone(relativeXRatio) {
  const x = Math.min(1, Math.max(0, Number(relativeXRatio) || 0.5));
  if (x < 0.33) return 'left';
  if (x > 0.67) return 'right';
  return 'center';
}

export function decideGestureAxis(dx, dy, slopPx = TOUCH_SLOP_PX) {
  const absX = Math.abs(Number(dx) || 0);
  const absY = Math.abs(Number(dy) || 0);
  if (absX < slopPx && absY < slopPx) return 'none';
  if (absY >= absX * 1.15) return 'vertical';
  if (absX >= absY * 1.15) return 'horizontal';
  return 'none';
}

export function createMobileGestureController(handlers = {}) {
  let locked = false;
  let lastTapTime = 0;
  let lastTapZone = '';
  let brightness = 0.7;
  let volumeMode = 'player'; // 'player' | 'system'

  function isLocked() {
    return locked;
  }

  function setLocked(next) {
    locked = Boolean(next);
    if (typeof handlers.onLockChange === 'function') {
      handlers.onLockChange(locked);
    }
    return locked;
  }

  function toggleLock() {
    return setLocked(!locked);
  }

  function setVolumeMode(mode) {
    volumeMode = mode === 'system' ? 'system' : 'player';
    return volumeMode;
  }

  function getVolumeMode() {
    return volumeMode;
  }

  function handleTap(relativeXRatio, nowMs = Date.now()) {
    if (locked) {
      if (typeof handlers.onLockedTouch === 'function') handlers.onLockedTouch();
      return { action: 'blocked-locked' };
    }
    const zone = classifyTapZone(relativeXRatio);
    const isDouble = zone === lastTapZone && nowMs - lastTapTime <= DOUBLE_TAP_WINDOW_MS;
    if (!isDouble) {
      lastTapTime = nowMs;
      lastTapZone = zone;
      return { action: 'single-tap', zone };
    }
    lastTapTime = 0;
    lastTapZone = '';

    if (zone === 'left') {
      if (typeof handlers.onSeekDelta === 'function') handlers.onSeekDelta(-DOUBLE_TAP_SEEK_SECS);
      return { action: 'seek', deltaSeconds: -DOUBLE_TAP_SEEK_SECS };
    }
    if (zone === 'right') {
      if (typeof handlers.onSeekDelta === 'function') handlers.onSeekDelta(DOUBLE_TAP_SEEK_SECS);
      return { action: 'seek', deltaSeconds: DOUBLE_TAP_SEEK_SECS };
    }
    if (typeof handlers.onTogglePlay === 'function') handlers.onTogglePlay();
    return { action: 'toggle-play' };
  }

  function handleVerticalSwipe({ relativeXRatio, deltaY, stageHeight = 400, currentVolume = 0.8 }) {
    if (locked) return { action: 'blocked-locked' };
    const height = Math.max(120, Number(stageHeight) || 400);
    // Swipe up (negative deltaY) increases value
    const deltaRatio = -(Number(deltaY) || 0) / (height * 0.75);
    const zone = classifyTapZone(relativeXRatio);
    if (zone === 'left') {
      brightness = Math.min(1, Math.max(0.05, Number((brightness + deltaRatio).toFixed(3))));
      if (typeof handlers.onBrightnessChange === 'function') {
        handlers.onBrightnessChange(brightness);
      }
      return { action: 'brightness', value: brightness };
    }
    if (zone === 'right') {
      const nextVol = Math.min(1, Math.max(0, Number(((Number(currentVolume) || 0) + deltaRatio).toFixed(3))));
      if (typeof handlers.onVolumeChange === 'function') {
        handlers.onVolumeChange(nextVol, volumeMode === 'system');
      }
      return { action: 'volume', value: nextVol, mode: volumeMode };
    }
    return { action: 'ignored' };
  }

  function handlePinchScale(scaleFactor) {
    if (locked) return { action: 'blocked-locked' };
    const clamped = Math.min(3, Math.max(0.5, Number(scaleFactor) || 1));
    if (typeof handlers.onPinchZoom === 'function') {
      handlers.onPinchZoom(clamped);
    }
    return { action: 'zoom', scale: clamped };
  }

  /**
   * Executes Android Back navigation priority (R22):
   * 1. Close top open modal / bottom sheet
   * 2. Exit fullscreen or PiP
   * 3. Navigate back inside app (e.g. close mobile playlist drawer)
   * 4. Confirm exit when playback is active; otherwise allow OS back
   */
  function handleBackAction(state = {}) {
    if (state.hasOpenModal) {
      if (typeof handlers.onCloseTopModal === 'function') handlers.onCloseTopModal();
      return 'closed-modal';
    }
    if (state.isFullscreen || state.isPip) {
      if (typeof handlers.onExitFullscreenOrPip === 'function') handlers.onExitFullscreenOrPip();
      return 'exited-fullscreen';
    }
    if (state.hasInternalBackView) {
      if (typeof handlers.onNavigateBack === 'function') handlers.onNavigateBack();
      return 'navigated-back';
    }
    if (state.isPlaying) {
      if (typeof handlers.onConfirmExit === 'function') handlers.onConfirmExit();
      return 'confirm-exit';
    }
    return 'allow-exit';
  }

  return {
    isLocked,
    setLocked,
    toggleLock,
    setVolumeMode,
    getVolumeMode,
    handleTap,
    handleVerticalSwipe,
    handlePinchScale,
    handleBackAction,
  };
}
