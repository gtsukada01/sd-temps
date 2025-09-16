#!/usr/bin/env python3
"""
NOAA Ocean Data Server
Replaces Copernicus with NOAA data sources for ocean temperature
Supports:
- NOAA RTGSST for real-time SST
- NOAA OI SST V2.1 for historical SST (1981-present)  
"""

from flask import Flask, jsonify, request, Response, make_response, send_from_directory
from flask_cors import CORS
import xarray as xr
import numpy as np
import pandas as pd  # For datetime operations
import json
import logging
import os
import re
import hashlib
import shutil
import threading
import time
from datetime import datetime, timedelta
import tempfile
import requests
from urllib.parse import urlencode
import math
import struct
import zlib
import binascii

# Optional dependency for xarray linear interpolation
try:
    import scipy  # noqa: F401
    HAS_SCIPY = True
except Exception:
    HAS_SCIPY = False
import cfgrib  # For GRIB file processing

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Request throttling to prevent server overload
request_throttle = {
    'active_downloads': 0,
    # Be conservative to avoid hammering ERDDAP under larger viewports
    'max_concurrent': 1,
    'lock': threading.Lock(),
    'last_request_times': {},
    # Slightly above frontend limiter to keep a safety margin
    'min_request_interval': 2.0  # seconds between requests per IP
}

# ================================
# NOAA DATA SOURCE CONFIGURATIONS  
# ================================

# JPL MUR Sea Surface Temperature (Working NOAA Source)
RTGSST_CONFIG = {
    'name': 'JPL MUR SST',
    'base_url': 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41',
    'description': 'Multi-scale Ultra-high Resolution SST analysis',
    'resolution': '0.01 degrees (1km)', 
    'update_frequency': 'Daily',
    'format': 'ERDDAP/NetCDF'
}

# NOAA Optimum Interpolation SST V2.1 (Historical)
OI_SST_CONFIG = {
    'name': 'NOAA OI SST V2.1',
    'thredds_base': 'https://www.ncei.noaa.gov/thredds/dodsC/OisstBase/NetCDF/V2.1/AVHRR',
    'description': 'Historical daily SST analysis 1981-present',
    'resolution': '0.25 degrees',
    'coverage': '1981-09-01 to present',
    'format': 'NetCDF via THREDDS'
}

# Regional bounds for Southern California to Mexico (from original system)
REGION_BOUNDS = {
    'min_longitude': -125.0,  # West of San Diego
    'max_longitude': -110.0,  # East border  
    'min_latitude': 24.0,     # Extend coverage to Bahia Santa Maria (~24.7°N)
    'max_latitude': 37.0      # Northern California
}

# Cache configuration
CACHE_BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'noaa_cache')
CACHE_RETENTION_DAYS = 3  # Keep cache for 3 days
NOAA_UPDATE_HOUR = 12     # NOAA updates around noon UTC

# ================================
# VALUE TILE ENCODING (for /tiles)
# ================================
TILE_SIZE = 256  # pixels
VALUE_SCALE = 0.01  # deg C per encoded unit
VALUE_OFFSET = -10.0  # deg C
VALID_RANGE = (-5.0, 40.0)  # sanity range for ocean temperatures

# ================================
# CACHE MANAGEMENT (reusing pattern from copernicus_official_server.py)
# ================================

def ensure_cache_directory():
    """Ensure cache directory structure exists"""
    if not os.path.exists(CACHE_BASE_DIR):
        os.makedirs(CACHE_BASE_DIR)
        logger.info(f"Created NOAA cache directory: {CACHE_BASE_DIR}")

def prune_cache_keep(current_date_key: str):
    """Remove all dated cache folders except the current_date_key.
    This keeps the cache footprint to a single day window (tiles + grids).
    """
    try:
        if not os.path.isdir(CACHE_BASE_DIR):
            return
        date_re = re.compile(r"^\d{4}-\d{2}-\d{2}$")
        for entry in os.listdir(CACHE_BASE_DIR):
            path = os.path.join(CACHE_BASE_DIR, entry)
            if not os.path.isdir(path):
                continue
            # Only consider YYYY-MM-DD folders
            if not date_re.match(entry):
                continue
            if entry != current_date_key:
                try:
                    shutil.rmtree(path, ignore_errors=True)
                    logger.info(f"🧹 Pruned old cache folder: {entry}")
                except Exception as e:
                    logger.warning(f"Failed to prune cache folder {entry}: {e}")
    except Exception as e:
        logger.warning(f"Cache prune skipped: {e}")

def generate_region_hash(min_lat, max_lat, min_lon, max_lon, grid_size=None):
    """Generate consistent hash for geographic region"""
    region_str = f"{round(min_lat, 3)}_{round(max_lat, 3)}_{round(min_lon, 3)}_{round(max_lon, 3)}"
    if grid_size:
        region_str += f"_{grid_size}"
    return hashlib.md5(region_str.encode()).hexdigest()[:12]

def get_cache_date_key(target_date=None):
    """Get effective cache date key (YYYY-MM-DD).
    Before NOAA's daily update hour, use yesterday's date to ensure
    consistent caching and avoid re-downloading the same data window.
    """
    if target_date is None:
        target_date = datetime.now()
    effective = target_date
    try:
        if effective.hour < NOAA_UPDATE_HOUR:
            effective = effective - timedelta(days=1)
    except Exception:
        pass
    return effective.strftime('%Y-%m-%d')

def is_cache_valid(cache_date_str):
    """Check if cached data is still valid based on NOAA update schedule"""
    try:
        cache_date = datetime.strptime(cache_date_str, '%Y-%m-%d')
        now = datetime.now()
        
        # If cache is from today and it's after noon, cache is valid
        if cache_date.date() == now.date():
            return now.hour >= NOAA_UPDATE_HOUR
            
        # If cache is from yesterday and it's before noon today, still valid
        if cache_date.date() == (now - timedelta(days=1)).date():
            return now.hour < NOAA_UPDATE_HOUR
            
        return False
    except (ValueError, TypeError):
        return False

