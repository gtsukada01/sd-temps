Ocean Map – Architecture, API, and Runbook

Overview
- React + OpenLayers single-page app for ocean data visualization.
- Real NOAA data via a local Flask backend (`noaa_data_server.py`).
- Supports Temperature Analysis (side‑by‑side current vs historical), SST layer, fishing spots, and a professional shadcn UI.

Quick Start
- Requirements
  - Node 18+ and npm
  - Python 3.10+ with pip
- Install frontend
  - `cd ocean-map`
  - `npm install`
- Install backend deps (one-time)
  - `python3 -m pip install --upgrade flask flask-cors xarray numpy pandas requests cfgrib`
    - Note: cfgrib may need system libs (ecCodes). If unavailable, current endpoints still work via ERDDAP CSV.
- Start backend (NOAA server on port 5176)
  - From repo root: `python3 noaa_data_server.py & echo $! > .noaa.pid`
  - Verify: `curl http://localhost:5176/status`
- Start frontend (Vite dev on 5173)
  - `cd ocean-map && npm run dev`
  - Open `http://localhost:5173`

Processes and Ports
- Backend (Flask): `http://localhost:5176` (writes optional `.noaa.pid` if started as above)
- Frontend (Vite): `http://localhost:5173` (uses `src/main.tsx`)
- Frontend → Backend proxy: configured in `ocean-map/vite.config.js` for `/grid`, `/grid/historical`, `/temperature`, `/status`, `/sources`, `/tiles`.

Restart (safe)
- Backend: `kill $(cat .noaa.pid 2>/dev/null) 2>/dev/null || true; python3 noaa_data_server.py & echo $! > .noaa.pid`
- Frontend: Ctrl+C the Vite process, then `npm run dev` again

Architecture
- Entrypoints
  - React app: `src/main.tsx` → `src/App.tsx` (default in `index.html`)
  - Legacy (vanilla) entry: `src/main.js` (kept for non-React demo/testing)
- Core map stack
  - `src/MapManager.js`: Initializes OpenLayers map (Web Mercator, OSM-based)
  - `src/layers/LayerManager.js`: Registers and toggles layers, opacity, active set
  - `src/layers/HybridSSTLayer.js`: SST layer with two render modes
    - Grid render (vector/canvas) via `DataSourceManager`
    - Experimental tile render (XYZ) via backend `/tiles` (value or styled)
  - `src/layers/FishingSpotsLayer.js`: Persisted spots (localStorage)
- Services
  - `src/services/DataSourceManager.js`: Talks to NOAA backend endpoints, caches grids in IndexedDB, rate limits, and normalizes metadata
  - `src/services/HistoricalDataService.js`: Used by Temperature Analysis to request `/grid/historical`
  - `src/services/NOAAService.js`/`NOAADataService.js`: Support code for NOAA requests (if present)
- UI (React shadcn)
  - `src/components/LayerSwitcherProfessional.tsx`: Main control panel
  - `src/components/SSTLegend.tsx`: SST legend/status (title removed; refresh button in footer; width aligned with layer panel)
  - `src/components/TemperatureTooltip.tsx`: Minimal click-to-readout (compact pill with temperature only)
  - Temperature Analysis (side-by-side):
    - `src/components/TemperatureComparisonModalShadcn.tsx` (core)
    - `src/components/TemperatureComparisonModalWrapper.js` bridges from vanilla code
    - Open via button in Layer Switcher or by emitting `temperature:comparison:open`
- Legacy controls (vanilla, optional)
  - `src/controls/LayerSwitcherProfessional.js` (non-React), `src/controls/LayerSwitcher.js`, `src/controls/TemperatureReadout.js`
- Events
  - Event bus: `src/utils/EventBus.js`
  - Common events (payload examples shown in code):
    - `layer:loading` / `layer:loaded` / `layer:error`
    - `layer:activated` / `layer:deactivated` / `layer:swapped`
    - `sst:data:loaded` (SST-specific status updates)
    - `data:source:used` (DataSourceManager emitted)
    - `temperature:comparison:open` (open the analysis modal)
    - `comparison:modal:opened` / `comparison:modal:closed`

NOAA Backend (Flask)
- File: `noaa_data_server.py`
- Endpoints
  - `GET /grid`: current SST grid (NOAA RTGSST via ERDDAP CSV)
  - `GET /grid/historical?date=YYYY-MM-DD`: historical SST grid (OI SST)
  - `GET /temperature`: point query (if enabled/kept)
  - `GET /tiles/sst/current/{z}/{x}/{y}.png`: RGB value tiles (24‑bit encoded)
  - `GET /tiles/sst/styled/current/{z}/{x}/{y}.png`: pre‑styled PNG tiles
  - `GET /tiles/sst/meta`: encoding metadata (offset/scale/range)
  - `GET /status`, `GET /sources`: server/service status
- Notes
  - Internal throttling: max 1 concurrent; 2.0s min interval per IP
  - Cache: `noaa_cache/` by date+region hash; validity accounts for NOAA update hour
  - Region snapping reduces duplicate downloads and improves cache hits
  - Responses include `cache_info` and basic temperature stats
  - Caching behavior (single active date)
    - Uses NOAA’s update boundary: before 12:00 UTC, data is considered “yesterday”; after 12:00 UTC, “today”.
    - Server prunes all other dated folders on startup and on requests, keeping only the active date’s cache.
    - Effect: at any time there is exactly one date directory under `noaa_cache/`, minimizing disk and avoiding pre‑noon redownloads.

