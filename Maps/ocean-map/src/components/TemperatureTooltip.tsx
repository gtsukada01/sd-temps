import React, { useState, useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { eventBus } from '../utils/EventBus'
import { toLonLat } from 'ol/proj'
import { cn } from '../lib/utils'

interface TooltipData {
  temperature: number | null
  coordinates: { lat: number; lon: number }
  loading: boolean
}

interface TooltipPosition {
  x: number
  y: number
  visible: boolean
}

export const TemperatureTooltip: React.FC<{ map?: any, layerManager?: any }> = ({ map, layerManager }) => {
  const [position, setPosition] = useState<TooltipPosition>({ x: 0, y: 0, visible: false })
  const [data, setData] = useState<TooltipData>({
    temperature: null,
    coordinates: { lat: 0, lon: 0 },
    loading: false
  })
  
  const tooltipRef = useRef<HTMLDivElement>(null)
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [sstLayerActive, setSstLayerActive] = useState(false)

  useEffect(() => {
    if (!map) return

    // Handle SST layer activation/deactivation
    const handleLayerActivated = (event: any) => {
      if (event.detail?.layerId === 'sst') {
        setSstLayerActive(true)
      }
    }

    const handleLayerDeactivated = (event: any) => {
      if (event.detail?.layerId === 'sst') {
        setSstLayerActive(false)
        setPosition(prev => ({ ...prev, visible: false }))
      }
    }

    eventBus.on('layer:activated', handleLayerActivated)
    eventBus.on('layer:deactivated', handleLayerDeactivated)

    // Handle map clicks
    const handleMapClick = (evt: any) => {
      if (!sstLayerActive) return

      // Get pixel coordinates for tooltip position
      const pixel = evt.pixel
      const [x, y] = pixel
      
      // Convert to lon/lat
      const coordinate = evt.coordinate
      const lonLat = toLonLat(coordinate)
      const [lon, lat] = lonLat

      // Clear any hide timeout
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }

      // Show tooltip at click position
      setPosition({ x, y, visible: true })
      setData({
        temperature: null,
        coordinates: { lat, lon },
        loading: true
      })

      // Try to get temperature from SST layer
      getTemperatureFromLayer(coordinate)

      // Auto-hide after 5 seconds
      hideTimeoutRef.current = setTimeout(() => {
        setPosition(prev => ({ ...prev, visible: false }))
      }, 5000)
    }

    const getTemperatureFromLayer = (coordinate: any) => {
      try {
        // Try to get temperature from HybridSSTLayer
        if (layerManager?.layers?.sst) {
          const sstLayer = layerManager.layers.sst
          
          if (typeof sstLayer.getTemperatureAtCoordinate === 'function') {
            const tempCelsius = sstLayer.getTemperatureAtCoordinate(coordinate)
            if (tempCelsius !== null) {
              // Convert to Fahrenheit
              const tempFahrenheit = (tempCelsius * 9/5) + 32
              setData(prev => ({
                ...prev,
                temperature: tempFahrenheit,
                loading: false
              }))
              return
            }
          }
        }

        // Fallback to feature-based approach
        const features = map.forEachFeatureAtPixel(
          map.getPixelFromCoordinate(coordinate),
          (feature: any) => feature,
          { 
            layerFilter: (layer: any) => {
              const layerName = layer.get('name') || ''
              return layerName.toLowerCase().includes('sst') || 
                     layerName.toLowerCase().includes('temperature')
            }
          }
        )

        if (features && features.get('temperature')) {
          const tempCelsius = features.get('temperature')
          // Convert Celsius to Fahrenheit
          const tempFahrenheit = (tempCelsius * 9/5) + 32
          setData(prev => ({
            ...prev,
            temperature: tempFahrenheit,
            loading: false
          }))
        } else {
          setData(prev => ({
            ...prev,
            temperature: null,
            loading: false
          }))
        }
      } catch (error) {
        console.error('Failed to get temperature:', error)
        setData(prev => ({
          ...prev,
          temperature: null,
          loading: false
        }))
      }
    }

    map.on('click', handleMapClick)

    return () => {
      map.un('click', handleMapClick)
      eventBus.off('layer:activated', handleLayerActivated)
      eventBus.off('layer:deactivated', handleLayerDeactivated)
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }
    }
  }, [map, layerManager, sstLayerActive])

  if (!position.visible) return null

  const getTemperatureColor = (temp: number) => {
    // Fahrenheit ranges for Southern California
    if (temp < 65) return 'text-blue-500' // Cold
    if (temp < 70) return 'text-cyan-500' // Cool
    if (temp < 75) return 'text-green-500' // Optimal
    if (temp < 80) return 'text-amber-500' // Warm
    return 'text-red-500' // Hot
  }

  return (
    <div
      ref={tooltipRef}
      className="absolute z-50 pointer-events-none"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transform: 'translate(-50%, -100%) translateY(-8px)'
      }}
    >
      <div className="px-2.5 py-1 rounded-md bg-neutral-900/80 text-white shadow-md border border-white/10">
        {data.loading ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm text-white/80">Loading</span>
          </div>
        ) : data.temperature !== null ? (
          <span className={cn("text-sm font-semibold tabular-nums", getTemperatureColor(data.temperature))}>
            {data.temperature.toFixed(1)}°F
          </span>
        ) : (
          <span className="text-sm text-white/70">--</span>
        )}
      </div>
    </div>
  )
}

export default TemperatureTooltip
