// 4 Corners Precip Map – hourly rain archive.
//
// Ambient's public feed keeps 5-minute readings for only about 8 days, so this
// job saves them as hourly rain before they age out. It runs once a day on
// GitHub's servers (see .github/workflows/hourly.yml), after the daily archive,
// and uses the station list in history/stations.json (station numbers match).
//
// For each station it asks for 5-minute readings, takes the rise of the daily
// rain counter between readings (a drop means the counter reset at the
// station's midnight, so the new value is the rise), and adds the rises up by
// hour of the station's local day, so a station's 24 hours add up to its daily
// total. Rain between readings more than 5 minutes apart is spread over the
// time between them. It also keeps the day's fastest 5-minute rate.
//
// Some owners set their station to the wrong time zone (Paramaribo, GMT ...).
// Those stations' "local day" is taken from their location instead, and the
// daily archive's totals for them are recomputed here from the hours, for the
// days the hourly archive covers.
//   history/hourly/YYYY-MM-DD.json   (format 2)
//     { v: 2, date, rows: [[station number, rain in hour 0, hour 1, ... hour 23, peak rate], ...] }
//     hour 0 is midnight to 1 AM on that station's local day (the station's time
//     zone is in stations.json, or in tzfix.json when it was corrected);
//     rain in hundredths of an inch; peak rate in hundredths of an inch per hour;
//     null for an hour with no readings. Stations with no readings that day are left out.
//     Format 1 files (Oct 19, 2026 and earlier runs) used hours on Denver time instead.
//   history/hourly/tzfix.json  { station number: corrected time zone }
//   history/hourly/index.json  { days: [dates saved] }
//
// DAYS (environment) = days to save, ending yesterday (Denver); 1 nightly,
// up to 8 for the first run (older 5-minute readings are no longer available).

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.AWN_BASE || 'https://lightning.ambientweather.net';
const OUT = process.env.OUT_DIR || 'history';
const DAYS = Math.max(1, Math.min(8, +(process.env.DAYS || 1)));
const PAR = +(process.env.PAR || 40);
const TZ = 'America/Denver';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fmts = new Map();
function partsIn(ms, tz) {
  let f = fmts.get(tz);
  if (!f) { try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { f = partsIn.denver; } fmts.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(ms)) o[p.type] = p.value;
  return { day: `${o.year}-${o.month}-${o.day}`, hour: +o.hour, minute: +o.minute };
}
partsIn.denver = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const parts = ms => partsIn(ms, TZ);
// hours a zone is behind UTC at a moment (7 for Denver in winter), or null for an unknown zone
function offsetH(tz, ms) {
  try { const p = partsIn(ms, tz), u = new Date(ms); return Math.round(((u.getUTCHours() - p.hour + 24 + 12) % 24) - 12); } catch { return null; }
}
// the zone a location in this region should be on (rough boundaries, good enough to catch wrong settings)
function zoneFor(lat, lon) {
  if (lat >= 31.3 && lat <= 37.0 && lon >= -114.8 && lon <= -109.05) return 'America/Phoenix';
  if (lon < -114.05 && lat >= 35.0) return 'America/Los_Angeles';
  if (lon < -114.6) return 'America/Los_Angeles';
  if (lon > -101.5) return 'America/Chicago';
  if (lon > -103.04 && lat < 37.0) return 'America/Chicago';
  if (lat < 31.8 && lon > -104.9) return 'America/Chicago';   // west Texas east of El Paso
  return TZ;
}
const addDays = (ds, n) => new Date(Date.parse(ds + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
function denverMidnight(ds) {
  for (const off of [6, 7]) { const t = Date.parse(ds + 'T00:00:00Z') + off * 3600e3; if (parts(t).day === ds && parts(t).hour === 0 && parts(t - 3600e3).day !== ds) return t; }
  return Date.parse(ds + 'T07:00:00Z');
}

async function getJSON(url, tries = 3) {
  for (let k = 1; ; k++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': '4CPM history archive (github.com/4CPM/precip)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (k >= tries) throw e; await sleep(1500 * k); }
    finally { clearTimeout(timer); }
  }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}
async function readJSON(f, fallback) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; } }

