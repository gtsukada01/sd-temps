#!/usr/bin/env node
// Lightweight CSV -> JSON converter for fishing spots
// Usage: node scripts/convert-fishing-csv-to-json.mjs [inputCsv] [outputJson]
// Defaults: inputCsv=ocean-map/data/fishing-spots.csv, outputJson=ocean-map/data/fishing-spots.json

import fs from 'fs';
import path from 'path';

const DEFAULT_INPUT = path.join('ocean-map', 'data', 'fishing-spots.csv');
const DEFAULT_OUTPUT = path.join('ocean-map', 'data', 'fishing-spots.json');

const inputPath = process.argv[2] || DEFAULT_INPUT;
const outputPath = process.argv[3] || DEFAULT_OUTPUT;

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (c === '\r') {
        // ignore CR (handle CRLF)
      } else {
        field += c;
      }
    }
  }
  // push last field/row if any
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function pickColumnIndex(headers, candidates) {
  const set = new Set(headers.map(normalizeHeader));
  for (const c of candidates) {
    const key = normalizeHeader(c);
    let idx = headers.findIndex(h => normalizeHeader(h) === key);
    if (idx !== -1) return idx;
  }
  return -1;
}

function roundTo(val, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

function convert(rows) {
  if (!rows.length) return [];
  const headers = rows[0];
  // Prefer DD LAT/DD LONG explicitly (columns D/E in provided sheet),
  // then fall back to generic lon/lat names.
  const lonIdx = pickColumnIndex(headers, ['dd_long','ddlon','lon','longitude','long','x','lng']);
  const latIdx = pickColumnIndex(headers, ['dd_lat','ddlat','lat','latitude','y']);
  const nameIdx = pickColumnIndex(headers, ['spot_name','name','spot','title','label']);
  const notesIdx = pickColumnIndex(headers, ['notes','note','description','desc','remarks','comment','comments']);

  if (lonIdx === -1 || latIdx === -1) {
    throw new Error('CSV must include lon and lat columns (any of: lon/longitude, lat/latitude)');
  }

  const out = [];
  const seen = new Map(); // key -> index in out

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const rawLon = String(row[lonIdx] ?? '').trim();
    const rawLat = String(row[latIdx] ?? '').trim();
    if (!rawLon || !rawLat) continue;
    const lon = Number(rawLon);
    const lat = Number(rawLat);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const name = String(row[nameIdx] ?? '').trim();
    const notes = String(row[notesIdx] ?? '').trim();

    // Deduplicate nearby points by snapping to 1e-4 deg (~11 m)
    const key = `${roundTo(lon, 4)},${roundTo(lat, 4)}`;
    if (seen.has(key)) {
      const idx = seen.get(key);
      if (notes) {
        const prev = out[idx].notes || '';
        out[idx].notes = prev ? `${prev} | ${notes}` : notes;
      }
      if (name) {
        const prevName = out[idx].name || '';
        if (!prevName) out[idx].name = name;
      }
      continue;
    }

    const spot = { lon, lat };
    if (name) spot.name = name;
    if (notes) spot.notes = notes;
    out.push(spot);
    seen.set(key, out.length - 1);
  }
  return out;
}

try {
  const csvText = fs.readFileSync(inputPath, 'utf8');
  const rows = parseCSV(csvText);
  const spots = convert(rows);
  fs.writeFileSync(outputPath, JSON.stringify(spots, null, 2));
  console.log(`Converted ${spots.length} spots -> ${outputPath}`);
} catch (err) {
  console.error(`Conversion failed: ${err.message}`);
  process.exit(1);
}
