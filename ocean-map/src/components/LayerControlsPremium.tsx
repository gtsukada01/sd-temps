import React, { useState, useEffect, useCallback } from 'react'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Progress } from './ui/progress'
import { Switch } from './ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { eventBus } from '../utils/EventBus.js'
import TemperatureComparisonModalShadcn from './TemperatureComparisonModalShadcn'
import { CONFIG } from '../config.js'
import TemperatureScaleCanvas from './TemperatureScaleCanvas'
import { 
  Thermometer, 
  TrendingUp, 
  Anchor, 
  Loader2, 
  RefreshCw,
  Waves,
  Activity,
  MapPin,
  Zap,
  Clock,
  Info,
  Eye,
  EyeOff,
  Satellite,
  ChevronDown,
  ChevronUp
} from 'lucide-react'

interface LayerControlsProps {
  map?: any
  layerManager?: any
}

interface LayerMetadata {
  status: 'active' | 'inactive' | 'loading' | 'error'
  dataSource?: string
  lastUpdate?: string
  coverage?: string
  dataPoints?: number
  quality?: 'excellent' | 'good' | 'fair' | 'poor'
  freshness?: string
}

interface LayerConfig {
  id: string
  name: string
  description: string
  icon: React.ComponentType<any>
  category: 'Environmental' | 'Navigation' | 'Analysis'
  metadata: LayerMetadata
  color: string
}

interface LayerState {
  [key: string]: boolean
}

interface OpacityState {
  [key: string]: number
}

