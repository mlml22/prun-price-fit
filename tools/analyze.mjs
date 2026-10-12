// analyze.mjs - fit + publish. Target variable is PRICE (user choice), horizon 30/90 days.
// Emits site/data/{meta,fit,board}.json so the static site needs no backend.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SITE = path.join(ROOT, 'site', 'data');
fs.mkdirSync(SITE, { recursive: true });

const feats = JSON.parse(fs.readFileSync(path.join(DATA, 'features.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'cxpc-manifest.json'), 'utf8'));

const rows = [];
for (const line of zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'dataset.jsonl.gz'))).toString('utf8').split('\n')) {
  if (!line) continue;
  const [t, cx, d, c, v, n, cost, mg, mgp, r7, r30, r90] = JSON.parse(line);
  rows.push({ t, cx, d, c, v, n, cost, mg, mgp, r7, r30, r90 });
}

const bySeries = new Map();
for (const r of rows) { const k = r.t + '|' + r.cx; if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(r); }
for (const arr of bySeries.values()) {
  arr.sort((a, b) => a.d - b.d);
  for (let i = 0; i < arr.length; i++) {
    if (i >= 9) { let s = 0; for (let k = i - 9; k <= i; k++) s += arr[k].c; arr[i].sma10 = s / 10; }
    if (i >= 20) { const rets = []; for (let k = i - 19; k <= i; k++) rets.push(Math.log(arr[k].c / arr[k - 1].c)); const m = rets.reduce((a, b) => a + b, 0) / rets.length; arr[i].vol20 = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length); }
    if (i >= 30) { let s = 0; for (let k = i - 29; k <= i; k++) s += arr[k].v; arr[i].liq30 = s / 30; }
    if (i >= 90) { let hi = 0, lo = Infinity, cnt = 0; for (let k = i - 89; k <= i; k++) { hi = Math.max(hi, arr[k].c); lo = Math.min(lo, arr[k].c); cnt++; } arr[i].hi90 = hi; arr[i].lo90 = lo; }
  }
}

const byDate = new Map();
for (const r of rows) { if (!byDate.has(r.d)) byDate.set(r.d, []); byDate.get(r.d).push(r); }

const F = {
  marginPct: { label: 'gross margin (price - materials) / price', fn: r => r.mgp },
  negDistSMA10: { label: 'below 10-day mean (old single factor)', fn: r => (r.sma10 ? -(r.c / r.sma10 - 1) : null) },
  recipeDownstream: { label: 'demand breadth: recipes consuming it', fn: r => (feats[r.t] ? feats[r.t].recipeDownstream : null) },
  constructionDownstream: { label: 'demand breadth: buildings using it', fn: r => (feats[r.t] ? feats[r.t].constructionDownstream : null) },
  producerRecipes: { label: 'supply elasticity: recipes that can make it', fn: r => (feats[r.t] ? feats[r.t].producerRecipes : null) },
  lowVol: { label: 'low 20d volatility', fn: r => (r.vol20 != null ? -r.vol20 : null) },
  liquidity: { label: 'log 30d traded money', fn: r => (r.liq30 != null ? Math.log(1 + r.liq30) : null) },
  rangePosition: { label: 'position in 90d range (low = cheap)', fn: r => (r.hi90 && r.hi90 > r.lo90 ? -(r.c - r.lo90) / (r.hi90 - r.lo90) : null) },
};

function rankify(vals) {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(vals.length); let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) out[idx[k][1]] = avg; i = j + 1; }
  return out;
}
function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; sa += da * da; sb += db * db; }
  return sa && sb ? sab / Math.sqrt(sa * sb) : 0;
}
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : NaN; };

