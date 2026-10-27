// 4 Corners Precip Map – nightly history archive.
//
// Runs on GitHub's servers (see .github/workflows/history.yml). It lists every
// public Ambient Weather Network station within 500 miles of the Four Corners
// Monument, asks the public Ambient feed for each station's readings, and works
// out each day's rain: the end-of-day value of the station's daily rain counter,
// which resets at the station's local midnight. Results go in history/ (format 2):
//   history/stations.json   { v: 2, list: [[device address, lat, lon, name, dashboard address, time zone], ...] }
//                           a station's place in the list is its number; stations are only ever added
//   history/YYYY-MM.json    { v: 2, month, days: [dates built], rows: [[station number, rain for day 1, day 2, ...], ...] }
//                           rain in hundredths of an inch (37 = 0.37 in), null where the station has no reading
//   history/index.json      { through, months: { 'YYYY-MM': [dates built] } }
// The map reads these files instead of asking Ambient station by station.
//
// DAYS (environment) = how many days back to rebuild, ending yesterday (Denver).
// Nightly runs rebuild the last 3 days to pick up late readings; the first run
// backfills a year with DAYS=365.

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.AWN_BASE || 'https://lightning.ambientweather.net';
const OUT = process.env.OUT_DIR || 'history';
const DAYS = Math.max(1, Math.min(366, +(process.env.DAYS || 3)));
const PAR = +(process.env.PAR || 40);                 // requests at a time
const CENTER = { lat: 36.99898, lon: -109.04517 };    // Four Corners Monument
const MAX_MI = 500;
const CELL_LAT = 1.0, CELL_LON = 1.2;                 // same cells as the map
const TZ = 'America/Denver';