// 5-minute readings for one station over [start, end], in windows the feed allows (2,000 readings each)
async function readings(st, start, end) {
  const out = [];
  for (let s = start; s < end; s += 6 * 86400e3) {
    const q = new URLSearchParams({ macAddress: st.mac, dataKey: st.key, start: Math.round(s), end: Math.round(Math.min(end, s + 6 * 86400e3)), limit: 2000, res: 5 });
    const j = await getJSON(`${BASE}/device-data?${q}`);
    for (const x of (Array.isArray(j) ? j : (j.data || []))) if (x.dateutc != null && x.dailyrainin != null) out.push([x.dateutc, +x.dailyrainin]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.filter((x, i) => i === 0 || x[0] !== out[i - 1][0]);
}

// rain per hour of the station's local day (dayTz), plus the day's fastest 5-minute rate.
// A rise between two readings is spread over the time between them, hour by hour.
function hourly(rs, days, dayTz) {
  const want = new Set(days), res = new Map();
  const add = (ms, amt) => {
    const { day, hour } = partsIn(ms, dayTz);
    if (!want.has(day)) return null;
    let e = res.get(day);
    if (!e) res.set(day, e = { h: Array(24).fill(null), peak: 0, first: ms });
    e.h[hour] = (e.h[hour] || 0) + amt;
    return e;
  };
  for (let i = 1; i < rs.length; i++) {
    const [t, v] = rs[i], [t0, v0] = rs[i - 1];
    const rise = v >= v0 ? v - v0 : v;          // a drop is the midnight reset
    const gap = (t - t0) / 60e3;
    if (gap <= 6) { const e = add(t, rise); if (e && gap >= 4 && rise > 0) e.peak = Math.max(e.peak, rise * 60 / gap); continue; }
    // longer gap: split [t0, t] at hour boundaries and share the rise by time
    for (let a = t0; a < t; ) {
      const b = Math.min(t, (Math.floor(a / 3600e3) + 1) * 3600e3);
      add((a + b) / 2, rise * (b - a) / (t - t0));
      a = b;
    }
  }
  return res;
}

async function main() {
  const today = parts(Date.now()).day, yesterday = addDays(today, -1);
  const days = []; for (let k = DAYS - 1; k >= 0; k--) days.push(addDays(yesterday, -k));
  log(`Saving hourly rain for ${days[0]} to ${yesterday} (${DAYS} days) from ${BASE}`);

  const sj = await readJSON(path.join(OUT, 'stations.json'), null);
  if (!sj || sj.v !== 2) { console.error('history/stations.json (format 2) not found; run the daily archive first.'); process.exit(1); }
  // stations that reported in the daily archive's latest month
  const idx = await readJSON(path.join(OUT, 'index.json'), { months: {} });
  const lastMonth = Object.keys(idx.months || {}).sort().pop();
  const mj = lastMonth ? await readJSON(path.join(OUT, lastMonth + '.json'), null) : null;
  const active = mj ? [...new Set(mj.rows.map(r => r[0]))] : sj.list.map((_, i) => i);
  const now = Date.now();
  // clocks this region legitimately uses (Pacific, Arizona, Mountain, Central). The Navajo Nation
  // and stations near state lines can be on either side's zone, so only a clock that matches
  // none of these is treated as set wrong.
  const regional = new Set(['America/Los_Angeles', 'America/Phoenix', TZ, 'America/Chicago'].map(z => offsetH(z, now)));
  const stations = active.map(n => {
    const [mac, lat, lon, , key, tz] = sj.list[n];
    const own = offsetH(tz, now);
    const fix = own == null || !regional.has(own) ? zoneFor(lat, lon) : null;
    return { n, mac, key, dayTz: fix || tz, fix };
  }).filter(s => s.mac && s.key);
  const fixes = stations.filter(s => s.fix);
  log(`${stations.length} stations from the daily archive (${fixes.length} with a time zone that doesn't match their location); fetching 5-minute readings, ${PAR} at a time`);

  // 6 hours either side so every station's local days are covered
  const start = denverMidnight(days[0]) - 6 * 3600e3, end = Math.min(Date.now(), denverMidnight(addDays(yesterday, 1)) + 6 * 3600e3);
  const byDay = new Map(days.map(d => [d, new Map()]));
  let done = 0, errs = 0, lastLog = Date.now();
  const t0 = Date.now();
  await pool(stations, PAR, async st => {
    try {
      const rs = await readings(st, start, end);
      const res = hourly(rs, days, st.dayTz);
      for (const [d, e] of res) {
        const h = e.h.map(v => v == null ? null : Math.round(v * 100));
        if (h.every(v => v == null)) continue;
        // complete only if readings start before the day does (older readings age out of the feed)
        const p = partsIn(rs[0][0], st.dayTz), complete = p.day < d || (p.day === d && p.hour === 0 && p.minute <= 10);
        byDay.get(d).set(st.n, { row: [st.n, ...h, Math.round(e.peak * 100)], complete });
      }
    } catch (e) { errs++; }
    done++;
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log(`  ${done} of ${stations.length} stations (${errs} failed)`); }
  });
  log(`Fetched ${done} stations in ${Math.round((Date.now() - t0) / 1000)} s; ${errs} failed`);
  if (errs > stations.length / 2) { console.error('More than half the stations failed; not writing files.'); process.exit(1); }

  const dir = path.join(OUT, 'hourly');
  await fs.mkdir(dir, { recursive: true });
  // corrected time zones
  const tf = path.join(dir, 'tzfix.json'), tzfix = await readJSON(tf, {});
  for (const s of fixes) tzfix[s.n] = s.fix;
  await fs.writeFile(tf, JSON.stringify(tzfix));
  for (const [d, got] of byDay) {
    const f = path.join(dir, d + '.json'), old = await readJSON(f, null);
    const keep = new Map(old && old.v === 2 ? old.rows.map(r => [r[0], r]) : []);
    let replaced = 0, kept = 0;
    for (const [n, x] of got) {
      // a day already saved is replaced only by a complete one
      if (x.complete || !keep.has(n)) { keep.set(n, x.row); replaced++; } else kept++;
    }
    if (old && old.v !== 2 && got.size && [...got.values()].filter(x => x.complete).length < got.size / 2) {
      log(`Kept hourly/${d}.json as it was (format 1): most stations' readings for this day have aged out of the feed`);
      continue;
    }
    const rows = [...keep.values()].sort((a, b) => a[0] - b[0]);
    await fs.writeFile(f, JSON.stringify({ v: 2, date: d, updated: new Date().toISOString(), rows }));
    log(`Wrote hourly/${d}.json: ${rows.length} stations (${replaced} new, ${kept} kept from before)`);
  }
  // daily totals for stations with a corrected time zone, from their hours, for every saved format-2 day
  const fixNums = new Set(Object.keys(tzfix).map(Number));
  const savedDays = (await fs.readdir(dir)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n => n.slice(0, 10)).sort();
  const monthsTouched = new Map();
  for (const d of savedDays.slice(-10)) {
    const hj = await readJSON(path.join(dir, d + '.json'), null);
    if (!hj || hj.v !== 2) continue;
    const m = d.slice(0, 7);
    if (!monthsTouched.has(m)) monthsTouched.set(m, await readJSON(path.join(OUT, m + '.json'), null));
    const mj = monthsTouched.get(m);
    if (!mj || mj.v !== 2 || !mj.days.includes(d)) continue;
    const rowOf = new Map(mj.rows.map(r => [r[0], r])), col = +d.slice(8);
    for (const r of hj.rows) {
      if (!fixNums.has(r[0])) continue;
      const hrs = r.slice(1, 25);
      if (hrs.filter(v => v != null).length < 20) continue;   // too few hours to stand in for the day
      const sum = hrs.reduce((a, v) => a + (v || 0), 0);
      let row = rowOf.get(r[0]);
      if (!row) { row = [r[0], ...Array(+new Date(Date.UTC(+m.slice(0, 4), +m.slice(5), 0)).getUTCDate()).fill(null)]; mj.rows.push(row); rowOf.set(r[0], row); }
      row[col] = sum;
    }
  }
  for (const [m, mj] of monthsTouched) if (mj && mj.v === 2) {
    mj.rows.sort((a, b) => a[0] - b[0]);
    await fs.writeFile(path.join(OUT, m + '.json'), JSON.stringify(mj));
    log(`Updated ${m}.json daily totals for ${fixNums.size} stations with corrected time zones`);
  }
  const saved = (await fs.readdir(dir)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n => n.slice(0, 10)).sort();
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ v: 1, updated: new Date().toISOString(), days: saved }));
  log('Done.');
}
main().catch(e => { console.error(e); process.exit(1); });
