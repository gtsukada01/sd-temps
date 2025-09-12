## Ocean Map – Current Architecture (React + NOAA)

This document describes the architecture that is actually in the codebase today. For runbook and API details, see README.md in the same directory.

High-Level
- Frontend: Vite + React (shadcn) UI, OpenLayers map
- Backend: Flask data server (`noaa_data_server.py`) providing NOAA SST grids and tiles
- Communication: Event bus (`src/utils/EventBus.js`) for loose coupling

Entrypoints
- React (default): `src/main.tsx` → `src/App.tsx`
- Legacy vanilla (optional): `src/main.js` (bridges to the React Temperature Analysis modal)

Module Topology
```
App.tsx (React)
├─ MapManager.js (OpenLayers)
├─ LayerManager.js
│  ├─ HybridSSTLayer.js
│  ├─ BathymetryLayer.js
│  └─ FishingSpotsLayer.js (always available)
├─ components/
│  ├─ LayerSwitcherProfessional.tsx (shadcn)
│  ├─ SSTLegend.tsx (no title; refresh at footer)
│  ├─ TemperatureTooltip.tsx (compact, temperature-only)
│  └─ TemperatureComparisonModalShadcn.tsx
└─ services/
   ├─ DataSourceManager.js (talks to NOAA backend)
   └─ HistoricalDataService.js
```

Event Bus
- File: `src/utils/EventBus.js`
- Typical events used by the app:
  - `layer:loading`, `layer:loaded`, `layer:error`
  - `layer:activated`, `layer:deactivated`, `layer:swapped`
  - `sst:data:loaded` (legend/readout)
  - `data:source:used` (which backend data was used)
  - `temperature:comparison:open` (open Temperature Analysis modal)
  - `comparison:modal:opened`, `comparison:modal:closed`

SST Rendering Modes
- Canvas/grid (default):
  - `HybridSSTLayer` requests `/grid` via `DataSourceManager`
  - Renders a stable, single-image canvas (consistent colors, no seams)
- Tiles (optional):
  - If `CONFIG.FEATURES.USE_VALUE_TILE_RENDERER=true`, creates an XYZ `TileLayer` using `/tiles` endpoints
  - `VALUE_TILE_MODE='styled'` uses fully colorized PNGs (opacity locked to 100% by UI)

Data Access & Caching
- `DataSourceManager`
  - Calls `GET /grid` and `GET /grid/historical` via the Vite proxy
  - Paces requests and deduplicates in-flight calls
  - Stores grid responses in IndexedDB (configurable retention and size)
- Backend (`noaa_data_server.py`):
  - Throttles (1 concurrent, min interval per IP), caches by date and region
  - Provides both grid JSON and PNG tiles

UI Composition
- `LayerSwitcherProfessional.tsx` (React shadcn)
  - Toggles layers, adjusts opacity
  - Tracks per-layer loading via `layer:loading/loaded/error`
  - Opens Temperature Analysis (button) and listens for `temperature:comparison:open`
- `TemperatureComparisonModalShadcn.tsx`
  - Side-by-side current vs historical; uses `HistoricalDataService` and `DataSourceManager`
  - Also openable from non-React controls through the event bus (see `TemperatureComparisonModalWrapper.js`)
- `FishingSpotsLayer`
  - Loads personal spots from localStorage and optional bulk JSON (`/data/fishing-spots.json`)
  - Renders text-only labels with declutter; labels gated by zoom threshold in config

Legacy Controls (Optional)
- `src/controls/LayerSwitcherProfessional.js` and friends remain for environments where React UI is not used
- `src/main.js` bridges `temperature:comparison:open` to the React modal wrapper so both paths are supported

Constraints & Guidelines
- Keep modules decoupled; cross-module communication via the event bus only
- Layers do not import other layers; `LayerManager` orchestrates them
- All layer operations should emit `layer:loading` and either `layer:loaded` or `layer:error`
- Avoid blocking calls on UI paths; prefer async with visible feedback

Testing & Validation (targeted)
- Validate SST activation emits the expected events and draws a layer
- Validate Temperature Analysis opens from both the button and the global event
- Validate `DataSourceManager` respects throttling and caches grids in IndexedDB
