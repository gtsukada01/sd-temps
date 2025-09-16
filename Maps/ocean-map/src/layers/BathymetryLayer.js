import TileLayer from 'ol/layer/Tile';
import LayerGroup from 'ol/layer/Group';
import XYZ from 'ol/source/XYZ';
import TileWMS from 'ol/source/TileWMS';
import { CONFIG } from '../config.js';
import { eventBus } from '../utils/EventBus.js';

/**
 * Ocean Base layer showing ocean depth colors and geographic features
 * Default base map layer with depth shading and labels
 */
export class BathymetryLayer {
  constructor(map) {
    this.map = map;
    this.layer = null;
    this.active = false;
    this.name = 'Ocean Base';
  }

  async activate() {
    if (this.active) return;

    try {
      // Layer 1: Ocean depth shading (base colors)
      const depthLayer = new TileLayer({
        source: new XYZ({
          url: 'https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
          crossOrigin: 'anonymous'
        }),
        opacity: 0.7
      });

      // Layer 2: GEBCO depth contour lines with values
      const contourLayer = new TileLayer({
        source: new TileWMS({
          url: 'https://www.gebco.net/data_and_products/gebco_web_services/web_map_service/mapserv',
          params: {
            'LAYERS': 'GEBCO_LATEST_SUB_ICE_TOPO',
            'VERSION': '1.3.0',
            'CRS': 'EPSG:3857',
            'STYLES': 'contour',
            'FORMAT': 'image/png',
            'TRANSPARENT': true
          },
          serverType: 'mapserver',
          crossOrigin: 'anonymous'
        }),
        opacity: 0.6
      });

      // Layer 3: Geographic labels and features
      const labelsLayer = new TileLayer({
        source: new XYZ({
          url: 'https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}',
          crossOrigin: 'anonymous'
        }),
        opacity: 0.9
      });

      // Group all three together
      this.layer = new LayerGroup({
        layers: [depthLayer, contourLayer, labelsLayer],
        zIndex: 5
      });

      this.map.addLayer(this.layer);
      this.active = true;

      eventBus.emit('layer:loaded', { 
        layer: this.name,
        source: 'Ocean depth + contours + labels'
      });

      // Show notification
      eventBus.emit('layer:info', {
        layer: this.name,
        message: 'Ocean Base: Map loaded with depth and labels'
      });

    } catch (error) {
      // If GEBCO fails, fall back to just ocean base + labels
      this.activateFallback();
    }
  }

  async activateFallback() {
    try {
      // Simplified version without GEBCO contours
      const depthLayer = new TileLayer({
        source: new XYZ({
          url: 'https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
          crossOrigin: 'anonymous'
        }),
        opacity: 0.8
      });

      const labelsLayer = new TileLayer({
        source: new XYZ({
          url: 'https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}',
          crossOrigin: 'anonymous'
        }),
        opacity: 0.9
      });

      this.layer = new LayerGroup({
        layers: [depthLayer, labelsLayer],
        zIndex: 5
      });

      this.map.addLayer(this.layer);
      this.active = true;

      eventBus.emit('layer:loaded', { 
        layer: this.name,
        source: 'Ocean depth + labels (no contours)'
      });

      eventBus.emit('layer:info', {
        layer: this.name,
        message: 'Ocean Base: Map loaded successfully'
      });

    } catch (error) {
      this.handleActivationError(error);
    }
  }

  handleActivationError(error) {
    console.error(`Ocean Base activation failed: ${error.message}`);
    
    eventBus.emit('layer:error', {
      layer: this.name,
      error: error.message,
      fallback: 'none'
    });
  }

  deactivate() {
    if (this.layer && this.active) {
      this.map.removeLayer(this.layer);
      this.layer = null;
      this.active = false;
    }
  }

  setOpacity(value) {
    if (this.layer) {
      // Set opacity on the entire group
      this.layer.setOpacity(value);
    }
  }

  isActive() {
    return this.active;
  }

  getLayer() {
    return this.layer;
  }
}