const HORIZONS = [30, 90];
const methods = [];
const dates = [...byDate.keys()].sort((a, b) => a - b);
for (const h of HORIZONS) {
  const target = h === 30 ? 'r30' : 'r90';
  for (const [key, spec] of Object.entries(F)) {
    const ics = [], byYear = {}; let top = 0, all = 0, nTop = 0, nAll = 0, xs = 0;
    for (const d of dates) {
      const usable = byDate.get(d).filter(r => r[target] != null);
      if (usable.length < 60) continue;
      const pairs = usable.map(r => [spec.fn(r), r]).filter(x => x[0] != null && Number.isFinite(x[0]));
      if (pairs.length < 60) continue;
      xs++;
      const ic = corr(rankify(pairs.map(x => x[0])), rankify(pairs.map(x => x[1][target])));
      ics.push(ic);
      const y = new Date(d).toISOString().slice(0, 4);
      (byYear[y] = byYear[y] || []).push(ic);
      const sorted = pairs.slice().sort((a, b) => b[0] - a[0]);
      const k = Math.max(5, Math.floor(sorted.length * 0.1));
      for (const x of sorted.slice(0, k)) { top += x[1][target]; nTop++; }
      for (const x of pairs) { all += x[1][target]; nAll++; }
    }
    if (!ics.length) continue;
    methods.push({
      key, label: spec.label, horizonDays: h, crossSections: xs,
      meanIC: +(mean(ics) * 100).toFixed(2),
      tStat: +(mean(ics) / (sd(ics) / Math.sqrt(ics.length))).toFixed(1),
      icPositivePct: Math.round(ics.filter(x => x > 0).length / ics.length * 100),
      topDecileReturnPct: +((top / nTop) * 100).toFixed(2),
      universeReturnPct: +((all / nAll) * 100).toFixed(2),
      spreadPct: +(((top / nTop) - (all / nAll)) * 100).toFixed(2),
      byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, +(mean(v) * 100).toFixed(1)])),
    });
  }
}

// ---- today's board: latest observation per series, with own-history context ----
const board = [];
for (const [key, arr] of bySeries) {
  const last = arr[arr.length - 1];
  const [t, cx] = key.split('|');
  const f = feats[t] || {};
  const hist = arr.filter(r => r.mgp != null).map(r => r.mgp);
  let pct = null;
  if (hist.length >= 30 && last.mgp != null) pct = Math.round(hist.filter(x => x <= last.mgp).length / hist.length * 100);
  const lag = Math.round((Date.now() - last.d) / 86400000);
  if (lag > 14) continue;
  board.push({
    ticker: t, cx, name: f.name || '', category: f.category || '',
    day: new Date(last.d).toISOString().slice(0, 10), daysAgo: lag,
    price: last.c, cost: last.cost, marginPct: last.mgp != null ? +(last.mgp * 100).toFixed(1) : null,
    marginPctile: pct, traded: last.n, tradedMoney30d: Math.round(last.liq30 || 0),
    recipeDownstream: f.recipeDownstream, constructionDownstream: f.constructionDownstream,
    producerRecipes: f.producerRecipes, producerBuildings: f.producerBuildings,
    popConsumable: f.popConsumable, fuel: f.fuel, distToTerminal: f.distToTerminal,
    below10dMeanPct: last.sma10 ? +((last.c / last.sma10 - 1) * 100).toFixed(1) : null,
  });
}
// transparent heuristic: demand breadth helps stickiness, many producer recipes = easy to crowd in
const z = (arr) => { const m = mean(arr), s = sd(arr) || 1; return (x) => (x - m) / s; };
const zDemand = z(board.map(b => (b.recipeDownstream || 0) + (b.constructionDownstream || 0)));
const zSupply = z(board.map(b => b.producerRecipes || 0));
for (const b of board) {
  b.stickiness = +((zDemand((b.recipeDownstream || 0) + (b.constructionDownstream || 0))) - zSupply(b.producerRecipes || 0)).toFixed(2);
  b.heuristicScore = +(((b.marginPctile ?? 50) / 25) + b.stickiness).toFixed(2);
}
board.sort((a, b) => b.heuristicScore - a.heuristicScore);

fs.writeFileSync(path.join(SITE, 'fit.json'), JSON.stringify({ generatedAt: new Date().toISOString(), methods }, null, 1));
fs.writeFileSync(path.join(SITE, 'board.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows: board }, null, 1));
fs.writeFileSync(path.join(SITE, 'meta.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  target: 'price (30/90 day forward log return)',
  history: { series: manifest.series, rows: manifest.rows, firstDate: manifest.firstDate, lastDate: manifest.lastDate, pulledAt: manifest.pulledAt },
  costAnchorCoveragePct: Math.round(rows.filter(r => r.cost != null).length / rows.length * 100),
  boardSize: board.length,
  sources: ['https://api.prunplanner.org/data/cxpc/{TICKER}/', 'https://api.prunplanner.org/data/recipes/', 'https://api.prunplanner.org/data/buildings/', 'https://api.prunplanner.org/data/materials/'],
}, null, 1));
console.log('fit rows:', methods.length, 'board rows:', board.length);
console.log('top of board:', board.slice(0, 5).map(b => `${b.ticker}.${b.cx} score=${b.heuristicScore} margin=${b.marginPct}% pct=${b.marginPctile}`).join(' | '));
