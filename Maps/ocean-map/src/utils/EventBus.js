/**
 * Central event bus for cross-module communication
 * All modules communicate through events, never direct coupling
 */
class EventBus extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, handler) {
    this.addEventListener(type, handler);
  }

  off(type, handler) {
    this.removeEventListener(type, handler);
  }

  once(type, handler) {
    this.addEventListener(type, handler, { once: true });
  }
}

export const eventBus = new EventBus();