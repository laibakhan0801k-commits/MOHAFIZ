# -*- coding: utf-8 -*-
"""
Builds the RAINFALL (pluvial) drainage-risk layer.

Rainfall flooding is not river flooding. It pools wherever urban drainage
is overwhelmed -- underpasses, sags, low-lying blocks -- which can be
anywhere in the sector and is often nowhere near the nullah. So the
rainfall scenario cannot validate against the river's flood polygon; it
needs its own risk geometry, and this script generates it.

Everything here is terrain- and layer-derived. There is no hydrology
model and none is claimed: these are documented PROXIES, each with a
stated reason, chosen because they are defensible for a planning tool.

Outputs (into the frontend's public/data):
    modeled_area.geojson    the DEM's real footprint -- the honest edge of
                            the demo, drawn on the map so nobody reads
                            "no risk zone" as "safe" outside it
    drainage_risk.geojson   risk pockets as classed polygons
    road_low_points.geojson road sags, split into grade-separated
                            underpasses and ordinary terrain sags

Run from Backend/:  python scripts/build_drainage_risk.py
"""

import io
import os
import sys
import json
import heapq
import numpy as np
import rasterio
from shapely.geometry import box, mapping, LineString, Point
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
DATA_OUT = os.path.join(BACKEND, '..', 'Frontend', 'mohafizweb', 'public', 'data')
DEM_PATH = os.path.join(BACKEND, 'elevation.tif')


# ---------------------------------------------------------------------
# Thresholds.
#
# EVERY elevation threshold here is a WHOLE NUMBER OF METRES, and that is
# not a style choice. This DEM stores integer metres -- 289 distinct
# values across 298m of relief -- so a sub-metre threshold cannot be
# enforced: it silently collapses onto the metre below or above it. The
# River Overflow scenario already learned this the hard way with a 0.2m
# rule that could never fire.
# ---------------------------------------------------------------------
SINK_MIN_M = 1                  # shallowest depression the DEM can express
SINK_HIGH_M = 2                 # deep enough to be dangerous to stand in
SINK_SEVERE_M = 3               # deep enough to submerge a vehicle

# A depression only matters if it is somewhere people are. Hillside
# hollows in the Margallas are real depressions and completely irrelevant
# to an urban flash-flood plan.
#
# ROADS, not buildings, define that. OSM building coverage here is badly
# uneven -- 3,920 buildings mapped in the northern half against 1,001 in
# the southern half, a 3.9x skew. Gating on buildings therefore suppressed
# risk zones hardest in the SOUTHERN sectors, which is precisely where the
# terrain has the most sinks (1,091 cells >=1m in the southernmost band
# against 444 in the northernmost). It was measuring OSM completeness, not
# urbanisation.
#
# Road coverage is near-even by comparison (6,351 north / 5,102 south,
# 1.25x), and "within 50m of a mapped road" comes out at 1.09x north/south
# -- unbiased enough to gate on, while still excluding the roadless
# interior of the hills.
ROAD_PROXIMITY_M = 50

# A depression sitting on top of the nullah drains into it. One several
# hundred metres away has nowhere to send its water -- which is exactly
# what separates pluvial risk from fluvial risk.
FAR_FROM_DRAIN_M = 300

# Imperviousness is still REPORTED per zone, but is deliberately NOT part
# of the classification, for the same OSM-completeness reason as above.
# A biased input does not become safe by being given a small weight.

# A sag becomes an UNDERPASS only if another road crosses it without
# sharing a junction node -- that is what grade separation looks like in
# the data. Without this test, half the detections were roads dipping
# through ordinary terrain hollows.
GRADE_SEP_RADIUS_M = 40

# Underpass / sag detection on the road network.
UNDERPASS_CLASSES = ('trunk', 'primary', 'secondary')
UNDERPASS_MIN_DROP_M = 2        # shallower than this is just a dip
UNDERPASS_MAX_DROP_M = 6        # deeper than this is a road crossing a ravine,
                                # not an underpass -- the earlier unfiltered
                                # pass surfaced 21m/14m/11m "sags" that were
                                # exactly that