const toRad = x => x * Math.PI / 180;
const miles = (a1, o1, a2, o2) => {
  const dl = toRad(a2 - a1), dn = toRad(o2 - o1);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * Math.sin(dn / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── dates ──
const fmtCache = new Map();
function localDay(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    fmtCache.set(tz, f);
  }
  return f.format(ms);
}
const addDays = (ds, n) => new Date(Date.parse(ds + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
function denverMidnight(ds) {   // ms of 00:00 Denver time on date ds
  for (const off of [6, 7]) { const t = Date.parse(ds + 'T00:00:00Z') + off * 3600e3; if (localDay(t, TZ) === ds && localDay(t - 3600e3, TZ) !== ds) return t; }
  return Date.parse(ds + 'T07:00:00Z');
}

// ── HTTP with retries ──
async function getJSON(url, tries = 3) {
  for (let k = 1; ; k++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': '4CPM history archive (github.com/4CPM/precip)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (k >= tries) throw e;
      await sleep(1500 * k);
    } finally { clearTimeout(timer); }
  }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

// ── 1. station list ──
async function fetchBox(w, s, e, n, depth, seen) {
  const q = new URLSearchParams({ '$publicBox[0][0]': w, '$publicBox[0][1]': s, '$publicBox[1][0]': e, '$publicBox[1][1]': n, '$limit': 100 });
  const j = await getJSON(`${BASE}/devices?${q}`);
  const arr = j.data || [];
  if (arr.length >= 100 && depth < 6) {   // the feed returns at most 100 per box, so split full boxes
    const mx = (w + e) / 2, my = (s + n) / 2;
    await Promise.all([fetchBox(w, s, mx, my, depth + 1, seen), fetchBox(mx, s, e, my, depth + 1, seen),
                       fetchBox(w, my, mx, n, depth + 1, seen), fetchBox(mx, my, e, n, depth + 1, seen)]);
  } else for (const x of arr) seen.set(x.macAddress || x._id, x);
}
async function listStations() {
  const cells = [];
  for (let i = Math.floor((CENTER.lat - 8) / CELL_LAT); i <= Math.floor((CENTER.lat + 8) / CELL_LAT); i++)
    for (let j = Math.floor((CENTER.lon - 10) / CELL_LON); j <= Math.floor((CENTER.lon + 10) / CELL_LON); j++) {
      const lat = Math.min(Math.max(CENTER.lat, i * CELL_LAT), (i + 1) * CELL_LAT), lon = Math.min(Math.max(CENTER.lon, j * CELL_LON), (j + 1) * CELL_LON);
      if (miles(CENTER.lat, CENTER.lon, lat, lon) <= MAX_MI) cells.push([i, j]);
    }
  const seen = new Map();
  let failed = 0;
  await pool(cells, 8, async ([i, j]) => {
    try { await fetchBox(j * CELL_LON, i * CELL_LAT, (j + 1) * CELL_LON, (i + 1) * CELL_LAT, 0, seen); } catch (e) { failed++; }
  });
  const out = [];
  for (const x of seen.values()) {
    const co = x.info?.coords?.geo?.coordinates;
    if (!co || !x.macAddress || !x.info?.slug) continue;
    const lat = co[1], lon = co[0];
    if (miles(CENTER.lat, CENTER.lon, lat, lon) > MAX_MI) continue;
    const last = x.lastData?.dateutc;
    out.push({ mac: x.macAddress, key: x.info.slug, lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      name: ((x.public && x.public.name) || x.info.name || 'Ambient station').trim(), tz: x.tz?.name || TZ, last, hasRain: x.lastData?.dailyrainin != null });
  }
  return { stations: out, cells: cells.length, failed };
}

// ── 2. one station's daily totals ──
function windows(first, last) {
  const start = denverMidnight(first) - 3 * 3600e3, end = Math.min(Date.now(), denverMidnight(addDays(last, 1)) + 3 * 3600e3);
  if (end - start <= 2.5 * 86400e3) return [{ start, end, res: 5 }];
  const out = [];
  for (let s = start; s < end; s += 80 * 86400e3) out.push({ start: s, end: Math.min(end, s + 80 * 86400e3), res: 60 });
  return out;
}
async function stationDays(st, first, last) {
  const dayMax = new Map();
  for (const w of windows(first, last)) {
    const q = new URLSearchParams({ macAddress: st.mac, dataKey: st.key, start: Math.round(w.start), end: Math.round(w.end), limit: 2000, res: w.res });
    const j = await getJSON(`${BASE}/device-data?${q}`);
    const arr = Array.isArray(j) ? j : (j.data || []);
    for (const x of arr) {
      if (x.dailyrainin == null || x.dateutc == null) continue;
      const ds = localDay(x.dateutc, st.tz);
      if (ds < first || ds > last) continue;
      const v = +x.dailyrainin;
      if (!(dayMax.get(ds) >= v)) dayMax.set(ds, v);
    }
  }
  return dayMax;
}

// ── 3. files ──
async function readJSON(f, fallback) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; } }
const monthDays = m => { const [y, mo] = m.split('-').map(Number), n = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`); };

async function main() {
  const yesterday = addDays(localDay(Date.now(), TZ), -1);
  const first = addDays(yesterday, -(DAYS - 1));
  log(`Rebuilding ${first} to ${yesterday} (${DAYS} days) from ${BASE}`);

  const { stations, cells, failed } = await listStations();
  log(`Station list: ${stations.length} stations with rain gauges and dashboards from ${cells} cells (${failed} cells failed)`);
  if (!stations.length) { console.error('No stations returned. Ambient may be refusing requests from this server.'); process.exit(1); }

  // skip stations that stopped reporting before the period began
  const active = stations.filter(s => s.hasRain && (!s.last || s.last >= denverMidnight(first) - 2 * 86400e3));
  log(`${active.length} stations reported during the period; fetching their readings, ${PAR} at a time`);

  const results = new Map();
  let done = 0, errs = 0, lastLog = Date.now();
  const t0 = Date.now();
  await pool(active, PAR, async st => {
    try { results.set(st.mac, await stationDays(st, first, yesterday)); } catch (e) { errs++; }
    done++;
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log(`  ${done} of ${active.length} stations (${errs} failed)`); }
  });
  log(`Fetched ${done} stations in ${Math.round((Date.now() - t0) / 1000)} s; ${errs} failed`);
  if (errs > active.length / 2) { console.error('More than half the stations failed; not writing files.'); process.exit(1); }

  await fs.mkdir(OUT, { recursive: true });
  // station list: keep stations seen before, update the rest
  const sf = path.join(OUT, 'stations.json');
  let sj = await readJSON(sf, null);
  if (!sj || sj.v !== 2) sj = { v: 2, list: [] };
  const num = new Map(sj.list.map((r, i) => [r[0], i]));
  for (const s of stations) {
    const row = [s.mac, s.lat, s.lon, s.name, s.key, s.tz];
    if (num.has(s.mac)) sj.list[num.get(s.mac)] = row; else { num.set(s.mac, sj.list.length); sj.list.push(row); }
  }
  sj.updated = new Date().toISOString();
  sj.note = 'Daily rain totals from public Ambient Weather Network stations, collected nightly for the 4 Corners Precip Map. Readings are unofficial and unverified.';
  await fs.writeFile(sf, JSON.stringify(sj));

  // month files: set every rebuilt day for every station fetched
  const days = []; for (let d = first; d <= yesterday; d = addDays(d, 1)) days.push(d);
  const months = [...new Set(days.map(d => d.slice(0, 7)))];
  for (const m of months) {
    const f = path.join(OUT, m + '.json');
    let mj = await readJSON(f, null);
    if (!mj || mj.v !== 2) mj = { v: 2, month: m, days: [], rows: [] };
    const all = monthDays(m), idx = new Map(all.map((d, i) => [d, i]));
    const byNum = new Map(mj.rows.map(r => [r[0], r]));
    const built = new Set(mj.days);
    for (const d of days) if (d.startsWith(m)) built.add(d);
    for (const [mac, dm] of results) {
      const n = num.get(mac);
      const row = byNum.get(n) || [n, ...Array(all.length).fill(null)];
      for (const d of days) if (d.startsWith(m)) { const v = dm.get(d); row[1 + idx.get(d)] = v == null ? null : Math.round(v * 100); }
      if (row.slice(1).some(v => v != null)) byNum.set(n, row); else byNum.delete(n);
    }
    mj.rows = [...byNum.values()].sort((a, b) => a[0] - b[0]);
    mj.days = [...built].sort();
    mj.updated = new Date().toISOString();
    await fs.writeFile(f, JSON.stringify(mj));
    log(`Wrote ${f}: ${mj.rows.length} stations, ${mj.days.length} days built`);
  }
  // index of months available
  const names = (await fs.readdir(OUT)).filter(n => /^\d{4}-\d{2}\.json$/.test(n)).map(n => n.slice(0, 7)).sort();
  const index = { updated: new Date().toISOString(), through: yesterday, months: {} };
  for (const m of names) { const mj = await readJSON(path.join(OUT, m + '.json'), null); if (mj && mj.v === 2) index.months[m] = mj.days; }
  index.v = 2;
  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  log('Done.');
}
main().catch(e => { console.error(e); process.exit(1); });
