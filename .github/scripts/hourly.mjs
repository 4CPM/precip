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
// clock hour on Denver time. It also keeps the day's fastest 5-minute rate.
//   history/hourly/YYYY-MM-DD.json
//     { v: 1, date, tz: 'America/Denver',
//       rows: [[station number, rain in hour 0, hour 1, ... hour 23, peak rate], ...] }
//     rain in hundredths of an inch; peak rate in hundredths of an inch per hour;
//     null for an hour with no readings. Stations with no readings that day are left out.
//   history/hourly/index.json   { days: [dates saved] }
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

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
const parts = ms => { const o = {}; for (const p of fmt.formatToParts(ms)) o[p.type] = p.value; return { day: `${o.year}-${o.month}-${o.day}`, hour: +o.hour }; };
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

// rain per Denver clock hour for each day, plus the day's fastest 5-minute rate
function hourly(rs, days) {
  const want = new Set(days), res = new Map();
  for (let i = 1; i < rs.length; i++) {
    const [t, v] = rs[i], [t0, v0] = rs[i - 1];
    const { day, hour } = parts(t);
    if (!want.has(day)) continue;
    let e = res.get(day);
    if (!e) res.set(day, e = { h: Array(24).fill(null), peak: 0 });
    // readings more than an hour apart can't be split by hour, so they are skipped
    const gap = (t - t0) / 60e3;
    if (gap > 60) { if (e.h[hour] == null) e.h[hour] = 0; continue; }
    const rise = v >= v0 ? v - v0 : v;          // a drop is the midnight reset
    e.h[hour] = (e.h[hour] || 0) + rise;
    if (gap >= 4 && rise > 0) e.peak = Math.max(e.peak, rise * 60 / gap);
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
  const stations = active.map(n => ({ n, mac: sj.list[n][0], key: sj.list[n][4] })).filter(s => s.mac && s.key);
  log(`${stations.length} stations from the daily archive; fetching 5-minute readings, ${PAR} at a time`);

  const start = denverMidnight(days[0]) - 15 * 60e3, end = Math.min(Date.now(), denverMidnight(addDays(yesterday, 1)) + 15 * 60e3);
  const byDay = new Map(days.map(d => [d, []]));
  let done = 0, errs = 0, lastLog = Date.now();
  const t0 = Date.now();
  await pool(stations, PAR, async st => {
    try {
      const res = hourly(await readings(st, start, end), days);
      for (const [d, e] of res) {
        const h = e.h.map(v => v == null ? null : Math.round(v * 100));
        if (h.every(v => v == null)) continue;
        byDay.get(d).push([st.n, ...h, Math.round(e.peak * 100)]);
      }
    } catch (e) { errs++; }
    done++;
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log(`  ${done} of ${stations.length} stations (${errs} failed)`); }
  });
  log(`Fetched ${done} stations in ${Math.round((Date.now() - t0) / 1000)} s; ${errs} failed`);
  if (errs > stations.length / 2) { console.error('More than half the stations failed; not writing files.'); process.exit(1); }

  const dir = path.join(OUT, 'hourly');
  await fs.mkdir(dir, { recursive: true });
  for (const [d, rows] of byDay) {
    rows.sort((a, b) => a[0] - b[0]);
    await fs.writeFile(path.join(dir, d + '.json'), JSON.stringify({ v: 1, date: d, tz: TZ, updated: new Date().toISOString(), rows }));
    log(`Wrote hourly/${d}.json: ${rows.length} stations`);
  }
  const saved = (await fs.readdir(dir)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n => n.slice(0, 10)).sort();
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ v: 1, updated: new Date().toISOString(), days: saved }));
  log('Done.');
}
main().catch(e => { console.error(e); process.exit(1); });
