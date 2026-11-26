/**
 * Lightweight, duplicate-safe EventBus for Hamza internal modules.
 */
export function createEventBus() {
  const listeners = new Map();

  function on(event, handler) {
    if (typeof event !== 'string' || !event || typeof handler !== 'function') {
      return () => {};
    }
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => off(event, handler);
  }

  function once(event, handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (payload) => {
      off(event, wrapped);
      handler(payload);
    };
    return on(event, wrapped);
  }

  function off(event, handler) {
    const set = listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) listeners.delete(event);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] Error in "${event}" listener:`, err);
      }
    }
  }

  function clear(event) {
    if (event) {
      listeners.delete(event);
    } else {
      listeners.clear();
    }
  }

  return { on, once, off, emit, clear };
}