def save_to_cache(cache_type, date_key, region_hash, data, is_json=True):
    """Save data to cache file"""
    try:
        cache_dir = os.path.join(CACHE_BASE_DIR, date_key)
        if not os.path.exists(cache_dir):
            os.makedirs(cache_dir)
            
        filename = f"{cache_type}_{region_hash}.json"
        cache_file = os.path.join(cache_dir, filename)
        
        with open(cache_file, 'w') as f:
            json.dump(data, f, default=str)
            
        logger.info(f"Saved {cache_type} cache: {os.path.basename(cache_file)}")
        return cache_file
    except Exception as e:
        logger.error(f"Failed to save cache: {e}")
        return None

def load_from_cache(cache_type, date_key, region_hash, is_json=True):
    """Load data from cache file"""
    try:
        cache_dir = os.path.join(CACHE_BASE_DIR, date_key)
        filename = f"{cache_type}_{region_hash}.json"
        cache_file = os.path.join(cache_dir, filename)
        
        if not os.path.exists(cache_file):
            return None
            
        with open(cache_file, 'r') as f:
            data = json.load(f)
        logger.info(f"Loaded {cache_type} cache: {os.path.basename(cache_file)}")
        return data
    except Exception as e:
        logger.error(f"Failed to load cache: {e}")
        return None

# ================================
# PNG ENCODER (no external deps)
# ================================

def encode_png_rgba(rgba_bytes: bytes, width: int, height: int) -> bytes:
    """Encode RGBA bytes into a PNG (no external dependencies).
    rgba_bytes must be len == width*height*4.
    """
    png_sig = b"\x89PNG\r\n\x1a\n"

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack('>I', len(data)) +
            tag +
            data +
            struct.pack('>I', binascii.crc32(tag + data) & 0xffffffff)
        )

    # IHDR: 8-bit RGBA
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)

    # IDAT: filter type 0 per scanline, zlib-compressed
    stride = width * 4
    rows = [b"\x00" + rgba_bytes[y*stride:(y+1)*stride] for y in range(height)]
    idat = zlib.compress(b''.join(rows), level=6)

    return (
        png_sig +
        chunk(b'IHDR', ihdr) +
        chunk(b'IDAT', idat) +
        chunk(b'IEND', b'')
    )

# ================================
# TILE MATH / UTILITIES
# ================================

def tile_xyz_to_lonlat_bounds(z: int, x: int, y: int):
    """Return (min_lon, min_lat, max_lon, max_lat) for a slippy tile in EPSG:3857."""
    n = 2 ** z
    lon_min = x / n * 360.0 - 180.0
    lon_max = (x + 1) / n * 360.0 - 180.0
    def merc_y_to_lat(yy):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy))))
    lat_max = merc_y_to_lat(y / n)
    lat_min = merc_y_to_lat((y + 1) / n)
    return (lon_min, lat_min, lon_max, lat_max)

def clamp(v, a, b):
    return a if v < a else b if v > b else v

def pack_value_to_rgb(temp_c: float) -> tuple:
    value = int(round((temp_c - VALUE_OFFSET) / VALUE_SCALE))
    if value < 0:
        value = 0
    if value > 16777215:
        value = 16777215
    r = (value >> 16) & 0xFF
    g = (value >> 8) & 0xFF
    b = value & 0xFF
    return (r, g, b)

def color_from_temp(temp_c: float) -> tuple:
    """Match the Temperature Analysis palette exactly (16–24°C).
    Blue → Cyan → Green → Orange → Red with high contrast in mid-bands.
    """
    tmin, tmax = 16.0, 24.0
    # Clamp to domain
    if temp_c <= tmin:
        temp_c = tmin
    if temp_c >= tmax:
        temp_c = tmax
    span = tmax - tmin if tmax != tmin else 1.0
    normalized = (temp_c - tmin) / span  # 0..1

    if normalized < 0.25:
        # Cool waters: Blue ➝ brighter blue‑cyan
        t = normalized / 0.25
        r = int(50 + t * 100)
        g = int(150 + t * 105)
        b = 255
    elif normalized < 0.5:
        # Cyan band
        t = (normalized - 0.25) / 0.25
        r = 0
        g = int(200 + t * 55)
        b = int(255 - t * 100)
    elif normalized < 0.75:
        # Green ➝ Orange
        t = (normalized - 0.5) / 0.25
        r = int(t * 255)
        g = 255
        b = int(50 - t * 50)
    else:
        # Orange ➝ Red
        t = (normalized - 0.75) / 0.25
        r = 255
        g = int(200 - t * 100)
        b = 0
    return (r, g, b)

# ================================
# REQUEST THROTTLING (same pattern)
# ================================

def check_request_throttle(client_ip):
    """Check if request should be throttled"""
    with request_throttle['lock']:
        now = time.time()
        
        if request_throttle['active_downloads'] >= request_throttle['max_concurrent']:
            return False, f"Too many concurrent downloads ({request_throttle['active_downloads']}/{request_throttle['max_concurrent']}). Please wait."
        
        last_request = request_throttle['last_request_times'].get(client_ip, 0)
        if now - last_request < request_throttle['min_request_interval']:
            remaining = request_throttle['min_request_interval'] - (now - last_request)
            return False, f"Rate limited. Please wait {remaining:.1f} seconds."
        
        request_throttle['last_request_times'][client_ip] = now
        request_throttle['active_downloads'] += 1
        return True, None

def release_download_slot():
    """Release a download slot when request completes"""
    with request_throttle['lock']:
        request_throttle['active_downloads'] = max(0, request_throttle['active_downloads'] - 1)

# ================================
# NOAA DATA ACCESS FUNCTIONS
# ================================

