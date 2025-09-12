import ImageLayer from 'ol/layer/Image';
import ImageCanvas from 'ol/source/ImageCanvas';
import { transformExtent } from 'ol/proj';
import { eventBus } from '../utils/EventBus.js';
import { CONFIG } from '../config.js';

/**
 * High-performance Canvas-based temperature renderer
 * Renders temperature data as a single image overlay instead of vector polygons
 */
export class CanvasTemperatureRenderer {
  constructor() {
    this.temperatureData = null;
    this.bounds = null;
    this.colorCache = new Map();
    this.colorScale = { min: 16, max: 24 }; // fixed range to match analysis (°C)
    this.performanceMetrics = {
      lastRenderTime: 0,
      renderCount: 0,
      averageRenderTime: 0
    };

    // Approximate coastline polyline (south→north) for SoCal to Baja masking
    // Rough, low-vertex path to gate out inland tiles without heavy datasets.
    this.coastline = [
      { lat: 24.5, lon: -111.6 },
      { lat: 25.5, lon: -112.4 },
      { lat: 26.5, lon: -112.9 },
      { lat: 27.5, lon: -113.6 },
      { lat: 28.5, lon: -114.2 },
      { lat: 29.5, lon: -114.8 },
      { lat: 30.5, lon: -115.6 },
      { lat: 31.5, lon: -116.5 },
      { lat: 32.7, lon: -117.2 },
      { lat: 33.3, lon: -117.8 },
      { lat: 34.3, lon: -119.4 },
      { lat: 35.0, lon: -120.1 },
      { lat: 36.0, lon: -121.0 },
      { lat: 36.8, lon: -121.9 }
    ];
  }

  /**
   * Create an OpenLayers Image layer with temperature data
   */
  createImageLayer(temperatureData, bounds, opacity = 0.7) {
    const startTime = performance.now();
    
    // Store the complete data structure
    this.temperatureData = temperatureData;
    this.bounds = bounds;
    this.colorCache.clear();
    this.computeColorScale(temperatureData);

    // Extract grid for debugging
    const grid = temperatureData.grid_data || temperatureData.grid || temperatureData;
    
    // Debug log to check data
    console.log('🎨 Creating Canvas layer with data:', {
      hasData: !!this.temperatureData,
      hasGridData: !!temperatureData.grid_data,
      gridSize: grid?.length ? `${grid[0]?.length}x${grid.length}` : 'no grid',
      regionSize: temperatureData.region_size_degrees,
      bounds: bounds,
      colorScale: this.colorScale
    });

    const imageSource = new ImageCanvas({
      canvasFunction: this.renderTemperatureCanvas.bind(this),
      projection: 'EPSG:3857',
      ratio: 1
    });

    const layer = new ImageLayer({
      source: imageSource,
      opacity: opacity,
      zIndex: 10,
      name: 'sst' // Critical for temperature readout
    });

    // Track performance
    const renderTime = performance.now() - startTime;
    this.updatePerformanceMetrics(renderTime);
    
    console.log(`🎨 Canvas temperature layer created in ${renderTime.toFixed(2)}ms`);
    
    return layer;
  }

  /**
   * Compute an adaptive color scale from data stats
   */
  computeColorScale(temperatureData) {
    // Fixed palette to match Temperature Analysis (16–24°C)
    this.colorScale = { min: 16, max: 24 };
  }

  /**
   * Canvas rendering function for OpenLayers
   */
  renderTemperatureCanvas(extent, resolution, pixelRatio, size, projection) {
    const startTime = performance.now();
    
    const canvas = document.createElement('canvas');
    const width = Math.max(1, Math.floor(size[0] || 0));
    const height = Math.max(1, Math.floor(size[1] || 0));
    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d');
    
    if (!this.temperatureData) {
      console.warn('🎨 No temperature data available for rendering');
      return canvas;
    }

    // Transform extent to lon/lat for data lookup
    const lonLatExtent = transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
    const [minLon, minLat, maxLon, maxLat] = lonLatExtent;

    // Get grid dimensions - handle both grid_data and direct array formats
    const gridData = this.temperatureData.grid_data || this.temperatureData.grid || this.temperatureData;
    const gridHeight = Array.isArray(gridData) ? gridData.length : 0;
    const gridWidth = gridHeight > 0 ? Math.min(...gridData.map(row => Array.isArray(row) ? row.length : 0)) : 0;

    if (gridHeight === 0 || gridWidth === 0) {
      console.warn('🎨 Grid has no dimensions:', gridHeight, 'x', gridWidth);
      return canvas;
    }

    // Log rendering info
    console.log(`🎨 Rendering temperature canvas: ${gridWidth}x${gridHeight} grid onto ${width}x${height} canvas`);

    // Strategy: draw a 1:1 offscreen grid (one pixel per cell), then scale to viewport.
    // This avoids rounding gaps (single-pixel lines) when grid >> canvas or vice versa.
    const off = document.createElement('canvas');
    off.width = Math.max(1, gridWidth);
    off.height = Math.max(1, gridHeight);
    const octx = off.getContext('2d');
    const odata = octx.createImageData(off.width, off.height);
    const buf = odata.data;

    // Flip vertically so the northmost latitude renders at the top of the image
    // gridData[0] is usually the southernmost row in ascending latitude arrays.
    for (let row = 0; row < gridHeight; row++) {
      const srcRow = gridData[row];
      const destRow = (gridHeight - 1 - row); // flip vertically
      for (let col = 0; col < gridWidth; col++) {
        const cell = srcRow[col];
        const idx = (destRow * gridWidth + col) * 4;
        if (!cell || cell.temp === null || cell.temp === undefined) {
          // Transparent for missing data
          buf[idx] = 0;
          buf[idx + 1] = 0;
          buf[idx + 2] = 0;
          buf[idx + 3] = 0;
          continue;
        }
        const color = this.getTemperatureColor(cell.temp);
        buf[idx] = color.r;
        buf[idx + 1] = color.g;
        buf[idx + 2] = color.b;
        buf[idx + 3] = 255;
      }
    }

    // Commit offscreen data
    octx.putImageData(odata, 0, 0);

    // Draw only where the data extent intersects the current view extent
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);

