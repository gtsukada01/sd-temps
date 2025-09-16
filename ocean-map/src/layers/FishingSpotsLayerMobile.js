import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { Icon, Style, Text, Fill, Stroke } from 'ol/style';
import { fromLonLat, toLonLat } from 'ol/proj';
import { CONFIG } from '../config.js';
import { eventBus } from '../utils/EventBus.js';

/**
 * Mobile-friendly fishing spots layer with fallback storage
 */
export class FishingSpotsLayerMobile {
  constructor(map) {
    this.map = map;
    this.layer = null;
    this.source = null;
    this.active = false;
    this.spots = [];
    this.selectedSpot = null;
    this._clickHandler = null;
    this.storageAvailable = this.checkStorageAvailable();
  }

  // Check if localStorage is available (mobile Safari private mode issue)
  checkStorageAvailable() {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch (e) {
      console.warn('localStorage not available, using memory storage');
      return false;
    }
  }

  async activate() {
    if (this.active) return;

    // Create vector source
    this.source = new VectorSource();

    // Create layer with custom style
    this.layer = new VectorLayer({
      source: this.source,
      style: (feature) => this.createSpotStyle(feature),
      zIndex: 100, // Always on top
      declutter: true
    });

    // Load saved spots (with fallback)
    this.loadSpots();

    // Add to map
    this.map.addLayer(this.layer);
    this.active = true;

    // Enable double-click to add spots
    this.map.on('dblclick', (evt) => {
      evt.preventDefault();
      const coords = toLonLat(evt.coordinate);
      this.addSpot(coords[1], coords[0]);
      return false;
    });

    // Enable right-click to remove spots
    this.map.on('contextmenu', (evt) => {
      evt.preventDefault();
      const feature = this.map.forEachFeatureAtPixel(evt.pixel, (f) => f);
      if (feature && feature.get('type') === 'fishing_spot') {
        this.removeSpot(feature);
      }
      return false;
    });

    eventBus.emit('layer:activated', { layer: 'fishing_spots' });
  }

  createSpotStyle(feature) {
    const isSelected = feature === this.selectedSpot;
    
    return new Style({
      image: new Icon({
        src: 'data:image/svg+xml;base64,' + btoa(`
          <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
            <circle cx="16" cy="16" r="8" fill="${isSelected ? '#ff4444' : '#4CAF50'}" stroke="white" stroke-width="2"/>
            <circle cx="16" cy="16" r="3" fill="white"/>
          </svg>
        `),
        scale: isSelected ? 1.2 : 1,
        anchor: [0.5, 0.5]
      }),
      text: new Text({
        text: feature.get('name') || 'Spot',
        offsetY: 20,
        fill: new Fill({ color: '#000' }),
        stroke: new Stroke({ color: '#fff', width: 3 }),
        font: '12px sans-serif'
      })
    });
  }

  addSpot(lat, lon, name = null) {
    const spotName = name || `Spot ${this.spots.length + 1}`;
    const spot = {
      id: Date.now(),
      lat,
      lon,
      name: spotName,
      type: 'fishing_spot',
      created: new Date().toISOString()
    };

    const feature = new Feature({
      geometry: new Point(fromLonLat([lon, lat])),
      ...spot
    });

    this.source.addFeature(feature);
    this.spots.push(spot);
    this.saveSpots();

    eventBus.emit('spot:added', spot);
  }

  removeSpot(feature) {
    const id = feature.get('id');
    this.spots = this.spots.filter(s => s.id !== id);
    this.source.removeFeature(feature);
    this.saveSpots();
    
    eventBus.emit('spot:removed', { id });
  }

  loadSpots() {
    try {
      if (this.storageAvailable) {
        const saved = localStorage.getItem(CONFIG.STORAGE.FISHING_SPOTS);
        if (saved) {
          const spots = JSON.parse(saved);
          this.displaySpots(spots);
        }
      } else {
        // Try sessionStorage as fallback
        const saved = sessionStorage.getItem(CONFIG.STORAGE.FISHING_SPOTS);
        if (saved) {
          const spots = JSON.parse(saved);
          this.displaySpots(spots);
        }
      }
    } catch (error) {
      console.error('Failed to load fishing spots:', error);
      // Use default demo spots if storage fails
      this.loadDemoSpots();
    }
  }

  displaySpots(spots) {
    spots.forEach(spot => {
      const feature = new Feature({
        geometry: new Point(fromLonLat([spot.lon, spot.lat])),
        ...spot
      });
      this.source.addFeature(feature);
    });
    this.spots = spots;
  }

  loadDemoSpots() {
    // Load some demo spots for mobile users who can't use localStorage
    const demoSpots = [
      { id: 1, lat: 32.7157, lon: -117.1611, name: 'San Diego Bay', type: 'fishing_spot' },
      { id: 2, lat: 32.6781, lon: -117.2420, name: 'Point Loma', type: 'fishing_spot' },
      { id: 3, lat: 32.8328, lon: -117.2713, name: 'La Jolla', type: 'fishing_spot' }
    ];
    this.displaySpots(demoSpots);
  }

  saveSpots() {
    try {
      const spotsJson = JSON.stringify(this.spots);
      
      if (this.storageAvailable) {
        localStorage.setItem(CONFIG.STORAGE.FISHING_SPOTS, spotsJson);
      } else {
        // Use sessionStorage as fallback (persists for session only)
        sessionStorage.setItem(CONFIG.STORAGE.FISHING_SPOTS, spotsJson);
      }
      
      eventBus.emit('spots:saved', { count: this.spots.length });
    } catch (error) {
      console.error('Failed to save fishing spots:', error);
      // Continue working even if save fails
    }
  }

  deactivate() {
    if (!this.active) return;
    
    if (this.layer) {
      this.map.removeLayer(this.layer);
    }
    
    this.active = false;
    eventBus.emit('layer:deactivated', { layer: 'fishing_spots' });
  }

  setOpacity(value) {
    if (this.layer) {
      this.layer.setOpacity(value);
    }
  }

  getOpacity() {
    return this.layer ? this.layer.getOpacity() : 1;
  }
}

export default FishingSpotsLayerMobile;