def normalize_latlon(ds):
    """Ensure dataset uses 'latitude' and 'longitude' coordinate names"""
    try:
        rename_map = {}
        if 'lat' in ds.dims:
            rename_map['lat'] = 'latitude'
        if 'lon' in ds.dims:
            rename_map['lon'] = 'longitude'
        if rename_map:
            ds = ds.rename(rename_map)
    except Exception:
        pass
    return ds


def open_remote_dataset(url):
    """Open ERDDAP/OPeNDAP dataset with engine fallbacks for reliability."""
    last_err = None
    engines = (None, 'netcdf4', 'pydap')
    for eng in engines:
        try:
            if eng is None:
                logger.info(f"Opening dataset: {url}")
                return xr.open_dataset(url)
            logger.info(f"Opening dataset via engine={eng}: {url}")
            return xr.open_dataset(url, engine=eng)
        except Exception as e:
            last_err = e
            logger.warning(f"open_dataset failed (engine={eng}): {e}")
    raise Exception(f"Failed to open dataset with available engines: {last_err}")


def _prepare_bounds_for_dataset(ds, min_lat, max_lat, min_lon, max_lon):
    """Adjust requested bounds to match dataset conventions.
    - Handle longitude domain (0..360 vs -180..180)
    - Handle latitude orientation (ascending vs descending)
    Returns: (lat_slice, lon_slice)
    """
    # Normalize lon range if dataset uses [0, 360)
    try:
        lon_vals = ds['longitude'].values
        lon_min, lon_max = float(np.nanmin(lon_vals)), float(np.nanmax(lon_vals))
        if lon_min >= 0 and min_lon < 0 and max_lon < 0:
            min_lon = (min_lon + 360.0)
            max_lon = (max_lon + 360.0)
    except Exception:
        pass

    # Determine latitude orientation
    try:
        lat_vals = ds['latitude'].values
        lat_asc = bool(np.all(np.diff(lat_vals) > 0))
    except Exception:
        lat_asc = True

    # Build slices respecting orientation
    if lat_asc:
        lat_slice = slice(min_lat, max_lat)
    else:
        lat_slice = slice(max_lat, min_lat)

    # Assume longitude ascending
    lon_slice = slice(min_lon, max_lon)
    return lat_slice, lon_slice


def fetch_rtgsst_data(min_lat, max_lat, min_lon, max_lon):
    """Fetch real-time SST data from JPL MUR SST - REAL DATA ONLY"""
    try:
        # Prefer fast ERDDAP CSV grid (no SciPy/netCDF needed)
        grid, lats, lons, data_time = fetch_rtgsst_csv_grid(min_lat, max_lat, min_lon, max_lon)
        return grid, data_time
        
    except Exception as e:
        logger.error(f"JPL MUR SST fetch failed: {e}")
        raise Exception(f"NOAA JPL MUR SST data unavailable: {str(e)}")

def fetch_rtgsst_csv_grid(min_lat, max_lat, min_lon, max_lon):
    """Fetch a gridded subset from ERDDAP via CSV using stride to target ~100x100.
    Returns: (grid_data_list, lat_values, lon_values, data_time)
    Each grid cell: {'lat': lat, 'lon': lon, 'temp': celsius_or_None}
    """
    base = RTGSST_CONFIG['base_url']  # .../griddap/jplMURSST41
    # jplMURSST41 uses longitude domain -180..180; keep requested longitudes as-is
    lon0, lon1 = (min_lon, max_lon) if min_lon <= max_lon else (max_lon, min_lon)
    lat0, lat1 = (min_lat, max_lat) if min_lat <= max_lat else (max_lat, min_lat)

    # Dataset native resolution ~0.01 deg
    lat_span = lat1 - lat0
    lon_span = lon1 - lon0
    lat_stride = max(1, int(round((lat_span / max(1, 100)) / 0.01)))
    lon_stride = max(1, int(round((lon_span / max(1, 100)) / 0.01)))

    def build_query(lat_a=lat0, lat_b=lat1, lon_a=lon0, lon_b=lon1):
        # Use coordinate-value selection with parentheses and integer stride
        return (
            f"analysed_sst[(last)][({lat_a}):{lat_stride}:({lat_b})][({lon_a}):{lon_stride}:({lon_b})]"
        )

    # Try a few URL variants for ERDDAP quirks
    urls = [
        f"{base}.csv?" + build_query(lat0, lat1, lon0, lon1),
        # Try swapped lat order in case ERDDAP requires it
        f"{base}.csv?" + build_query(lat1, lat0, lon0, lon1),
    ]

    resp = None
    for u in urls:
        try:
            logger.info(f"Fetching ERDDAP CSV: {u}")
            r = requests.get(u, timeout=60)
            if r.status_code == 200 and 'analysed_sst' in r.text:
                resp = r
                break
            else:
                logger.warning(f"CSV variant failed ({r.status_code}); trying next")
        except Exception as e:
            logger.warning(f"CSV request error: {e}")
            continue

    if resp is None:
        raise Exception("ERDDAP CSV request failed: 404/Bad response on all variants")

    text = resp.text.splitlines()
    # Expect header like: time,latitude,longitude,analysed_sst
    import csv
    reader = csv.DictReader(text)
    points = []
    data_time_str = None
    for row in reader:
        try:
            if data_time_str is None and 'time' in row:
                data_time_str = row['time']
            t = row.get('analysed_sst')
            temp = None if t in (None, '', 'NaN', 'nan') else float(t)
            lat = float(row['latitude'])
            lon = float(row['longitude'])
            points.append((lat, lon, temp))
        except Exception:
            continue

    if not points:
        raise Exception('ERDDAP CSV returned no points')

    # Get unique sorted coordinate axes
    lat_values = sorted({p[0] for p in points})
    lon_values = sorted({p[1] for p in points})
    nlat, nlon = len(lat_values), len(lon_values)

    # Build lookup for temps
    from collections import defaultdict
    temp_map = defaultdict(dict)
    for lat, lon, temp in points:
        temp_map[lat][lon] = temp

    grid = []
    for lat in lat_values:
        row = []
        for lon in lon_values:
            val = temp_map.get(lat, {}).get(lon, None)
            # Validate range, convert Kelvin if needed
            if val is not None and val > 100:
                val = val - 273.15
            if val is not None and not (-5 <= val <= 40):
                val = None
            row.append({ 'lat': round(lat, 3), 'lon': round((lon if lon <= 180 else lon - 360), 3), 'temp': None if val is None else round(float(val), 1) })
        grid.append(row)

    # Prefer dataset time if available
    data_time = data_time_str or datetime.utcnow().isoformat()
    return grid, lat_values, lon_values, data_time


