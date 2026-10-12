// analyze.mjs - fit + publish. Target = PRICE (30/90 day forward log return).
// Emits: site/data/meta.json, fit.json, board.json, hist/{TICKER}.json.gz (OHLCV for charts)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { workersOf, dailyWorkforceCost, DAY_MS } from './baskets.mjs';

const DATA = path.join(ROOT, 'data');
const SITE = path.join(ROOT, 'site', 'data');
const HIST = path.join(SITE, 'hist');
fs.mkdirSync(HIST, { recursive: true });

const feats = JSON.parse(fs.readFileSync(path.join(DATA, 'features.json'), 'utf8'));
let CURRENCY_INFLATION = null;
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'cxpc-manifest.json'), 'utf8'));

// ---- 1) chart payload: raw OHLCV per ticker (gzipped, decompressed in the browser) ----
{
  const byTicker = new Map();
  const panelByCx = new Map();
  for (const line of zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'cxpc-daily.jsonl.gz'))).toString('utf8').split('\n')) {
    if (!line) continue;
    // upstream row order is [ticker, cx, day, OPEN, CLOSE, HIGH, LOW, volume, traded]
    const [t, cx, d, o, c, h, l, v, n] = JSON.parse(line);
    if (!(Number(c) > 0)) continue;
    if (Number(h) < Number(l)) throw new Error('OHLC order sanity check failed for ' + t + ' ' + cx);
    if (!panelByCx.has(cx)) panelByCx.set(cx, new Map());
    const byT = panelByCx.get(cx);
    if (!byT.has(t)) byT.set(t, new Map());
    byT.get(t).set(d, Number(c));
    if (!byTicker.has(t)) byTicker.set(t, { t, series: {} });
    const rec = byTicker.get(t);
    (rec.series[cx] = rec.series[cx] || []).push([d, Number(o) || Number(c), Number(h) || Number(c), Number(l) || Number(c), Number(c), Number(v) || 0, Number(n) || 0]);
  }
  let files = 0;
  for (const [t, rec] of byTicker) {
    for (const k of Object.keys(rec.series)) rec.series[k].sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(path.join(HIST, t + '.json.gz'), zlib.gzipSync(JSON.stringify(rec), { level: 9 }));
    files++;
  }
  console.log('hist files:', files);

  // observed currency inflation: median log price change over the trailing 365 days, plus a monthly history
  const CURRENCY = { AI1: 'AIC', CI1: 'CIS', IC1: 'ICA', NC1: 'NCC' };
  const med = (a) => { const x = a.slice().sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
  let lastDay = 0;
  for (const m of panelByCx.values()) for (const mm of m.values()) for (const d of mm.keys()) if (d > lastDay) lastDay = d;
  const yearAgo = lastDay - 365 * 86400000;
  CURRENCY_INFLATION = {};
  for (const [cx, tickers] of panelByCx) {
    const code = CURRENCY[cx] || cx;
    const changes = [];
    for (const [, m] of tickers) {
      const ds = [...m.keys()].sort((a, b) => a - b);
      if (ds.length < 120) continue;
      let past = null;
      for (const d of ds) { if (d <= yearAgo) past = d; else break; }
      if (past == null) continue;
      const p0 = m.get(past), p1 = m.get(ds[ds.length - 1]);
      if (p0 > 0 && p1 > 0) changes.push(Math.log(p1 / p0));
    }
    const annual = med(changes);
    // monthly history of the same measure (month end, trailing 12 months), for a sparkline
    const monthly = [];
    const monthEnds = [];
    for (const d of [...new Set([...[...tickers.values()].flatMap(mm => [...mm.keys()])])].sort((a, b) => a - b)) {
      if (monthEnds.length && new Date(monthEnds[monthEnds.length - 1]).getUTCMonth() === new Date(d).getUTCMonth()) monthEnds[monthEnds.length - 1] = d;
      else monthEnds.push(d);
    }
    for (const me of monthEnds.slice(-24)) {
      const from = me - 365 * 86400000;
      const ch = [];
      for (const [, m] of tickers) {
        const ds = [...m.keys()].filter(x => x <= me).sort((a, b) => a - b);
        if (ds.length < 120) continue;
        let past = null;
        for (const d of ds) { if (d <= from) past = d; else break; }
        if (past == null) continue;
        const p0 = m.get(past), p1 = m.get(ds[ds.length - 1]);
        if (p0 > 0 && p1 > 0) ch.push(Math.log(p1 / p0));
      }
      const v = med(ch);
      if (v != null) monthly.push([new Date(me).toISOString().slice(0, 7), +(v * 100).toFixed(1)]);
    }
    CURRENCY_INFLATION[code] = { exchange: cx, annualInflationPct: annual == null ? null : +(annual * 100).toFixed(1), tradedTickers: changes.length, monthly };
  }
  console.log('currency inflation (trailing 365d, median):', JSON.stringify(Object.fromEntries(Object.entries(CURRENCY_INFLATION).map(([k, v]) => [k, v.annualInflationPct]))));
  fs.writeFileSync(path.join(SITE, 'inflation.json'), JSON.stringify({ generatedAt: new Date().toISOString(), note: 'median log price change over the trailing 365 days, per currency; measured from CX prices, not from a money-printing proxy', byCurrency: CURRENCY_INFLATION }, null, 1));
}

