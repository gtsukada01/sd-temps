import { eventBus } from '../utils/EventBus.js';
import { toLonLat } from 'ol/proj';

/**
 * Temperature Readout with Frontend Caching
 * Shows temperature values with intelligent caching to avoid repeated API calls
 */
export class TemperatureReadout {
  constructor(map, layerManager = null) {
    this.map = map;
    this.layerManager = layerManager;
    this.element = null;
    this.visible = false;
    this.sstLayerActive = false;
    this.currentHoverTimeout = null;
    this.activeFetchRequest = null; // Prevent multiple simultaneous requests
    this.displayTimeout = null; // Control display timing
    this.lastRequestTime = 0; // Rate limiting
    this.minRequestInterval = 1000; // Minimum 1 second between requests
    
    // Temperature point caching configuration
    this.cacheConfig = {
      storageKey: 'ocean_map_temp_cache',
      maxCacheAge: 24 * 60 * 60 * 1000, // 24 hours
      maxCacheEntries: 200, // Limit cache size
      coordinatePrecision: 0.01 // Cache precision (about 1km)
    };
    
    this.init();
    this.setupEventListeners();
  }

  init() {
    // Create readout container
    this.element = document.createElement('div');
    this.element.className = 'temperature-readout';
    this.element.innerHTML = `
      <div class="temp-value">--°F</div>
      <div class="temp-label">Sea Temperature</div>
    `;
    
    // Add to map container
    const mapContainer = document.getElementById('map');
    if (mapContainer) {
      mapContainer.appendChild(this.element);
    }
  }

  setupEventListeners() {
    // Enable temperature readout when SST layer is attempted (regardless of success)
    eventBus.on('layer:activated', (event) => {
      if (event.detail?.layerId === 'sst') {
        this.sstLayerActive = true;
        this.enableHover();
      }
    });
    
    // Also enable on SST layer loading attempt (even if it fails)
    eventBus.on('layer:loading', (event) => {
      if (event.detail?.layer === 'SST') {
        this.sstLayerActive = true;
        this.enableHover();
      }
    });
    
    eventBus.on('layer:deactivated', (event) => {
      if (event.detail?.layerId === 'sst') {
        this.sstLayerActive = false;
        this.disableHover();
        this.hide();
      }
    });

    // Handle layer swaps
    eventBus.on('layer:swapped', (event) => {
      if (event.detail?.removed === 'SST') {
        this.sstLayerActive = false;
        this.disableHover();
        this.hide();
      }
      if (event.detail?.added === 'SST') {
        this.sstLayerActive = true;
        this.enableHover();
      }
    });
  }

  // ================================
  // TEMPERATURE POINT CACHING
  // ================================

  /**
   * Generate cache key from coordinates (rounded for consistency)
   */
  generateTempCacheKey(lat, lon) {
    const roundedLat = Math.round(lat / this.cacheConfig.coordinatePrecision) * this.cacheConfig.coordinatePrecision;
    const roundedLon = Math.round(lon / this.cacheConfig.coordinatePrecision) * this.cacheConfig.coordinatePrecision;
    return `${roundedLat.toFixed(2)}_${roundedLon.toFixed(2)}`;
  }

  /**
   * Get current cache date (based on Copernicus daily updates at noon)
   */
  getCurrentCacheDate() {
    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // If it's before noon, use yesterday's data as current
    if (now.getHours() < 12) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday.toISOString().split('T')[0];
    }
    