def resample_grid(data_array, min_lat, max_lat, min_lon, max_lon, grid_size):
    """Resample a 2D DataArray (lat, lon) to a regular grid using xarray interp.
    Returns numpy array of shape (grid_size, grid_size) with float temps in C (or NaN).
    """
    try:
        lat_points = np.linspace(min_lat, max_lat, grid_size)
        lon_points = np.linspace(min_lon, max_lon, grid_size)
        # Ensure coordinates are ascending for interpolation
        da = data_array
        try:
            lat_vals = da['latitude'].values
            if np.any(np.diff(lat_vals) < 0):
                da = da.sortby('latitude')
        except Exception:
            pass
        try:
            lon_vals = da['longitude'].values
            if np.any(np.diff(lon_vals) < 0):
                da = da.sortby('longitude')
        except Exception:
            pass
        # Prefer linear interpolation when SciPy is available; otherwise use nearest
        method = 'linear' if HAS_SCIPY else 'nearest'
        interp = da.interp(latitude=lat_points, longitude=lon_points, method=method)
        # Some datasets store Kelvin; normalize later per cell if needed
        return interp.values, lat_points, lon_points
    except Exception as e:
        logger.warning(f"Interp failed ({e}), falling back to nearest")
        interp = da.interp(latitude=lat_points, longitude=lon_points, method='nearest')
        return interp.values, lat_points, lon_points


def snap_parameters(center_lat, center_lon, region_size):
    """Snap center and region to canonical steps to maximize cache hits and limit load."""
    # Clamp region into supported set and snap to nearest allowed value
    allowed_regions = [2.0, 3.0, 4.0, 6.0]
    region = min(allowed_regions, key=lambda v: abs(v - region_size))
    # Snap center to 0.25° grid to share cache across nearby views
    def snap_coord(v):
        return round(round(v / 0.25) * 0.25, 2)
    lat = snap_coord(center_lat)
    lon = snap_coord(center_lon)
    return lat, lon, region

def fetch_rtgsst_csv_grid_at_date(min_lat, max_lat, min_lon, max_lon, target_date):
    """Fetch a historical gridded subset from ERDDAP via CSV at a specific date.
    Returns: (grid_data_list, lat_values, lon_values, data_time)
    """
    base = RTGSST_CONFIG['base_url']
    # Use -180..180 domain for MUR
    lon0, lon1 = (min_lon, max_lon) if min_lon <= max_lon else (max_lon, min_lon)
    lat0, lat1 = (min_lat, max_lat) if min_lat <= max_lat else (max_lat, min_lat)

    # Dataset native resolution ~0.01 deg; stride to ~100x100
    lat_span = lat1 - lat0
    lon_span = lon1 - lon0
    lat_stride = max(1, int(round((lat_span / max(1, 100)) / 0.01)))
    lon_stride = max(1, int(round((lon_span / max(1, 100)) / 0.01)))

    # MUR times are at 09:00:00Z
    time_str = f"{target_date}T09:00:00Z"

    def q(lat_a=lat0, lat_b=lat1, lon_a=lon0, lon_b=lon1):
        return (
            f"analysed_sst[({time_str})][({lat_a}):{lat_stride}:({lat_b})][({lon_a}):{lon_stride}:({lon_b})]"
        )

    urls = [
        f"{base}.csv?" + q(lat0, lat1, lon0, lon1),
        f"{base}.csv?" + q(lat1, lat0, lon0, lon1),
    ]

    resp = None
    for u in urls:
        try:
            logger.info(f"Fetching ERDDAP CSV (historical): {u}")
            r = requests.get(u, timeout=60)
            if r.status_code == 200 and 'analysed_sst' in r.text:
                resp = r
                break
            else:
                logger.warning(f"CSV historical variant failed ({r.status_code}); trying next")
        except Exception as e:
            logger.warning(f"CSV historical request error: {e}")
            continue

    if resp is None:
        raise Exception("ERDDAP CSV historical request failed: 404/Bad response on all variants")

    text = resp.text.splitlines()
    import csv
    reader = csv.DictReader(text)
    points = []
    for row in reader:
        try:
            t = row.get('analysed_sst')
            temp = None if t in (None, '', 'NaN', 'nan') else float(t)
            lat = float(row['latitude'])
            lon = float(row['longitude'])
            points.append((lat, lon, temp))
        except Exception:
            continue

    if not points:
        raise Exception('ERDDAP CSV historical returned no points')

    lat_values = sorted({p[0] for p in points})
    lon_values = sorted({p[1] for p in points})
    from collections import defaultdict
    temp_map = defaultdict(dict)
    for lat, lon, temp in points:
        temp_map[lat][lon] = temp

    grid = []
    for lat in lat_values:
        row = []
        for lon in lon_values:
            val = temp_map.get(lat, {}).get(lon, None)
            if val is not None and val > 100:
                val = val - 273.15
            if val is not None and not (-5 <= val <= 40):
                val = None
            row.append({ 'lat': round(lat, 3), 'lon': round(lon, 3), 'temp': None if val is None else round(float(val), 1) })
        grid.append(row)

    data_time = f"{time_str}"
    return grid, lat_values, lon_values, data_time

