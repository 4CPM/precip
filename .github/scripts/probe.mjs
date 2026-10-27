// One-off check of what the public Ambient feed returns for long periods.
// Prints record counts, date ranges and rain fields; writes nothing.
const BASE = 'https://lightning.ambientweather.net';
const q = new URLSearchParams({ '$publicBox[0][0]': -107.95, '$publicBox[0][1]': 37.2, '$publicBox[1][0]': -107.75, '$publicBox[1][1]': 37.35, '$limit': 5 });
const st = ((await (await fetch(`${BASE}/devices?${q}`)).json()).data || []).find(x => (x.info?.name || '').includes('Perins Canyon') && x.macAddress && x.info?.slug);
console.log('station:', st.info.name);
const now = Date.now(), day = 86400e3;
for (const [label, days, res, extra] of [['31 days hourly', 31, 60], ['31 days hourly, limit 800', 31, 60, { limit: 800 }], ['8 days 5-min', 8, 5], ['365 days daily', 365, 1440], ['365 days daily summary', 365, 1440, { stats: 'summary' }], ['90 days 30-min', 90, 30]]) {
  const p = new URLSearchParams({ macAddress: st.macAddress, dataKey: st.info.slug, start: now - days * day, end: now, limit: 2000, res, ...(extra || {}) });
  const r = await fetch(`${BASE}/device-data?${p}`);
  let j; try { j = await r.json(); } catch { j = null; }
  const a = Array.isArray(j) ? j : (j && j.data) || [];
  const ts = a.map(x => x.dateutc).filter(Boolean).sort((x, y) => x - y);
  console.log(`\n== ${label}: HTTP ${r.status}, ${a.length} records, ${ts.length ? new Date(ts[0]).toISOString().slice(0, 10) + ' to ' + new Date(ts[ts.length - 1]).toISOString().slice(0, 10) : 'no dates'}`);
  if (!Array.isArray(j) && j && !a.length) console.log('  body:', JSON.stringify(j).slice(0, 600));
  if (a[0]) console.log('  rain fields in first record:', JSON.stringify(Object.fromEntries(Object.entries(a[0]).filter(([k]) => /rain|date/i.test(k)))).slice(0, 700));
  if (a[1]) console.log('  second record:', JSON.stringify(Object.fromEntries(Object.entries(a[1]).filter(([k]) => /rain|date/i.test(k)))).slice(0, 700));
}