// ---- 2) dataset -> features/IC ----
const rows = [];
for (const line of zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'dataset.jsonl.gz'))).toString('utf8').split('\n')) {
  if (!line) continue;
  const [t, cx, d, c, v, n, cost, mg, mgp, r7, r30, r90, lab, tot, tmp] = JSON.parse(line);
  rows.push({ t, cx, d, c, v, n, cost, mg, mgp, r7, r30, r90, lab, tot, tmp });
}

const priceAtGlobal = new Map();
for (const r of rows) { const k = r.t + '|' + r.cx; if (!priceAtGlobal.has(k)) priceAtGlobal.set(k, new Map()); priceAtGlobal.get(k).set(r.d, r.c); }
const bySeries = new Map();
for (const r of rows) { const k = r.t + '|' + r.cx; if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(r); }
for (const arr of bySeries.values()) {
  arr.sort((a, b) => a.d - b.d);
  for (let i = 0; i < arr.length; i++) {
    if (i >= 9) { let s = 0; for (let k = i - 9; k <= i; k++) s += arr[k].c; arr[i].sma10 = s / 10; }
    if (i >= 20) { const rets = []; for (let k = i - 19; k <= i; k++) rets.push(Math.log(arr[k].c / arr[k - 1].c)); const m = rets.reduce((a, b) => a + b, 0) / rets.length; arr[i].vol20 = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length); }
    if (i >= 30) { let s = 0; for (let k = i - 29; k <= i; k++) s += arr[k].v; arr[i].liq30 = s / 30; }
    if (i >= 90) { let hi = 0, lo = Infinity; for (let k = i - 89; k <= i; k++) { hi = Math.max(hi, arr[k].c); lo = Math.min(lo, arr[k].c); } arr[i].hi90 = hi; arr[i].lo90 = lo; }
  }
}

const byDate = new Map();
for (const r of rows) { if (!byDate.has(r.d)) byDate.set(r.d, []); byDate.get(r.d).push(r); }

