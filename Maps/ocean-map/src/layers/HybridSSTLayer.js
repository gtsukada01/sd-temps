import TileLayer from 'ol/layer/Tile';
import TileWMS from 'ol/source/TileWMS';
import XYZ from 'ol/source/XYZ';
// WebGLTile is available in OL >= 6; keep optional usage behind feature flag
// import WebGLTile from 'ol/layer/WebGLTile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Feature } from 'ol';
import { Polygon } from 'ol/geom';
import { Style, Fill, Stroke } from 'ol/style';
import { transform, fromLonLat, transformExtent } from 'ol/proj';
import { eventBus } from '../utils/EventBus.js';
import { DataSourceManager } from '../services/DataSourceManager.js';
import { canvasRenderer } from '../renderers/CanvasTemperatureRenderer.js';
import { CONFIG, TILE_CONFIG } from '../config.js';

/**
 * Hybrid SST Layer - Supports both Copernicus vector grids and NOAA WMS tiles
 * Automatically selects optimal data source and rendering method
 */
export class HybridSSTLayer {
  constructor(map) {
    this.map = map;
    this.layer = null;
    this.active = false;
    this.name = 'SST';
    
    // Initialize data source manager
    this.dataSourceManager = new DataSourceManager();
    
    // Current state
    this.currentSource = null;
    this.currentDataType = null; // 'vector_grid' or 'wms_tiles'
    this.temperatureData = null; // Store grid data for click readout
    
    // Layer configuration
    this.opacity = 1.0; // full opacity for consistent color perception
    this.zIndex = 10;
    
    this.setupEventListeners();
  }

  /**
   * Activate the layer - main entry point
   */
  async activate() {
    if (this.active) return;

    try {
      // Experimental: tile-based renderer (value tiles or styled tiles)
      if (CONFIG.FEATURES?.USE_VALUE_TILE_RENDERER) {
        // Emit loading so UIs can show progress
        eventBus.emit('layer:loading', {
          layer: this.name,
          message: 'Loading SST tiles...'
        });

        await this.createValueTileLayer();
        this.active = true;

        // Inform generic listeners that the layer finished loading
        eventBus.emit('layer:loaded', {
          layer: this.name,
          source: 'NOAA SST Tiles',
          dataType: (CONFIG.FEATURES?.VALUE_TILE_MODE || 'styled'),
          realData: true
        });

        // SST-specific status for legend/readout
        eventBus.emit('sst:data:loaded', {
          layer: this.name,
          source: 'NOAA Value Tiles',
          timestamp: new Date().toISOString(),
          age: 'Real-time'
        });
        return;
      }

      // Get current map bounds
      const bounds = this.getCurrentMapBounds();
      
      // Emit loading event
      eventBus.emit('layer:loading', {
        layer: this.name,
        message: 'Loading temperature data...'
      });

      // Fetch data from best available source
      const result = await this.dataSourceManager.getTemperatureData(bounds, {
        gridSize: this.calculateOptimalGridSize(),
        preferredFormat: 'vector_grid',
        region: this.calculateOptimalRegionSize(bounds) // Dynamic region size for fishing precision
      });

      this.currentSource = result.source;
      this.currentDataType = result.metadata.type;

      // Create appropriate layer based on data type
      if (result.metadata.type === 'vector_grid') {
        await this.createVectorLayer(result.data);
      } else if (result.metadata.type === 'wms_layer') {
        await this.createWMSLayer(result.data);
      }

      this.active = true;

      // Emit success event with complete data info
      eventBus.emit('layer:loaded', {
        layer: this.name,
        source: result.source, // Should be 'copernicus'
        dataSource: result.metadata.name, // 'Copernicus Marine Service'
        dataType: result.metadata.type, // 'vector_grid'
        quality: result.metadata.quality, // 1.0
        fetchTime: result.metadata.fetchTime,
        dataTime: result.metadata.dataTime, // Actual data timestamp
        freshness: result.metadata.freshness, // { hours, text }
        realData: result.metadata.realData, // true
        cached: result.metadata.cached, // true/false - whether from cache
        cacheDate: result.metadata.cacheDate, // Cache date if applicable
        cacheAge: result.metadata.cacheAge, // Age of cached data in ms
        freshlyDownloaded: result.metadata.freshlyDownloaded // true if just downloaded
      });

      // Also emit SST-specific data loaded event for legend/status UI
      eventBus.emit('sst:data:loaded', {
        layer: this.name,
        source: result.metadata.name || result.source,
        timestamp: result.metadata.dataTime,
        age: (result.metadata.freshness && (result.metadata.freshness.text || `${result.metadata.freshness.hours}h old`)) || 'Real-time'
      });

      console.log(`✅ SST Layer activated using ${result.metadata.name}`);

    } catch (error) {
      console.error('SST Layer activation failed:', error);
      
      eventBus.emit('layer:error', {
        layer: this.name,
        error: error.message,
        fallback: 'none'
      });
    }
  }

