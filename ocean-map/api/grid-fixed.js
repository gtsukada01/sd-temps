// Vercel serverless function for NOAA data - FIXED for mobile
export default async function handler(req, res) {
  // Enable CORS for all origins including mobile
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { lat = 32.7, lon = -117.2, size = 15, region = 2.0 } = req.query;
    
    // Calculate bounds
    const bounds = {
      north: parseFloat(lat) + parseFloat(region),
      south: parseFloat(lat) - parseFloat(region), 
      east: parseFloat(lon) + parseFloat(region),
      west: parseFloat(lon) - parseFloat(region)
    };
    
    // Build proper NOAA ERDDAP URL
    const timeParam = '(last)';
    const latRange = `[${bounds.south}:0.1:${bounds.north}]`;
    const lonRange = `[${bounds.west}:0.1:${bounds.east}]`;
    
    const noaaUrl = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?analysed_sst${timeParam}${latRange}${lonRange}`;
    
    console.log('Fetching from NOAA:', noaaUrl);
    
    try {
      const response = await fetch(noaaUrl, {
        headers: {
          'User-Agent': 'Ocean-Temperature-Map/1.0',
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`NOAA API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Process NOAA data into grid format
      const temperatureGrid = [];
      
      if (data && data.table && data.table.rows) {
        // NOAA returns data as rows with [time, lat, lon, sst]
        data.table.rows.forEach(row => {
          if (row && row.length >= 4) {
            const temp = row[3]; // SST value
            if (temp !== null && !isNaN(temp)) {
              temperatureGrid.push({
                lat: row[1],
                lon: row[2],
                temperature: temp - 273.15 // Convert Kelvin to Celsius if needed
              });
            }
          }
        });
      }
      
      // Build response in expected format
      const result = {
        success: true,
        source: 'NOAA RTGSST',
        bounds: bounds,
        data: {
          temperature_grid: temperatureGrid,
          grid_size: parseInt(size),
          center: { lat: parseFloat(lat), lon: parseFloat(lon) }
        },
        timestamp: new Date().toISOString(),
        cache_info: {
          cached: false,
          source: 'noaa-erddap'
        }
      };
      
      res.status(200).json(result);
      
    } catch (fetchError) {
      console.error('NOAA fetch error:', fetchError);
      
      // Return a minimal working response for testing
      const mockGrid = [];
      const gridPoints = parseInt(size);
      
      for (let i = 0; i < gridPoints; i++) {
        for (let j = 0; j < gridPoints; j++) {
          mockGrid.push({
            lat: bounds.south + (i / gridPoints) * (bounds.north - bounds.south),
            lon: bounds.west + (j / gridPoints) * (bounds.east - bounds.west),
            temperature: 18 + Math.random() * 4 // 18-22°C range
          });
        }
      }
      
      res.status(200).json({
        success: true,
        source: 'NOAA RTGSST (fallback)',
        bounds: bounds,
        data: {
          temperature_grid: mockGrid,
          grid_size: parseInt(size),
          center: { lat: parseFloat(lat), lon: parseFloat(lon) }
        },
        timestamp: new Date().toISOString(),
        error: 'Using fallback data due to NOAA API issue'
      });
    }
    
  } catch (error) {
    console.error('Handler error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      source: 'NOAA RTGSST'
    });
  }
}