def fetch_rtgsst_csv_grid_stride(min_lat, max_lat, min_lon, max_lon, lat_stride=1, lon_stride=1, time_str=None):
    """Fetch ERDDAP CSV grid with explicit stride to control resolution.
    If time_str is None, uses (last). Returns (grid, lat_values, lon_values, data_time).
    """
    base = RTGSST_CONFIG['base_url']
    lon0, lon1 = (min_lon, max_lon) if min_lon <= max_lon else (max_lon, min_lon)
    lat0, lat1 = (min_lat, max_lat) if min_lat <= max_lat else (max_lat, min_lat)

    tsel = f"({time_str})" if time_str else "(last)"

    def q(lat_a=lat0, lat_b=lat1, lon_a=lon0, lon_b=lon1):
        return (
            f"analysed_sst[{tsel}][({lat_a}):{int(max(1,lat_stride))}:({lat_b})][({lon_a}):{int(max(1,lon_stride))}:({lon_b})]"
        )

    urls = [
        f"{base}.csv?" + q(lat0, lat1, lon0, lon1),
        f"{base}.csv?" + q(lat1, lat0, lon0, lon1),
    ]

    resp = None
    for u in urls:
        try:
            logger.info(f"Fetching ERDDAP CSV (stride {lat_stride},{lon_stride}): {u}")
            r = requests.get(u, timeout=60)
            if r.status_code == 200 and 'analysed_sst' in r.text:
                resp = r
                break
            else:
                logger.warning(f"CSV stride variant failed ({r.status_code}); trying next")
        except Exception as e:
            logger.warning(f"CSV stride request error: {e}")
            continue

    if resp is None:
        raise Exception("ERDDAP CSV stride request failed: 404/Bad response on all variants")

    text = resp.text.splitlines()
    import csv
    reader = csv.DictReader(text)
    points = []
    data_time_str = None
    for row in reader:
        try:
            if data_time_str is None and 'time' in row:
                data_time_str = row['time']
            t = row.get('analysed_sst')
            temp = None if t in (None, '', 'NaN', 'nan') else float(t)
            lat = float(row['latitude'])
            lon = float(row['longitude'])
            points.append((lat, lon, temp))
        except Exception:
            continue

    if not points:
        raise Exception('ERDDAP CSV (stride) returned no points')

    lat_values = sorted({p[0] for p in points})
    lon_values = sorted({p[1] for p in points})
    nlat, nlon = len(lat_values), len(lon_values)
    from collections import defaultdict
    temp_map = defaultdict(dict)
    for lat, lon, temp in points:
        temp_map[lat][lon] = temp
    grid = []
    for lat in lat_values:
        row = []
        for lon in lon_values:
            val = temp_map.get(lat, {}).get(lon, None)
            if val is not None and val > 100:
                val = val - 273.15
            if val is not None and not (-5 <= val <= 40):
                val = None
            row.append({ 'lat': round(lat, 3), 'lon': round((lon if lon <= 180 else lon - 360), 3), 'temp': None if val is None else round(float(val), 1) })
        grid.append(row)

    data_time = data_time_str or datetime.utcnow().isoformat()
    return grid, lat_values, lon_values, data_time

# ================================
# API ENDPOINTS
# ================================

@app.route('/')
def index():
    """Root endpoint - NOAA API status"""
    return jsonify({
        'status': 'NOAA Ocean Data Server Running',
        'timestamp': datetime.now().isoformat(),
        'data_sources': {
            'rtgsst': RTGSST_CONFIG,
            'oi_sst': OI_SST_CONFIG, 
            
        },
        'coverage': REGION_BOUNDS,
        'endpoints': {
            '/temperature': 'Get temperature at coordinates (RTGSST)',
            '/grid': 'Get temperature grid for region (RTGSST)', 
            '/grid/historical': 'Get historical temperature grid (OI SST V2.1)',
            '/tiles/sst/current/{z}/{x}/{y}.png': 'RGB value tile (24-bit, alpha masked by data)',
            '/tiles/sst/styled/current/{z}/{x}/{y}.png': 'Server-styled PNG tile (alpha masked by data)',
            '/tiles/sst/meta': 'Encoding metadata (scale/offset/valid range)',
            
            '/status': 'Multi-source health check',
            '/sources': 'List all NOAA data sources'
        }
    })

@app.route('/status')
def status():
    """Health check endpoint - test all NOAA sources"""
    health_results = {}
    overall_status = 'healthy'
    
    # Test RTGSST
    try:
        today = datetime.now().strftime('%Y%m%d')
        test_url = f"{RTGSST_CONFIG['base_url']}/rtgsst.{today}"
        response = requests.head(test_url, timeout=10)
        health_results['rtgsst'] = 'accessible' if response.status_code == 200 else f'status_{response.status_code}'
    except Exception as e:
        health_results['rtgsst'] = f'error: {str(e)}'
        overall_status = 'degraded'
    
    # Test OI SST
    try:
        test_year = datetime.now().year
        test_url = f"{OI_SST_CONFIG['thredds_base']}/{test_year}"
        response = requests.head(test_url, timeout=10)
        health_results['oi_sst'] = 'accessible' if response.status_code == 200 else f'status_{response.status_code}'
    except Exception as e:
        health_results['oi_sst'] = f'error: {str(e)}'
        overall_status = 'degraded'

    return jsonify({
        'status': overall_status,
        'noaa_services': health_results,
        'timestamp': datetime.now().isoformat(),
        'active_downloads': request_throttle['active_downloads']
    })

@app.route('/sources') 
def list_sources():
    """List all NOAA data sources and their capabilities"""
    return jsonify({
        'data_sources': {
            'rtgsst': {
                **RTGSST_CONFIG,
                'use_case': 'Real-time sea surface temperature',
                'latency': '1-2 days',
                'quality': 'operational_analysis'
            },
            'oi_sst': {
                **OI_SST_CONFIG, 
                'use_case': 'Historical SST analysis and climatology',
                'latency': '2 weeks (preliminary), final after 2 weeks',
                'quality': 'research_quality'
            },
            
        },
        'timestamp': datetime.now().isoformat()
    })