UNDERPASS_APPROACH_M = 150      # the drop has to happen over a short distance
UNDERPASS_SAMPLE_M = 20         # densify roads so short sags are not missed
UNDERPASS_DEDUPE_M = 40         # roads.geojson stores both directions of a
                                # two-way street as separate features

MIN_ZONE_CELLS = 3              # smaller than this is raster noise


def log(msg):
    sys.stdout.write(msg + '\n')
    sys.stdout.flush()


# ---------------------------------------------------------------------
# DEM
# ---------------------------------------------------------------------
with rasterio.open(DEM_PATH) as src:
    elev = src.read(1).astype(float)
    nodata = src.nodata
    WEST, SOUTH, EAST, NORTH = src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top
elev = np.where(elev == nodata, np.nan, elev)
H, W = elev.shape

LAT_MID = (NORTH + SOUTH) / 2
M_PER_DEG_LAT = 111320.0
M_PER_DEG_LON = 111320.0 * np.cos(np.radians(LAT_MID))
CELL_H_M = (NORTH - SOUTH) / H * M_PER_DEG_LAT
CELL_W_M = (EAST - WEST) / W * M_PER_DEG_LON
CELL_AREA_M2 = CELL_H_M * CELL_W_M

log('DEM %dx%d  cell %.1fx%.1fm  elevation %.0f-%.0fm'
    % (H, W, CELL_W_M, CELL_H_M, np.nanmin(elev), np.nanmax(elev)))

step = np.min(np.diff(np.unique(elev[~np.isnan(elev)])))
log('vertical quantisation %.2fm -- all thresholds below are whole metres' % step)


def cell_lonlat(row, col):
    return (WEST + (col + 0.5) / W * (EAST - WEST),
            NORTH - (row + 0.5) / H * (NORTH - SOUTH))


def sample_elev(lon, lat):
    c = int((lon - WEST) / (EAST - WEST) * W)
    r = int((NORTH - lat) / (NORTH - SOUTH) * H)
    if 0 <= r < H and 0 <= c < W:
        return elev[r, c]
    return np.nan


# ---------------------------------------------------------------------
# 1. Depression fill -> sink depth. The primary signal: how deep the
#    water can stand before it spills out and drains away.
# ---------------------------------------------------------------------
def priority_flood(dem):
    mask = np.isnan(dem)
    work = np.where(mask, np.inf, dem)
    closed = mask.copy()
    pq = []
    h, w = dem.shape
    for i in range(h):
        for j in (0, w - 1):
            if not closed[i, j]:
                heapq.heappush(pq, (work[i, j], i, j))
                closed[i, j] = True
    for j in range(w):
        for i in (0, h - 1):
            if not closed[i, j]:
                heapq.heappush(pq, (work[i, j], i, j))
                closed[i, j] = True
    while pq:
        z, i, j = heapq.heappop(pq)
        for di, dj in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            ni, nj = i + di, j + dj
            if ni < 0 or nj < 0 or ni >= h or nj >= w or closed[ni, nj]:
                continue
            nz = max(work[ni, nj], z)
            work[ni, nj] = nz
            closed[ni, nj] = True
            heapq.heappush(pq, (nz, ni, nj))
    return np.where(mask, np.nan, work)


log('filling depressions...')
filled = priority_flood(elev)
sink = np.where(np.isnan(elev), np.nan, filled - elev)
sink_int = np.where(np.isnan(sink), np.nan, np.round(sink))


# ---------------------------------------------------------------------
# 2. Surface cover and the built-up mask
# ---------------------------------------------------------------------
def load(name):
    with io.open(os.path.join(DATA_OUT, name), encoding='utf-8') as f:
        return json.load(f)


def polygon_centroid_and_area(geom):
    if geom['type'] == 'Point':
        return geom['coordinates'][0], geom['coordinates'][1], 120.0
    ring = geom['coordinates'][0] if geom['type'] == 'Polygon' else geom['coordinates'][0][0]
    if len(ring) < 3:
        return None
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    a = 0.0
    for k in range(len(ring) - 1):
        a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]
    area_m2 = abs(a) / 2 * M_PER_DEG_LON * M_PER_DEG_LAT
    return sum(xs) / len(xs), sum(ys) / len(ys), area_m2


