/**
 * NOAA ERDDAP service for long-term historical temperature data (2-3+ years)
 * Used as fallback when Copernicus Marine Service lacks historical data
 */
export class NOAADataService {
  constructor() {
    this.baseUrl = ''; // Use local proxy via Vite
    this.proxyEndpoint = '/noaa/historical'; // Backend proxy endpoint
    this.cache = new Map(); // Session cache for NOAA data
  }

  /**
   * Get historical temperature data from NOAA for long-term periods (2-3+ years)
   * @param {Object} bounds - Map bounds with center and region
   * @param {string} targetDate - Date in YYYY-MM-DD format 
   * @param {Object} options - Request options
   * @returns {Promise<Object>} NOAA temperature data in Copernicus-compatible format
   */
  async getHistoricalTemperatureData(bounds, targetDate, options = {}) {
    const startTime = Date.now();
    const { center, region = 2.0 } = bounds;
    const { gridSize = 15 } = options;
    
    // Generate cache key
    const cacheKey = `noaa_${targetDate}_${center.lat}_${center.lon}_${region}_${gridSize}`;
    
    // Check session cache first
    if (this.cache.has(cacheKey)) {
      console.log(`⚡ Using cached NOAA data for ${targetDate}`);
      return this.cache.get(cacheKey);
    }
    
    try {
      console.log(`🌊 Fetching NOAA historical data for ${targetDate} via backend proxy...`);
      
      // Build request to backend NOAA proxy
      const params = new URLSearchParams({
        lat: center.lat,
        lon: center.lon,
        date: targetDate,
        region: region
      });
      
      const response = await fetch(`${this.baseUrl}${this.proxyEndpoint}?${params}`, {
        method: 'GET',
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      if (!response.ok) {
        throw new Error(`NOAA proxy request failed: ${response.status} ${response.statusText}`);
      }

      const proxyResponse = await response.json();
      
      if (proxyResponse.error) {
        throw new Error(proxyResponse.error);
      }
      
      // Convert NOAA format to Copernicus-compatible format
      const convertedData = this.convertNOAAData(proxyResponse.data, center, region, gridSize);
      
      // Cache successful response
      this.cache.set(cacheKey, convertedData);
      
      console.log(`✅ NOAA historical data loaded for ${targetDate} (${Date.now() - startTime}ms)`);
      return convertedData;
      
    } catch (error) {
      console.error(`❌ Failed to load NOAA data for ${targetDate}:`, error);
      throw new Error(`NOAA historical data unavailable: ${error.message}`);
    }
  }

  /**
   * Convert NOAA ERDDAP JSON response to Copernicus-compatible format
   * @param {Object} noaaData - Raw NOAA JSON response
   * @param {Object} center - Map center coordinates
   * @param {number} region - Geographic region size
   * @param {number} gridSize - Target grid resolution
   * @returns {Object} Copernicus-compatible temperature data
   */
  convertNOAAData(noaaData, center, region, gridSize) {
    const { table } = noaaData;
    
    if (!table || !table.rows || table.rows.length === 0) {
      throw new Error('No NOAA temperature data found for requested period');
    }
    
    // NOAA ERDDAP returns: [time, latitude, longitude, sst]
    const temperaturePoints = table.rows.map(row => ({
      lat: parseFloat(row[1]),
      lon: parseFloat(row[2]),
      temp: parseFloat(row[3]) // NOAA returns Celsius
    })).filter(point => !isNaN(point.temp));
    
    if (temperaturePoints.length === 0) {
      throw new Error('No valid temperature measurements in NOAA response');
    }
    
    // Create grid structure similar to Copernicus format
    const latMin = center.lat - region;
    const latMax = center.lat + region;
    const lonMin = center.lon - region;
    const lonMax = center.lon + region;
    
    const latStep = (latMax - latMin) / (gridSize - 1);
    const lonStep = (lonMax - lonMin) / (gridSize - 1);
    
    const features = [];
    
    // Generate grid by interpolating NOAA point data
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const gridLat = latMin + (i * latStep);
        const gridLon = lonMin + (j * lonStep);
        
        // Find nearest NOAA temperature point
        const nearestTemp = this.findNearestTemperature(temperaturePoints, gridLat, gridLon);
        
        if (nearestTemp !== null) {
          features.push({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [gridLon, gridLat]
            },
            properties: {
              temperature: nearestTemp // Celsius, same as Copernicus
            }
          });
        }
      }
    }
    
    return {
      type: 'FeatureCollection',
      features: features,
      metadata: {
        source: 'NOAA ERDDAP',
        dataset: this.datasetId,
        timestamp: new Date().toISOString(),
        bounds: { latMin, latMax, lonMin, lonMax },
        gridSize: features.length,
        dataType: 'historical'
      }
    };
  }

  /**
   * Find nearest temperature value to grid point using simple distance
   * @param {Array} temperaturePoints - Array of {lat, lon, temp} objects
   * @param {number} targetLat - Target latitude
   * @param {number} targetLon - Target longitude
   * @returns {number|null} Nearest temperature in Celsius
   */
  findNearestTemperature(temperaturePoints, targetLat, targetLon) {
    let nearestTemp = null;
    let minDistance = Infinity;
    
    for (const point of temperaturePoints) {
      const distance = Math.sqrt(
        Math.pow(point.lat - targetLat, 2) + 
        Math.pow(point.lon - targetLon, 2)
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestTemp = point.temp;
      }
    }
    
    // Only use points within reasonable distance (0.5 degrees ~55km)
    return minDistance <= 0.5 ? nearestTemp : null;
  }

  /**
   * Check if NOAA data is available for a given date
   * @param {string} targetDate - Date in YYYY-MM-DD format
   * @returns {boolean} True if NOAA should have data for this period
   */
  isDataAvailable(targetDate) {
    const target = new Date(targetDate);
    const now = new Date();
    const minDate = new Date('2002-01-01'); // NOAA ERDDAP typical coverage start
    
    return target >= minDate && target < now;
  }

  /**
   * Clear session cache
   */
  clearCache() {
    this.cache.clear();
  }
}