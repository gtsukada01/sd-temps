/**
 * Central configuration for all data sources and constraints
 */
export const CONFIG = {
  // Map configuration
  MAP: {
    CENTER: [-117.0, 28.0], // Centered between Southern California and Cabo San Lucas
    ZOOM: 4,  // Zoomed out more to see larger area including Baja California
    MAX_ZOOM: 15,
    MIN_ZOOM: 3
  },

  // Layer constraints
  CONSTRAINTS: {
    MAX_DATA_LAYERS: 3,
    TILE_SIZE: 256,
    TILE_FORMAT: 'image/png',
    TIMEOUT_MS: 3000,
    MAX_FISHING_SPOTS: 500
  },

  // Data sources - Updated with working endpoints
  SOURCES: {
    SST: {
      name: 'Sea Surface Temperature',
      // Using NOAA CoastWatch ERDDAP WMS
      url: 'https://coastwatch.pfeg.noaa.gov/erddap/wms/jplMURSST41mday/request',
      layer: 'jplMURSST41mday:sst',
      params: {
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        REQUEST: 'GetMap',
        STYLES: 'psu_viridis/x-Rainbow',
        COLORSCALERANGE: '10,26.7',
        TRANSPARENT: true,
        CRS: 'EPSG:3857',
        TIME: '2024-01-15T00:00:00Z'
      }
    },
    FISHING_SPOTS: {
      // Optional bulk dataset to load alongside personal spots
      IMPORT_URL: '/data/fishing-spots.json',
      // Pixel distance for clustering at current resolution
      CLUSTER_DISTANCE: 40,
      // Clustering support (not currently enabled in UI)
      ENABLE_CLUSTERING: true,
      // Render all spots as text-only labels (no pin)
      TEXT_ONLY_ALL_SPOTS: true,
      // Only show labels when zoomed in enough (in meters/pixel)
      // ~500 m/px ~ Z≈9.6–10 in Web Mercator
      LABEL_MAX_RESOLUTION_MPP: 500
    },
    CHLOROPHYLL: {
      name: 'Chlorophyll Concentration',
      // Using simpler XYZ tiles from GMRT as fallback
      url: 'https://www.gmrt.org/services/mapserver/wms_merc',
      layer: 'GMRT',
      type: 'wms',
      params: {
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        REQUEST: 'GetMap',
        TRANSPARENT: true,
        CRS: 'EPSG:3857'
      }
    },
    BATHYMETRY: {
      GEBCO: {
        name: 'GEBCO Bathymetry',
        url: 'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_2023_TID/MapServer/tile/{z}/{y}/{x}',
        type: 'xyz'
      },
      GMRT: {
        name: 'GMRT High-Resolution',
        url: 'https://www.gmrt.org/services/mapserver/wms_merc',
        layer: 'GMRT',
        type: 'wms'
      },
      ESRI_OCEAN: {
        name: 'ESRI Ocean Basemap',
        url: 'https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
        type: 'xyz'
      },
      CONTOURS: {
        name: 'Depth Contours',
        url: '/data/depth-contours.json',
        type: 'vector',
        intervals: [100, 200, 500, 1000, 2000, 3000, 4000, 5000]
      }
    }
  },

  // Base map options
  BASE_MAPS: {
    SATELLITE: {
      name: 'Satellite',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Esri'
    },
    OCEAN: {
      name: 'Ocean Base',
      url: 'https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Esri'
    }
  },

  // Color normalization for bathymetry
  BATHYMETRY_COLORS: {
    PALETTE: [
      { depth: 0, color: '#84CEEB' },
      { depth: -200, color: '#5AB9EA' },
      { depth: -1000, color: '#3A7CA5' },
      { depth: -2000, color: '#2E5F88' },
      { depth: -3000, color: '#16425B' },
      { depth: -4000, color: '#0B2545' },
      { depth: -6000, color: '#000428' }
    ]
  },

  // Storage keys
  STORAGE: {
    FISHING_SPOTS: 'ocean-map-fishing-spots',
    LAST_POSITION: 'ocean-map-last-position',
    LAYER_PREFERENCES: 'ocean-map-layer-prefs'
  },

  // Feature flags for A/B testing and gradual rollout
  FEATURES: {
    // Performance + visual quality
    USE_CANVAS_RENDERER: true,       // Single-image canvas for consistency (no seams)
    MASK_LAND: false,                // Let data NaNs define coastline (jagged)
    COAST_BUFFER_DEG: 0.1,           // Shift mask ~0.1° (~11 km) offshore to avoid spillover
    PROGRESSIVE_GRID_LOADING: false, // Load low-res first, then enhance
    ENABLE_WEBGL: false,             // WebGL acceleration (future)
    
    // Experimental value-tiles (RGB-encoded) renderer
    USE_VALUE_TILE_RENDERER: false,  // Disable tiles for consistency across zoom
    VALUE_TILE_MODE: 'styled',       // (kept for future use)

    // Lock colors across zoom: do not auto-refresh SST grid on zoom changes
    LOCK_SST_COLORS: true,
    
    // Data optimizations
    ADAPTIVE_GRID_SIZING: false,     // Fixed grid size for consistent 100x100 resolution
    CACHE_GRID_DATA: true,           // Cache temperature grids in IndexedDB
    
    // Debug options
    SHOW_PERFORMANCE_STATS: true,    // Display rendering performance metrics
    DEBUG_MODE: false                // Enable debug logging
    ,
    // UI: begin moving the temp legend into the SST panel
    SST_SCALE_IN_PANEL: true         // When true, show scale in panel and hide floating legend
  }
};

// Tile endpoints and encoding metadata for experimental value tiles
export const TILE_CONFIG = {
  SST: {
    // Styled PNG tiles (server colorized) for quick visual validation
    STYLED_URL_TEMPLATE: '/tiles/sst/styled/current/{z}/{x}/{y}.png',
    // RGB-encoded value tiles (24-bit) for GPU shading
    VALUE_URL_TEMPLATE: '/tiles/sst/current/{z}/{x}/{y}.png',
    // Metadata: scale/offset for decoding
    META_URL: '/tiles/sst/meta?date=current',
    // Default encoding if META is unreachable
    DEFAULT_OFFSET: -10.0, // deg C
    DEFAULT_SCALE: 0.01,   // deg C per encoded unit
    DEFAULT_RANGE: [5, 30] // suggested initial palette range (deg C)
  }
};
