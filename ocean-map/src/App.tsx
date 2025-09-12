import React, { useEffect, useRef, useState } from 'react'
import { MapManager } from './MapManager.js'
import { LayerManager } from './layers/LayerManager.js'
import { TemperatureReadout } from './controls/TemperatureReadout.js'
import { eventBus } from './utils/EventBus.js'
import LayerControlsPremium from './components/LayerControlsPremium'
import TemperatureTooltip from './components/TemperatureTooltip'

function App() {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapManagerRef = useRef<MapManager | null>(null)
  const layerManagerRef = useRef<LayerManager | null>(null)
  const temperatureReadoutRef = useRef<any>(null)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (!mapRef.current) return

    // Set a small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      try {
        // Initialize map
        mapManagerRef.current = new MapManager('map')
        layerManagerRef.current = new LayerManager(mapManagerRef.current)
        
        // Create legacy UI controls (non-React components)
        temperatureReadoutRef.current = new TemperatureReadout(mapManagerRef.current.getMap(), layerManagerRef.current)
        
        // Mark as initialized to show React components
        setInitialized(true)
        
        // Log ready state
        console.log('Ocean Map initialized')
        
        // Show instructions
        eventBus.emit('app:ready', {
          message: 'Double-click to add fishing spots. Click layers to toggle.'
        })
      } catch (error) {
        console.error('Failed to initialize map:', error)
      }
    }, 100)

    // Cleanup
    return () => {
      if (timer) clearTimeout(timer)
      if (temperatureReadoutRef.current) {
        temperatureReadoutRef.current = null
      }
    }
  }, [])

  return (
    <div className="relative w-full h-screen">
      <div 
        ref={mapRef} 
        id="map" 
        className="w-full h-full"
      />
      
      {/* Always show LayerControls - it will handle its own loading states */}
      <LayerControlsPremium 
        map={mapManagerRef.current?.getMap()}
        layerManager={layerManagerRef.current}
      />
      
      {/* Floating SST legend removed (consolidated into SST panel) */}
      
      {/* Temperature Tooltip on Click */}
      <TemperatureTooltip 
        map={mapManagerRef.current?.getMap()}
        layerManager={layerManagerRef.current}
      />
    </div>
  )
}

export default App