buildings = load('buildings.geojson')
impervious = np.zeros((H, W))
building_pts = []
for f in buildings['features']:
    g = f.get('geometry') or {}
    if g.get('type') not in ('Point', 'Polygon', 'MultiPolygon'):
        continue
    res = polygon_centroid_and_area(g)
    if not res:
        continue
    lon, lat, area = res
    building_pts.append((lon, lat))
    c = int((lon - WEST) / (EAST - WEST) * W)
    r = int((NORTH - lat) / (NORTH - SOUTH) * H)
    if 0 <= r < H and 0 <= c < W:
        impervious[r, c] += area
impervious = np.minimum(impervious / CELL_AREA_M2, 1.0)

log('buildings %d rasterised for reporting (not used to gate risk)' % len(building_pts))


# ---------------------------------------------------------------------
# 3. Distance to mapped drainage
# ---------------------------------------------------------------------
ways = load('waterways.geojson')
drain_pts = []
for f in ways['features']:
    g = f.get('geometry') or {}
    if g.get('type') == 'LineString':
        drain_pts.extend(g['coordinates'])
    elif g.get('type') == 'MultiLineString':
        for part in g['coordinates']:
            drain_pts.extend(part)
drain_pts = np.array(drain_pts)

rows, cols = np.indices((H, W))
cell_lon = WEST + (cols + 0.5) / W * (EAST - WEST)
cell_lat = NORTH - (rows + 0.5) / H * (NORTH - SOUTH)
dist_drain = np.full((H, W), np.inf)
for k in range(0, len(drain_pts), 3):
    dx = (cell_lon - drain_pts[k, 0]) * M_PER_DEG_LON
    dy = (cell_lat - drain_pts[k, 1]) * M_PER_DEG_LAT
    np.minimum(dist_drain, np.sqrt(dx * dx + dy * dy), out=dist_drain)


# ---------------------------------------------------------------------
# 5. Contiguous cells -> polygons
# ---------------------------------------------------------------------
def components(mask):
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for i in range(H):
        for j in range(W):
            if not mask[i, j] or seen[i, j]:
                continue
            stack = [(i, j)]
            seen[i, j] = True
            comp = []
            while stack:
                a, b = stack.pop()
                comp.append((a, b))
                for da, db in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    na, nb = a + da, b + db
                    if 0 <= na < H and 0 <= nb < W and mask[na, nb] and not seen[na, nb]:
                        seen[na, nb] = True
                        stack.append((na, nb))
            out.append(comp)
    return out


roads = load('roads.geojson')

# Inhabited mask: within ROAD_PROXIMITY_M of any mapped road.
_rr = max(1, int(round(ROAD_PROXIMITY_M / CELL_H_M)))
_cc = max(1, int(round(ROAD_PROXIMITY_M / CELL_W_M)))
inhabited = np.zeros((H, W), dtype=bool)
for f in roads['features']:
    for lo, la in f['geometry']['coordinates']:
        c0 = int((lo - WEST) / (EAST - WEST) * W)
        r0 = int((NORTH - la) / (NORTH - SOUTH) * H)
        if 0 <= r0 < H and 0 <= c0 < W:
            inhabited[max(0, r0 - _rr):r0 + _rr + 1, max(0, c0 - _cc):c0 + _cc + 1] = True
log('inhabited cells %d (%.1f%% of map, within %dm of a mapped road)'
    % (inhabited.sum(), 100 * inhabited.mean(), ROAD_PROXIMITY_M))

# ---------------------------------------------------------------------
# 4. Risk classification -- whole-metre thresholds only
# ---------------------------------------------------------------------
far_from_drain = dist_drain >= FAR_FROM_DRAIN_M

