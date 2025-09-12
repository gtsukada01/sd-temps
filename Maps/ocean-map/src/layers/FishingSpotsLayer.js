import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { Icon, Style, Text, Fill, Stroke } from 'ol/style';
import { fromLonLat, toLonLat } from 'ol/proj';
import { CONFIG } from '../config.js';
import { eventBus } from '../utils/EventBus.js';
import { canAddFishingSpot } from '../utils/constraints.js';

/**
 * Fishing spots layer with localStorage auto-save
 * Always visible, not counted in layer limit
 */
export class FishingSpotsLayer {
  constructor(map) {
    this.map = map;
    this.layer = null;
    this.source = null;
    this.active = false;
    this.spots = [];
    this.selectedSpot = null;
    this._clickHandler = null;
    this._importedCount = 0;
  }

  async activate() {
    if (this.active) return;

    // Create vector source
    this.source = new VectorSource();

    // Create layer with custom style
    this.layer = new VectorLayer({
      source: this.source,
      style: (feature, resolution) => this.createSpotStyle(feature, resolution),
      zIndex: 100, // Always on top
      declutter: true
    });

    // Load saved personal spots
    this.loadSpots();

    // Optionally load bulk/imported spots from static JSON
    await this._loadImportedSpotsIfAvailable();

    // Add to map
    this.map.addLayer(this.layer);
    this.active = true;

    // Setup interactions
    this.setupInteractions();

    eventBus.emit('layer:loaded', { 
      layer: 'FishingSpots',
      layerId: 'fishingSpots',
      count: this.spots.length + this._importedCount
    });
  }

  createSpotStyle(feature, resolution) {
    const isSelected = feature === this.selectedSpot;
    const isImported = !!feature.get('isImported');
    const cfg = CONFIG?.SOURCES?.FISHING_SPOTS || {};
    const textOnlyAll = !!cfg.TEXT_ONLY_ALL_SPOTS;
    const maxRes = cfg.LABEL_MAX_RESOLUTION_MPP || cfg.TEXT_ONLY_MAX_RESOLUTION_MPP || 500; // meters/pixel
    const withinLabelZoom = (resolution || 0) > 0 ? (resolution <= maxRes) : true;

    // Show label when zoomed in enough or when selected
    const showLabel = withinLabelZoom || isSelected;

    // Text styling: emphasize selection, slight color variance for imported vs personal
    const textColor = isSelected ? '#c81e1e' : (isImported ? '#0f4aff' : '#0b3d91');
    const font = isSelected ? 'bold 13px sans-serif' : '12px sans-serif';

    const styleOptions = {};

    // For text-only mode (requested), we omit the pin entirely
    if (showLabel) {
      styleOptions.text = new Text({
        text: feature.get('name') || '',
        font,
        fill: new Fill({ color: textColor }),
        stroke: new Stroke({ color: '#ffffff', width: 3 })
      });
    }

    return new Style(styleOptions);
  }

  setupInteractions() {
    // Click to select/edit
    this._clickHandler = (evt) => {
      const feature = this.map.forEachFeatureAtPixel(evt.pixel, 
        (feature) => feature,
        { layerFilter: (layer) => layer === this.layer }
      );

      if (feature) {
        this.selectSpot(feature);
      } else {
        this.deselectSpot();
      }
    };

    this.map.on('singleclick', this._clickHandler);

    // Double-click spot creation DISABLED - spots can only be created through import
    // this.map.on('dblclick', (evt) => {
    //   const coords = toLonLat(evt.coordinate);
    //   this.addSpot(coords[0], coords[1]);
    //   evt.preventDefault();
    // });
  }

  addSpot(lon, lat, name = null) {
    if (!canAddFishingSpot(this.spots.length)) {
      eventBus.emit('layer:limit', {
        layer: 'FishingSpots',
        message: `Maximum ${CONFIG.CONSTRAINTS.MAX_FISHING_SPOTS} spots allowed`
      });
      return null;
    }

    const spotName = name || `Spot ${this.spots.length + 1}`;
    const id = Date.now().toString();
    
    const feature = new Feature({
      geometry: new Point(fromLonLat([lon, lat])),
      id: id,
      name: spotName,
      lon: lon,
      lat: lat,
      notes: '',
      created: new Date().toISOString()
    });

    this.source.addFeature(feature);
    this.spots.push({
      id: id,
      name: spotName,
      lon: lon,
      lat: lat,
      notes: '',
      created: feature.get('created')
    });

    this.saveSpots();
    
    eventBus.emit('spots:added', {
      spot: { id, name: spotName, lon, lat }
    });

    return feature;
  }