  /**
   * Create temperature layer - uses Canvas for performance or Vector for compatibility
   */
  async createVectorLayer(data) {
    // Remove existing layer
    if (this.layer) {
      this.map.removeLayer(this.layer);
      if (CONFIG.FEATURES.USE_CANVAS_RENDERER) {
        canvasRenderer.clear();
      }
    }

    // Store temperature data for click readout
    this.temperatureData = data;

    if (CONFIG.FEATURES.USE_CANVAS_RENDERER) {
      // Use Canvas renderer for 5x performance improvement
      const bounds = this.getCurrentMapBounds();
      
      // Pass the full data structure to the renderer
      this.layer = canvasRenderer.createImageLayer(data, bounds, this.opacity);
      
      if (CONFIG.FEATURES.SHOW_PERFORMANCE_STATS) {
        const stats = canvasRenderer.getPerformanceStats();
        console.log(`🎨 Canvas rendering: ${stats.lastRenderTime} (avg: ${stats.averageRenderTime})`);
      }
    } else {
      // Fallback to vector polygons (original implementation)
      const features = this.createTemperatureFeatures(data);
      const vectorSource = new VectorSource({ features });

      this.layer = new VectorLayer({
        source: vectorSource,
        style: this.getTemperatureStyle.bind(this),
        opacity: this.opacity,
        zIndex: this.zIndex,
        name: 'sst'
      });
    }
    
    this.map.addLayer(this.layer);
  }

  /**
   * Create WMS tile layer for NOAA data
   */
  async createWMSLayer(data) {
    // Remove existing layer
    if (this.layer) {
      this.map.removeLayer(this.layer);
    }

    const wmsSource = new TileWMS({
      url: data.wmsConfig.url,
      params: data.wmsConfig.params,
      serverType: 'geoserver',
      crossOrigin: 'anonymous',
      transition: 0
    });

    this.layer = new TileLayer({
      source: wmsSource,
      opacity: this.opacity,
      zIndex: this.zIndex
    });

    this.map.addLayer(this.layer);
  }

  /**
   * Experimental value-tile (or styled-tiles) renderer using XYZ tiles
   * VALUE mode: RGB encodes 24-bit values; client-side shader planned
   * STYLED mode: Server-colorized PNGs as a visual fallback
   */
  async createValueTileLayer() {
    // Remove existing layer if present
    if (this.layer) {
      this.map.removeLayer(this.layer);
      this.layer = null;
    }

    const mode = CONFIG.FEATURES?.VALUE_TILE_MODE || 'styled';
    const urlTemplate =
      mode === 'value'
        ? TILE_CONFIG.SST.VALUE_URL_TEMPLATE
        : TILE_CONFIG.SST.STYLED_URL_TEMPLATE;

    // Basic XYZ tile layer; will upgrade to WebGL shader in VALUE mode
    const xyz = new XYZ({
      url: urlTemplate,
      crossOrigin: 'anonymous',
      transition: 0,          // disable cross-fade to prevent color mixing on zoom
      tilePixelRatio: 1,
      interpolate: false,     // nearest-neighbor resample to avoid color blend
      zDirection: 0           // prefer nearest zoom level for stability
    });

    // To prevent perceived color shifts from base-map blending, render styled tiles opaque
    const layerOpacity = mode === 'styled' ? 1.0 : this.opacity;

    this.layer = new TileLayer({
      source: xyz,
      opacity: layerOpacity,
      zIndex: this.zIndex,
    });

    // Note: When VALUE mode is enabled, we will replace TileLayer with WebGLTile
    // to decode RGB->temp in a GPU shader and apply palettes dynamically.
    // For now, styled tiles provide a working visual and anchoring.

    this.map.addLayer(this.layer);
  }

