Ocean Map – Handover

This file is intentionally brief and defers to the active documentation:
- Runbook, API, and usage: `ocean-map/README.md`
- Architecture: `ocean-map/ARCHITECTURE.md`

Notes
- The app runs React UI by default (`src/main.tsx`); the legacy vanilla entry (`src/main.js`) remains for non‑React usage.
- Real data comes from the local NOAA backend (`noaa_data_server.py`) on port 5176.
- Fishing spots import: place CSV at `ocean-map/data/fishing-spots.csv` (SPOT NAME, DD LAT, DD LONG) and run `npm run convert:fishing-spots` to generate `data/fishing-spots.json`.