@app.route('/grid')
def get_temperature_grid():
    """Get current temperature grid using NOAA RTGSST"""
    client_ip = request.environ.get('REMOTE_ADDR', 'unknown')
    
    try:
        center_lat = float(request.args.get('lat', 32.7))
        center_lon = float(request.args.get('lon', -117.2))
        grid_size = int(request.args.get('size', 10))
        region_size = float(request.args.get('region', 2.0))

        # Snap and clamp to canonical parameters to reduce cache variance and load
        center_lat, center_lon, region_size = snap_parameters(center_lat, center_lon, region_size)
        
        logger.info(f"NOAA RTGSST grid request: {grid_size}x{grid_size} around {center_lat}°N, {center_lon}°W")
        
        # Calculate bounds
        min_lat = center_lat - region_size/2
        max_lat = center_lat + region_size/2  
        min_lon = center_lon - region_size/2
        max_lon = center_lon + region_size/2
        
        # Check cache first (grid_size-agnostic for RTGSST to maximize reuse)
        region_hash = generate_region_hash(min_lat, max_lat, min_lon, max_lon)
        date_key = get_cache_date_key()
        # Prune old cache folders so we only keep the current date window
        prune_cache_keep(date_key)
        
        cached_data = load_from_cache('rtgsst_grid', date_key, region_hash)
        if cached_data and is_cache_valid(date_key):
            logger.info(f"🚀 Serving cached RTGSST grid for {region_hash}")
            cached_data['cache_info'] = {
                'cached': True,
                'cache_date': date_key,
                'source': 'noaa_rtgsst'
            }
            return jsonify(cached_data)
        
        # Check throttling
        can_proceed, throttle_message = check_request_throttle(client_ip)
        if not can_proceed:
            return jsonify({'error': throttle_message}), 429
        
        try:
            ensure_cache_directory()
            
            # Fetch RTGSST via ERDDAP CSV (fast path, approx ~100x100)
            grid_data, lat_points, lon_points, data_time = fetch_rtgsst_csv_grid(min_lat, max_lat, min_lon, max_lon)
            
            # Calculate statistics
            valid_temps = [cell['temp'] for row in grid_data for cell in row if cell['temp'] is not None]
            temp_stats = {
                'min': round(min(valid_temps), 1) if valid_temps else None,
                'max': round(max(valid_temps), 1) if valid_temps else None,
                'avg': round(sum(valid_temps) / len(valid_temps), 1) if valid_temps else None
            }
            
            # Prepare response
            response_data = {
                'center_latitude': center_lat,
                'center_longitude': center_lon,
                'grid_size': len(grid_data),
                'region_size_degrees': region_size,
                'grid_data': grid_data,
                'temperature_stats': temp_stats,
                'data_points': len(valid_temps),
                'source': 'NOAA RTGSST',
                'timestamp': datetime.now().isoformat(),
                'data_time': str(data_time),
                'cache_info': {
                    'cached': False,
                    'cache_date': date_key,
                    'freshly_downloaded': True
                }
            }
            
            # Save to cache
            save_to_cache('rtgsst_grid', date_key, region_hash, response_data)
            return jsonify(response_data)
            
        finally:
            release_download_slot()
            
    except Exception as e:
        logger.error(f"RTGSST grid error: {e}")
        try:
            release_download_slot()
        except:
            pass
        return jsonify({'error': str(e)}), 500

# ================================
# VALUE TILE ENDPOINTS
# ================================

def _nearest_indices(values, targets):
    """Nearest-value indices for each target using binary search. values ascending."""
    import bisect
    idxs = []
    for t in targets:
        i = bisect.bisect_left(values, t)
        if i <= 0:
            idxs.append(0)
        elif i >= len(values):
            idxs.append(len(values) - 1)
        else:
            if abs(values[i] - t) < abs(values[i-1] - t):
                idxs.append(i)
            else:
                idxs.append(i-1)
    return idxs

def _render_tile_rgba(min_lon, min_lat, max_lon, max_lat, date_str=None, styled=False):
    # Fetch gridded data via ERDDAP CSV (~100x100) and resample to tile
    if date_str and date_str != 'current':
        grid, lats, lons, _ = fetch_rtgsst_csv_grid_at_date(min_lat, max_lat, min_lon, max_lon, date_str)
    else:
        grid, lats, lons, _ = fetch_rtgsst_csv_grid(min_lat, max_lat, min_lon, max_lon)

    h = TILE_SIZE
    w = TILE_SIZE
    lat_targets = [max_lat - (i + 0.5) * (max_lat - min_lat) / h for i in range(h)]
    lon_targets = [min_lon + (j + 0.5) * (max_lon - min_lon) / w for j in range(w)]

    lat_idxs = _nearest_indices(lats, lat_targets)
    lon_idxs = _nearest_indices(lons, lon_targets)

    nlat = len(grid)
    nlon = len(grid[0]) if nlat > 0 else 0
    if nlat == 0 or nlon == 0:
        return bytes([0, 0, 0, 0]) * (w * h)

    rgba = bytearray(w * h * 4)
    for i, li in enumerate(lat_idxs):
        li = 0 if li < 0 else (nlat - 1 if li >= nlat else li)
        row = grid[li]
        for j, lj in enumerate(lon_idxs):
            lj = 0 if lj < 0 else (nlon - 1 if lj >= nlon else lj)
            cell = row[lj]
            idx = (i * w + j) * 4
            temp = None if cell is None else cell.get('temp')
            if temp is None or not (VALID_RANGE[0] - 5 <= float(temp) <= VALID_RANGE[1] + 5):
                rgba[idx:idx+4] = b"\x00\x00\x00\x00"
                continue
            if styled:
                r, g, b = color_from_temp(float(temp))
            else:
                r, g, b = pack_value_to_rgb(float(temp))
            rgba[idx] = r
            rgba[idx+1] = g
            rgba[idx+2] = b
            rgba[idx+3] = 255
    return bytes(rgba)