risk_class = np.zeros((H, W), dtype=int)          # 0 none, 1 moderate, 2 high, 3 severe
valid = ~np.isnan(sink_int) & inhabited
# moderate needs the extra qualifier: a 1m dip right beside the nullah
# drains into it, so only count shallow sinks that have nowhere to send
# their water.
risk_class[valid & (sink_int >= SINK_MIN_M) & far_from_drain] = 1
risk_class[valid & (sink_int >= SINK_HIGH_M)] = 2
risk_class[valid & (sink_int >= SINK_SEVERE_M)] = 3

CLASS_NAMES = {1: 'moderate', 2: 'high', 3: 'severe'}
for k in (1, 2, 3):
    n = int((risk_class == k).sum())
    log('  %-9s %5d cells  %.2f km2' % (CLASS_NAMES[k], n, n * CELL_AREA_M2 / 1e6))

zone_features = []
zone_id = 0
for k in (3, 2, 1):
    for comp in components(risk_class == k):
        if len(comp) < MIN_ZONE_CELLS:
            continue
        boxes = []
        for (r, c) in comp:
            lon0 = WEST + c / W * (EAST - WEST)
            lon1 = WEST + (c + 1) / W * (EAST - WEST)
            lat1 = NORTH - r / H * (NORTH - SOUTH)
            lat0 = NORTH - (r + 1) / H * (NORTH - SOUTH)
            boxes.append(box(lon0, lat0, lon1, lat1))
        poly = unary_union(boxes).simplify(0.00002, preserve_topology=True)

        depths = [sink_int[r, c] for (r, c) in comp]
        imp = float(np.mean([impervious[r, c] for (r, c) in comp]))
        dmin = float(np.min([dist_drain[r, c] for (r, c) in comp]))
        cen = poly.centroid
        zone_id += 1
        zone_features.append({
            'type': 'Feature',
            'properties': {
                'zone_id': zone_id,
                'risk_class': CLASS_NAMES[k],
                'max_sink_m': int(np.max(depths)),
                'mean_sink_m': int(round(float(np.mean(depths)))),
                'cells': len(comp),
                'area_m2': int(round(len(comp) * CELL_AREA_M2)),
                'impervious_frac': round(imp, 3),
                'min_dist_to_drain_m': int(round(dmin)),
                'centroid_lon': round(cen.x, 6),
                'centroid_lat': round(cen.y, 6),
            },
            'geometry': mapping(poly),
        })

log('risk zones: %d polygons (min %d cells each)' % (len(zone_features), MIN_ZONE_CELLS))


