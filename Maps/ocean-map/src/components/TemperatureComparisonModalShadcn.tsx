import React, { useState, useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Progress } from './ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Button } from './ui/button'
import { RefreshCw } from 'lucide-react'
import { cn } from '../lib/utils'
import { BathymetryLayer } from '../layers/BathymetryLayer.js'
import { HistoricalDataService } from '../services/HistoricalDataService.js'
import { DataSourceManager } from '../services/DataSourceManager.js'
import { toLonLat, fromLonLat, transformExtent } from 'ol/proj'
import { Map, View } from 'ol'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import XYZ from 'ol/source/XYZ'
import { CONFIG } from '../config.js'
import { Feature } from 'ol'
import { Polygon } from 'ol/geom'
import { Style, Fill, Stroke } from 'ol/style'

interface TemperatureComparisonModalProps {
  isOpen: boolean
  onClose: () => void
  map?: any
}

interface ComparisonData {
  current: {
    temperature: number
    timestamp: string
  }
  historical: {
    temperature: number
    timestamp: string
  }
  difference: number
  period: string
}

const TemperatureComparisonModalShadcn: React.FC<TemperatureComparisonModalProps> = ({
  isOpen,
  onClose,
  map
}) => {
  const [selectedPeriod, setSelectedPeriod] = useState('1m')
  const [loading, setLoading] = useState(false)
  const [comparisonData, setComparisonData] = useState<ComparisonData | null>(null)
  const [error, setError] = useState<string>('')
  const [currentTempData, setCurrentTempData] = useState<any>(null)
  const [historicalTempData, setHistoricalTempData] = useState<any>(null)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  
  const currentMapRef = useRef<HTMLDivElement>(null)
  const historicalMapRef = useRef<HTMLDivElement>(null)
  const currentMapInstance = useRef<any>(null)
  const historicalMapInstance = useRef<any>(null)
  const historicalService = useRef(new HistoricalDataService())
  const dataSourceManager = useRef(new DataSourceManager())
  const isSyncing = useRef(false)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const currentTemperatureLayer = useRef<any>(null)
  const historicalTemperatureLayer = useRef<any>(null)
  const lastLoadedBounds = useRef<any>(null)
  const isInitialLoad = useRef(true)

  const periods = [
    { id: '1d', label: '1 Day', description: 'Yesterday' },
    { id: '1w', label: '1 Week', description: 'Last week' },
    { id: '1m', label: '1 Month', description: 'Last month' },
    { id: '1y', label: '1 Year', description: 'Last year' }
  ]

  useEffect(() => {
    if (isOpen) {
      // Delay initialization to ensure DOM is ready
      setTimeout(() => {
        initializeMaps()
        // Load data after maps are initialized
        setTimeout(() => {
          loadComparisonData()
        }, 500)
      }, 300)  // Increased delay for Dialog animation
    } else {
      cleanupMaps()
    }

    return () => {
      cleanupMaps()
    }
  }, [isOpen, selectedPeriod])

  const initializeMaps = () => {
    console.log('🗺️ Initializing comparison maps...', {
      currentMapRef: currentMapRef.current,
      historicalMapRef: historicalMapRef.current,
      map: map
    })
    
    if (!currentMapRef.current || !historicalMapRef.current || !map) {
      console.error('❌ Map refs not ready:', {
        currentMapRef: currentMapRef.current,
        historicalMapRef: historicalMapRef.current,
        map: map
      })
      return
    }

    // Clean up any existing maps first
    cleanupMaps()

    // Use the main map's current view if available, otherwise default to San Diego area
    let initialCenter = fromLonLat([-117.2, 32.7])  // Default San Diego area
    let initialZoom = 9  // Default zoom
    
    if (map) {
      try {
        const mainView = map.getView()
        initialCenter = mainView.getCenter()
        initialZoom = mainView.getZoom()
        console.log('📍 Using main map view - Zoom:', initialZoom, 'Center:', initialCenter)
      } catch (e) {
        console.log('⚠️ Could not get main map view, using defaults')
      }
    }

    const currentView = new View({
      center: initialCenter,
      zoom: initialZoom,
      projection: 'EPSG:3857'
    })

    const createBaseLayerFromMain = () => {
      try {
        // Try to mirror the main map's base layer
        const layers = map.getLayers().getArray()
        const mainBase: any = layers && layers.length > 0 ? layers[0] : null
        const src = mainBase?.getSource?.()
        let url = CONFIG.BASE_MAPS.SATELLITE.url
        let attribution = CONFIG.BASE_MAPS.SATELLITE.attribution
        if (src) {
          const urls = typeof src.getUrls === 'function' ? src.getUrls() : null
          const single = typeof src.getUrl === 'function' ? src.getUrl() : null
          const chosen = urls?.[0] || single
          if (chosen) {
            url = chosen
            const match = Object.values((CONFIG.BASE_MAPS as any)).find((bm: any) => bm.url === chosen)
            attribution = match?.attribution || attribution
          }
        }
        return new TileLayer({
          source: new XYZ({ url, attributions: attribution, crossOrigin: 'anonymous' }),
          zIndex: 0
        })
      } catch {
        // Fallback to Satellite
        return new TileLayer({
          source: new XYZ({ url: CONFIG.BASE_MAPS.SATELLITE.url, attributions: CONFIG.BASE_MAPS.SATELLITE.attribution, crossOrigin: 'anonymous' }),
          zIndex: 0
        })
      }
    }

    currentMapInstance.current = new Map({
      target: currentMapRef.current,
      layers: [createBaseLayerFromMain()],
      view: currentView,
      controls: []
    })

    const historicalView = new View({
      center: initialCenter,
      zoom: initialZoom,
      projection: 'EPSG:3857'
    })

    historicalMapInstance.current = new Map({
      target: historicalMapRef.current,
      layers: [createBaseLayerFromMain()],
      view: historicalView,
      controls: []
    })

    // Add the same Ocean Base bathymetry/labels used on the main map
    try {
      const currentBathymetry = new BathymetryLayer(currentMapInstance.current)
      const historicalBathymetry = new BathymetryLayer(historicalMapInstance.current)
      currentBathymetry.activate()
      historicalBathymetry.activate()
    } catch (e) {
      console.warn('Failed to add bathymetry to comparison maps:', (e as any)?.message || e)
    }

    setupMapSync()
    
    // Force a render update after initialization
    setTimeout(() => {
      currentMapInstance.current?.updateSize()
      historicalMapInstance.current?.updateSize()
    }, 100)
  }

  const setupMapSync = () => {
    if (!currentMapInstance.current || !historicalMapInstance.current) return

    const syncView = (sourceMap: any, targetMap: any) => {
      if (isSyncing.current) return
      isSyncing.current = true
      
      const sourceView = sourceMap.getView()
      const targetView = targetMap.getView()
      
      targetView.setCenter(sourceView.getCenter())
      targetView.setZoom(sourceView.getZoom())
      
      setTimeout(() => {
        isSyncing.current = false
      }, 100)
    }

    currentMapInstance.current.on('moveend', () => {
      syncView(currentMapInstance.current, historicalMapInstance.current)
      // Only refresh if user initiated the move (not from sync)
      if (!isSyncing.current) {
        handleMapViewChange()
      }
    })

    historicalMapInstance.current.on('moveend', () => {
      syncView(historicalMapInstance.current, currentMapInstance.current)
      // Only refresh if user initiated the move (not from sync)
      if (!isSyncing.current) {
        handleMapViewChange()
      }
    })
  }

  const handleMapViewChange = () => {
    // Skip if this is from initial load
    if (isInitialLoad.current) {
      return
    }
    
    // Clear any existing debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // Debounce the actual refresh to avoid excessive API calls
    debounceTimerRef.current = setTimeout(() => {
      if (!currentMapInstance.current || loading) return

      // Check if bounds have changed significantly
      const currentBounds = getCurrentMapBounds()
      if (lastLoadedBounds.current) {
        const boundsChange = Math.max(
          Math.abs(currentBounds.north - lastLoadedBounds.current.north),
          Math.abs(currentBounds.south - lastLoadedBounds.current.south),
          Math.abs(currentBounds.east - lastLoadedBounds.current.east),
          Math.abs(currentBounds.west - lastLoadedBounds.current.west)
        )
        
        // Only reload if bounds changed by more than 10% of the view
        const threshold = Math.max(currentBounds.north - currentBounds.south, currentBounds.east - currentBounds.west) * 0.1
        if (boundsChange < threshold) {
          console.log('📍 View change too small, skipping reload')
          return
        }
      }

      const zoom = currentMapInstance.current.getView().getZoom()
      
      // Dynamic grid size based on zoom level
      // Adjust grid size to get more coverage when zoomed out
      let gridSize = 10 // Default for far zoom
      if (zoom >= 12) {
        gridSize = 40  // Very close zoom - high detail (reduced from 80)
      } else if (zoom >= 10) {
        gridSize = 30  // Close zoom (reduced from 60)
      } else if (zoom >= 8) {
        gridSize = 20  // Medium zoom (reduced from 40)
      } else if (zoom >= 6) {
        gridSize = 15  // Far zoom (reduced from 25)
      } else if (zoom >= 4) {
        gridSize = 10  // Very far zoom
      } else {
        gridSize = 8   // Extreme zoom out
      }

      console.log(`🔄 Refreshing temperature data - Zoom: ${zoom?.toFixed(1)}, Grid size: ${gridSize}`)
      
      // Store the bounds we're loading
      lastLoadedBounds.current = currentBounds
      
      // Reload data with new bounds and resolution
      // Don't clear layers first to avoid flicker
      loadComparisonData(gridSize)
    }, 1200) // Wait 1.2 seconds after user stops moving the map
  }

  const clearTemperatureLayers = () => {
    // Remove current temperature layer
    if (currentTemperatureLayer.current && currentMapInstance.current) {
      currentMapInstance.current.removeLayer(currentTemperatureLayer.current)
      currentTemperatureLayer.current = null
    }
    
    // Remove historical temperature layer
    if (historicalTemperatureLayer.current && historicalMapInstance.current) {
      historicalMapInstance.current.removeLayer(historicalTemperatureLayer.current)
      historicalTemperatureLayer.current = null
    }
  }

  const cleanupMaps = () => {
    if (currentMapInstance.current) {
      currentMapInstance.current.setTarget(undefined)
      currentMapInstance.current.dispose()
      currentMapInstance.current = null
    }
    if (historicalMapInstance.current) {
      historicalMapInstance.current.setTarget(undefined)
      historicalMapInstance.current.dispose()
      historicalMapInstance.current = null
    }
  }

  const loadComparisonData = async (customGridSize?: number, forceRefresh = false) => {
    if (forceRefresh) {
      console.log('🔄 Manual refresh triggered - reloading temperature data')
      setIsRefreshing(true)
      // Clear the last loaded bounds to force a reload
      lastLoadedBounds.current = null
    } else {
      setLoading(true)
    }
    setLoadingProgress(0)
    setError('')
    
    // Mark that initial load is complete after first successful load
    if (isInitialLoad.current) {
      setTimeout(() => {
        isInitialLoad.current = false
      }, 2000)
    }

    try {
      setLoadingProgress(25)
      
      const historicalDate = historicalService.current.calculateHistoricalDate(selectedPeriod)
      
      if (!historicalService.current.isDataAvailable(historicalDate)) {
        console.warn(`Historical data not available for ${historicalDate}, using mock data for demo`)
      }

      setLoadingProgress(50)
      
      const bounds = getCurrentMapBounds()
      
      // Fixed grid size for consistency with main SST layer
      const gridSize = customGridSize || 100
      
      console.log(`🌡️ Loading temperature data - Bounds: ${bounds.north.toFixed(2)}N to ${bounds.south.toFixed(2)}S, Grid size: ${gridSize}`)
      
      // Load current temperature data
      const currentData = await dataSourceManager.current.getTemperatureData(bounds, {
        gridSize,
        preferredFormat: 'vector_grid',
        region: bounds.region
      })
      
      console.log('📊 Current temperature data loaded:', currentData)
      
      setLoadingProgress(75)
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000))
      
      // Load historical temperature data with the same grid size
      const historicalData = await dataSourceManager.current.getHistoricalTemperatureData(
        bounds, 
        historicalDate,
        { gridSize }
      )
      
      console.log('📈 Historical temperature data loaded:', historicalData)
      
      setLoadingProgress(100)
      
      setCurrentTempData(currentData)
      setHistoricalTempData(historicalData)
      
      // Store the bounds we loaded
      lastLoadedBounds.current = bounds
      
      // Wait for maps to be ready before adding data
      setTimeout(() => {
        updateMapsWithData(currentData, historicalData)
      }, 200)
      
      // Extract the actual grid data from nested structure - NOAA returns data.grid_data
      const currentGrid = currentData?.data || currentData
      const historicalGrid = historicalData?.data || historicalData
      
      const avgCurrent = calculateAverageTemp(currentGrid)
      const avgHistorical = calculateAverageTemp(historicalGrid)
      
      setComparisonData({
        current: {
          temperature: avgCurrent,
          timestamp: new Date().toISOString()
        },
        historical: {
          temperature: avgHistorical,
          timestamp: historicalDate
        },
        difference: avgCurrent - avgHistorical,
        period: selectedPeriod
      })
    } catch (err: any) {
      console.error('❌ Failed to load comparison data:', err)
      setError(err.message || 'Failed to load comparison data')
    } finally {
      setLoading(false)
      setIsRefreshing(false)
      setLoadingProgress(0)
    }
  }

  const getCurrentMapBounds = () => {
    // Use the comparison modal's current map view instead of the main map
    // This gives us the focused area we're actually looking at
    if (!currentMapInstance.current) {
      // Default to San Diego area with reasonable bounds
      return { 
        north: 33.5, 
        south: 32.0, 
        east: -116.5, 
        west: -118.0, 
        center: { lat: 32.7, lon: -117.2 }, 
        region: 1.5 
      }
    }
    
    const view = currentMapInstance.current.getView()
    const extent = view.calculateExtent()
    const [west, south, east, north] = transformExtent(
      extent,
      view.getProjection(),
      'EPSG:4326'
    )
    
    // Validate bounds are reasonable (not global extent)
    const boundsWidth = Math.abs(east - west)
    const boundsHeight = Math.abs(north - south)
    
    // Allow larger bounds for zoomed out views but not global
    if (boundsWidth > 50 || boundsHeight > 50) {
      console.warn('⚠️ Bounds too large (global), limiting to region:', { north, south, east, west })
      // Limit to a reasonable maximum area around current center
      const center = { lat: (north + south) / 2, lon: (east + west) / 2 }
      return { 
        north: Math.min(center.lat + 10, 40), 
        south: Math.max(center.lat - 10, 20), 
        east: Math.min(center.lon + 10, -110), 
        west: Math.max(center.lon - 10, -125), 
        center: center, 
        region: 20 
      }
    }
    
    console.log('📐 Current bounds:', { north: north.toFixed(2), south: south.toFixed(2), east: east.toFixed(2), west: west.toFixed(2) })
    
    return {
      north, south, east, west,
      center: { lat: (north + south) / 2, lon: (east + west) / 2 },
      region: Math.max(north - south, east - west)
    }
  }

  const calculateAverageTemp = (data: any): number => {
    // Check for grid_data (NOAA API) or grid property
    const grid = data?.grid_data || data?.grid || data?.data
    
    console.log('📊 calculateAverageTemp - input data structure:', {
      hasGridData: !!data?.grid_data,
      hasGrid: !!data?.grid,
      hasData: !!data?.data,
      dataKeys: data ? Object.keys(data) : [],
      gridType: Array.isArray(grid) ? 'array' : typeof grid,
      gridLength: Array.isArray(grid) ? grid.length : 0
    })
    
    if (!grid || !Array.isArray(grid)) return 0
    
    let sum = 0
    let count = 0
    
    grid.forEach((row: any[]) => {
      if (Array.isArray(row)) {
        row.forEach((item: any) => {
          // Handle both object format {lat, lon, temp} and direct number format
          const temp = typeof item === 'object' && item !== null ? item.temp : item
          if (temp !== null && temp !== undefined && !isNaN(temp)) {
            sum += temp
            count++
          }
        })
      }
    })
    
    const average = count > 0 ? sum / count : 0
    console.log(`📊 Average temperature calculated: ${average.toFixed(1)}°C (${count} valid points)`)
    
    // Convert from Celsius to Fahrenheit
    const averageFahrenheit = (average * 9/5) + 32
    console.log(`📊 Average temperature in Fahrenheit: ${averageFahrenheit.toFixed(1)}°F`)
    return averageFahrenheit
  }

  const updateMapsWithData = (currentData: any, historicalData: any) => {
    if (!currentMapInstance.current || !historicalMapInstance.current) {
      console.error('❌ Maps not initialized yet')
      return
    }
    
    console.log('🗺️ Updating maps with temperature data', {
      currentData,
      historicalData
    })
    
    // The data structure is {data: {grid, bounds, source}, source: ..., metadata: ...}
    // We need to pass the nested data object which contains grid and bounds
    const currentGrid = currentData?.data?.data || currentData?.data || currentData
    const historicalGrid = historicalData?.data?.data || historicalData?.data || historicalData
    
    console.log('📊 Grid data extracted:', {
      currentGrid,
      historicalGrid,
      currentDataStructure: {
        hasData: !!currentData?.data,
        hasGrid: !!currentData?.data?.grid,
        hasDataData: !!currentData?.data?.data,
        actualKeys: currentData?.data ? Object.keys(currentData.data) : []
      },
      historicalDataStructure: {
        hasData: !!historicalData?.data,
        hasGrid: !!historicalData?.data?.grid,
        hasDataData: !!historicalData?.data?.data,
        actualKeys: historicalData?.data ? Object.keys(historicalData.data) : []
      }
    })
    
    addTemperatureLayer(currentMapInstance.current, currentGrid, 'current')
    addTemperatureLayer(historicalMapInstance.current, historicalGrid, 'historical')
    
    // Force map refresh
    currentMapInstance.current.renderSync()
    historicalMapInstance.current.renderSync()
  }

  const addTemperatureLayer = (map: any, data: any, type: string) => {
    if (!map) {
      console.error('❌ Map not initialized for', type)
      return
    }
    
    // Check for grid_data (NOAA API) or grid property, otherwise assume data itself is the grid
    const grid = data?.grid_data || data?.grid || data?.data || (Array.isArray(data) ? data : null)
    const bounds = data?.bounds || data?.metadata?.bounds || getCurrentMapBounds()
    
    if (!grid || !Array.isArray(grid) || grid.length === 0) {
      console.error('❌ No valid temperature grid for', type, { data, grid })
      return
    }

    console.log(`🎨 Creating temperature layer for ${type}:`, {
      gridSize: grid.length,
      gridFirstRow: grid[0]?.length,
      bounds: bounds,
      firstDataPoint: grid[0]?.[0],  // Log the structure of the first data point
      dataType: typeof grid[0]?.[0]
    })

    const vectorSource = new VectorSource()

    // Calculate nominal cell dimensions from returned bounds
    const numRows = grid.length
    const numCols = grid[0].length
    const nominalCellWidth = (bounds.east - bounds.west) / numCols
    const nominalCellHeight = (bounds.north - bounds.south) / numRows

    // Derive per-row and per-column steps from actual data coordinates to reduce seams
    const rowLonStep: number[] = new Array(numRows).fill(nominalCellWidth)
    const colLatStep: number[] = new Array(numCols).fill(nominalCellHeight)

    // Collect diffs where lat/lon present, then average
    for (let r = 0; r < numRows; r++) {
      const diffs: number[] = []
      for (let c = 0; c < numCols - 1; c++) {
        const a = grid[r][c]
        const b = grid[r][c + 1]
        if (a && b && typeof a === 'object' && typeof b === 'object' && a.lon != null && b.lon != null) {
          const d = Math.abs(b.lon - a.lon)
          if (d > 0) diffs.push(d)
        }
      }
      if (diffs.length) {
        rowLonStep[r] = diffs.reduce((s, v) => s + v, 0) / diffs.length
      }
    }
    for (let c = 0; c < numCols; c++) {
      const diffs: number[] = []
      for (let r = 0; r < numRows - 1; r++) {
        const a = grid[r][c]
        const b = grid[r + 1][c]
        if (a && b && typeof a === 'object' && typeof b === 'object' && a.lat != null && b.lat != null) {
          const d = Math.abs(a.lat - b.lat) // rows increase southward typically
          if (d > 0) diffs.push(d)
        }
      }
      if (diffs.length) {
        colLatStep[c] = diffs.reduce((s, v) => s + v, 0) / diffs.length
      }
    }

    // Slightly inflate tiles to overlap by ~3% to avoid antialias seams
    // Slightly more overlap to remove any seams between tiles at high zoom
    const inflate = 1.08
    
    // Create tiles for ALL grid positions, even null values
    grid.forEach((row: any[], rowIndex: number) => {
      row.forEach((item: any, colIndex: number) => {
        // Handle both object format {lat, lon, temp} and direct number format
        let temp, lat, lon
        
        if (typeof item === 'object' && item !== null) {
          // Object format from NOAA API - use the ACTUAL provided coordinates
          temp = item.temp
          lat = item.lat  // Use actual latitude from data
          lon = item.lon  // Use actual longitude from data
          
          // If coordinates are missing, skip this point
          if (!lat || !lon) {
            return
          }
        } else if (typeof item === 'number') {
          // Simple number format - calculate position from grid
          temp = item
          lon = bounds.west + (colIndex * nominalCellWidth) + (nominalCellWidth / 2)
          lat = bounds.north - (rowIndex * nominalCellHeight) - (nominalCellHeight / 2)
        } else {
          // Null or invalid data - skip
          return
        }
        
        // Only create visible tiles for non-null temperatures (ocean data)
        if (temp !== null && temp !== undefined && !isNaN(temp)) {
          // Determine local half sizes
          const localWidth = (typeof item === 'object' && item !== null)
            ? (rowLonStep[rowIndex] || nominalCellWidth)
            : nominalCellWidth
          const localHeight = (typeof item === 'object' && item !== null)
            ? (colLatStep[colIndex] || nominalCellHeight)
            : nominalCellHeight

          const halfW = (localWidth / 2) * inflate
          const halfH = (localHeight / 2) * inflate

          const feature = new Feature({
            geometry: new Polygon([[
              fromLonLat([lon - halfW, lat + halfH]),
              fromLonLat([lon + halfW, lat + halfH]),
              fromLonLat([lon + halfW, lat - halfH]),
              fromLonLat([lon - halfW, lat - halfH]),
              fromLonLat([lon - halfW, lat + halfH])
            ]]),
            temperature: temp,
            type: type,
            row: rowIndex,
            col: colIndex
          })
          
          feature.setStyle(new Style({
            fill: new Fill({
              color: getTemperatureColor(temp)
            })
            // Removed stroke to make tiles appear more continuous
          }))
          
          vectorSource.addFeature(feature)
        }
      })
    })
    
    // Remove any existing temperature layers more carefully to avoid flicker
    const existingLayers = map.getLayers().getArray().filter((layer: any) => layer.get('temperature'))
    
    // Only remove after adding new layer to minimize flicker
    const removeOldLayers = () => {
      existingLayers.forEach((layer: any) => {
        map.removeLayer(layer)
      })
    }
    
    const vectorLayer = new VectorLayer({
      source: vectorSource,
      opacity: 1.0,            // Full opacity to avoid base map showing through
      zIndex: 20               // Ensure it renders above bathymetry/base layers
    })
    
    vectorLayer.set('temperature', true)
    vectorLayer.set('type', type)
    
    map.addLayer(vectorLayer)
    
    // Remove old layers after new one is added to avoid flicker
    removeOldLayers()
    
    // Store layer reference for later cleanup
    if (type === 'current') {
      currentTemperatureLayer.current = vectorLayer
    } else if (type === 'historical') {
      historicalTemperatureLayer.current = vectorLayer
    }
    
    console.log(`✅ Added ${vectorSource.getFeatures().length} temperature features to ${type} map`)
  }

  const getTemperatureColor = (temp: number): string => {
    // Temperature in Celsius
    const minTemp = 16
    const maxTemp = 24
    const normalized = Math.max(0, Math.min(1, (temp - minTemp) / (maxTemp - minTemp)))
    
    if (normalized < 0.25) {
      // Cool waters: Blue (16-18°C)
      const intensity = normalized * 4
      const r = Math.floor(50 + intensity * 100)
      const g = Math.floor(150 + intensity * 105)
      const b = 255
      return `rgba(${r}, ${g}, ${b}, 1.0)`
    } else if (normalized < 0.5) {
      // Moderate: Cyan to Green (18-20°C)
      const localNorm = (normalized - 0.25) * 4
      const r = Math.floor(150 - localNorm * 150)
      const g = Math.floor(255 - localNorm * 50)
      const b = Math.floor(255 - localNorm * 155)
      return `rgba(${r}, ${g}, ${b}, 1.0)`
    } else if (normalized < 0.75) {
      // Warm: Green to Yellow (20-22°C)
      const localNorm = (normalized - 0.5) * 4
      const r = Math.floor(0 + localNorm * 255)
      const g = Math.floor(205 + localNorm * 50)
      const b = Math.floor(100 - localNorm * 100)
      return `rgba(${r}, ${g}, ${b}, 1.0)`
    } else {
      // Hot: Orange to Red (22-24°C)
      const localNorm = (normalized - 0.75) * 4
      const r = 255
      const g = Math.floor(255 - localNorm * 100)
      const b = 0
      return `rgba(${r}, ${g}, ${b}, 1.0)`
    }
  }


  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] w-full h-[95vh] p-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
          <DialogTitle className="text-xl font-semibold">
            Temperature Analysis
          </DialogTitle>
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-2">
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {periods.map(period => (
                    <SelectItem key={period.id} value={period.id}>
                      {period.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="px-2"
                onClick={() => {
                  // Force refresh with fixed 100x100 grid
                  loadComparisonData(100, true)
                }}
                disabled={isRefreshing || loading}
              >
                <RefreshCw className={cn("h-4 w-4", (isRefreshing || loading) && "animate-spin")} />
              </Button>
            </div>
            
            {comparisonData && (
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">Current</div>
                  <div className="text-lg font-semibold">{comparisonData.current.temperature.toFixed(1)}°F</div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">{periods.find(p => p.id === selectedPeriod)?.label}</div>
                  <div className="text-lg font-semibold">{comparisonData.historical.temperature.toFixed(1)}°F</div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">Difference</div>
                  <div className={cn("text-lg font-semibold", 
                    comparisonData.difference > 0 ? "text-orange-600" : 
                    comparisonData.difference < 0 ? "text-blue-600" : "text-muted-foreground"
                  )}>
                    {comparisonData.difference > 0 ? '+' : ''}{comparisonData.difference.toFixed(1)}°F
                  </div>
                </div>
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 grid grid-cols-2 gap-px bg-border overflow-hidden">
          <div className="relative h-full">
            <div ref={currentMapRef} className="absolute inset-0" />
            <div className="absolute top-3 right-3 z-10">
              <div className="bg-background/90 backdrop-blur-sm border rounded-md px-2 py-1">
                <span className="text-sm font-medium">Current</span>
              </div>
            </div>
          </div>

          <div className="relative h-full">
            <div ref={historicalMapRef} className="absolute inset-0" />
            <div className="absolute top-3 right-3 z-10">
              <div className="bg-background/90 backdrop-blur-sm border rounded-md px-2 py-1">
                <span className="text-sm font-medium">
                  {periods.find(p => p.id === selectedPeriod)?.label} Ago
                </span>
              </div>
            </div>
          </div>
        </div>

        {(loading || error) && (
          <div className="px-6 py-3 border-t bg-muted/30 flex-shrink-0">
            {loading && (
              <div className="flex items-center gap-2">
                <Progress value={loadingProgress} className="flex-1 h-2" />
                <span className="text-sm text-muted-foreground">Loading...</span>
              </div>
            )}
            {error && (
              <div className="text-sm text-destructive">{error}</div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default TemperatureComparisonModalShadcn