const F = {
  marginPct: { label: 'gross margin (price - materials) / price', fn: r => r.mgp },
  marginAfterLabour: { label: 'margin after labour (price - materials - labour) / price', fn: r => r.tmp },
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

const dates = [...byDate.keys()].sort((a, b) => a - b);
const methods = [];
for (const h of [30, 90]) {
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

// ---- 3) today's board ----
// cost breakdown for the detail page: best producing recipe + labour basket, priced on the row's own day
const CACHE = path.join(ROOT, 'cache');
let RECIPES = [], BUILDINGS = [];
try { RECIPES = JSON.parse(fs.readFileSync(path.join(CACHE, 'recipes.json'), 'utf8')); } catch { /* optional */ }
try { BUILDINGS = JSON.parse(fs.readFileSync(path.join(CACHE, 'buildings.json'), 'utf8')); } catch { /* optional */ }
const buildingOfWork = new Map(BUILDINGS.map(b => [b.building_ticker, b]));
const recipesByOutput = new Map();
for (const r of RECIPES) {
  const outs = (r.outputs || []).filter(o => o.material_ticker);
  for (const o of outs) {
    if (!recipesByOutput.has(o.material_ticker)) recipesByOutput.set(o.material_ticker, []);
    recipesByOutput.get(o.material_ticker).push({ building: r.building_ticker, timeMs: Number(r.time_ms) || 0, outAmount: Number(o.material_amount) || 1,
      inputs: (r.inputs || []).map(i => ({ t: i.material_ticker, per: (Number(o.material_amount) || 1) ? (Number(i.material_amount) || 0) / (Number(o.material_amount) || 1) : 0 })) });
  }
}

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
  // detail-page breakdown
  const priceLookup = (mat) => { const m = priceAtGlobal.get(mat + '|' + cx); if (!m) return null; for (let k = 0; k <= 7; k++) { const v = m.get(last.d - k * 86400000); if (v != null) return v; } return null; };
  let breakdown = null;
  for (const r of (recipesByOutput.get(t) || [])) {
    const matItems = []; let matSum = 0, ok = true;
    for (const inp of r.inputs) { const p = priceLookup(inp.t); if (p == null) { ok = false; break; } matSum += p * inp.per; matItems.push({ ticker: inp.t, per: inp.per, price: p }); }
    if (!ok) continue;
    const b = buildingOfWork.get(r.building);
    const lab = b ? dailyWorkforceCost(workersOf(b), priceLookup) : null;
    const labUnit = lab && r.outAmount ? lab.totalPerDay * (r.timeMs / DAY_MS) / r.outAmount : null;
    const total = matSum + (labUnit || 0);
    if (!breakdown || total < breakdown.totalCost) breakdown = { building: r.building, timeMs: r.timeMs, outAmount: r.outAmount, matItems, matCost: matSum, labourCost: labUnit, labourDetail: lab ? lab.detail : null, totalCost: total };
  }
  board.push({
    ticker: t, cx, name: f.name || '', category: f.category || '',
    day: new Date(last.d).toISOString().slice(0, 10), daysAgo: lag,
    price: last.c, matCost: last.cost, labourCost: last.lab, totalCost: last.tot,
    matMarginPct: last.mgp != null ? +(last.mgp * 100).toFixed(1) : null,
    marginPct: last.tmp != null ? +(last.tmp * 100).toFixed(1) : null,
    marginPctile: pct, traded: last.n, tradedMoney30d: Math.round(last.liq30 || 0),
    recipeDownstream: f.recipeDownstream, constructionDownstream: f.constructionDownstream,
    producerRecipes: f.producerRecipes, producerBuildings: f.producerBuildings,
    popConsumable: f.popConsumable, fuel: f.fuel, distToTerminal: f.distToTerminal,
    below10dMeanPct: last.sma10 ? +((last.c / last.sma10 - 1) * 100).toFixed(1) : null,
    days: arr.length, first: new Date(arr[0].d).toISOString().slice(0, 10),
    currency: ({ AI1: 'AIC', CI1: 'CIS', IC1: 'ICA', NC1: 'NCC' })[cx] || cx,
    inflationAnnualPct: null,
    costBreakdown: breakdown ? { building: breakdown.building, timeMs: breakdown.timeMs, outAmount: breakdown.outAmount, matItems: breakdown.matItems, matCost: breakdown.matCost, labourCost: breakdown.labourCost, labourDetail: breakdown.labourDetail, totalCost: breakdown.totalCost } : null,
  });
}
const z = (arr) => { const m = mean(arr), s = sd(arr) || 1; return (x) => (x - m) / s; };
const zDemand = z(board.map(b => (b.recipeDownstream || 0) + (b.constructionDownstream || 0)));
const zSupply = z(board.map(b => b.producerRecipes || 0));
for (const b of board) {
  b.stickiness = +((zDemand((b.recipeDownstream || 0) + (b.constructionDownstream || 0))) - zSupply(b.producerRecipes || 0)).toFixed(2);
  b.heuristicScore = +(((b.marginPctile ?? 50) / 25) + b.stickiness).toFixed(2);
}
for (const b of board) { const inf = CURRENCY_INFLATION && CURRENCY_INFLATION[b.currency]; if (inf) b.inflationAnnualPct = inf.annualInflationPct; }
board.sort((a, b) => b.heuristicScore - a.heuristicScore);

const withLab = board.filter(b => b.labourCost != null);
const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
fs.writeFileSync(path.join(SITE, 'fit.json'), JSON.stringify({ generatedAt: new Date().toISOString(), methods }, null, 1));
fs.writeFileSync(path.join(SITE, 'board.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows: board }, null, 1));
fs.writeFileSync(path.join(SITE, 'meta.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  target: 'price (30/90 day forward log return)',
  history: { series: manifest.series, rows: manifest.rows, firstDate: manifest.firstDate, lastDate: manifest.lastDate, pulledAt: manifest.pulledAt },
  costAnchorCoveragePct: Math.round(rows.filter(r => r.cost != null).length / rows.length * 100),
  labourCoveragePct: Math.round(withLab.length / board.length * 100),
  medianMaterialsCostShare: +(med(withLab.map(b => b.matCost / b.price)) * 100).toFixed(1),
  medianLabourCostShare: +(med(withLab.map(b => b.labourCost / b.price)) * 100).toFixed(1),
  boardSize: board.length, histFiles: fs.readdirSync(HIST).length,
  sources: ['https://api.prunplanner.org/data/cxpc/{TICKER}/', 'https://api.prunplanner.org/data/recipes/', 'https://api.prunplanner.org/data/buildings/', 'https://api.prunplanner.org/data/materials/'],
}, null, 1));
console.log('fit rows:', methods.length, 'board:', board.length, 'meta written');
console.log('cost shares (median): materials', (med(withLab.map(b => b.matCost / b.price)) * 100).toFixed(1) + '%, labour', (med(withLab.map(b => b.labourCost / b.price)) * 100).toFixed(1) + '%');