# ---------------------------------------------------------------------
# 6. Underpass / sag detection
# ---------------------------------------------------------------------
def densify(coords, spacing_m):
    out = []
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        dx = (lon2 - lon1) * M_PER_DEG_LON
        dy = (lat2 - lat1) * M_PER_DEG_LAT
        seg = np.hypot(dx, dy)
        n = max(1, int(seg // spacing_m))
        for t in range(n):
            f = t / n
            out.append((lon1 + (lon2 - lon1) * f, lat1 + (lat2 - lat1) * f))
    out.append(tuple(coords[-1]))
    return out


def running_dist(pts):
    d = [0.0]
    for i in range(1, len(pts)):
        dx = (pts[i][0] - pts[i - 1][0]) * M_PER_DEG_LON
        dy = (pts[i][1] - pts[i - 1][1]) * M_PER_DEG_LAT
        d.append(d[-1] + np.hypot(dx, dy))
    return d


# Spatial index over road geometries, for the grade-separation test.
road_lines = []
for f in roads['features']:
    c = f['geometry']['coordinates']
    road_lines.append(LineString(c) if len(c) >= 2 else None)

BUCKET_DEG = 0.001
road_index = {}
for fi, f in enumerate(roads['features']):
    for (lo, la) in f['geometry']['coordinates']:
        road_index.setdefault((int(lo / BUCKET_DEG), int(la / BUCKET_DEG)), set()).add(fi)


def crosses_at_different_level(own_index, lon, lat):
    """
    True when another road actually CROSSES this one within
    GRADE_SEP_RADIUS_M of the point, sharing no junction node.

    Sharing no node is the signal: at a normal intersection the two roads
    meet at a common graph node. A crossing with no shared node is a
    bridge or an underpass -- one road passes over the other.
    """
    own_line = road_lines[own_index]
    if own_line is None:
        return False
    own = roads['features'][own_index]['properties']
    own_nodes = {own.get('u'), own.get('v')}

    cand = set()
    bx, by = int(lon / BUCKET_DEG), int(lat / BUCKET_DEG)
    for i in (-1, 0, 1):
        for j in (-1, 0, 1):
            cand |= road_index.get((bx + i, by + j), set())

    here = Point(lon, lat)
    for fi in cand:
        if fi == own_index or road_lines[fi] is None:
            continue
        other = roads['features'][fi]['properties']
        if {other.get('u'), other.get('v')} & own_nodes:
            continue                       # meets at a junction: same level
        inter = own_line.intersection(road_lines[fi])
        if inter.is_empty:
            continue
        # the crossing has to be at THIS sag, not 500m down the road
        d_deg = inter.distance(here)
        if d_deg * M_PER_DEG_LAT <= GRADE_SEP_RADIUS_M:
            return True
    return False


raw_sags = []
scanned = 0
for road_i, f in enumerate(roads['features']):
    hw = f['properties'].get('highway')
    if isinstance(hw, list):
        hw = hw[0]
    if hw not in UNDERPASS_CLASSES:
        continue
    coords = f['geometry']['coordinates']
    if len(coords) < 2:
        continue
    scanned += 1

    pts = densify(coords, UNDERPASS_SAMPLE_M)
    zs = [sample_elev(p[0], p[1]) for p in pts]
    if any(np.isnan(z) for z in zs):
        continue
    dist = running_dist(pts)

    for i in range(1, len(zs) - 1):
        if zs[i] > zs[i - 1] or zs[i] > zs[i + 1]:
            continue                                   # not a local minimum

        # Walk out both ways: how far does the road climb, and how fast?
        rise_l = 0.0
        for j in range(i - 1, -1, -1):
            if dist[i] - dist[j] > UNDERPASS_APPROACH_M:
                break
            rise_l = max(rise_l, zs[j] - zs[i])
        rise_r = 0.0
        for j in range(i + 1, len(zs)):
            if dist[j] - dist[i] > UNDERPASS_APPROACH_M:
                break
            rise_r = max(rise_r, zs[j] - zs[i])

        drop = min(rise_l, rise_r)                     # a sag needs BOTH sides up
        if UNDERPASS_MIN_DROP_M <= drop <= UNDERPASS_MAX_DROP_M:
            r = int((NORTH - pts[i][1]) / (NORTH - SOUTH) * H)
            c = int((pts[i][0] - WEST) / (EAST - WEST) * W)
            sd = sink_int[r, c] if (0 <= r < H and 0 <= c < W) else 0
            raw_sags.append({
                'lon': pts[i][0], 'lat': pts[i][1],
                'drop_m': int(round(drop)),
                'sink_depth_m': int(sd if not np.isnan(sd) else 0),
                'highway': hw,
                'name': f['properties'].get('name'),
                'u': f['properties'].get('u'), 'v': f['properties'].get('v'),
                'road_index': road_i,
            })

# Dedupe: both directions of a two-way street are separate features.
raw_sags.sort(key=lambda s: -s['drop_m'])
sags = []
for s in raw_sags:
    dup = False
    for keep in sags:
        dx = (s['lon'] - keep['lon']) * M_PER_DEG_LON
        dy = (s['lat'] - keep['lat']) * M_PER_DEG_LAT
        if np.hypot(dx, dy) < UNDERPASS_DEDUPE_M:
            dup = True
            break
    if not dup:
        sags.append(s)

# Grade separation decides underpass vs ordinary sag.
for s in sags:
    s['kind'] = ('underpass'
                 if crosses_at_different_level(s['road_index'], s['lon'], s['lat'])
                 else 'sag')
    del s['road_index']

n_under = sum(1 for s in sags if s['kind'] == 'underpass')
log('road low points: %d trunk/primary/secondary features -> %d raw -> %d after dedupe'
    % (scanned, len(raw_sags), len(sags)))
log('   underpasses (grade-separated crossing) : %d' % n_under)
log('   ordinary sags (terrain hollow)         : %d' % (len(sags) - n_under))
by_class = {}
for s in sags:
    key = s['highway'] + '/' + s['kind']
    by_class[key] = by_class.get(key, 0) + 1
for k, v in sorted(by_class.items(), key=lambda x: -x[1]):
    log('   %-24s %d' % (k, v))


# ---------------------------------------------------------------------
# 7. Write the layers
# ---------------------------------------------------------------------
def write(name, obj):
    path = os.path.join(DATA_OUT, name)
    with io.open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f)
    log('wrote %-24s %8.1f KB' % (name, os.path.getsize(path) / 1024))


write('modeled_area.geojson', {
    'type': 'FeatureCollection',
    'features': [{
        'type': 'Feature',
        'properties': {
            'name': 'Modeled area',
            'note': 'Terrain data covers only this rectangle. Outside it nothing is modeled -- absence of a risk zone is not evidence of safety.',
            'west': WEST, 'south': SOUTH, 'east': EAST, 'north': NORTH,
            'cell_width_m': round(CELL_W_M, 1), 'cell_height_m': round(CELL_H_M, 1),
        },
        'geometry': mapping(box(WEST, SOUTH, EAST, NORTH)),
    }],
})

write('drainage_risk.geojson', {
    'type': 'FeatureCollection',
    'properties': {
        'sink_min_m': SINK_MIN_M, 'sink_high_m': SINK_HIGH_M, 'sink_severe_m': SINK_SEVERE_M,
        'road_proximity_m': ROAD_PROXIMITY_M, 'far_from_drain_m': FAR_FROM_DRAIN_M,
    },
    'features': zone_features,
})

write('road_low_points.geojson', {
    'type': 'FeatureCollection',
    'properties': {
        'min_drop_m': UNDERPASS_MIN_DROP_M, 'max_drop_m': UNDERPASS_MAX_DROP_M,
        'approach_m': UNDERPASS_APPROACH_M, 'classes': list(UNDERPASS_CLASSES),
        'grade_sep_radius_m': GRADE_SEP_RADIUS_M,
        'kinds': {'underpass': 'sag at a grade-separated crossing',
                  'sag': 'sag through ordinary terrain'},
    },
    'features': [{
        'type': 'Feature',
        'properties': {k: v for k, v in s.items() if k not in ('lon', 'lat')},
        'geometry': {'type': 'Point', 'coordinates': [s['lon'], s['lat']]},
    } for s in sags],
})


# ---------------------------------------------------------------------
# 8. Where did they land? Expected: clustered south / south-east, since
#    the sector drains toward ~163 degrees.
# ---------------------------------------------------------------------
log('')
log('=' * 66)
log('SPATIAL DISTRIBUTION CHECK')
if zone_features:
    lats = np.array([f['properties']['centroid_lat'] for f in zone_features])
    lons = np.array([f['properties']['centroid_lon'] for f in zone_features])
    weights = np.array([f['properties']['cells'] for f in zone_features], dtype=float)
    mid_lat = (NORTH + SOUTH) / 2
    mid_lon = (EAST + WEST) / 2
    south_share = 100 * weights[lats < mid_lat].sum() / weights.sum()
    east_share = 100 * weights[lons > mid_lon].sum() / weights.sum()
    log('  zone AREA in the southern half : %.0f%%' % south_share)
    log('  zone AREA in the eastern half  : %.0f%%' % east_share)
    log('  area-weighted centroid         : %.4f N, %.4f E' % (
        float((lats * weights).sum() / weights.sum()),
        float((lons * weights).sum() / weights.sum())))
    log('  sector centre                  : %.4f N, %.4f E' % (mid_lat, mid_lon))
    if south_share >= 55:
        log('  -> matches the expected southward drainage bias')
    else:
        log('  -> WARNING: not southward-biased. Check the DEM orientation.')
log('=' * 66)
