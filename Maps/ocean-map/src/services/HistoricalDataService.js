import { eventBus } from '../utils/EventBus.js';
import { NOAADataService } from './NOAADataService.js';

/**
 * Service for fetching historical temperature data (NOAA-only)
 * - Uses NOAA OI SST V2.1 (and similar) for historical grids
 */
export class HistoricalDataService {
  constructor() {
    this.cache = new Map(); // In-memory cache for session
    this.noaaService = new NOAADataService();
  }

  /**
   * Get historical temperature data for comparison using hybrid data sources
   * @param {Object} bounds - Map bounds
   * @param {string} targetDate - Date in YYYY-MM-DD format
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Historical temperature data
   */
  async getHistoricalTemperatureData(bounds, targetDate, options = {}) {
    const startTime = Date.now();
    const { center, region = 2.0 } = bounds;
    const { gridSize = 15 } = options;
    
    // Generate cache key
    const cacheKey = `${targetDate}_${center.lat}_${center.lon}_${region}_${gridSize}`;
    
    // Check session cache first
    if (this.cache.has(cacheKey)) {
      console.log(`⚡ Using cached historical data for ${targetDate}`);
      return this.cache.get(cacheKey);
    }
    
    try {
      // NOAA historical data (single source)
      console.log(`🌊 Fetching NOAA historical data for ${targetDate}...`);
      const data = await this.noaaService.getHistoricalTemperatureData(bounds, targetDate, options);
      data.metadata = data.metadata || {};
      data.metadata.dataSource = 'NOAA';

      // Cache successful response
      this.cache.set(cacheKey, data);
      
      const dataSource = data.metadata?.dataSource || 'NOAA';
      console.log(`✅ Historical data loaded for ${targetDate} from ${dataSource} (${Date.now() - startTime}ms)`);
      return data;
      
    } catch (error) {
      console.error(`❌ Failed to load historical data for ${targetDate}:`, error);
      throw error;
    }
  }

  /**
   * Calculate date for relative periods (7 days ago, 30 days ago, etc.)
   * @param {string} period - Period type: '1d', '1w', '1m', '3m', '1y', '2y', '3y'
   * @returns {string} Date in YYYY-MM-DD format
   */
  calculateHistoricalDate(period) {
    const now = new Date();
    let daysAgo = 0;
    
    switch (period) {
      case '1d':
        daysAgo = 7; // Actually 7 days for "7 Days" button
        break;
      case '1w':
        daysAgo = 7;
        break;
      case '1m':
        daysAgo = 30;
        break;
      case '3m':
        daysAgo = 90;
        break;
      case '1y':
        daysAgo = 365;
        break;
      case '2y':
        daysAgo = 365 * 2;
        break;
      case '3y':
        daysAgo = 365 * 3;
        break;
      default:
        throw new Error(`Unknown period: ${period}`);
    }
    
    const historicalDate = new Date(now);
    historicalDate.setDate(now.getDate() - daysAgo);
    
    return historicalDate.toISOString().split('T')[0]; // YYYY-MM-DD format
  }

  /**
   * Check if historical data is available for a given date (NOAA)
   * @param {string} targetDate - Date in YYYY-MM-DD format
   * @returns {boolean} True if data should be available from either Copernicus or NOAA
   */
  isDataAvailable(targetDate) {
    const target = new Date(targetDate);
    const now = new Date();
    const noaaMinDate = new Date('1981-09-01'); // OI SST starts 1981-09-01
    return target >= noaaMinDate && target < now;
  }

  /**
   * Clear session cache
   */
  clearCache() {
    this.cache.clear();
  }
}
