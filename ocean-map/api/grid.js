// Vercel serverless function for NOAA data (minimal, correct)
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { lat = 32.7, lon = -117.2, size = 15, region = 2.0 } = req.query;

    const centerLat = Number.parseFloat(lat);
    const centerLon = Number.parseFloat(lon);
    const regionSize = Number.parseFloat(region);
    const gridSize = Number.isFinite(Number.parseInt(size)) ? Number.parseInt(size) : 40;

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    // Clamp region to stay within dataset bounds and avoid zero-span requests
    const south = clamp(centerLat - regionSize, -89.5, 89.5);
    const north = clamp(centerLat + regionSize, -89.5, 89.5);
    const westRaw = centerLon - regionSize;
    const eastRaw = centerLon + regionSize;

    const west = clamp(Math.min(westRaw, eastRaw), -179.5, 179.5);
    const east = clamp(Math.max(westRaw, eastRaw), -179.5, 179.5);

    const latSpan = Math.max(Math.abs(north - south), 0.1);
    const lonSpan = Math.max(Math.abs(east - west), 0.1);

    // Dataset native resolution is ~0.01°; compute stride so we do not fetch excessive points
    const datasetResolution = 0.01;
    const targetSamples = Math.min(Math.max(Number.isFinite(gridSize) ? gridSize : 100, 20), 200);
    const computeStride = (span) => {
      if (!Number.isFinite(span) || span <= 0) return 1;
      const approxStep = span / Math.max(targetSamples - 1, 1);
      return Math.max(1, Math.round(approxStep / datasetResolution));
    };

    const latStride = computeStride(latSpan);
    const lonStride = computeStride(lonSpan);

    // Build ERDDAP JSON URL (try normal then reversed latitude order)
    const base = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json';
    const buildUrl = (latA, latB) => {
      const southV = Math.min(latA, latB);
      const northV = Math.max(latA, latB);
      return (
        `${base}?analysed_sst[(last)][(${southV.toFixed(4)}):${latStride}:(${northV.toFixed(4)})][(${west.toFixed(4)}):${lonStride}:(${east.toFixed(4)})]`
      );
    };

    const urls = [
      buildUrl(south, north),
      buildUrl(north, south) // fallback for ERDDAP latitude order quirks
    ];

    // Helper: fetch with timeout
    async function fetchWithTimeout(url, ms = 30000) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), ms);
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Ocean-Temperature-Map/1.0',
            'Accept': 'application/json'
          },
          signal: controller.signal
        });
        return response;
      } finally {
        clearTimeout(t);
      }
    }

    let response = null;
    let lastStatus = null;
    for (const u of urls) {
      console.log('Fetching from NOAA:', u);
      const r = await fetchWithTimeout(u, 30000);
      lastStatus = r.status;
      if (r.ok) {
        response = r;
        break;
      }
      // Retry next variant only for 404/400 family; otherwise fail fast on server errors
      if (r.status >= 500) {
        break;
      }
    }

    if (!response || !response.ok) {
      throw new Error(`NOAA API error: ${lastStatus || 'unknown'}`);
    }

    const data = await response.json();

    // ERDDAP JSON Table Writer: table.rows = [time, lat, lon, sst]
    const rows = data?.table?.rows || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('No NOAA data rows returned');
    }

    // Build 2D grid_data to match frontend expectations
    const lats = Array.from(new Set(rows.map(r => parseFloat(r[1])))).sort((a, b) => a - b);
    const lons = Array.from(new Set(rows.map(r => parseFloat(r[2])))).sort((a, b) => a - b);
    const tempMap = new Map(); // key `${lat}|${lon}` -> temp
    let dataTime = null;
    for (const r of rows) {
      const t = r[0];
      if (!dataTime) dataTime = t;
      let v = r[3];
      if (v === null || Number.isNaN(v)) continue;
      // Convert Kelvin only if clearly Kelvin
      if (typeof v === 'number' && v > 100) v = v - 273.15;
      if (typeof v !== 'number') continue;
      // Sanity range
      if (v < -5 || v > 40) continue;
      const la = parseFloat(r[1]);
      const loRaw = parseFloat(r[2]);
      const lo = loRaw > 180 ? (loRaw - 360) : loRaw; // normalize for output only
      tempMap.set(`${la}|${lo}`, Number.parseFloat(v.toFixed(1)));
    }

    const grid_data = lats.map(la => (
      lons.map(loRaw => {
        const lo = loRaw > 180 ? (loRaw - 360) : loRaw;
        const key = `${la}|${lo}`;
        const temp = tempMap.has(key) ? tempMap.get(key) : null;
        return { lat: Number.parseFloat(la.toFixed(3)), lon: Number.parseFloat(lo.toFixed(3)), temp };
      })
    ));

    const result = {
      center_latitude: centerLat,
      center_longitude: centerLon,
      grid_size: grid_data.length,
      region_size_degrees: regionSize,
      grid_data,
      source: 'NOAA RTGSST',
      timestamp: new Date().toISOString(),
      data_time: dataTime || null,
      cache_info: { cached: false }
    };

    res.status(200).json(result);

  } catch (error) {
    console.error('NOAA API error:', error);
    res.status(500).json({
      error: error.message || String(error),
      source: 'NOAA RTGSST'
    });
  }
}
