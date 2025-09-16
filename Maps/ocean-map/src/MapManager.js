import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import { fromLonLat } from 'ol/proj';
import { CONFIG } from './config.js';
import { eventBus } from './utils/EventBus.js';

/**
 * Core map instance manager
 * Handles base map setup and provides map instance to other modules
 */
export class MapManager {
  constructor(targetId) {
    this.targetId = targetId;
    this.map = null;
    this.baseLayer = null;
    this.initializeMap();
  }

  initializeMap() {
    // Create base satellite layer
    this.baseLayer = new TileLayer({
      source: new XYZ({
        url: CONFIG.BASE_MAPS.SATELLITE.url,
        attributions: CONFIG.BASE_MAPS.SATELLITE.attribution,
        crossOrigin: 'anonymous'
      }),
      zIndex: 0
    });

    // Initialize map
    this.map = new Map({
      target: this.targetId,
      layers: [this.baseLayer],
      view: new View({
        center: fromLonLat(CONFIG.MAP.CENTER),
        zoom: CONFIG.MAP.ZOOM,
        maxZoom: CONFIG.MAP.MAX_ZOOM,
        minZoom: CONFIG.MAP.MIN_ZOOM
      })
    });

    // Restore last position if available
    this.restorePosition();

    // Save position on move
    this.map.on('moveend', () => this.savePosition());

    // Emit ready event
    eventBus.emit('map:ready', { map: this.map });
  }

  getMap() {
    return this.map;
  }

  addLayer(layer) {
    this.map.addLayer(layer);
  }

  removeLayer(layer) {
    this.map.removeLayer(layer);
  }

  switchBaseMap(type) {
    const config = CONFIG.BASE_MAPS[type];
    if (!config) return;

    this.baseLayer.setSource(new XYZ({
      url: config.url,
      attributions: config.attribution,
      crossOrigin: 'anonymous'
    }));

    eventBus.emit('basemap:changed', { type });
  }

  savePosition() {
    const view = this.map.getView();
    const position = {
      center: view.getCenter(),
      zoom: view.getZoom()
    };
    localStorage.setItem(CONFIG.STORAGE.LAST_POSITION, JSON.stringify(position));
  }

  restorePosition() {
    try {
      const saved = localStorage.getItem(CONFIG.STORAGE.LAST_POSITION);
      if (saved) {
        const position = JSON.parse(saved);
        this.map.getView().setCenter(position.center);
        this.map.getView().setZoom(position.zoom);
      }
    } catch (error) {
      // Ignore errors, use default position
    }
  }

  destroy() {
    if (this.map) {
      this.map.setTarget(null);
      this.map = null;
    }
  }
}