  /**
   * Create temperature features from grid data
   */
  createTemperatureFeatures(data) {
    const features = [];
    const { grid_data, region_size_degrees } = data;
    const step = region_size_degrees / grid_data.length;

    for (let i = 0; i < grid_data.length; i++) {
      for (let j = 0; j < grid_data[i].length; j++) {
        const cell = grid_data[i][j];
        
        if (cell.temp == null) continue;

        const lat = cell.lat;
        const lon = cell.lon;
        const halfStep = step / 2;

        // Create polygon coordinates
        const coords = [[
          [lon - halfStep, lat - halfStep], // Bottom-left
          [lon + halfStep, lat - halfStep], // Bottom-right
          [lon + halfStep, lat + halfStep], // Top-right
          [lon - halfStep, lat + halfStep], // Top-left
          [lon - halfStep, lat - halfStep]  // Close polygon
        ]];

        // Transform to map projection (Web Mercator)
        const transformedCoords = coords[0].map(coord => 
          fromLonLat(coord, this.map.getView().getProjection())
        );

        const feature = new Feature({
          geometry: new Polygon([transformedCoords]),
          temperature: cell.temp,
          latitude: lat,
          longitude: lon,
          gridCell: `${i},${j}`
        });

        features.push(feature);
      }
    }

    return features;
  }

  /**
   * Temperature-based styling for vector features
   */
  getTemperatureStyle(feature) {
    const temp = feature.get('temperature');
    const color = this.getTemperatureColor(temp);

    return new Style({
      fill: new Fill({
        color: `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})`
      }),
      // Remove stroke to avoid visible grid lines between cells
      stroke: undefined
    });
  }