const LayerControlsPremium: React.FC<LayerControlsProps> = ({ map, layerManager }) => {
  const [layers, setLayers] = useState<LayerState>({
    sst: false,
    fishingSpots: false
  })
  
  const isStyledTiles = !!(CONFIG.FEATURES?.USE_VALUE_TILE_RENDERER && CONFIG.FEATURES?.VALUE_TILE_MODE === 'styled')
  const showScaleInPanel = !!CONFIG.FEATURES?.SST_SCALE_IN_PANEL

  const [opacity, setOpacity] = useState<OpacityState>({
    sst: isStyledTiles ? 100 : 30,
    fishingSpots: 90
  })
  
  const [notification, setNotification] = useState<string>('')
  const [loadingLayers, setLoadingLayers] = useState<{[key:string]: boolean}>({})
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [expandedLayers, setExpandedLayers] = useState<{[key: string]: boolean}>({
    sst: false,
    fishingSpots: false
  })
  const [layerMetadata, setLayerMetadata] = useState<{[key: string]: LayerMetadata}>({
    sst: {
      status: 'inactive',
      dataSource: 'NOAA RTGSST',
      lastUpdate: '--',
      coverage: 'Southern California',
      dataPoints: 0,
      quality: 'excellent',
      freshness: '--'
    },
    fishingSpots: {
      status: 'inactive',
      dataSource: 'Local Storage',
      lastUpdate: '--',
      coverage: 'User Defined',
      dataPoints: 0,
      quality: 'excellent',
      freshness: 'Real-time'
    }
  })

  // Layer configurations with professional metadata
  const layerConfigs: LayerConfig[] = [
    {
      id: 'sst',
      name: 'Sea Surface Temperature',
      description: 'Real-time ocean temperature data',
      icon: Thermometer,
      category: 'Environmental',
      color: 'from-blue-500 to-orange-500',
      metadata: layerMetadata.sst
    },
    {
      id: 'fishingSpots',
      name: 'Fishing Spots',
      description: 'Personal fishing locations',
      icon: Anchor,
      category: 'Navigation',
      color: 'from-teal-500 to-blue-500',
      metadata: layerMetadata.fishingSpots
    }
  ]

  // Event listener for layer updates
  const handleLayerEvent = useCallback((event: any) => {
    if (!layerManager) return
    const activeLayers = layerManager.getActiveLayers()
    setLayers(prev => {
      const newState = { ...prev }
      layerConfigs.forEach(config => {
        newState[config.id] = activeLayers.includes(config.id)
      })
      return newState
    })
  }, [layerManager])

  const showNotification = useCallback((message: string, duration = 3000) => {
    setNotification(message)
    setTimeout(() => setNotification(''), duration)
  }, [])

  useEffect(() => {
    // Enhanced metadata tracking
    const updateMetadata = (layerId: string, updates: Partial<LayerMetadata>) => {
      setLayerMetadata(prev => ({
        ...prev,
        [layerId]: { ...prev[layerId], ...updates }
      }))
    }

    // SST data loaded event handler
    const onSstDataLoaded = (e: any) => {
      const gridSize = e.detail?.gridSize || 0
      const dataPoints = gridSize ? gridSize * gridSize : 0
      updateMetadata('sst', {
        status: 'active',
        dataSource: e.detail.source || 'NOAA RTGSST',
        lastUpdate: new Date().toLocaleTimeString(),
        dataPoints: dataPoints,
        quality: dataPoints > 5000 ? 'excellent' : dataPoints > 1000 ? 'good' : 'fair',
        freshness: e.detail.age || '0h old'
      })
    }

    // Fishing spots update handler
    const onFishingSpotsUpdate = () => {
      const spots = JSON.parse(localStorage.getItem('fishingSpots') || '[]')
      updateMetadata('fishingSpots', {
        status: layers.fishingSpots ? 'active' : 'inactive',
        dataPoints: spots.length,
        lastUpdate: new Date().toLocaleTimeString()
      })
    }

    const toCanonicalId = (raw?: string) => {
      if (!raw) return ''
      const s = String(raw)
      const match = layerConfigs.find(cfg => cfg.id.toLowerCase() === s.toLowerCase())
      if (match) return match.id
      if (s.replace(/\s+/g, '').toLowerCase() === 'fishingspots') return 'fishingSpots'
      return s
    }

    // Setup event listeners
    eventBus.on('layer:swapped', (e: any) => {
      showNotification(e.detail.message, 3000)
      handleLayerEvent(e)
    })

    eventBus.on('layer:activated', (e: any) => {
      handleLayerEvent(e)
      const id = toCanonicalId(e?.detail?.layerId || e?.detail?.layer)
      if (id) updateMetadata(id, { status: 'active' })
    })
    
    eventBus.on('layer:deactivated', (e: any) => {
      handleLayerEvent(e)
      const id = toCanonicalId(e?.detail?.layerId || e?.detail?.layer)
      if (id) updateMetadata(id, { status: 'inactive' })
    })
    
    // Loading states
    const onLoading = (e: any) => {
      const id = toCanonicalId(e?.detail?.layerId || e?.detail?.layer)
      if (!id) return
      setLoadingLayers(prev => ({ ...prev, [id]: true }))
      updateMetadata(id, { status: 'loading' })
    }
    
    const onLoaded = (e: any) => {
      const id = toCanonicalId(e?.detail?.layerId || e?.detail?.layer)
      if (!id) return
      setLoadingLayers(prev => ({ ...prev, [id]: false }))
      updateMetadata(id, { status: 'active' })
    }
    
    const onError = (e: any) => {
      const id = toCanonicalId(e?.detail?.layerId || e?.detail?.layer)
      if (!id) return
      setLoadingLayers(prev => ({ ...prev, [id]: false }))
      updateMetadata(id, { status: 'error' })
      showNotification(`${id} error: ${e?.detail?.error || 'Load failed'}`, 4000)
    }

    eventBus.on('layer:loading', onLoading)
    eventBus.on('layer:loaded', onLoaded)
    eventBus.on('layer:error', onError)
    eventBus.on('sst:data:loaded', onSstDataLoaded)
    eventBus.on('fishingSpots:update', onFishingSpotsUpdate)

    return () => {
      eventBus.off('layer:swapped', handleLayerEvent)
      eventBus.off('layer:activated', handleLayerEvent)
      eventBus.off('layer:deactivated', handleLayerEvent)
      eventBus.off('layer:loading', onLoading)
      eventBus.off('layer:loaded', onLoaded)
      eventBus.off('layer:error', onError)
      eventBus.off('sst:data:loaded', onSstDataLoaded)
      eventBus.off('fishingSpots:update', onFishingSpotsUpdate)
    }
  }, [handleLayerEvent, showNotification, layers.fishingSpots])

  const handleLayerToggle = async (layerId: string, checked: boolean) => {
    if (!layerManager) {
      showNotification('Map is still loading...', 2000)
      return
    }
    
    setLoadingLayers(prev => ({ ...prev, [layerId]: checked }))

    if (checked) {
      const success = await layerManager.activateLayer(layerId)
      if (!success) {
        setLayers(prev => ({ ...prev, [layerId]: false }))
        setLoadingLayers(prev => ({ ...prev, [layerId]: false }))
      } else {
        const defaultOpacity = opacity[layerId] ?? (layerId === 'sst' ? (isStyledTiles ? 100 : 30) : 90)
        layerManager?.setLayerOpacity(layerId, defaultOpacity / 100)
        // Auto-expand when first activated
        setExpandedLayers(prev => ({ ...prev, [layerId]: true }))
      }
    } else {
      await layerManager.deactivateLayer(layerId)
      setLoadingLayers(prev => ({ ...prev, [layerId]: false }))
      // Auto-collapse when deactivated
      setExpandedLayers(prev => ({ ...prev, [layerId]: false }))
    }
  }

  const handleOpacityChange = (layerId: string, value: number) => {
    if (layerId === 'sst' && isStyledTiles) {
      setOpacity(prev => ({ ...prev, [layerId]: 100 }))
      layerManager?.setLayerOpacity('sst', 1.0)
      return
    }
    setOpacity(prev => ({ ...prev, [layerId]: value }))
    layerManager?.setLayerOpacity(layerId, value / 100)
  }

  const openTemperatureComparison = () => {
    if (!map) {
      showNotification('Map is still loading... opening analysis anyway', 2000)
    }
    setIsModalOpen(true)
  }

  const refreshSST = async () => {
    if (!layerManager) return
    try {
      setLoadingLayers(prev => ({ ...prev, sst: true }))
      const sstLayer = (layerManager as any).layers?.sst
      if (sstLayer) {
        if (!sstLayer.active) {
          await (layerManager as any).activateLayer('sst')
        } else if (typeof sstLayer.expandTemperatureField === 'function') {
          await sstLayer.expandTemperatureField()
        } else if (typeof sstLayer.refresh === 'function') {
          await sstLayer.refresh()
        }
        showNotification('SST coverage refreshed', 2000)
      }
    } catch (e: any) {
      showNotification(`SST refresh failed: ${e?.message || 'Unknown error'}`, 4000)
    } finally {
      setLoadingLayers(prev => ({ ...prev, sst: false }))
    }
  }

  const getQualityColor = (quality?: string) => {
    switch(quality) {
      case 'excellent': return 'text-green-600'
      case 'good': return 'text-blue-600'
      case 'fair': return 'text-yellow-600'
      case 'poor': return 'text-red-600'
      default: return 'text-gray-600'
    }
  }

  const getStatusBadgeVariant = (status?: string) => {
    switch(status) {
      case 'active': return 'default'
      case 'loading': return 'secondary'
      case 'error': return 'destructive'
      default: return 'outline'
    }
  }

  return (
    <TooltipProvider>
      <div className="fixed top-4 right-4 w-96 z-50">
        <Card className="bg-white/95 backdrop-blur-md shadow-xl border rounded-xl">
          <CardContent className="p-2">
            <div className="space-y-1.5">
              {layerConfigs.map((config) => {
                const IconComponent = config.icon
                const isActive = layers[config.id]
                const isExpanded = expandedLayers[config.id]
                const currentOpacity = opacity[config.id] || 70
                const metadata = config.metadata
                
                return (
                  <Card key={config.id} className="border-0 shadow-sm bg-gray-50/50">
                    <CardContent className="p-2">
                      {/* Compact Layer Header */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-1">
                          {/* Chevron for expand/collapse - only show when active */}
                          {isActive && (
                            <button
                              onClick={() => setExpandedLayers(prev => ({ ...prev, [config.id]: !prev[config.id] }))}
                              className="p-0.5 hover:bg-gray-200/50 rounded transition-colors"
                            >
                              <span className="text-gray-500 text-xs block">
                                {isExpanded ? '▼' : '▶'}
                              </span>
                            </button>
                          )}
                          
                          {/* Icon */}
                          <div className={`p-1.5 rounded-lg bg-gradient-to-br ${config.color} bg-opacity-10`}>
                            <IconComponent className="h-4 w-4 text-gray-700" />
                          </div>
                          
                          {/* Name and description */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-xs text-gray-900 truncate">{config.name}</h3>
                              {(metadata.status === 'loading' || metadata.status === 'error') && (
                                <Badge 
                                  variant={getStatusBadgeVariant(metadata.status)} 
                                  className="text-[9px] px-1 py-0 h-4"
                                >
                                  {metadata.status}
                                </Badge>
                              )}
                            </div>
                            <p className="text-[10px] text-gray-500 truncate">{config.description}</p>
                          </div>
                        </div>
                        
                        {/* Toggle switch */}
                        <div className="flex items-center gap-1.5 ml-2">
                          {loadingLayers[config.id] && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                          )}
                          <Switch
                            checked={isActive}
                            onCheckedChange={(checked) => handleLayerToggle(config.id, checked)}
                            disabled={loadingLayers[config.id] && !isActive}
                            className="scale-90"
                          />
                        </div>
                      </div>

                      {/* Quick stats line - only when active but collapsed */}
                      {isActive && !isExpanded && (
                        <div className="flex items-center gap-2 mt-2 ml-7 text-[10px] text-gray-500">
                          <span className="flex items-center gap-1">
                            <Zap className="h-2.5 w-2.5 text-amber-500" />
                            {metadata.freshness}
                          </span>
                          <span>•</span>
                          <span>{metadata.dataPoints?.toLocaleString() || '--'} points</span>
                          <span>•</span>
                          <span>{currentOpacity}% opacity</span>
                        </div>
                      )}

                      {/* Collapsed mini temperature scale inside SST header */}
                      {showScaleInPanel && config.id === 'sst' && isActive && !isExpanded && !isStyledTiles && (
                        <div className="ml-7 mt-1">
                          <TemperatureScaleCanvas compact />
                        </div>
                      )}

                      {/* Metadata Grid - Now collapsible */}
                      {isActive && isExpanded && (
                        <div className="space-y-2 mt-2 ml-7 animate-in slide-in-from-top-2 duration-200">
                          {/* Opacity Control with Visual Feedback */}
                          <div className="bg-white rounded-lg p-2 border border-gray-200">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-1.5">
                                <Eye className="h-3 w-3 text-gray-500" />
                                <span className="text-xs font-medium text-gray-700">Layer Opacity</span>
                              </div>
                              <span className="text-xs font-semibold text-gray-900">{currentOpacity}%</span>
                            </div>
                            <div 
                              className="relative h-6 bg-gray-100 rounded-full cursor-pointer overflow-hidden"
                              onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect()
                                const x = e.clientX - rect.left
                                const newValue = Math.round((x / rect.width) * 100)
                                handleOpacityChange(config.id, Math.max(0, Math.min(100, newValue)))
                              }}
                            >
                              <div 
                                className={`absolute inset-y-0 left-0 bg-gradient-to-r ${config.color} rounded-full transition-all duration-150`}
                                style={{ width: `${currentOpacity}%` }}
                              />
                              <div 
                                className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-md border-2 border-gray-300 transition-all duration-150"
                                style={{ left: `calc(${currentOpacity}% - 8px)` }}
                              />
                            </div>
                          </div>

                          {/* Temperature scale for SST (full) */}
                          {showScaleInPanel && config.id === 'sst' && !isStyledTiles && (
                            <div className="">
                              <TemperatureScaleCanvas />
                            </div>
                          )}

                          {/* Information Grid - Only show for SST layers */}
                          {config.id === 'sst' && (
                            <>
                              <div className="grid grid-cols-2 gap-2 text-[11px]">
                                {/* Source tile: header on top, value below */}
                                <div className="p-2 bg-white rounded-lg border border-gray-100">
                                  <div className="flex items-center gap-1.5 text-gray-600">
                                    <Satellite className="h-3 w-3" />
                                    <span className="uppercase tracking-wide">Source</span>
                                  </div>
                                  <div className="font-medium text-gray-800 truncate whitespace-nowrap" title={metadata.dataSource}>
                                    {metadata.dataSource}
                                  </div>
                                </div>

                                {/* Updated tile: header on top, value below */}
                                <div className="p-2 bg-white rounded-lg border border-gray-100">
                                  <div className="flex items-center gap-1.5 text-gray-600">
                                    <Clock className="h-3 w-3" />
                                    <span className="uppercase tracking-wide">Updated</span>
                                  </div>
                                  <div className="font-medium text-gray-800 truncate whitespace-nowrap" title={metadata.lastUpdate}>
                                    {metadata.lastUpdate}
                                  </div>
                                </div>

                              </div>

                              {/* Quality and Freshness Bar */}
                              <div className="flex items-center justify-between p-2 bg-white rounded-lg border border-gray-100">
                                <div className="flex items-center gap-2">
                                  <Activity className={`h-3 w-3 ${getQualityColor(metadata.quality)}`} />
                                  <span className="text-xs font-medium capitalize">{metadata.quality} Quality</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Zap className="h-3 w-3 text-amber-500" />
                                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                    {metadata.freshness}
                                  </Badge>
                                </div>
                              </div>
                            </>
                          )}

                          {/* Quick Actions */}
                          {config.id === 'sst' && (
                            <div className="flex items-center justify-end pt-1">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={refreshSST}
                                    disabled={loadingLayers.sst}
                                  >
                                    <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loadingLayers.sst ? 'animate-spin' : ''}`} />
                                    Refresh Coverage
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Expand temperature data coverage area</p>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>

            {/* Temperature Analysis Button */}
            <div className="mt-2 pt-2 border-t">
              <Button
                onClick={openTemperatureComparison}
                variant="default"
                size="sm"
                className="w-full h-8 text-xs bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
              >
                <TrendingUp className="h-3.5 w-3.5 mr-1.5" />
                Temperature Analysis
              </Button>
            </div>

            {/* Notification */}
            {notification && (
              <div className="mt-3 p-2.5 text-xs bg-blue-50 text-blue-700 rounded-lg border border-blue-200 animate-in slide-in-from-top-2">
                <div className="flex items-center gap-2">
                  <Info className="h-3.5 w-3.5" />
                  {notification}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Temperature Comparison Modal */}
        <TemperatureComparisonModalShadcn 
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          map={map}
        />
      </div>
    </TooltipProvider>
  )
}

export default LayerControlsPremium