    // Compute data extent from metadata (fallback to grid bounds)
    const td = this.temperatureData || {};
    let dataCenterLat = td.center_latitude;
    let dataCenterLon = td.center_longitude;
    let dataRegion = td.region_size_degrees;
    let dataMinLon, dataMinLat, dataMaxLon, dataMaxLat;

    if (
      typeof dataCenterLat === 'number' &&
      typeof dataCenterLon === 'number' &&
      typeof dataRegion === 'number' && dataRegion > 0
    ) {
      const half = dataRegion / 2;
      dataMinLat = dataCenterLat - half;
      dataMaxLat = dataCenterLat + half;
      dataMinLon = dataCenterLon - half;
      dataMaxLon = dataCenterLon + half;
    } else {
      // Derive from grid_data coordinates
      let minLatV = Infinity, maxLatV = -Infinity, minLonV = Infinity, maxLonV = -Infinity;
      for (const row of gridData) {
        for (const cell of row) {
          if (!cell) continue;
          if (typeof cell.lat === 'number') {
            if (cell.lat < minLatV) minLatV = cell.lat;
            if (cell.lat > maxLatV) maxLatV = cell.lat;
          }
          if (typeof cell.lon === 'number') {
            if (cell.lon < minLonV) minLonV = cell.lon;
            if (cell.lon > maxLonV) maxLonV = cell.lon;
          }
        }
      }
      if (isFinite(minLatV) && isFinite(maxLatV) && isFinite(minLonV) && isFinite(maxLonV)) {
        // Add half a cell as padding to cover cell area
        const latStep = (maxLatV - minLatV) / Math.max(1, gridHeight - 1);
        const lonStep = (maxLonV - minLonV) / Math.max(1, gridWidth - 1);
        dataMinLat = minLatV - latStep / 2;
        dataMaxLat = maxLatV + latStep / 2;
        dataMinLon = minLonV - lonStep / 2;
        dataMaxLon = maxLonV + lonStep / 2;
      } else {
        // As a last resort, fill entire view
        dataMinLat = minLat;
        dataMaxLat = maxLat;
        dataMinLon = minLon;
        dataMaxLon = maxLon;
      }
    }

    // Intersection between data extent and current view extent
    const viewMinLon = minLon;
    const viewMaxLon = maxLon;
    const viewMinLat = minLat;
    const viewMaxLat = maxLat;
    const ixMinLon = Math.max(dataMinLon, viewMinLon);
    const ixMaxLon = Math.min(dataMaxLon, viewMaxLon);
    const ixMinLat = Math.max(dataMinLat, viewMinLat);
    const ixMaxLat = Math.min(dataMaxLat, viewMaxLat);

    if (ixMinLon < ixMaxLon && ixMinLat < ixMaxLat) {
      const toDX = (lon) => (lon - viewMinLon) / (viewMaxLon - viewMinLon) * width;
      const toDY = (lat) => (viewMaxLat - lat) / (viewMaxLat - viewMinLat) * height;
      const toSX = (lon) => (lon - dataMinLon) / (dataMaxLon - dataMinLon) * off.width;
      const toSY = (lat) => (dataMaxLat - lat) / (dataMaxLat - dataMinLat) * off.height;

      const sx0 = Math.max(0, Math.min(off.width, toSX(ixMinLon)));
      const sx1 = Math.max(0, Math.min(off.width, toSX(ixMaxLon)));
      const sy0 = Math.max(0, Math.min(off.height, toSY(ixMaxLat)));
      const sy1 = Math.max(0, Math.min(off.height, toSY(ixMinLat)));

      const dx0 = Math.max(0, Math.min(width, toDX(ixMinLon)));
      const dx1 = Math.max(0, Math.min(width, toDX(ixMaxLon)));
      const dy0 = Math.max(0, Math.min(height, toDY(ixMaxLat)));
      const dy1 = Math.max(0, Math.min(height, toDY(ixMinLat)));

      const sWidth = Math.max(0, sx1 - sx0);
      const sHeight = Math.max(0, sy1 - sy0);
      const dWidth = Math.max(0, dx1 - dx0);
      const dHeight = Math.max(0, dy1 - dy0);

      if (sWidth > 0 && sHeight > 0 && dWidth > 0 && dHeight > 0) {
        ctx.drawImage(off, sx0, sy0, sWidth, sHeight, dx0, dy0, dWidth, dHeight);
      }
    }