  async _loadImportedSpotsIfAvailable() {
    try {
      const cfg = CONFIG?.SOURCES?.FISHING_SPOTS;
      if (!cfg?.IMPORT_URL) return;
      const res = await fetch(cfg.IMPORT_URL, { cache: 'no-cache' });
      if (!res.ok) return; // no static file present; silently skip
      const data = await res.json();

      // Accept either array of simple objects or GeoJSON FeatureCollection
      let items = [];
      if (Array.isArray(data)) {
        items = data;
      } else if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
        items = data.features.map(f => ({
          lon: f.geometry?.coordinates?.[0],
          lat: f.geometry?.coordinates?.[1],
          name: f.properties?.name,
          notes: f.properties?.notes
        }));
      }

      let imported = 0;
      for (const item of items) {
        const lon = Number(item.lon);
        const lat = Number(item.lat);
        if (!isFinite(lon) || !isFinite(lat)) continue;
        const feature = new Feature({
          geometry: new Point(fromLonLat([lon, lat])),
          id: `imp_${Date.now()}_${imported}`,
          name: item.name || 'Spot',
          lon, lat,
          notes: item.notes || '',
          created: new Date().toISOString(),
          isImported: true
        });
        this.source.addFeature(feature);
        imported++;
      }
      this._importedCount = imported;
      if (imported > 0) {
        eventBus.emit('layer:info', { message: `Loaded ${imported} imported fishing spots` });
      }
    } catch (err) {
      // Non-fatal: imported file may not exist or may be invalid
      console.warn('Import fishing spots load skipped:', err?.message || err);
    }
  }

  removeSpot(feature) {
    const id = feature.get('id');
    
    this.source.removeFeature(feature);
    this.spots = this.spots.filter(s => s.id !== id);
    
    this.saveSpots();
    
    eventBus.emit('spots:removed', { id });
  }

  updateSpot(feature, updates) {
    // Update feature properties
    Object.keys(updates).forEach(key => {
      feature.set(key, updates[key]);
    });

    // Update spots array
    const id = feature.get('id');
    const spotIndex = this.spots.findIndex(s => s.id === id);
    if (spotIndex !== -1) {
      this.spots[spotIndex] = {
        ...this.spots[spotIndex],
        ...updates
      };
    }

    // Refresh style if name changed
    if (updates.name) {
      feature.changed();
    }

    this.saveSpots();
    
    eventBus.emit('spots:updated', { id, updates });
  }

  selectSpot(feature) {
    this.selectedSpot = feature;
    feature.changed(); // Trigger style update
    
    eventBus.emit('spots:selected', {
      id: feature.get('id'),
      name: feature.get('name'),
      lon: feature.get('lon'),
      lat: feature.get('lat'),
      notes: feature.get('notes')
    });
  }

  deselectSpot() {
    if (this.selectedSpot) {
      const prevSelected = this.selectedSpot;
      this.selectedSpot = null;
      prevSelected.changed(); // Trigger style update
      
      eventBus.emit('spots:deselected');
    }
  }

  loadSpots() {
    try {
      const saved = localStorage.getItem(CONFIG.STORAGE.FISHING_SPOTS);
      if (saved) {
        const spots = JSON.parse(saved);
        spots.forEach(spot => {
          const feature = new Feature({
            geometry: new Point(fromLonLat([spot.lon, spot.lat])),
            ...spot
          });
          this.source.addFeature(feature);
        });
        this.spots = spots;
      }
    } catch (error) {
      console.error('Failed to load fishing spots:', error);
      this.spots = [];
    }
  }

  saveSpots() {
    try {
      localStorage.setItem(
        CONFIG.STORAGE.FISHING_SPOTS,
        JSON.stringify(this.spots)
      );
      
      eventBus.emit('spots:saved', {
        count: this.spots.length
      });
    } catch (error) {
      console.error('Failed to save fishing spots:', error);
      eventBus.emit('spots:save-error', {
        error: error.message
      });
    }
  }


  deactivate() {
    if (!this.active) return false;
    try {
      // Remove interactions
      if (this._clickHandler) {
        this.map.un('singleclick', this._clickHandler);
        this._clickHandler = null;
      }

      // Remove layer from map
      if (this.layer) {
        this.map.removeLayer(this.layer);
      }

      this.layer = null;
      this.source = null;
      this.selectedSpot = null;
      this.active = false;

      eventBus.emit('layer:deactivated', { layer: 'fishingSpots', layerId: 'fishingSpots' });
      return true;
    } catch (error) {
      console.error('Failed to deactivate fishing spots:', error);
      return false;
    }
  }

  setOpacity(value) {
    if (this.layer) {
      this.layer.setOpacity(value);
    }
  }

  getSpots() {
    return this.spots;
  }

  getSpotCount() {
    return this.spots.length;
  }
}
