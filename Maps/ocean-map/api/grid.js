// Vercel serverless function for NOAA data
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { lat = 32.7, lon = -117.2, size = 15, region = 2.0 } = req.query;
    
    // Simple NOAA ERDDAP API call for real temperature data
    const bounds = {
      north: parseFloat(lat) + parseFloat(region),
      south: parseFloat(lat) - parseFloat(region), 
      east: parseFloat(lon) + parseFloat(region),
      west: parseFloat(lon) - parseFloat(region)
    };
    
    // JPL MUR SST from NOAA ERDDAP
    const noaaUrl = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?analysed_sst[(last)][${bounds.south}:${bounds.north}][${bounds.west}:${bounds.east}]`;
    
    console.log('Fetching from NOAA:', noaaUrl);
    
    const response = await fetch(noaaUrl, {
      headers: {
        'User-Agent': 'Ocean-Temperature-Map/1.0'
      },
      timeout: 30000
    });
    
    if (!response.ok) {
      throw new Error(`NOAA API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Convert NOAA format to expected format
    const result = {
      success: true,
      source: 'NOAA RTGSST',
      bounds: bounds,
      data: {
        temperature_grid: data.table?.data || [],
        grid_size: parseInt(size),
        center: { lat: parseFloat(lat), lon: parseFloat(lon) }
      },
      timestamp: new Date().toISOString()
    };
    
    res.status(200).json(result);
    
  } catch (error) {
    console.error('NOAA API error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      source: 'NOAA RTGSST'
    });
  }
}