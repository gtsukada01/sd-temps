# Temperature Legend Consolidation - Implementation Plan

## Overview
Remove the standalone temperature legend (bottom-right) and integrate its functionality directly into the SST layer controls (top-right) to eliminate redundancy and create a unified temperature interface.

## Current State
- **SSTLegend.tsx**: Standalone component fixed at bottom-right showing:
  - Temperature gradient (61°F - 68°F - 75°F)
  - Source: NOAA Real-time Global SST
  - Updated: Timestamp
  - Freshness: Hours old
  - Refresh button
- **LayerControlsPremium.tsx**: SST controls showing:
  - Source and Updated metadata (duplicating legend)
  - Layer opacity control
  - Refresh Coverage button

## Implementation Steps

### Step 1: Remove SSTLegend Component
```bash
# Files to delete:
- ocean-map/src/components/SSTLegend.tsx
- ocean-map/src/styles/sst-legend.css (if exists)

# Remove import and usage from App.tsx:
- Delete: import SSTLegend from './components/SSTLegend'
- Delete: {showSSTLegend && <SSTLegend />}
- Delete: showSSTLegend state management
```

### Step 2: Add Temperature Gradient to LayerControlsPremium

```tsx
// In LayerControlsPremium.tsx, add temperature gradient component:

// Add new sub-component (inside LayerControlsPremium):
const TemperatureScale = ({ isCollapsed }: { isCollapsed: boolean }) => {
  if (isCollapsed) {
    // Compact horizontal gradient bar when collapsed
    return (
      <div className="flex items-center gap-1.5 ml-7 mt-1">
        <div className="flex-1 h-3 rounded-full bg-gradient-to-r from-blue-500 via-cyan-400 via-green-400 via-yellow-400 to-red-500" />
        <span className="text-[9px] text-gray-500">61-75°F</span>
      </div>
    );
  }
  
  // Full temperature scale when expanded
  return (
    <div className="bg-white rounded-lg p-2 border border-gray-200 ml-7 mt-2">
      <div className="flex items-center justify-between text-[10px] text-gray-600 mb-1">
        <span>61°F</span>
        <span>68°F</span>
        <span>75°F</span>
      </div>
      <div className="h-4 rounded bg-gradient-to-r from-blue-500 via-cyan-400 via-green-400 via-yellow-400 to-red-500" />
    </div>
  );
};
```

### Step 3: Integrate Temperature Scale into SST Section

```tsx
// Modify the SST layer section in LayerControlsPremium.tsx:

{config.id === 'sst' && (
  <>
    {/* Show temperature scale when SST is active */}
    {isActive && (
      <TemperatureScale isCollapsed={!isExpanded} />
    )}
    
    {/* Existing expanded content */}
    {isExpanded && isActive && (
      <div className="space-y-2 mt-2 ml-7">
        {/* Existing opacity control */}
        
        {/* Existing metadata grid (Source, Updated) */}
        
        {/* Quality and Freshness bar */}
        
        {/* Refresh button */}
      </div>
    )}
  </>
)}
```

### Step 4: Update Event Handlers

```tsx
// Remove SSTLegend-specific event emissions from HybridSSTLayer.js:
- eventBus.emit('sst:legend:show')
- eventBus.emit('sst:legend:hide')
- eventBus.emit('sst:legend:update', {...})

// Keep only layer activation events:
+ eventBus.emit('layer:activated', { layerId: 'sst' })
+ eventBus.emit('layer:deactivated', { layerId: 'sst' })
```

### Step 5: Clean Up Temperature Readout Component

```tsx
// In TemperatureReadout.js, ensure it works independently:
// Remove any dependencies on SSTLegend
// Keep the click-to-read temperature functionality as-is
```

## Visual Design Specifications

### When SST Inactive (Collapsed)
```
┌─────────────────────────────┐
│ ▶ 🌡️ Sea Surface Temperature │
│    Real-time ocean data      │
│                         [○]  │
└─────────────────────────────┘
```

### When SST Active (Collapsed)
```
┌─────────────────────────────┐
│ ▼ 🌡️ Sea Surface Temperature │
│    Real-time ocean data      │
│    [━━━━━━━━━━] 61-75°F     │
│                         [●]  │
└─────────────────────────────┘
```

### When SST Active (Expanded)
```
┌─────────────────────────────┐
│ ▼ 🌡️ Sea Surface Temperature │
│    Real-time ocean data      │
│                         [●]  │
│                              │
│  🎨 Layer Opacity      30%   │
│  [━━━━━━━━━━━━━━━━━━━]      │
│                              │
│  61°F    68°F    75°F        │
│  [━━━━━━━━━━━━━━━━━━]        │
│                              │
│  📡 Source: NOAA RTGSST      │
│  🕐 Updated: 8:24 AM         │
│                              │
│  ⚡ Fair Quality  0h old     │
│                              │
│  [↻ Refresh Coverage]        │
└─────────────────────────────┘
```

## Code Changes Summary

### Files to Modify:
1. **App.tsx**
   - Remove SSTLegend import
   - Remove showSSTLegend state
   - Remove SSTLegend component from JSX

2. **LayerControlsPremium.tsx**
   - Add TemperatureScale sub-component
   - Integrate temperature gradient into SST section
   - Show/hide based on SST activation state

3. **HybridSSTLayer.js**
   - Remove legend-specific events
   - Keep only standard layer events

### Files to Delete:
1. **SSTLegend.tsx** - Entire component
2. **sst-legend.css** - Associated styles (if exists)

## Benefits
1. **Reduced Redundancy**: No duplicate Source/Updated/Freshness info
2. **More Map Space**: ~200px more vertical space for map
3. **Unified Controls**: All temperature UI in one location
4. **Cleaner Interface**: Fewer floating components
5. **Context-Aware**: Temperature scale only shows when relevant (SST active)

## Testing Checklist
- [ ] SSTLegend component completely removed
- [ ] Temperature gradient shows when SST active
- [ ] Gradient hides when SST inactive
- [ ] Compact view when collapsed
- [ ] Full scale when expanded
- [ ] No console errors
- [ ] Temperature readout (click on map) still works
- [ ] Refresh functionality maintained
- [ ] Mobile responsive

## Migration Path
1. Create feature branch: `feature/consolidate-temperature-legend`
2. Implement TemperatureScale component
3. Test in isolation
4. Remove SSTLegend
5. Integration test
6. PR review
7. Deploy

## Rollback Plan
If issues arise, the changes are easily reversible:
- Git revert the commit
- Re-add SSTLegend component
- Restore App.tsx imports

## Time Estimate
- Implementation: 2-3 hours
- Testing: 1 hour
- Review & Deploy: 1 hour
- **Total: 4-5 hours**