    // Optionally mask out land using an approximate coastline for SoCal/Baja
    if (CONFIG.FEATURES?.MASK_LAND) {
      try {
        this.applyOceanMask(ctx, [minLon, minLat, maxLon, maxLat], width, height);
      } catch (e) {
        console.warn('Masking failed, drawing unmasked:', e);
      }
    }
    
    // No blur - preserve the crisp square grid appearance

    // Track performance
    const renderTime = performance.now() - startTime;
    this.updatePerformanceMetrics(renderTime);
    
    // Emit performance event
    eventBus.emit('renderer:performance', {
      type: 'canvas',
      renderTime: renderTime,
      gridSize: `${gridWidth}x${gridHeight}`,
      canvasSize: `${width}x${height}`
    });

    return canvas;
  }

  /**
   * Convert temperature to RGB color with caching
   */
  getTemperatureColor(tempCelsius) {
    const cached = this.colorCache.get(tempCelsius);
    if (cached) return cached;
    const minT = 16;
    const maxT = 24;
    const n = Math.max(0, Math.min(1, (tempCelsius - minT) / (maxT - minT)));
    let r, g, b;
    if (n < 0.25) {
      const t = n / 0.25;
      r = Math.floor(50 + t * 100);
      g = Math.floor(150 + t * 105);
      b = 255;
    } else if (n < 0.5) {
      const t = (n - 0.25) / 0.25;
      r = 0;
      g = Math.floor(200 + t * 55);
      b = Math.floor(255 - t * 100);
    } else if (n < 0.75) {
      const t = (n - 0.5) / 0.25;
      r = Math.floor(t * 255);
      g = 255;
      b = Math.floor(50 - t * 50);
    } else {
      const t = (n - 0.75) / 0.25;
      r = 255;
      g = Math.floor(200 - t * 100);
      b = 0;
    }
    const color = { r, g, b };
    if (this.colorCache.size > 1000) this.colorCache.clear();
    this.colorCache.set(tempCelsius, color);
    return color;
  }

  /**
   * Update performance metrics
   */
  updatePerformanceMetrics(renderTime) {
    this.performanceMetrics.lastRenderTime = renderTime;
    this.performanceMetrics.renderCount++;
    
    // Calculate running average
    const prevAvg = this.performanceMetrics.averageRenderTime;
    const count = this.performanceMetrics.renderCount;
    this.performanceMetrics.averageRenderTime = 
      (prevAvg * (count - 1) + renderTime) / count;
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats() {
    return {
      lastRenderTime: `${this.performanceMetrics.lastRenderTime.toFixed(2)}ms`,
      averageRenderTime: `${this.performanceMetrics.averageRenderTime.toFixed(2)}ms`,
      renderCount: this.performanceMetrics.renderCount,
      cacheSize: this.colorCache.size
    };
  }

  /**
   * Clear cached data
   */
  clear() {
    this.temperatureData = null;
    this.bounds = null;
    this.colorCache.clear();
    console.log('🧹 Canvas renderer cleared');
  }

  /**
   * Apply an ocean-only mask using an approximate coastline.
   * Keeps pixels west of the coastline; removes inland spillover.
   */
  applyOceanMask(ctx, lonLatExtent, width, height) {
    const [minLon, minLat, maxLon, maxLat] = lonLatExtent;
    const margin = 5; // degrees
    const farWest = Math.max(-180, minLon - margin);
    const farSouth = minLat - margin;
    const farNorth = maxLat + margin;

    const toXY = (lon, lat) => {
      const x = ((lon - minLon) / (maxLon - minLon)) * width;
      const y = ((maxLat - lat) / (maxLat - minLat)) * height; // top-left origin
      return [x, y];
    };

    // Build polygon: start SW far-west, follow coastline south→north (east boundary),
    // then close at far-west north, forming a west-of-coastline ocean polygon.
    const buffer = (CONFIG.FEATURES?.COAST_BUFFER_DEG ?? 0);
    const path = [];
    path.push([farWest, farSouth]);
    for (const p of this.coastline) {
      // Shift a bit offshore (west) to avoid any inland bleed
      path.push([p.lon - buffer, p.lat]);
    }
    path.push([farWest, farNorth]);

    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    for (let i = 0; i < path.length; i++) {
      const [lon, lat] = path[i];
      const [x, y] = toXY(lon, lat);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }
}

// Create singleton instance
export const canvasRenderer = new CanvasTemperatureRenderer();
