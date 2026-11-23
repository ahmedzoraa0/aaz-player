/**
 * Hold-to-Speed Boost Controller.
 *
 * While a hold is active the playback rate is pinned at EXACTLY
 * SPEED_BOOST_PIN_RATE (2.0x), whatever the base rate was — a hold never
 * multiplies the base rate and never preserves a higher rate. Releasing (or
 * cancelling) the hold restores the exact base rate that was active before
 * the hold, including turbo rates above 2x.
 *
 * Boost triggers are matched per source ('touch' | 'mouse' | 'space') so one
 * source cannot cancel another's boost. This module is pure logic so the
 * behavior is executable in Node tests; player-app.js wires DOM events to it.
 */

export const SPEED_BOOST_PIN_RATE = 2;

export function createSpeedBoostController({ getBaseRate, applyRate, onChange } = {}) {
  const state = {
    active: false,
    source: null,
    baseRate: 1,
    boostedRate: SPEED_BOOST_PIN_RATE,
  };

  function readBaseRate() {
    const raw = Number(typeof getBaseRate === 'function' ? getBaseRate() : NaN);
    return Number.isFinite(raw) && raw > 0 ? raw : NaN;
  }

  function emit(restoredRate = null) {
    if (typeof onChange === 'function') {
      onChange({
        active: state.active,
        source: state.source,
        baseRate: state.baseRate,
        boostedRate: state.boostedRate,
        restoredRate,
      });
    }
  }

  /**
   * Begin a hold from `source`. Same-source re-press during an active boost is
   * a no-op (returns true). A different source while active is refused so it
   * cannot corrupt the stored base rate (returns false).
   */
  function start(source) {
    if (state.active && state.source === source) return true;
    if (state.active) return false;
    const base = readBaseRate();
    state.baseRate = Number.isFinite(base) ? base : 1;
    state.boostedRate = SPEED_BOOST_PIN_RATE;
    state.active = true;
    state.source = source;
    if (typeof applyRate === 'function') applyRate(state.boostedRate);
    emit(null);
    return true;
  }

  /**
   * End the hold, restoring the exact base rate active before the hold. If the
   * base rate was changed while the hold was active (e.g. from the speed
   * menu), the live base rate wins so the result stays coherent. Passing a
   * `source` only stops a boost owned by that source.
   */
  function stop(source = null) {
    if (!state.active) return false;
    if (source && state.source !== source) return false;
    const live = readBaseRate();
    const restoreRate = Number.isFinite(live) ? live : state.baseRate;
    state.active = false;
    state.source = null;
    if (typeof applyRate === 'function') applyRate(restoreRate);
    emit(restoreRate);
    return true;
  }

  /**
   * Cancel any active hold regardless of source (window blur, app
   * backgrounding, touchcancel/pointercancel, multitouch, pause, track end or
   * track change). Identical restore semantics to a normal release: a hold
   * must never get stuck on.
   */
  function cancel() {
    return stop(null);
  }

  /**
   * The user picked a new base speed while a hold was active: update the
   * restore target without disturbing the active boost, so release restores
   * the newly chosen rate. Ignored when no boost is active.
   */
  function setBaseRate(rate) {
    if (!state.active) return false;
    const parsed = Number(rate);
    if (Number.isFinite(parsed) && parsed > 0) state.baseRate = parsed;
    return true;
  }

  return {
    state,
    start,
    stop,
    cancel,
    setBaseRate,
  };
}
