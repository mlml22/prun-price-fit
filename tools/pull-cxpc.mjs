// pull-cxpc.mjs - polite daily pull from PRUNplanner's bulk endpoint.
//
// Why this shape: the API author asked to keep traffic gentle. One bulk request per day
// (`/data/cxpc/daily/?days=3`) replaces 370 per-ticker requests. History is stored as one
// gzipped file per month under data/history/ and committed, so a daily run only ever needs
// the small incremental slice.
//
// Modes:
//   node tools/pull-cxpc.mjs              -> incremental (default): fetch ?days=3, merge, rebuild
//   node tools/pull-cxpc.mjs --backfill   -> page history from 2023-07-01 in <=31-day windows per exchange
//   node tools/pull-cxpc.mjs --rebuild    -> only rebuild data/cxpc-daily.jsonl.gz from month files
//
// Politeness: sequential requests, 1.5 s pause, Retry-After honoured, UA carries the repo URL.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const HIST = path.join(DATA, 'history');
fs.mkdirSync(HIST, { recursive: true });

const UA = { 'User-Agent': 'prun-price-fit/1.0 (https://github.com/mlml22/prun-price-fit)', Accept: 'application/json' };
const BASE = 'https://api.prunplanner.org/data/cxpc/daily/';
const DAY = 86400000;
const DEFAULT_START = '2023-07-01';
const EXCHANGES = ['AI1', 'CI1', 'IC1', 'NC1'];
const PAUSE_MS = 1500;

const args = process.argv.slice(2);
const MODE = args.includes('--backfill') ? 'backfill' : args.includes('--rebuild') ? 'rebuild' : 'auto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (epoch) => new Date(epoch).toISOString().slice(0, 7);

async function fetchJson(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 180000);
    try {
      const res = await fetch(url, { headers: UA, signal: ctl.signal });
      if (res.status === 200) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 5000 * i;
        console.log(`  ${res.status} -> wait ${Math.round(wait / 1000)}s (attempt ${i}/${tries})`);
        await sleep(wait);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    } catch (e) {
      if (i === tries) throw e;
      await sleep(3000 * i);
    } finally { clearTimeout(timer); }
  }
}

function loadMonth(key) {
  const f = path.join(HIST, key + '.jsonl.gz');
  if (!fs.existsSync(f)) return new Map();
  const m = new Map();
  for (const line of zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    m.set(`${r[0]}|${r[1]}|${r[2]}`, r);
  }
  return m;
}

function saveMonth(key, map) {
  const rows = [...map.values()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]) || a[2] - b[2]);
  const f = path.join(HIST, key + '.jsonl.gz');
  const tmp = f + '.tmp';
  const buf = zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { level: 9 });
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, f);
  return rows.length;
}

function mergeRows(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const k = monthOf(r.date_epoch);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push([r.ticker, r.exchange_code, r.date_epoch, r.open_p, r.close_p, r.high_p, r.low_p, r.volume, r.traded]);
  }
  let added = 0, touched = [];
  for (const [k, list] of byMonth) {
    const m = loadMonth(k);
    const before = m.size;
    for (const row of list) m.set(`${row[0]}|${row[1]}|${row[2]}`, row);
    if (m.size !== before) { saveMonth(k, m); added += m.size - before; }
    touched.push(`${k}:${m.size}`);
  }
  return { added, touched };
}

async function incremental() {
  console.log('mode=incremental: one bulk request (?days=3)');
  const j = await fetchJson(BASE + '?days=3');
  const rows = j.rows || [];
  console.log(`  rows=${rows.length} since=${j.since} until=${j.until}`);
  const r = mergeRows(rows);
  console.log(`  merged: +${r.added} new rows | months: ${r.touched.join(' ')}`);
}

async function backfill() {
  console.log('mode=backfill: paging per exchange in <=31-day windows');
  const today = Date.now();
  for (const ex of EXCHANGES) {
    let cursor = Date.parse(DEFAULT_START + 'T00:00:00Z');
    while (cursor < today) {
      const until = Math.min(cursor + 30 * DAY, today);
      const url = `${BASE}?since=${ymd(cursor)}&until=${ymd(until)}&exchange=${ex}`;
      try {
        const j = await fetchJson(url);
        const rows = j.rows || [];
        const r = mergeRows(rows);
        console.log(`  ${ex} ${ymd(cursor)}..${ymd(until)} rows=${rows.length} +${r.added}`);
      } catch (e) {
        console.log(`  ${ex} ${ymd(cursor)}..${ymd(until)} FAILED: ${e.message}`);
      }
      cursor = until + DAY;
      await sleep(PAUSE_MS);
    }
  }
}

async function rebuild() {
  const files = fs.readdirSync(HIST).filter((f) => /^\d{4}-\d{2}\.jsonl\.gz$/.test(f)).sort();
  if (!files.length) { console.log('no month files'); return; }
  const out = fs.createWriteStream(path.join(DATA, 'cxpc-daily.jsonl.gz'));
  const counts = [];
  await pipeline(async function* () {
    for (const f of files) {
      const rows = zlib.gunzipSync(fs.readFileSync(path.join(HIST, f))).toString('utf8').split('\n').filter(Boolean);
      counts.push(`${f.slice(0, 7)}:${rows.length}`);
      for (const line of rows) yield line + '\n';
    }
  }(), zlib.createGzip({ level: 6 }), out);

  const rows = [];
  for (const f of files) {
    for (const line of zlib.gunzipSync(fs.readFileSync(path.join(HIST, f))).toString('utf8').split('\n')) {
      if (line) rows.push(JSON.parse(line));
    }
  }
  const series = new Set(rows.map((r) => r[0] + '|' + r[1]));
  let minE = Infinity, maxE = -Infinity;
  for (const r of rows) { if (r[2] < minE) minE = r[2]; if (r[2] > maxE) maxE = r[2]; }
  const manifest = {
    pulledAt: new Date().toISOString(),
    source: 'https://api.prunplanner.org/data/cxpc/daily/ (bulk, FIO-imported game data)',
    policy: 'one bulk request per day; history kept as monthly files in data/history/',
    months: files.length, series: series.size, rows: rows.length,
    firstDate: ymd(minE), lastDate: ymd(maxE),
    gzBytes: fs.statSync(path.join(DATA, 'cxpc-daily.jsonl.gz')).size,
  };
  fs.writeFileSync(path.join(DATA, 'cxpc-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('rebuild:', JSON.stringify(manifest));
}

async function main() {
  if (MODE === 'rebuild') return rebuild();
  if (MODE === 'backfill') { await backfill(); return rebuild(); }
  const months = fs.readdirSync(HIST).filter((f) => /^\d{4}-\d{2}\.jsonl\.gz$/.test(f));
  if (!months.length) {
    console.log('history is empty -> backfill first');
    await backfill();
  } else {
    await incremental();
  }
  return rebuild();
}

main().catch((e) => { console.error('pull failed:', e.message); process.exitCode = 1; });
