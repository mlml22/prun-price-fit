// pull-cxpc.mjs - full daily price history straight from the upstream public API.
// Read-only, no auth, no writes anywhere except data/cxpc-daily.jsonl.gz in this repo.
// Source: https://api.prunplanner.org/data/cxpc/{TICKER}/  (the FIO-imported game record)
// Shape : [ticker, exchange, dayEpochMs, open, close, high, low, volume(money), traded(qty)]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const UA = { 'User-Agent': 'prun-price-fit/1.0 (read-only)', Accept: 'application/json,*/*' };

await fs.promises.mkdir(DATA, { recursive: true });

const cacheDir = path.join(ROOT, 'cache');
await fs.promises.mkdir(cacheDir, { recursive: true });

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(url, { headers: UA, signal: ctl.signal });
      if (r.status === 200) { const j = await r.json(); return Array.isArray(j) ? j : []; }
      if (r.status === 404) return [];
    } catch { /* retry */ }
    finally { clearTimeout(t); }
    if (i < tries) await new Promise(r => setTimeout(r, 800 * i));
  }
  return null;
}

async function gameData(name, url) {
  const f = path.join(cacheDir, name + '.json');
  try { return JSON.parse(await fs.promises.readFile(f, 'utf8')); } catch { /* fetch it */ }
  const j = await getJson(url, 4);
  if (!j) throw new Error('cannot load ' + url);
  await fs.promises.writeFile(f, JSON.stringify(j));
  return j;
}
const mats = await gameData('materials', 'https://api.prunplanner.org/data/materials/');

const tickers = [...new Set(mats.map(m => m.material_ticker || m.ticker).filter(Boolean))].sort();
console.log(`tickers: ${tickers.length}`);

const rows = [];
let ok = 0, failed = 0, empty = 0;
let cursor = 0;
const CONC = 6;
const t0 = Date.now();

async function worker() {
  while (cursor < tickers.length) {
    const tk = tickers[cursor++];
    const arr = await getJson(`https://api.prunplanner.org/data/cxpc/${encodeURIComponent(tk)}/`);
    if (arr === null) { failed++; continue; }
    if (!arr.length) { empty++; continue; }
    ok++;
    for (const x of arr) {
      const epoch = Number(x.date_epoch || 0);
      if (!epoch) continue;
      rows.push([x.ticker || tk, x.exchange_code, epoch, x.open_p, x.close_p, x.high_p, x.low_p, x.volume, x.traded]);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

rows.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]) || a[2] - b[2]);
const gzPath = path.join(DATA, 'cxpc-daily.jsonl.gz');
await pipeline(async function* () { for (const r of rows) yield JSON.stringify(r) + '\n'; }(), zlib.createGzip({ level: 6 }), fs.createWriteStream(gzPath));

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const epochs = rows.map(r => r[2]);
let minE = Infinity, maxE = -Infinity;
for (const e of epochs) { if (e < minE) minE = e; if (e > maxE) maxE = e; }
const manifest = {
  pulledAt: new Date().toISOString(),
  source: 'https://api.prunplanner.org/data/cxpc/{TICKER}/ (FIO-imported game data)',
  tickersRequested: tickers.length, tickersWithData: ok, empty, failed,
  series: new Set(rows.map(r => r[0] + '|' + r[1])).size,
  rows: rows.length, firstDate: day(minE), lastDate: day(maxE),
  gzBytes: fs.statSync(gzPath).size, elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
};
fs.writeFileSync(path.join(DATA, 'cxpc-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 1));
