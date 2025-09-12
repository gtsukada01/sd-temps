import React, { useEffect, useRef } from 'react'

// Temperature scale and palette matching the CanvasTemperatureRenderer
// Fixed palette: 16–24°C (61–75°F)

const MIN_F = 61
const MAX_F = 75

const fToC = (f: number) => (f - 32) * 5 / 9

// Match the piecewise palette from CanvasTemperatureRenderer.getTemperatureColor
function colorForCelsius(tempC: number): { r: number; g: number; b: number } {
  const minT = 16
  const maxT = 24
  const n = Math.max(0, Math.min(1, (tempC - minT) / (maxT - minT)))
  let r: number, g: number, b: number
  if (n < 0.25) {
    const t = n / 0.25
    r = Math.floor(50 + t * 100)
    g = Math.floor(150 + t * 105)
    b = 255
  } else if (n < 0.5) {
    const t = (n - 0.25) / 0.25
    r = 0
    g = Math.floor(200 + t * 55)
    b = Math.floor(255 - t * 100)
  } else if (n < 0.75) {
    const t = (n - 0.5) / 0.25
    r = Math.floor(t * 255)
    g = 255
    b = Math.floor(50 - t * 50)
  } else {
    const t = (n - 0.75) / 0.25
    r = 255
    g = Math.floor(200 - t * 100)
    b = 0
  }
  return { r, g, b }
}

export const TemperatureScaleCanvas: React.FC<{
  compact?: boolean
  className?: string
}> = ({ compact = false, className }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const draw = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const displayWidth = Math.max(160, Math.floor(rect.width || 160))
    const displayHeight = Math.max(compact ? 10 : 16, Math.floor(rect.height || (compact ? 10 : 16)))
    canvas.width = Math.floor(displayWidth * dpr)
    canvas.height = Math.floor(displayHeight * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)

    for (let x = 0; x < displayWidth; x++) {
      const f = MIN_F + (x / (displayWidth - 1)) * (MAX_F - MIN_F)
      const c = fToC(f)
      const { r, g, b } = colorForCelsius(c)
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
      ctx.fillRect(x, 0, 1, displayHeight)
    }

    // Border for legibility
    ctx.strokeStyle = '#d1d5db'
    ctx.lineWidth = 1
    ctx.strokeRect(0, 0, displayWidth, displayHeight)
  }

  useEffect(() => {
    draw()
    const handle = () => draw()
    window.addEventListener('resize', handle)
    let ro: ResizeObserver | null = null
    if ('ResizeObserver' in window && canvasRef.current) {
      ro = new ResizeObserver(() => draw())
      ro.observe(canvasRef.current)
    }
    return () => {
      window.removeEventListener('resize', handle)
      if (ro) ro.disconnect()
    }
  }, [])

  const tickLabels = [MIN_F, Math.round((MIN_F + MAX_F) / 2), MAX_F]

  return (
    <div className={className}>
      <div className={compact ? 'space-y-0.5' : 'space-y-1'}>
        <canvas
          ref={canvasRef}
          className={compact ? 'w-full h-3 rounded' : 'w-full h-4 rounded'}
          aria-label={`Temperature scale ${MIN_F} to ${MAX_F} degrees Fahrenheit`}
        />
        <div className={`flex justify-between ${compact ? 'text-[10px]' : 'text-[11px]'} text-gray-600`}>
          {tickLabels.map(t => (
            <span key={t} className="font-mono">{t}°F</span>
          ))}
        </div>
      </div>
    </div>
  )
}

export default TemperatureScaleCanvas
