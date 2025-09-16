// Vercel serverless function for historical NOAA temperature data
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
    const {
      lat = 32.7,
      lon = -117.2,
      size = 15,
      region = 2.0,
      date // YYYY-MM-DD format
    } = req.query;

    if (!date) {
      throw new Error('Date parameter is required (YYYY-MM-DD format)');
    }

    const centerLat = parseFloat(lat);
    const centerLon = parseFloat(lon);
    const regionSize = parseFloat(region);
    const gridSize = parseInt(size);

    // Calculate bounds
    const south = centerLat - regionSize;
    const north = centerLat + regionSize;
    const west = centerLon - regionSize;
    const east = centerLon + regionSize;

    // Parse date and format for ERDDAP
    const targetDate = new Date(date);
    const dateStr = targetDate.toISOString().split('T')[0];

    // Build ERDDAP JSON URL for historical data
    const base = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json';
    const buildUrl = (southV, northV) => (
      `${base}?analysed_sst[(${dateStr})][${southV}:${northV}][${west}:${east}]`
    );

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
      console.log('Fetching historical from NOAA:', u);
      const r = await fetchWithTimeout(u, 30000);
      lastStatus = r.status;
      if (r.ok) {
        response = r;
        break;
      }
      // Retry next variant only for 404/400 family
      if (r.status >= 500) {
        break;
      }
    }

    if (!response || !response.ok) {
      // If historical data not available, return error
      throw new Error(`Historical data not available for ${date}: ${lastStatus || 'unknown'}`);
    }

    const data = await response.json();

    // ERDDAP JSON Table Writer: table.rows = [time, lat, lon, sst]
    const rows = data?.table?.rows || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`No historical data available for ${date}`);
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
      const lo = loRaw > 180 ? (loRaw - 360) : loRaw; // normalize for output
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
      source: 'NOAA OI SST Historical',
      timestamp: new Date().toISOString(),
      data_time: dataTime || dateStr,
      requested_date: date,
      cache_info: { cached: false }
    };

    res.status(200).json(result);

  } catch (error) {
    console.error('Historical NOAA API error:', error);
    res.status(500).json({
      error: error.message || String(error),
      source: 'NOAA Historical'
    });
  }
}