    return today;
  }

  /**
   * Get temperature cache from localStorage
   */
  getTempCache() {
    try {
      const cached = localStorage.getItem(this.cacheConfig.storageKey);
      return cached ? JSON.parse(cached) : {};
    } catch (error) {
      console.warn('Failed to load temperature cache:', error);
      return {};
    }
  }

  /**
   * Save temperature cache to localStorage
   */
  saveTempCache(cache) {
    try {
      localStorage.setItem(this.cacheConfig.storageKey, JSON.stringify(cache));
    } catch (error) {
      console.warn('Failed to save temperature cache:', error);
    }
  }

  /**
   * Check if cached temperature point is still valid
   */
  isTempCacheValid(cacheEntry) {
    if (!cacheEntry || !cacheEntry.timestamp) return false;
    
    const now = Date.now();
    const cacheAge = now - cacheEntry.timestamp;
    const currentCacheDate = this.getCurrentCacheDate();
    
    return (
      cacheEntry.cacheDate === currentCacheDate &&
      cacheAge < this.cacheConfig.maxCacheAge
    );
  }

  /**
   * Get cached temperature for coordinates
   */
  getCachedTemperature(lat, lon) {
    const cacheKey = this.generateTempCacheKey(lat, lon);
    const cache = this.getTempCache();
    const cacheEntry = cache[cacheKey];
    
    if (cacheEntry && this.isTempCacheValid(cacheEntry)) {
      console.log(`🚀 Temperature cache hit for ${lat.toFixed(2)}°N, ${lon.toFixed(2)}°W`);
      return cacheEntry.temperature;
    }
    
    return null;
  }

  /**
   * Cache temperature for coordinates
   */
  cacheTemperature(lat, lon, temperature) {
    const cacheKey = this.generateTempCacheKey(lat, lon);
    const cache = this.getTempCache();
    
    // Add new entry
    cache[cacheKey] = {
      temperature,
      timestamp: Date.now(),
      cacheDate: this.getCurrentCacheDate(),
      coordinates: { lat, lon }
    };

    // Clean up old entries if cache is too large
    const keys = Object.keys(cache);
    if (keys.length > this.cacheConfig.maxCacheEntries) {
      // Remove oldest entries (by timestamp)
      const sortedKeys = keys.sort((a, b) => {
        const entryA = cache[a];
        const entryB = cache[b];
        return entryA.timestamp - entryB.timestamp;
      });
      
      const keysToRemove = sortedKeys.slice(0, keys.length - this.cacheConfig.maxCacheEntries);
      keysToRemove.forEach(key => delete cache[key]);
    }

    // Clean up invalid entries
    Object.keys(cache).forEach(key => {
      if (!this.isTempCacheValid(cache[key])) {
        delete cache[key];
      }
    });

    this.saveTempCache(cache);
    console.log(`💾 Cached temperature ${temperature}°F for ${lat.toFixed(2)}°N, ${lon.toFixed(2)}°W`);
  }

  /**
   * Extract temperature from loaded SST layer (instant response!)
   */
  getTemperatureFromSSTLayer(coordinate) {
    try {
      // First try the new Canvas-based approach
      // Find the HybridSSTLayer instance through LayerManager
      if (this.layerManager && this.layerManager.layers) {
        const sstLayer = this.layerManager.layers.sst;
        
        if (sstLayer && typeof sstLayer.getTemperatureAtCoordinate === 'function') {
          const tempCelsius = sstLayer.getTemperatureAtCoordinate(coordinate);
          if (tempCelsius !== null) {
            // Convert to Fahrenheit
            const tempFahrenheit = (tempCelsius * 9/5) + 32;
            return tempFahrenheit.toFixed(1);
          }
        }
      }
      
      // Fallback to feature-based approach (for backwards compatibility)
      const features = this.map.forEachFeatureAtPixel(
        this.map.getPixelFromCoordinate(coordinate),
        (feature) => feature,
        { 
          layerFilter: (layer) => {
            const layerName = layer.get('name') || '';
            return layerName.toLowerCase().includes('sst') || 
                   layerName.toLowerCase().includes('temperature');
          }
        }
      );

      if (features && features.get('temperature')) {
        const tempCelsius = features.get('temperature');
        // Convert Celsius to Fahrenheit
        const tempFahrenheit = (tempCelsius * 9/5) + 32;
        return Math.round(tempFahrenheit * 10) / 10;
      }

      return null;
    } catch (error) {
      console.warn('Failed to get temperature from SST layer:', error);
      return null;
    }
  }

  enableHover() {
    // Add hover listener to map
    this.map.on('pointermove', this.handleMapHover.bind(this));
    this.map.on('click', this.handleMapClick.bind(this));
  }

  disableHover() {
    // Remove hover listeners
    this.map.un('pointermove', this.handleMapHover.bind(this));
    this.map.un('click', this.handleMapClick.bind(this));
  }

  handleMapHover(event) {
    if (!this.sstLayerActive) return;

    // Clear previous timeout
    if (this.currentHoverTimeout) {
      clearTimeout(this.currentHoverTimeout);
    }

    // Increased delay to avoid overwhelming server - only fetch if user hovers for 800ms
    this.currentHoverTimeout = setTimeout(() => {
      this.fetchTemperatureForCoordinate(event.coordinate);
    }, 800);
  }

  handleMapClick(event) {
    if (!this.sstLayerActive) return;
    
    // Immediate fetch on click
    this.fetchTemperatureForCoordinate(event.coordinate, true);
  }

  async fetchTemperatureForCoordinate(coordinate, showAlways = false) {
    try {
      // Convert to lon/lat
      const lonLat = toLonLat(coordinate);
      const [lon, lat] = lonLat;
      
      // Show loading state immediately for better UX
      if (showAlways) {
        this.updateDisplay('🌡️...', true, true);
      }
      
      // Check cache first
      const cachedTemp = this.getCachedTemperature(lat, lon);
      if (cachedTemp !== null) {
        this.updateDisplay(cachedTemp, showAlways);
        return;
      }
      
      // Try to get temperature from loaded SST layer features first (instant!)
      const sstLayerTemp = this.getTemperatureFromSSTLayer(coordinate);
      if (sstLayerTemp !== null) {
        console.log(`⚡ Got temperature from SST layer: ${sstLayerTemp}°F`);
        this.cacheTemperature(lat, lon, sstLayerTemp);
        this.updateDisplay(sstLayerTemp, showAlways);
        return;
      }
      
      // Rate limiting check for fallback API calls
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        console.log('⏳ Rate limited - waiting before next request');
        if (showAlways) {
          this.updateDisplay('Try again...', true, true);
        }
        return;
      }
      
      // Fallback: No data available
      console.log(`❌ No temperature data available for ${lat.toFixed(2)}°N, ${lon.toFixed(2)}°W`);
      this.updateDisplay(null, showAlways);
      
    } catch (error) {
      this.activeFetchRequest = null;
      console.warn('Temperature fetch error:', error);
      this.updateDisplay(null, showAlways);
    }
  }

  async fetchRealTemperature(lat, lon) {
    try {
      // Use NOAA ERDDAP WMS GetFeatureInfo for faster temperature queries
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // Even faster 2-second timeout for NOAA
      
      // NOAA ERDDAP GetFeatureInfo request - much faster than Copernicus backend
      const wmsUrl = 'https://coastwatch.pfeg.noaa.gov/erddap/wms/jplMURSST41mday/request';
      const params = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        REQUEST: 'GetFeatureInfo',
        LAYERS: 'jplMURSST41mday:sst',
        QUERY_LAYERS: 'jplMURSST41mday:sst',
        INFO_FORMAT: 'text/plain',
        CRS: 'EPSG:4326',
        BBOX: `${lon-0.01},${lat-0.01},${lon+0.01},${lat+0.01}`,
        WIDTH: '10',
        HEIGHT: '10',
        I: '5',
        J: '5',
        TIME: '2024-01-15T00:00:00Z'
      });
      
      const response = await fetch(`${wmsUrl}?${params}`, {
        signal: controller.signal,
        method: 'GET'
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`NOAA WMS responded with ${response.status}: ${response.statusText}`);
      }
      
      // NOAA returns plain text with temperature value
      const textData = await response.text();
      console.log('NOAA WMS response:', textData);
      
      // Parse temperature from NOAA text response (format varies)
      // Look for numeric values that could be temperature
      const tempMatch = textData.match(/(-?\d+\.?\d*)/);
      
      if (tempMatch) {
        const tempValue = parseFloat(tempMatch[1]);
        
        // NOAA SST data is typically in Celsius, convert to Fahrenheit
        if (!isNaN(tempValue) && tempValue > -10 && tempValue < 50) { // Reasonable ocean temp range in Celsius
          const fahrenheit = (tempValue * 9/5) + 32;
          return Math.round(fahrenheit * 10) / 10; // Round to 1 decimal place
        }
      }
      
      console.warn(`No valid temperature data from NOAA for coordinates: ${lat}, ${lon}`);
      return null;
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn('NOAA temperature fetch timed out after 2 seconds');
      } else {
        console.warn('NOAA temperature fetch failed:', error.message);
      }
      return null;
    }
  }

  updateDisplay(temperature, forceShow = false, isLoading = false) {
    const tempValue = this.element.querySelector('.temp-value');
    if (tempValue) {
      if (isLoading) {
        // Show immediate loading feedback
        tempValue.textContent = '🌡️...';
        tempValue.style.color = '#f59e0b'; // Amber for loading
      } else if (temperature === null) {
        tempValue.textContent = '--°F';
        tempValue.style.color = '#9ca3af'; // Gray for no data
      } else if (typeof temperature === 'string') {
        // Handle loading text
        tempValue.textContent = temperature;
        tempValue.style.color = '#f59e0b'; // Amber for loading states
      } else {
        tempValue.textContent = `${temperature.toFixed(1)}°F`;
        
        // Color code based on temperature (Fahrenheit) - optimized for Southern California waters
        if (temperature < 65) {  // < 18.3°C - Cold for SoCal
          tempValue.style.color = '#3b82f6'; // Blue - cold
        } else if (temperature < 70) {  // 18.3-21.1°C - Cool
          tempValue.style.color = '#06b6d4'; // Cyan - cool
        } else if (temperature < 75) {  // 21.1-23.9°C - Optimal
          tempValue.style.color = '#10b981'; // Green - optimal
        } else if (temperature < 80) {  // 23.9-26.7°C - Warm
          tempValue.style.color = '#f59e0b'; // Amber - warm
        } else {  // > 26.7°C - Hot for SoCal
          tempValue.style.color = '#ef4444'; // Red - hot
        }
      }
    }

    if (forceShow) {
      this.showTemporary();
    }
  }

  show() {
    if (this.element && !this.visible) {
      this.element.classList.add('visible');
      this.visible = true;
    }
  }

  hide() {
    if (this.element && this.visible) {
      this.element.classList.remove('visible');
      this.visible = false;
    }
  }

  showTemporary(duration = 3000) {
    // Clear any existing display timeout to prevent conflicts
    if (this.displayTimeout) {
      clearTimeout(this.displayTimeout);
    }
    
    this.show();
    
    // Set new timeout with proper cleanup
    this.displayTimeout = setTimeout(() => {
      this.hide();
      this.displayTimeout = null;
    }, duration);
  }
  
  /**
   * Force hide temperature display (used when SST layer is deactivated)
   */
  forceHide() {
    if (this.displayTimeout) {
      clearTimeout(this.displayTimeout);
      this.displayTimeout = null;
    }
    this.hide();
  }
}