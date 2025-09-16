import { eventBus } from '../utils/EventBus.js';

/**
 * NOAA Ocean Data Manager with Frontend Caching
 * Uses IndexedDB for large datasets and localStorage for metadata  
 * POLICY: ONLY REAL DATA - NO FAKE/SYNTHETIC DATA ALLOWED
 */
export class DataSourceManager {
  constructor() {
    // Base URL for backend API (set via Vite env on hosted deployments)
    try {
      this.apiBase = (import.meta && import.meta.env && import.meta.env.VITE_API_BASE)
        ? String(import.meta.env.VITE_API_BASE).replace(/\/+$/, '')
        : '';
    } catch (_) {
      this.apiBase = '';
    }
    // Use multiple NOAA data sources for comprehensive ocean data coverage
    this.sourceConfig = {
      noaa_rtgsst: {
        name: 'NOAA Real-time Global SST',
        type: 'vector_grid',
        timeout: 60000, // Extended timeout for NOAA RTGSST
        endpoint: '/grid',
        description: 'Real-time sea surface temperature analysis'
      },
      noaa_oisst: {
        name: 'NOAA OI SST V2.1 Historical',
        type: 'vector_grid', 
        timeout: 60000,
        endpoint: '/grid/historical',
        description: 'Historical SST analysis 1981-present'
      },
    };

    // Health tracking for all NOAA sources
    this.healthStatus = new Map();
    this.errorCounts = new Map();
    this.lastHealthCheck = new Map();

    // Initialize health status for all NOAA sources
    Object.keys(this.sourceConfig).forEach(source => {
      this.healthStatus.set(source, 'unknown');
      this.errorCounts.set(source, 0);
    });
    
    // Rate limiting and request queuing
    this.requestQueue = [];
    this.activeRequests = 0;
    this.maxConcurrentRequests = 1; // Avoid concurrency; backend throttles per IP
    this.requestInterval = 2200; // Keep above backend throttle (2.0s)
    this.lastRequestTime = 0;
    this.retryAttempts = 3;
    this.retryBaseDelay = 2000; // 2 seconds base delay

    // Frontend cache configuration for NOAA data
    this.cacheConfig = {
      dbName: 'NOAAOceanMapCache',
      dbVersion: 2, // Increment version for NOAA migration
      gridStoreName: 'noaaTemperatureGrids', 
      metadataKey: 'noaa_ocean_map_cache_metadata',
      maxCacheAge: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
      maxCacheEntries: 50 // Limit to prevent excessive storage usage
    };

    // Initialize cache system
    this.db = null;
    this.initializeCache();

    // Track in-flight requests by cache key to de-duplicate
    this.pendingRequests = new Map(); // cacheKey -> Promise
  }

  // ================================
  // FRONTEND CACHE MANAGEMENT
  // ================================