def _tile_cache_path(date_key: str, kind: str, z: int, x: int, y: int) -> str:
    base = os.path.join(CACHE_BASE_DIR, date_key, 'tiles', 'sst', kind, str(z), str(x))
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, f"{y}.png")

@app.route('/tiles/sst/meta')
def sst_tile_meta():
    date = request.args.get('date', 'current')
    return jsonify({
        'date': date,
        'encoding': {
            'scale': VALUE_SCALE,
            'offset': VALUE_OFFSET,
            'validRange': VALID_RANGE
        },
        'tile': {
            'size': TILE_SIZE,
            'format': 'png',
            'channels': ['R','G','B','A']
        }
    })

@app.route('/tiles/sst/current/<int:z>/<int:x>/<int:y>.png')
def sst_value_tile_current(z, x, y):
    lon_min, lat_min, lon_max, lat_max = tile_xyz_to_lonlat_bounds(z, x, y)
    date_key = get_cache_date_key()
    prune_cache_keep(date_key)
    cache_path = _tile_cache_path(date_key, 'value', z, x, y)
    if os.path.exists(cache_path):
        with open(cache_path, 'rb') as f:
            resp = make_response(f.read())
            resp.headers['Content-Type'] = 'image/png'
            resp.headers['X-Value-Scale'] = str(VALUE_SCALE)
            resp.headers['X-Value-Offset'] = str(VALUE_OFFSET)
            return resp
    try:
        rgba = _render_tile_rgba(lon_min, lat_min, lon_max, lat_max, date_str='current', styled=False)
        png = encode_png_rgba(rgba, TILE_SIZE, TILE_SIZE)
        with open(cache_path, 'wb') as f:
            f.write(png)
        resp = make_response(png)
        resp.headers['Content-Type'] = 'image/png'
        resp.headers['X-Value-Scale'] = str(VALUE_SCALE)
        resp.headers['X-Value-Offset'] = str(VALUE_OFFSET)
        return resp
    except Exception as e:
        logger.error(f"Tile render error (current {z}/{x}/{y}): {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/tiles/sst/<date>/<int:z>/<int:x>/<int:y>.png')
def sst_value_tile_date(date, z, x, y):
    lon_min, lat_min, lon_max, lat_max = tile_xyz_to_lonlat_bounds(z, x, y)
    date_key = date if date != 'current' else get_cache_date_key()
    # Keep only current date window; historical tiles won't be retained across days
    prune_cache_keep(get_cache_date_key())
    cache_path = _tile_cache_path(date_key, 'value', z, x, y)
    if os.path.exists(cache_path):
        with open(cache_path, 'rb') as f:
            resp = make_response(f.read())
            resp.headers['Content-Type'] = 'image/png'
            resp.headers['X-Value-Scale'] = str(VALUE_SCALE)
            resp.headers['X-Value-Offset'] = str(VALUE_OFFSET)
            return resp
    try:
        rgba = _render_tile_rgba(lon_min, lat_min, lon_max, lat_max, date_str=date, styled=False)
        png = encode_png_rgba(rgba, TILE_SIZE, TILE_SIZE)
        with open(cache_path, 'wb') as f:
            f.write(png)
        resp = make_response(png)
        resp.headers['Content-Type'] = 'image/png'
        resp.headers['X-Value-Scale'] = str(VALUE_SCALE)
        resp.headers['X-Value-Offset'] = str(VALUE_OFFSET)
        return resp
    except Exception as e:
        logger.error(f"Tile render error ({date} {z}/{x}/{y}): {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/tiles/sst/styled/current/<int:z>/<int:x>/<int:y>.png')
def sst_styled_tile_current(z, x, y):
    lon_min, lat_min, lon_max, lat_max = tile_xyz_to_lonlat_bounds(z, x, y)
    date_key = get_cache_date_key()
    prune_cache_keep(date_key)
    cache_path = _tile_cache_path(date_key, 'styled', z, x, y)
    if os.path.exists(cache_path):
        with open(cache_path, 'rb') as f:
            return Response(f.read(), mimetype='image/png')
    try:
        rgba = _render_tile_rgba(lon_min, lat_min, lon_max, lat_max, date_str='current', styled=True)
        png = encode_png_rgba(rgba, TILE_SIZE, TILE_SIZE)
        with open(cache_path, 'wb') as f:
            f.write(png)
        return Response(png, mimetype='image/png')
    except Exception as e:
        logger.error(f"Styled tile render error (current {z}/{x}/{y}): {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/tiles/sst/styled/<date>/<int:z>/<int:x>/<int:y>.png')
def sst_styled_tile_date(date, z, x, y):
    lon_min, lat_min, lon_max, lat_max = tile_xyz_to_lonlat_bounds(z, x, y)
    date_key = date if date != 'current' else get_cache_date_key()
    prune_cache_keep(get_cache_date_key())
    cache_path = _tile_cache_path(date_key, 'styled', z, x, y)
    if os.path.exists(cache_path):
        with open(cache_path, 'rb') as f:
            return Response(f.read(), mimetype='image/png')
    try:
        rgba = _render_tile_rgba(lon_min, lat_min, lon_max, lat_max, date_str=date, styled=True)
        png = encode_png_rgba(rgba, TILE_SIZE, TILE_SIZE)
        with open(cache_path, 'wb') as f:
            f.write(png)
        return Response(png, mimetype='image/png')
    except Exception as e:
        logger.error(f"Styled tile render error ({date} {z}/{x}/{y}): {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/grid/historical')
def get_historical_temperature_grid():
    """Get historical temperature grid using NOAA OI SST V2.1"""
    client_ip = request.environ.get('REMOTE_ADDR', 'unknown')
    
    try:
        center_lat = float(request.args.get('lat', 32.7))
        center_lon = float(request.args.get('lon', -117.2)) 
        grid_size = int(request.args.get('size', 10))
        region_size = float(request.args.get('region', 2.0))

        # Snap for cache friendliness / load reduction
        center_lat, center_lon, region_size = snap_parameters(center_lat, center_lon, region_size)
        target_date = request.args.get('date')
        
        if not target_date:
            return jsonify({'error': 'date parameter required (YYYY-MM-DD format)'}), 400
        
        # Validate date
        try:
            target_datetime = datetime.strptime(target_date, '%Y-%m-%d')
        except ValueError:
            return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD'}), 400
        
        # Check date range (OI SST starts 1981-09-01)
        if target_datetime < datetime(1981, 9, 1):
            return jsonify({'error': 'Date must be after 1981-09-01 for OI SST data'}), 400
            
        if target_datetime > datetime.now():
            return jsonify({'error': 'Cannot retrieve data for future dates'}), 400
        
        logger.info(f"NOAA OI SST historical request for {target_date}")
        
        # Calculate bounds
        min_lat = center_lat - region_size/2
        max_lat = center_lat + region_size/2
        min_lon = center_lon - region_size/2  
        max_lon = center_lon + region_size/2
        
        # Check cache using historical date folder (will be pruned once current date advances)
        region_hash = generate_region_hash(min_lat, max_lat, min_lon, max_lon)
        
        cached_data = load_from_cache('oisst_historical', target_date, region_hash)
        if cached_data:
            logger.info(f"🚀 Serving cached OI SST historical for {target_date}")
            return jsonify(cached_data)
        
        # Check throttling
        can_proceed, throttle_message = check_request_throttle(client_ip)
        if not can_proceed:
            return jsonify({'error': throttle_message}), 429
        
        try:
            ensure_cache_directory()
            
            # Fetch historical data via ERDDAP CSV (no SciPy/xarray required)
            grid_data, lat_points, lon_points, data_time = fetch_rtgsst_csv_grid_at_date(
                min_lat, max_lat, min_lon, max_lon, target_date
            )
            
            # Calculate statistics
            valid_temps = [cell['temp'] for row in grid_data for cell in row if cell['temp'] is not None]
            temp_stats = {
                'min': round(min(valid_temps), 1) if valid_temps else None,
                'max': round(max(valid_temps), 1) if valid_temps else None,
                'avg': round(sum(valid_temps) / len(valid_temps), 1) if valid_temps else None
            }
            
            # Prepare response
            response_data = {
                'center_latitude': center_lat,
                'center_longitude': center_lon,
                'grid_size': len(grid_data),
                'region_size_degrees': region_size,
                'grid_data': grid_data,
                'temperature_stats': temp_stats,
                'data_points': len(valid_temps),
                'source': 'NOAA MUR SST Historical',
                'target_date': target_date,
                'timestamp': datetime.now().isoformat(),
                'historical_data': True,
                'cache_info': {
                    'cached': False,
                    'cache_date': target_date,
                    'freshly_downloaded': True
                }
            }
            
            # Save to permanent cache
            save_to_cache('oisst_historical', target_date, region_hash, response_data)
            return jsonify(response_data)
            
        finally:
            release_download_slot()
            
    except Exception as e:
        logger.error(f"OI SST historical error: {e}")
        try:
            release_download_slot()
        except:
            pass
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    logger.info("🌊 Starting NOAA Ocean Data Server")
    logger.info("Data Sources:")
    logger.info(f"  📊 RTGSST: {RTGSST_CONFIG['name']} - Real-time SST")
    logger.info(f"  📈 OI SST: {OI_SST_CONFIG['name']} - Historical SST (1981-present)")  
    
    logger.info(f"Coverage: {REGION_BOUNDS}")
    
    # Initialize cache system
    try:
        ensure_cache_directory()
        # Keep only the current effective date folder to limit disk usage
        prune_cache_keep(get_cache_date_key())
        logger.info(f"💾 Cache system initialized: {CACHE_BASE_DIR}")
    except Exception as e:
        logger.warning(f"⚠️ Cache initialization issues: {e}")
    
    port = int(os.environ.get('NOAA_DATA_SERVER_PORT', '5176'))
    logger.info(f"🚀 NOAA Ocean Data Server ready on port {port}")
    app.run(host='0.0.0.0', port=port, debug=True)
# Optional: serve built frontend assets (ocean-map/dist) at /app
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ocean-map', 'dist')
FRONTEND_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ocean-map', 'data')

@app.route('/app')
def serve_app_index():
    try:
        return send_from_directory(FRONTEND_DIR, 'index.html')
    except Exception:
        return jsonify({
            'error': 'Frontend not built. Run "cd ocean-map && npm run build".'
        }), 404

@app.route('/app/<path:path>')
def serve_app_static(path):
    try:
        full_path = os.path.join(FRONTEND_DIR, path)
        if os.path.isfile(full_path):
            return send_from_directory(FRONTEND_DIR, path)
        # SPA fallback to index for client-side routing
        return send_from_directory(FRONTEND_DIR, 'index.html')
    except Exception:
        return jsonify({'error': 'Asset not found'}), 404

@app.route('/assets/<path:path>')
def serve_app_assets(path):
    try:
        assets_dir = os.path.join(FRONTEND_DIR, 'assets')
        return send_from_directory(assets_dir, path)
    except Exception:
        return jsonify({'error': 'Asset not found'}), 404

@app.route('/data/<path:path>')
def serve_frontend_data(path):
    try:
        return send_from_directory(FRONTEND_DATA_DIR, path)
    except Exception:
        return jsonify({'error': 'Data file not found'}), 404