Configuration
- `src/config.js`
  - `CONFIG.MAP`: map center/zoom
  - `CONFIG.FEATURES` (notable flags)
    - `USE_CANVAS_RENDERER`: draw SST grids to an image canvas for consistent visuals (default true)
    - `USE_VALUE_TILE_RENDERER`: use backend XYZ tiles (default false)
    - `VALUE_TILE_MODE`: `styled` (server-styled PNG) or `value` (RGB values)
    - `LOCK_SST_COLORS`: keep colors stable across zooms (no auto grid refresh on zoom)
    - `ADAPTIVE_GRID_SIZING`: auto grid resolution by zoom (default false for consistent look)
  - `TILE_CONFIG.SST`: tile URL templates and default encoding

Temperature Analysis (Modal)
- Component: `src/components/TemperatureComparisonModalShadcn.tsx`
- Open paths
  - Button in `LayerSwitcherProfessional.tsx`
  - Global event `temperature:comparison:open` (handled by React and bridged from `src/main.js`)
- Data
  - Current grid via `/grid`; historical grids via `/grid/historical?date=YYYY-MM-DD`
  - Uses `HistoricalDataService` and `DataSourceManager` under the hood

SST Layer Behavior
- Activation
  - Emits `layer:loading` → fetches grid (or creates tile layer) → emits `layer:loaded` and `sst:data:loaded`
- Canvas/grid mode (default)
  - DataSourceManager requests `/grid` using a fixed grid size for stable appearance
  - Canvas renderer draws a single image layer; vector mode remains as fallback
  - Default opacity on activation: 30% (unless styled tile mode is enabled, which locks opacity to 100%)
- Tile mode (optional)
  - `USE_VALUE_TILE_RENDERER=true` switches to backend XYZ tiles
  - `VALUE_TILE_MODE='styled'` renders opaque styled PNGs to avoid base-map bleeding

UI Notes
- `LayerSwitcherProfessional.tsx`
  - Shows loading spinners per layer based on `layer:loading/loaded/error`
  - SST default opacity is 30% in grid mode; locked at 100% when using styled tiles to preserve the palette
  - Provides a Refresh SST action (if layer supports `expandTemperatureField()`)
- `TemperatureTooltip.tsx`
  - Click to view nearest SST cell temperature; compact, unobtrusive overlay

Fishing Spots
- Layer: "Fishing Spots" (toggle in Layer Switcher)
- Data sources
  - Bulk/imported: `ocean-map/data/fishing-spots.json` (auto-loaded on toggle)
  - Personal/saved: stored in browser `localStorage` (kept separate; unaffected by imports)
- Rendering
  - Text-only labels (no pins) for all spots; declutter enabled
  - Labels appear when zoomed sufficiently in (threshold configurable via `CONFIG.SOURCES.FISHING_SPOTS.LABEL_MAX_RESOLUTION_MPP`)
- Importing from CSV
  - Place a CSV at `ocean-map/data/fishing-spots.csv` with columns: SPOT NAME (A), DD LAT (D), DD LONG (E)
  - Supported header names include: `spot`/`name`, `dd_lat`/`lat`, `dd_long`/`lon`
  - Convert to JSON: `cd ocean-map && npm run convert:fishing-spots`
    - Script: `scripts/convert-fishing-csv-to-json.mjs`
    - Output: `data/fishing-spots.json`
  - Dedupe: snaps to ~11 m and merges notes if present

Dev Tips
- Logs
  - Backend: run `python3 noaa_data_server.py` in foreground for logs; or tail `noaa_server.log` if you tee output
  - Frontend: browser console + `ocean-map/vite.log` if you pipe logs there
- 429 / rate limiting
  - DataSourceManager enforces client-side pacing; backend also throttles
  - If you see spinners persist, check for `layer:error` emissions and network 429s
- Historical data
  - OI SST earliest date is 1981‑09‑01; future dates are rejected

Known Good Paths
- Current grid (center near San Diego):
  - `curl "http://localhost:5176/grid?lat=32.7&lon=-117.2&size=15&region=2.0"`
- Historical (1 week ago):
  - `DATE=$(date -v-7d +%F 2>/dev/null || date -d '-7 days' +%F)`
  - `curl "http://localhost:5176/grid/historical?lat=32.7&lon=-117.2&size=15&region=2.0&date=$DATE"`

Troubleshooting
- Blank SST layer
  - Ensure backend running on 5176; check Vite proxy config
  - Watch console for 429 or CORS errors
  - Try toggling `USE_CANVAS_RENDERER` or `LOCK_SST_COLORS`
- Temperature Analysis won’t open
  - Confirm React UI is loaded (entry is `src/main.tsx`)
  - From console: `window.eventBus.emit('temperature:comparison:open')`
- Styled tile color shifts
  - Keep opacity at 100% for styled mode; ensure base map doesn’t blend through

Outdated/Legacy
- `copernicus-test/` is legacy only; the live app and this README describe NOAA-based behavior.

Status of Other Folders
- `ocean-map/src/controls/` and `src/main.js` provide a non‑React UI path. Supported but the React entry is the primary runtime.
- `maps-dashboard/` is an experimental Next.js dashboard and not wired to the NOAA backend.
