import { CONFIG } from '../config.js';

/**
 * Enforces tile size and format constraints for WMS requests
 */
export function enforceWMSConstraints(params) {
  return {
    ...params,
    WIDTH: CONFIG.CONSTRAINTS.TILE_SIZE,
    HEIGHT: CONFIG.CONSTRAINTS.TILE_SIZE,
    FORMAT: CONFIG.CONSTRAINTS.TILE_FORMAT
  };
}

/**
 * Validates layer count before activation
 */
export function canActivateLayer(activeCount) {
  return activeCount < CONFIG.CONSTRAINTS.MAX_DATA_LAYERS;
}

/**
 * Creates a timeout promise for network requests
 */
export function withTimeout(promise, timeoutMs = CONFIG.CONSTRAINTS.TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
    )
  ]);
}

/**
 * Validates fishing spot count
 */
export function canAddFishingSpot(currentCount) {
  return currentCount < CONFIG.CONSTRAINTS.MAX_FISHING_SPOTS;
}

/**
 * Enforces opacity range
 */
export function clampOpacity(value) {
  return Math.max(0, Math.min(1, value));
}