  /**
   * Temperature color mapping optimized for Southern California/Baja waters
   * Uses the superior color scheme from the comparison modal for better visual differentiation
   * Range: 16-24°C (61-75°F) for realistic regional fishing temperatures
   */
  getTemperatureColor(temp) {
    // Fixed range: 50°F (10°C) to 80°F (26.67°C) with vivid stops
    const stops = [
      { c: 10.0,  rgb: [0, 51, 255] },   // 50°F deep blue
      { c: 15.56, rgb: [0, 181, 255] },  // 60°F sky blue
      { c: 20.0,  rgb: [0, 200, 83] },   // 68°F vivid green
      { c: 23.33, rgb: [255, 212, 0] },  // 74°F vivid yellow
      { c: 26.67, rgb: [255, 59, 48] },  // 80°F strong red
    ];

    const t = temp;
    if (t <= stops[0].c) return [...stops[0].rgb, 255];
    if (t >= stops[stops.length-1].c) return [...stops[stops.length-1].rgb, 255];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i-1], b = stops[i];
      if (t <= b.c) {
        const f = (t - a.c) / (b.c - a.c);
        const r = Math.round(a.rgb[0] + f * (b.rgb[0] - a.rgb[0]));
        const g = Math.round(a.rgb[1] + f * (b.rgb[1] - a.rgb[1]));
        const bl = Math.round(a.rgb[2] + f * (b.rgb[2] - a.rgb[2]));
        return [r, g, bl, 255];
      }
    }
    return [...stops[stops.length-1].rgb, 255];
  }

  /**
   * Deactivate the layer
   */
  deactivate() {
    if (this.layer && this.active) {
      this.map.removeLayer(this.layer);
      this.layer = null;
      this.active = false;
      this.currentSource = null;
      this.currentDataType = null;
      this.temperatureData = null;
      canvasRenderer.clear();
    }
  }

  /**
   * Set layer opacity
   */
  setOpacity(value) {
    // Lock opacity to 1.0 for styled tile mode to avoid base-map blending
    const lockSST = CONFIG.FEATURES?.USE_VALUE_TILE_RENDERER && CONFIG.FEATURES?.VALUE_TILE_MODE === 'styled';
    const effective = lockSST ? 1.0 : value;
    this.opacity = effective;
    if (this.layer) {
      this.layer.setOpacity(effective);
    }
  }

  /**
   * Check if layer is active
   */
  isActive() {
    return this.active;
  }

  /**
   * Get current layer info
   */
  getLayerInfo() {
    return {
      active: this.active,
      source: this.currentSource,
      dataType: this.currentDataType,
      opacity: this.opacity
    };
  }

  /**
   * Get temperature at specific coordinates (for click readout)
   */
  getTemperatureAtCoordinate(coordinate) {
    if (!this.temperatureData || !this.temperatureData.grid_data) {
      return null;
    }

    // Convert coordinate to lon/lat
    const lonLat = transform(coordinate, 'EPSG:3857', 'EPSG:4326');
    const [clickLon, clickLat] = lonLat;

    // Find nearest grid point
    let nearestTemp = null;
    let minDistance = Infinity;

    const gridData = this.temperatureData.grid_data;
    for (let row of gridData) {
      for (let cell of row) {
        if (cell.temp === null || cell.temp === undefined) continue;
        
        const distance = Math.sqrt(
          Math.pow(cell.lat - clickLat, 2) + 
          Math.pow(cell.lon - clickLon, 2)
        );
        
        if (distance < minDistance) {
          minDistance = distance;
          nearestTemp = cell.temp;
        }
      }
    }

    // Only return temperature if click is reasonably close to a grid point
    // (within ~0.05 degrees, roughly 5km)
    if (minDistance < 0.05) {
      return nearestTemp;
    }

    return null;
  }

  /**
   * Get current map bounds for data requests
   */
  getCurrentMapBounds() {
    const view = this.map.getView();
    const extent = view.calculateExtent();
    const [west, south, east, north] = transformExtent(
      extent, 
      view.getProjection(), 
      'EPSG:4326'
    );

    return {
      north, south, east, west,
      center: {
        lat: (north + south) / 2,
        lon: (east + west) / 2
      },
      region: Math.max(north - south, east - west)
    };
  }

  /**
   * Calculate optimal grid size based on zoom level
   */
  calculateOptimalGridSize() {
    const zoom = this.map.getView().getZoom();
    
    if (CONFIG.FEATURES.ADAPTIVE_GRID_SIZING) {
      // Target ~100x100 cells at typical fishing zooms
      if (zoom < 4) return 12;     // World view
      if (zoom < 6) return 20;     // Region view
      if (zoom < 8) return 40;     // Coast view
      if (zoom < 10) return 80;    // Nearshore
      if (zoom < 12) return 100;   // Detailed fishing range
      return 120;                  // Very close zoom
    } else {
      // Fixed high-resolution grid (original behavior)
      return 100; // Consistent grid size regardless of zoom
    }
  }

  /**
   * Calculate region size for continuous temperature field
   * Creates large buffer area to maintain coverage during pan/zoom
   */
  calculateOptimalRegionSize(bounds) {
    const zoom = this.map.getView().getZoom();
    const viewableRegion = bounds.region || Math.max(bounds.north - bounds.south, bounds.east - bounds.west);
    
    // Keep requests lightweight for backend performance: clamp region size
    const bufferMultiplier = zoom < 6 ? 1.3 : zoom < 8 ? 1.2 : 1.1;
    const desired = viewableRegion * bufferMultiplier;
    const minRegion = 2.0;   // Ensure enough context for gradients
    const maxRegion = 6.0;   // Prevent huge, slow requests
    
    return Math.min(maxRegion, Math.max(minRegion, desired));
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Track zoom level for auto-refresh
    this.lastZoomLevel = this.map.getView().getZoom();
    
    // Listen for data source changes
    eventBus.on('data:source:used', (event) => {
      const payload = event?.detail || event;
      const { source, quality } = payload;
      console.log(`📡 Data source switched to: ${source} (quality: ${quality})`);
    });

    // Keep colors consistent across zoom by not refreshing data on zoom changes
    if (!CONFIG.FEATURES?.LOCK_SST_COLORS) {
      this.map.getView().on('change:resolution', () => {
        if (!this.active) return;
        const currentZoom = this.map.getView().getZoom();
        const zoomDifference = Math.abs(currentZoom - this.lastZoomLevel);
        if (zoomDifference >= 1) {
          console.log(`🔄 Zoom changed by ${zoomDifference.toFixed(1)} levels, updating SST resolution...`);
          this.lastZoomLevel = currentZoom;
          clearTimeout(this.zoomRefreshTimeout);
          this.zoomRefreshTimeout = setTimeout(() => {
            this.expandTemperatureField();
          }, 800);
        }
      });
    }
  }

  /**
   * Refresh layer data (legacy method - use expandTemperatureField instead)
   */
  async refresh() {
    if (this.active) {
      await this.deactivate();
      await this.activate();
    }
  }

  /**
   * Expand temperature field to cover larger area without destroying existing data
   * This maintains continuous coverage during zoom/pan operations
   */
  async expandTemperatureField() {
    if (!this.active) return;
    
    try {
      // Get expanded bounds for new temperature field
      const bounds = this.getCurrentMapBounds();
      
      // Emit loading event
      eventBus.emit('layer:loading', {
        layer: this.name,
        message: 'Expanding temperature field...'
      });

      // Fetch expanded temperature data
      const result = await this.dataSourceManager.getTemperatureData(bounds, {
        gridSize: this.calculateOptimalGridSize(),
        preferredFormat: 'vector_grid',
        region: this.calculateOptimalRegionSize(bounds)
      });

      // Recreate vector layer with new resolution so cells scale with zoom
      if (result.metadata.type === 'vector_grid') {
        await this.createVectorLayer(result.data);
      }

      // Inform UI that fresh data has been incorporated
      eventBus.emit('sst:data:loaded', {
        layer: this.name,
        source: result.metadata.name || result.source,
        timestamp: result.metadata.dataTime,
        age: (result.metadata.freshness && (result.metadata.freshness.text || `${result.metadata.freshness.hours}h old`)) || 'Real-time'
      });

      // Clear loading indicator for general listeners
      eventBus.emit('layer:loaded', {
        layer: this.name,
        source: result.metadata.name || result.source,
        dataType: result.metadata.type,
        realData: true
      });

      console.log(`🌊 Temperature field expanded for continuous coverage`);
      
    } catch (error) {
      console.warn('Temperature field expansion failed:', error.message);
      // Emit error so UIs can clear spinners and notify
      eventBus.emit('layer:error', {
        layer: this.name,
        error: error.message,
        fallback: 'none'
      });
    }
  }

  /**
   * Update vector layer with new data while preserving existing coverage
   */
  async updateVectorLayer(data) {
    if (!this.layer) return;

    const newFeatures = this.createTemperatureFeatures(data);
    const vectorSource = this.layer.getSource();
    
    // Add new features to existing layer instead of replacing
    vectorSource.addFeatures(newFeatures);
    
    // Optional: Remove features outside expanded area to prevent memory bloat
    // This could be implemented later if performance becomes an issue
  }

  /**
   * Force specific data source (for testing/debugging)
   */
  async activateWithSource(sourceOverride) {
    // Temporarily override source priority for testing
    const originalPriority = this.dataSourceManager.sourceConfig[sourceOverride].priority;
    this.dataSourceManager.sourceConfig[sourceOverride].priority = 0;
    
    try {
      await this.activate();
    } finally {
      // Restore original priority
      this.dataSourceManager.sourceConfig[sourceOverride].priority = originalPriority;
    }
  }
}