  /**
   * Initialize IndexedDB for frontend caching
   */
  async initializeCache() {
    try {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.cacheConfig.dbName, this.cacheConfig.dbVersion);
        
        request.onerror = () => {
          console.warn('IndexedDB failed to initialize, caching disabled');
          resolve(); // Continue without caching
        };

        request.onsuccess = (event) => {
          this.db = event.target.result;
          console.log('🗄️ Frontend cache (IndexedDB) initialized');
          resolve();
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          
          // Create temperature grids store
          if (!db.objectStoreNames.contains(this.cacheConfig.gridStoreName)) {
            const store = db.createObjectStore(this.cacheConfig.gridStoreName, { keyPath: 'cacheKey' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('bounds', 'bounds', { unique: false });
          }
        };
      });
    } catch (error) {
      console.warn('Cache initialization failed:', error);
    }
  }

  /**
   * Generate cache key from geographic bounds and parameters
   */
  generateCacheKey(bounds, options = {}) {
    const { center, region = 2.0 } = bounds;
    const { gridSize = 15 } = options;
    
    // Create consistent key based on rounded coordinates
    const lat = Math.round(center.lat * 100) / 100; // Round to 2 decimals
    const lon = Math.round(center.lon * 100) / 100;
    const regionRounded = Math.round(region * 10) / 10;
    
    return `grid_${lat}_${lon}_${regionRounded}_${gridSize}`;
  }

  /**
   * Get current cache date (based on NOAA daily updates around noon UTC)
   */
  getCacheDate() {
    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // If it's before noon, use yesterday's data as current for NOAA RTGSST
    if (now.getHours() < 12) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday.toISOString().split('T')[0];
    }
    
    return today;
  }

  /**
   * Check if cached data is still valid
   */
  isCacheValid(cacheEntry) {
    if (!cacheEntry || !cacheEntry.timestamp) return false;
    
    const now = Date.now();
    const cacheAge = now - cacheEntry.timestamp;
    const currentCacheDate = this.getCacheDate();
    
    // Check if cache is from current valid date and not too old
    return (
      cacheEntry.cacheDate === currentCacheDate &&
      cacheAge < this.cacheConfig.maxCacheAge
    );
  }

  /**
   * Store grid data in IndexedDB cache
   */
  async storeCacheEntry(cacheKey, data, bounds, options) {
    if (!this.db) return false;

    try {
      const cacheEntry = {
        cacheKey,
        data,
        bounds,
        options,
        timestamp: Date.now(),
        cacheDate: this.getCacheDate()
      };

      const transaction = this.db.transaction([this.cacheConfig.gridStoreName], 'readwrite');
      const store = transaction.objectStore(this.cacheConfig.gridStoreName);
      
      await new Promise((resolve, reject) => {
        const request = store.put(cacheEntry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      console.log(`💾 Frontend cache stored: ${cacheKey}`);
      
      // Cleanup old entries to prevent storage bloat
      await this.cleanupOldCacheEntries();
      
      return true;
    } catch (error) {
      console.warn('Failed to store cache entry:', error);
      return false;
    }
  }

  /**
   * Retrieve grid data from IndexedDB cache
   */
  async getCacheEntry(cacheKey) {
    if (!this.db) return null;

    try {
      const transaction = this.db.transaction([this.cacheConfig.gridStoreName], 'readonly');
      const store = transaction.objectStore(this.cacheConfig.gridStoreName);

      return new Promise((resolve, reject) => {
        const request = store.get(cacheKey);
        
        request.onsuccess = () => {
          const result = request.result;
          if (result && this.isCacheValid(result)) {
            console.log(`🚀 Frontend cache hit: ${cacheKey}`);
            resolve(result);
          } else {
            resolve(null);
          }
        };
        
        request.onerror = () => resolve(null);
      });
    } catch (error) {
      console.warn('Failed to retrieve cache entry:', error);
      return null;
    }
  }

  /**
   * Clean up old cache entries to prevent storage bloat
   */
  async cleanupOldCacheEntries() {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction([this.cacheConfig.gridStoreName], 'readwrite');
      const store = transaction.objectStore(this.cacheConfig.gridStoreName);
      const index = store.index('timestamp');

      // Get all entries sorted by timestamp (oldest first)
      const allEntries = await new Promise((resolve) => {
        const entries = [];
        const request = index.openCursor();
        
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            entries.push(cursor.value);
            cursor.continue();
          } else {
            resolve(entries);
          }
        };
        
        request.onerror = () => resolve([]);
      });

      // Remove entries beyond max limit or too old
      const now = Date.now();
      const cutoffTime = now - this.cacheConfig.maxCacheAge;
      let removeCount = 0;

      for (let i = 0; i < allEntries.length; i++) {
        const entry = allEntries[i];
        const shouldRemove = 
          entry.timestamp < cutoffTime || // Too old
          i < (allEntries.length - this.cacheConfig.maxCacheEntries); // Beyond limit

        if (shouldRemove) {
          await new Promise((resolve) => {
            const deleteRequest = store.delete(entry.cacheKey);
            deleteRequest.onsuccess = () => resolve();
            deleteRequest.onerror = () => resolve();
          });
          removeCount++;
        }
      }

      if (removeCount > 0) {
        console.log(`🧹 Cleaned up ${removeCount} old cache entries`);
      }
    } catch (error) {
      console.warn('Cache cleanup failed:', error);
    }
  }

  /**
   * Main entry point: Get temperature data with intelligent frontend caching
   * @param {Object} bounds - Map bounds or center coordinates
   * @param {Object} options - Request options
   * @returns {Promise<Object>} {data, source, metadata}
   */
  async getTemperatureData(bounds, options = {}) {
    const startTime = Date.now();
    
    // Generate cache key for this request
    const cacheKey = this.generateCacheKey(bounds, options);
    
    // Try frontend cache first
    console.log(`🔍 Checking frontend cache for: ${cacheKey}`);
    const cachedEntry = await this.getCacheEntry(cacheKey);
    
    if (cachedEntry) {
      console.log(`⚡ Instant load from frontend cache (${Date.now() - startTime}ms)`);
      
      // Emit cache event
      this.emitDataSourceEvent('data:source:used', {
        source: 'frontend_cache',
        responseTime: Date.now() - startTime,
        quality: 1.0,
        bounds: bounds,
        cached: true
      });
      
      return {
        data: cachedEntry.data,
        // Default to NOAA RTGSST when cache lacks explicit source (we no longer use Copernicus)
        source: cachedEntry.data.source || 'noaa_rtgsst',
        metadata: {
          fetchTime: Date.now() - startTime,
          quality: 1.0,
          type: cachedEntry.data.metadata?.type || 'vector_grid',
          name: cachedEntry.data.metadata?.name || this.sourceConfig.noaa_rtgsst.name,
          realData: true,
          dataTime: cachedEntry.data.timestamp || cachedEntry.data.data_time,
          freshness: cachedEntry.data.cache_info ? 
            { hours: cachedEntry.data.cache_info.cache_age_hours || 0, text: `${Math.floor(cachedEntry.data.cache_info.cache_age_hours || 0)}h old` } :
            this.calculateDataFreshness(cachedEntry.data.timestamp || cachedEntry.data.data_time),
          cached: true,
          cacheDate: cachedEntry.cacheDate,
          cacheAge: Date.now() - cachedEntry.timestamp
        }
      };
    }
    
    // Cache miss - if identical request is in-flight, join it
    if (this.pendingRequests.has(cacheKey)) {
      try {
        return await this.pendingRequests.get(cacheKey);
      } catch (e) {
        // fall through to try again fresh
      }
    }

    // Enforce rate limiting before API call
    console.log(`📡 Cache miss, fetching from NOAA data services...`);
    
    // Check if we need to wait due to rate limiting
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.requestInterval) {
      const waitTime = this.requestInterval - timeSinceLastRequest;
      console.log(`🚦 Rate limiting: waiting ${waitTime}ms before request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Check concurrent request limit
    if (this.activeRequests >= this.maxConcurrentRequests) {
      console.log(`🚦 Too many concurrent requests (${this.activeRequests}/${this.maxConcurrentRequests}), queuing...`);
      
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ resolve, reject, bounds, options, startTime });
      });
    }

    try {
      this.activeRequests++;
      this.lastRequestTime = Date.now();
      
      // Create a de-duplicated in-flight promise
      const inflight = this.fetchFromNOAA(bounds, options);
      this.pendingRequests.set(cacheKey, inflight);
      const result = await inflight;
      
      // Store in frontend cache for future requests
      await this.storeCacheEntry(cacheKey, result.data, bounds, options);
      
      // Track success for the appropriate NOAA source
      const sourceKey = this.determineNOAASource(result.data.source);
      this.recordSuccess(sourceKey, Date.now() - startTime);
      
      // Emit event for UI updates
      this.emitDataSourceEvent('data:source:used', {
        source: sourceKey,
        responseTime: Date.now() - startTime,
        quality: 1.0, // NOAA data is highest quality authentic data
        bounds: bounds,
        cached: false
      });

      return {
        data: result.data,
        source: result.data.source || sourceKey,
        metadata: {
          fetchTime: Date.now() - startTime,
          quality: 1.0,
          type: result.data.metadata?.type || 'vector_grid',
          name: result.data.source || this.sourceConfig[sourceKey]?.name || 'NOAA Ocean Data',
          realData: true,
          dataTime: result.data.timestamp || result.data.data_time || new Date().toISOString(),
          freshness: result.data.cache_info ? 
            { hours: result.data.cache_info.cache_age_hours || 0, text: `${Math.floor(result.data.cache_info.cache_age_hours || 0)}h old` } :
            this.calculateDataFreshness(result.data.timestamp || result.data.data_time),
          cached: result.data.cache_info?.cached || false,
          freshlyDownloaded: !result.data.cache_info?.cached
        }
      };

    } catch (error) {
      console.error(`❌ NOAA data services failed:`, error.message);
      this.recordError('noaa_rtgsst', error); // Default to RTGSST for current data errors
      throw new Error(`NOAA data services unavailable: ${error.message}`);
    } finally {
      // Always decrement active requests and process queue
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.pendingRequests.delete(cacheKey);
      this.processRequestQueue();
    }
  }

  /**
   * Process queued requests when slots become available
   */
  processRequestQueue() {
    while (this.requestQueue.length > 0 && this.activeRequests < this.maxConcurrentRequests) {
      const { resolve, reject, bounds, options, startTime, isHistorical } = this.requestQueue.shift();
      
      // Execute queued request - check if historical or current
      if (isHistorical) {
        const { targetDate, ...cleanOptions } = options;
        this.getHistoricalTemperatureData(bounds, targetDate, cleanOptions)
          .then(resolve)
          .catch(reject);
      } else {
        this.getTemperatureData(bounds, options)
          .then(resolve)
          .catch(reject);
      }
    }
  }

  /**
   * Fetch real ocean data from NOAA services via backend proxy
   */
  async fetchFromNOAA(bounds, options) {
    // Extract coordinates from bounds
    const { center, region = 2.0 } = bounds;
    const { gridSize = 15, endpoint = '/grid' } = options;
    
    // Build URL with query parameters for GET request (proxied by Vite or absolute via API base)
    const base = (this.apiBase || '').replace(/\/+$/, '');
    const baseUrl = `${base}${endpoint}`;
    const params = new URLSearchParams({
      lat: center.lat,
      lon: center.lon,
      size: gridSize,
      region: region
    });
    
    const url = `${baseUrl}?${params}`;
    
    let attempt = 0;
    let lastError = null;
    while (attempt <= this.retryAttempts) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(60000)
        });

        if (response.status === 429) {
          throw new Error('429: too many requests');
        }

        if (!response.ok) {
          throw new Error(`NOAA API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        if (result.error) {
          throw new Error(result.error);
        }
        return { data: result };
      } catch (err) {
        lastError = err;
        attempt += 1;
        if (attempt > this.retryAttempts) break;
        const delay = this.retryBaseDelay * Math.pow(2, attempt - 1);
        console.warn(`⏳ NOAA request retry ${attempt}/${this.retryAttempts} in ${delay}ms due to: ${err.message}`);
        await new Promise(res => setTimeout(res, delay));
      }
    }
    // Fallback: direct to backend (bypass Vite proxy) only in local dev with no API base
    try {
      if (this.apiBase) throw lastError || new Error('NOAA request failed');
      // Try localhost first (works best on macOS browsers), then 127.0.0.1
      let directUrl = `http://localhost:5176${endpoint}?${params}`;
      const response = await fetch(directUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(60000)
      });
      if (response.ok) {
        const result = await response.json();
        if (!result.error) {
          return { data: result };
        }
      }
      // Retry with 127.0.0.1 if localhost path didn’t succeed
      directUrl = `http://127.0.0.1:5176${endpoint}?${params}`;
      const response2 = await fetch(directUrl, { method: 'GET', signal: AbortSignal.timeout(60000) });
      if (response2.ok) {
        const result = await response2.json();
        if (!result.error) {
          return { data: result };
        }
      }
    } catch (_) {
      // ignore and fall through to throw below
    }

    throw lastError || new Error('NOAA request failed');
  }

  /**
   * Determine which NOAA source was used based on response data
   */
  determineNOAASource(responseSource) {
    if (!responseSource) return 'noaa_rtgsst'; // Default to RTGSST
    
    const source = responseSource.toLowerCase();
    if (source.includes('rtgsst') || source.includes('real-time')) {
      return 'noaa_rtgsst';
    } else if (source.includes('oisst') || source.includes('historical') || source.includes('oi sst')) {
      return 'noaa_oisst';
    }
    
    return 'noaa_rtgsst'; // Default fallback
  }

  /**
   * Calculate data freshness in hours
   */
  calculateDataFreshness(dataTime) {
    if (!dataTime) return { hours: 0, text: 'Real-time' };
    
    const now = new Date();
    const dataDate = new Date(dataTime);
    const hoursOld = Math.floor((now - dataDate) / (1000 * 60 * 60));
    
    if (hoursOld < 1) return { hours: 0, text: 'Real-time' };
    if (hoursOld < 24) return { hours: hoursOld, text: `${hoursOld}h old` };
    
    const daysOld = Math.floor(hoursOld / 24);
    return { hours: hoursOld, text: `${daysOld}d old` };
  }

  /**
   * Health monitoring methods
   */
  recordSuccess(source, responseTime) {
    this.healthStatus.set(source, 'healthy');
    this.errorCounts.set(source, 0);
    this.lastHealthCheck.set(source, Date.now());
  }

  recordError(source, error) {
    const currentCount = this.errorCounts.get(source) || 0;
    this.errorCounts.set(source, currentCount + 1);
    this.lastHealthCheck.set(source, Date.now());
    
    if (currentCount + 1 >= 3) {
      this.healthStatus.set(source, 'unhealthy');
    }
  }

  /**
   * Emit data source events
   */
  emitDataSourceEvent(eventName, data) {
    // Emit with a flat detail payload; listeners should read event.detail
    eventBus.emit(eventName, data);
  }

  /**
   * Get current health status for all NOAA sources
   */
  getHealthStatus() {
    const healthReport = {};
    
    Object.keys(this.sourceConfig).forEach(source => {
      healthReport[source] = {
        status: this.healthStatus.get(source),
        errorCount: this.errorCounts.get(source),
        lastCheck: this.lastHealthCheck.get(source),
        name: this.sourceConfig[source].name
      };
    });
    
    return healthReport;
  }

  /**
   * Get historical temperature data for comparison
   * @param {Object} bounds - Map bounds
   * @param {string} targetDate - Date in YYYY-MM-DD format  
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Historical data result
   */
  async getHistoricalTemperatureData(bounds, targetDate, options = {}) {
    const startTime = Date.now();
    
    // Enforce rate limiting for historical requests too
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.requestInterval) {
      const waitTime = this.requestInterval - timeSinceLastRequest;
      console.log(`🚦 Rate limiting historical request: waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Check concurrent request limit
    if (this.activeRequests >= this.maxConcurrentRequests) {
      console.log(`🚦 Too many concurrent requests for historical data, queuing...`);
      
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ 
          resolve, 
          reject, 
          bounds, 
          options: { ...options, historical: true, targetDate }, 
          startTime,
          isHistorical: true
        });
      });
    }
    
    try {
      this.activeRequests++;
      this.lastRequestTime = Date.now();
      
      // Use same endpoint format as current data but with date parameter
      const { center, region = 2.0 } = bounds;
      const { gridSize = 15 } = options;
      
      const params = new URLSearchParams({
        lat: center.lat,
        lon: center.lon,
        size: gridSize,
        region: region,
        date: targetDate
      });
      
      const base = (this.apiBase || '').replace(/\/+$/, '');
      const url = `${base}/grid/historical?${params}`;
      
      let attempt = 0;
      let lastError = null;
      let result = null;
      while (attempt <= this.retryAttempts) {
        try {
          const response = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(60000)
          });
          if (response.status === 429) {
            throw new Error('429: too many requests');
          }
          if (!response.ok) {
            throw new Error(`Historical API error: ${response.status} ${response.statusText}`);
          }
          result = await response.json();
          if (result.error) {
            throw new Error(result.error);
          }
          break;
        } catch (err) {
          lastError = err;
          attempt += 1;
          if (attempt > this.retryAttempts) break;
          const delay = this.retryBaseDelay * Math.pow(2, attempt - 1);
          console.warn(`⏳ Historical request retry ${attempt}/${this.retryAttempts} in ${delay}ms due to: ${err.message}`);
          await new Promise(res => setTimeout(res, delay));
        }
      }

      if (!result) throw lastError || new Error('Historical request failed');
      // If we reached here, fetch via proxy succeeded. If not, attempt direct fallback below.
      return {
        data: result,
        source: 'noaa_oisst',
        metadata: {
          fetchTime: Date.now() - startTime,
          quality: 1.0,
          type: 'vector_grid',
          name: 'NOAA OI SST V2.1 (Historical)',
          realData: true,
          dataTime: result.target_date,
          historical: true,
          cached: result.cache_info?.cached || false
        }
      };

    } catch (error) {
      console.error(`❌ Historical data fetch failed for ${targetDate}:`, error.message);
      // Fallback: attempt direct backend call bypassing Vite proxy
      try {
        // Only use localhost fallback in local dev when no API base is provided
        if (this.apiBase) {
          throw error;
        }
        const { center, region = 2.0 } = bounds;
        const { gridSize = 15 } = options;
        const params = new URLSearchParams({
          lat: center.lat,
          lon: center.lon,
          size: gridSize,
          region: region,
          date: targetDate
        });
        let directUrl = `http://localhost:5176/grid/historical?${params}`;
        let response = await fetch(directUrl, { method: 'GET', signal: AbortSignal.timeout(60000) });
        if (response.ok) {
          const result = await response.json();
          if (!result.error) {
            return {
              data: result,
              source: 'noaa_oisst',
              metadata: {
                fetchTime: Date.now() - startTime,
                quality: 1.0,
                type: 'vector_grid',
                name: 'NOAA OI SST V2.1 (Historical)',
                realData: true,
                dataTime: result.target_date,
                historical: true,
                cached: result.cache_info?.cached || false
              }
            };
          }
        }
        // Retry with 127.0.0.1
        directUrl = `http://127.0.0.1:5176/grid/historical?${params}`;
        response = await fetch(directUrl, { method: 'GET', signal: AbortSignal.timeout(60000) });
        if (response.ok) {
          const result = await response.json();
          if (!result.error) {
            return {
              data: result,
              source: 'noaa_oisst',
              metadata: {
                fetchTime: Date.now() - startTime,
                quality: 1.0,
                type: 'vector_grid',
                name: 'NOAA OI SST V2.1 (Historical)',
                realData: true,
                dataTime: result.target_date,
                historical: true,
                cached: result.cache_info?.cached || false
              }
            };
          }
        }
      } catch (_) {
        // ignore and rethrow original error
      }
      throw error;
    } finally {
      // Always decrement active requests and process queue
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.processRequestQueue();
    }
  }
}
