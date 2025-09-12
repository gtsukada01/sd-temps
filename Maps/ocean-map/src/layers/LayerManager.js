import { CONFIG } from '../config.js';
import { eventBus } from '../utils/EventBus.js';
import { HybridSSTLayer } from './HybridSSTLayer.js';
import { BathymetryLayer } from './BathymetryLayer.js';
import { FishingSpotsLayer } from './FishingSpotsLayer.js';

/**
 * Central layer orchestrator
 * Enforces 3-layer limit with swap behavior
 */
export class LayerManager {
  constructor(mapManager) {
    this.mapManager = mapManager;
    this.map = mapManager.getMap();
    
    // Track active data layers (not including fishing spots)
    this.activeDataLayers = new Map(); // layerId -> {layer, timestamp}
    
    // Initialize all layer instances
    this.layers = {
      sst: new HybridSSTLayer(this.map),
      bathymetry: new BathymetryLayer(this.map),
      fishingSpots: new FishingSpotsLayer(this.map)
    };

    // Keep Ocean Base (bathymetry) always on
    // Fishing spots remain OFF by default unless the user enables them
    this.layers.bathymetry.activate();

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Listen for layer errors
    eventBus.on('layer:error', (e) => {
      console.error(`Layer error: ${e.detail.layer}`, e.detail.error);
      // Could add UI notification here
    });

    // External request to refresh SST coverage (e.g., from legend refresh icon)
    eventBus.on('sst:refresh', async () => {
      try {
        const sst = this.layers?.sst;
        if (!sst) return;
        if (!sst.active) {
          await this.activateLayer('sst');
          return;
        }
        if (typeof sst.expandTemperatureField === 'function') {
          await sst.expandTemperatureField();
        } else if (typeof sst.refresh === 'function') {
          await sst.refresh();
        }
      } catch (err) {
        console.warn('SST refresh request failed:', err?.message || err);
      }
    });
  }

  /**
   * Activate a data layer with automatic swap if at limit
   */
  async activateLayer(layerId) {
    // Ocean Base (bathymetry) and fishing spots don't count toward limit
    if (layerId === 'bathymetry') {
      return true;
    }

    if (layerId === 'fishingSpots') {
      // Allow toggling fishing spots (does not count toward max layer limit)
      if (!this.layers.fishingSpots.active) {
        await this.layers.fishingSpots.activate();
        eventBus.emit('layer:activated', {
          layer: 'fishingSpots',
          layerId: 'fishingSpots',
          count: this.activeDataLayers.size
        });
      }
      return true;
    }

    const layer = this.layers[layerId];
    if (!layer) {
      console.error(`Unknown layer: ${layerId}`);
      return false;
    }

    // Check if already active
    if (this.activeDataLayers.has(layerId)) {
      return true;
    }

    // Check limit and swap if needed
    if (this.activeDataLayers.size >= CONFIG.CONSTRAINTS.MAX_DATA_LAYERS) {
      // Find oldest layer
      let oldestId = null;
      let oldestTime = Date.now();
      
      for (const [id, data] of this.activeDataLayers.entries()) {
        if (data.timestamp < oldestTime) {
          oldestTime = data.timestamp;
          oldestId = id;
        }
      }

      // Deactivate oldest
      if (oldestId) {
        await this.deactivateLayer(oldestId);
        
        // Emit swap event for UI notification
        eventBus.emit('layer:swapped', {
          removed: this.getLayerName(oldestId),
          added: this.getLayerName(layerId),
          message: `Swapped ${this.getLayerName(oldestId)} for ${this.getLayerName(layerId)} (3 layer max)`
        });
      }
    }

    // Activate the new layer
    try {
      await layer.activate();
      this.activeDataLayers.set(layerId, {
        layer: layer,
        timestamp: Date.now()
      });

      eventBus.emit('layer:activated', {
        layer: layerId,
        layerId: layerId,
        count: this.activeDataLayers.size
      });

      return true;
    } catch (error) {
      eventBus.emit('layer:error', {
        layer: layerId,
        error: error.message,
        fallback: 'none'
      });
      return false;
    }
  }

  /**
   * Deactivate a layer
   */
  async deactivateLayer(layerId) {
    // Can't deactivate Ocean Base (bathymetry) or fishing spots
    if (layerId === 'bathymetry') {
      return false;
    }

    if (layerId === 'fishingSpots') {
      if (this.layers.fishingSpots.active) {
        await this.layers.fishingSpots.deactivate();
        eventBus.emit('layer:deactivated', {
          layer: 'fishingSpots',
          layerId: 'fishingSpots',
          count: this.activeDataLayers.size
        });
        return true;
      }
      return false;
    }

    const layerData = this.activeDataLayers.get(layerId);
    if (!layerData) {
      return false;
    }

    try {
      await layerData.layer.deactivate();
      this.activeDataLayers.delete(layerId);

      eventBus.emit('layer:deactivated', {
        layer: layerId,
        layerId: layerId,
        count: this.activeDataLayers.size
      });

      return true;
    } catch (error) {
      console.error(`Error deactivating layer ${layerId}:`, error);
      return false;
    }
  }

  /**
   * Set layer opacity
   */
  setLayerOpacity(layerId, opacity) {
    const layer = this.layers[layerId];
    if (!layer) return;
    // Lock SST opacity at 1.0 when using styled value tiles
    const lockSST = CONFIG?.FEATURES?.USE_VALUE_TILE_RENDERER && CONFIG?.FEATURES?.VALUE_TILE_MODE === 'styled';
    if (layerId === 'sst' && lockSST) {
      layer.setOpacity(1.0);
      return;
    }
    layer.setOpacity(opacity);
  }

  /**
   * Get active layer IDs
   */
  getActiveLayers() {
    const ids = Array.from(this.activeDataLayers.keys());
    // Include fishing spots if currently active (it doesn't count toward limit)
    if (this.layers.fishingSpots?.active) {
      ids.push('fishingSpots');
    }
    return ids;
  }

  /**
   * Check if layer is active
   */
  isLayerActive(layerId) {
    return this.activeDataLayers.has(layerId);
  }

  /**
   * Get human-readable layer name
   */
  getLayerName(layerId) {
    const names = {
      sst: 'SST',
      bathymetry: 'Bathymetry',
      fishingSpots: 'Fishing Spots'
    };
    return names[layerId] || layerId;
  }

  /**
   * Get all layer IDs
   */
  getAllLayerIds() {
    return Object.keys(this.layers);
  }

  /**
   * Toggle layer on/off
   */
  async toggleLayer(layerId) {
    if (this.isLayerActive(layerId)) {
      await this.deactivateLayer(layerId);
      return false;
    } else {
      await this.activateLayer(layerId);
      return true;
    }
  }
}
