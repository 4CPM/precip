// 4 Corners Precip Map – boundary files (v1.73).
//
// Runs on GitHub's servers (see .github/workflows/boundaries.yml), by hand from the Actions tab.
// It asks the USGS Watershed Boundary Dataset service and the Census Bureau's TIGERweb service for every
// hydrologic unit, county and state that touches the map's 500-mile region, generalized for drawing, and
// writes them to boundaries/ so the map can draw them at once instead of asking the services as it pans:
//   boundaries/huc2.json, huc4.json, huc6.json, huc8.json   whole region, one GeoJSON file per level
//   boundaries/huc10/<huc4>.json                              HUC10 watersheds, one file per HUC4 subregion
//   boundaries/huc12/<huc6>.json                              HUC12 subwatersheds, one file per HUC6 basin
//   boundaries/counties.json, states.json                     Census generalized (1:500k) lines
//   boundaries/index.json                                     what was built, and the tiles that exist
// Lines are generalized to about 0.1 mile (coarser for the big units), which is finer than a screen pixel at
// the zooms each level is drawn at. The map fetches a picked boundary again at full detail from the service.

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = process.env.OUT_DIR || 'boundaries';
const WBD = 'https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/';
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2025/State_County/MapServer/';
const LAYER = { 2: 1, 4: 2, 6: 3, 8: 4, 10: 5, 12: 6 };
// 500 miles around the Four Corners Monument (36.99898, -109.04517), with a little margin
const BBOX = [-118.4, 29.45, -99.7, 44.55];
const PAR = +(process.env.PAR || 4);
const LEVELS = (process.env.LEVELS || '2,4,6,8,10,12').split(',').map(Number);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function getJSON(url, tries = 4) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(240000), headers: { 'user-agent': '4CPM precip map boundaries build (github actions)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j;
    } catch (e) {
      if (k >= tries) throw e;
      log('  retry', k, String(e.message || e).slice(0, 80));
      await sleep(5000 * k);
    }
  }
}
// One layer query, paged when the service caps the count
async function query(base, layer, params) {
  const feats = []; let offset = 0;
  for (;;) {
    const p = new URLSearchParams({ ...params, returnGeometry: 'true', outSR: '4326', f: 'geojson', resultOffset: String(offset), resultRecordCount: '1000' });
    const j = await getJSON(`${base}${layer}/query?${p}`);
    const got = j.features || [];
    feats.push(...got);
    if (!(j.properties && j.properties.exceededTransferLimit) || !got.length) break;
    offset += got.length;
  }
  return feats;
}
const inRegion = { geometry: BBOX.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' };
const r3 = v => Math.round(v * 1000) / 1000;
function slim(f, fields) {
  const p = {};
  for (const k of fields) { const v = f.properties[k] ?? f.properties[k.toUpperCase()] ?? f.properties[k.toLowerCase()]; if (v != null) p[k] = typeof v === 'number' && k === 'areasqkm' ? r3(v) : v; }
  return { type: 'Feature', properties: p, geometry: f.geometry };
}
const fc = features => ({ type: 'FeatureCollection', features });
async function pmap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); } }));
  return out;
}
async function write(rel, obj) {
  const file = path.join(OUT, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const txt = JSON.stringify(obj);
  await fs.writeFile(file, txt);
  log('  wrote', rel, (txt.length / 1024).toFixed(0) + ' kB', obj.features ? obj.features.length + ' features' : '');
  return txt.length;
}
const dedupe = (feats, key) => { const m = new Map(); for (const f of feats) m.set(f.properties[key], f); return [...m.values()].sort((a, b) => String(a.properties[key]).localeCompare(String(b.properties[key]))); };

const index = { built: new Date().toISOString(), bbox: BBOX, counts: {}, huc10: [], huc12: [] };
const t0 = Date.now();

// ── HUC2, 4, 6: one query each ──
const byLevel = {};
for (const L of [2, 4, 6]) {
  log(`HUC${L}`);
  const feats = await query(WBD, LAYER[L], { ...inRegion, where: '1=1', outFields: '*', maxAllowableOffset: L === 2 ? '0.005' : '0.003', geometryPrecision: '3' });
  byLevel[L] = dedupe(feats.map(f => slim(f, [`huc${L}`, 'name', 'areasqkm', 'states'])), `huc${L}`);
  if (LEVELS.includes(L)) await write(`huc${L}.json`, fc(byLevel[L]));
  index.counts[`huc${L}`] = byLevel[L].length;
}
const huc4s = byLevel[4].map(f => f.properties.huc4), huc6s = byLevel[6].map(f => f.properties.huc6);

// ── HUC8: by HUC4, kept to the region ──
log('HUC8 by', huc4s.length, 'HUC4s');
const huc8 = dedupe((await pmap(huc4s, PAR, async h4 => {
  const feats = await query(WBD, LAYER[8], { ...inRegion, where: `huc8 LIKE '${h4}%'`, outFields: '*', maxAllowableOffset: '0.002', geometryPrecision: '3' });
  log('  HUC8', h4, feats.length);
  return feats.map(f => slim(f, ['huc8', 'name', 'areasqkm', 'states']));
})).flat(), 'huc8');
if (LEVELS.includes(8)) await write('huc8.json', fc(huc8));
index.counts.huc8 = huc8.length;
const huc8s = huc8.map(f => f.properties.huc8);

// ── HUC10: by HUC6, filed by HUC4 ──
if (LEVELS.includes(10)) {
  log('HUC10 by', huc6s.length, 'HUC6s');
  const all = dedupe((await pmap(huc6s, PAR, async h6 => {
    const feats = await query(WBD, LAYER[10], { ...inRegion, where: `huc10 LIKE '${h6}%'`, outFields: '*', maxAllowableOffset: '0.0012', geometryPrecision: '4' });
    log('  HUC10', h6, feats.length);
    return feats.map(f => slim(f, ['huc10', 'name', 'areasqkm']));
  })).flat(), 'huc10');
  const groups = new Map();
  for (const f of all) { const k = f.properties.huc10.slice(0, 4); (groups.get(k) || groups.set(k, []).get(k)).push(f); }
  for (const [h4, feats] of [...groups].sort()) { const kb = await write(`huc10/${h4}.json`, fc(feats)); index.huc10.push({ huc4: h4, n: feats.length, kb: Math.round(kb / 1024) }); }
  index.counts.huc10 = all.length;
}

// ── HUC12: by HUC8, filed by HUC6 ──
if (LEVELS.includes(12)) {
  log('HUC12 by', huc8s.length, 'HUC8s');
  const all = dedupe((await pmap(huc8s, PAR, async h8 => {
    const feats = await query(WBD, LAYER[12], { ...inRegion, where: `huc12 LIKE '${h8}%'`, outFields: '*', maxAllowableOffset: '0.0008', geometryPrecision: '4' });
    log('  HUC12', h8, feats.length);
    return feats.map(f => slim(f, ['huc12', 'name', 'areasqkm']));
  })).flat(), 'huc12');
  const groups = new Map();
  for (const f of all) { const k = f.properties.huc12.slice(0, 6); (groups.get(k) || groups.set(k, []).get(k)).push(f); }
  for (const [h6, feats] of [...groups].sort()) { const kb = await write(`huc12/${h6}.json`, fc(feats)); index.huc12.push({ huc6: h6, n: feats.length, kb: Math.round(kb / 1024) }); }
  index.counts.huc12 = all.length;
}

// ── Counties and states (Census, generalized 1:500k) ──
log('counties');
const counties = dedupe((await query(TIGER, 11, { ...inRegion, where: '1=1', outFields: 'GEOID,NAME,BASENAME,STATE', maxAllowableOffset: '0.0015', geometryPrecision: '3' }))
  .map(f => slim(f, ['GEOID', 'NAME', 'BASENAME', 'STATE'])), 'GEOID');
await write('counties.json', fc(counties)); index.counts.counties = counties.length;
log('states');
const states = dedupe((await query(TIGER, 7, { ...inRegion, where: '1=1', outFields: 'GEOID,NAME,STUSAB', maxAllowableOffset: '0.002', geometryPrecision: '3' }))
  .map(f => slim(f, ['GEOID', 'NAME', 'STUSAB'])), 'GEOID');
await write('states.json', fc(states)); index.counts.states = states.length;

index.minutes = +((Date.now() - t0) / 60000).toFixed(1);
await write('index.json', index);
log('done in', index.minutes, 'min', JSON.stringify(index.counts));
