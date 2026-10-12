// analyze.mjs - fit + publish. Target = PRICE (30/90 day forward log return).
// Emits: site/data/meta.json, fit.json, board.json, hist/{TICKER}.json.gz (OHLCV for charts)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { workersOf, dailyWorkforceCost, DAY_MS } from './baskets.mjs';
import { TRIP_COST, TRIP_COST_SOURCE, breakEvenUnits } from './transport.mjs';
import { loadRaylu, monthKey, rawSet } from './raylu.mjs';
import { extractionCostPerUnit, UNITS_PER_DAY_AT_FACTOR_1 } from './extraction.mjs';

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
  const [t, cx, d, c, v, n, cost, mg, mgp, r7, r30, r90, lab, tot, tmp, dep] = JSON.parse(line);
  rows.push({ t, cx, d, c, v, n, cost, mg, mgp, r7, r30, r90, lab, tot, tmp, dep });
}

const priceAtGlobal = new Map();
for (const r of rows) { const k = r.t + '|' + r.cx; if (!priceAtGlobal.has(k)) priceAtGlobal.set(k, new Map()); priceAtGlobal.get(k).set(r.d, r.c); }
const priceByMonth = new Map();
for (const r of rows) { const day = new Date(r.d); const mk = day.getUTCFullYear() + '-' + String(day.getUTCMonth() + 1).padStart(2, '0'); if (!priceByMonth.has(r.t)) priceByMonth.set(r.t, new Map()); const m = priceByMonth.get(r.t); if (!m.has(mk)) m.set(mk, []); m.get(mk).push(r.c); }
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
  supplyScore: { label: 'monthly supply score (percentile, high = bullish)', fn: r => scoreFor(r.t, r.d) },
  comboScore: { label: 'combo: mean-reversion + supply score', fn: r => { const mr = r.sma10 ? -(r.c / r.sma10 - 1) : null; const ss = scoreFor(r.t, r.d); if (mr == null || ss == null) return null; return mr * 100 + (ss - 50); } },
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

// ---- 2b) forecast model: expected forward log return from three validated factors ----
// r30 ~ a + b1*(-(p/sma10-1)) + b2*totalMarginPct + b3*(-vol20)   (pooled OLS, in-sample)
// The mean-reversion factor is the only one with a strong, stable IC; the other two are controls.
function ols(rowsIn, target) {
  const X = rowsIn.map(r => [1, r.f1, r.f2, r.f3]);
  const y = rowsIn.map(r => r[target]);
  const k = 4;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gaussian elimination with tiny ridge for safety
  for (let i = 0; i < k; i++) XtX[i][i] *= 1.000001;
  const M = XtX.map((row, i) => row.concat([Xty[i]]));
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r2 = col + 1; r2 < k; r2++) if (Math.abs(M[r2][col]) > Math.abs(M[piv][col])) piv = r2;
    const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
    if (!M[col][col]) continue;
    for (let r2 = 0; r2 < k; r2++) {
      if (r2 === col) continue;
      const f2 = M[r2][col] / M[col][col];
      for (let c2 = col; c2 <= k; c2++) M[r2][c2] -= f2 * M[col][c2];
    }
  }
  const beta = M.map((row, i) => (row[i] ? row[k] / row[i] : 0));
  let sse = 0, sst = 0;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  for (let i = 0; i < X.length; i++) {
    const pred = X[i].reduce((a, v, j2) => a + v * beta[j2], 0);
    sse += (y[i] - pred) ** 2;
    sst += (y[i] - my) ** 2;
  }
  return { beta, sigma: Math.sqrt(sse / Math.max(1, X.length - k)), r2: sst ? 1 - sse / sst : 0, n: X.length };
}

const modelRows = rows.filter(r => r.r30 != null && r.sma10 && r.vol20 != null && r.tmp != null)
  .map(r => ({ t: r.t, cx: r.cx, d: r.d, c: r.c, f1: -(r.c / r.sma10 - 1), f2: r.tmp, f3: -r.vol20, r30: r.r30, r90: r.r90 }));
const fit30 = ols(modelRows.filter(r => r.r30 != null), 'r30');
const fit90 = ols(modelRows.filter(r => r.r90 != null), 'r90');
console.log('forecast model r30: r2=' + (fit30.r2 * 100).toFixed(2) + '% sigma=' + (fit30.sigma * 100).toFixed(2) + '% beta=' + fit30.beta.map(x => x.toFixed(4)).join(','));
console.log('forecast model r90: r2=' + (fit90.r2 * 100).toFixed(2) + '% sigma=' + (fit90.sigma * 100).toFixed(2) + '%');

// ---- 3) today's board ----
// cost breakdown for the detail page: best producing recipe + labour basket, priced on the row's own day
const CACHE = path.join(ROOT, 'cache');
const RAYLU = await loadRaylu(CACHE);
let RAW_SET = new Set();
let PLANETS = [];
let RECIPES = [], BUILDINGS = [];
try { RECIPES = JSON.parse(fs.readFileSync(path.join(CACHE, 'recipes.json'), 'utf8')); } catch { /* optional */ }
try { BUILDINGS = JSON.parse(fs.readFileSync(path.join(CACHE, 'buildings.json'), 'utf8')); } catch { /* optional */ }
RAW_SET = rawSet(RECIPES);
try { PLANETS = JSON.parse(fs.readFileSync(path.join(CACHE, 'planets.json'), 'utf8')); }
catch {
  const r = await fetch('https://api.prunplanner.org/data/planets/', { headers: { 'User-Agent': 'prun-price-fit/1.0' } });
  if (r.status === 200) { PLANETS = await r.json(); fs.writeFileSync(path.join(CACHE, 'planets.json'), JSON.stringify(PLANETS)); }
}
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
    price: last.c, matCost: last.cost, labourCost: last.lab, depreciationCost: last.dep, totalCost: last.tot,
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
const forecasts = {};
for (const b of board) {
  const arr = bySeries.get(b.ticker + '|' + b.cx);
  const last = arr && arr[arr.length - 1];
  if (!last || !last.sma10 || last.vol20 == null || last.tmp == null) continue;
  const x = [1, -(last.c / last.sma10 - 1), last.tmp, -last.vol20];
  const p30 = x.reduce((a, v, j2) => a + v * fit30.beta[j2], 0);
  const p90 = x.reduce((a, v, j2) => a + v * fit90.beta[j2], 0);
  forecasts[b.ticker + '|' + b.cx] = {
    expected30Pct: +(p30 * 100).toFixed(2), expected90Pct: +(p90 * 100).toFixed(2),
    band30Pct: +(fit30.sigma * 100).toFixed(2), band90Pct: +(fit90.sigma * 100).toFixed(2),
    meanRevert: +(-(last.c / last.sma10 - 1) * 100).toFixed(2), totalMarginPct: +(last.tmp * 100).toFixed(1),
  };
  b.expected30Pct = forecasts[b.ticker + '|' + b.cx].expected30Pct;
  b.expected90Pct = forecasts[b.ticker + '|' + b.cx].expected90Pct;
}
fs.writeFileSync(path.join(SITE, 'forecast.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
  model: 'r30/r90 = a + b1*(-(p/sma10-1)) + b2*totalMarginPct + b3*(-vol20); pooled OLS, in-sample',
  fit30: { beta: fit30.beta, sigma: fit30.sigma, r2: fit30.r2, n: fit30.n },
  fit90: { beta: fit90.beta, sigma: fit90.sigma, r2: fit90.r2, n: fit90.n },
  bySeries: forecasts }, null, 1));
console.log('forecasts:', Object.keys(forecasts).length);

// cross-exchange price gaps vs the cost of a trip (rough constant)
const byTicker = new Map();
for (const [key, arr] of bySeries) {
  const [t, cx] = key.split('|');
  const last = arr[arr.length - 1];
  if (!last || !(last.c > 0)) continue;
  if (Math.round((Date.now() - last.d) / 86400000) > 14) continue;
  if (!byTicker.has(t)) byTicker.set(t, { ticker: t, name: (feats[t] || {}).name || '', prices: {}, days: {} });
  byTicker.get(t).prices[cx] = last.c;
  byTicker.get(t).days[cx] = new Date(last.d).toISOString().slice(0, 10);
}
const freight = {};
for (const [t, rec] of byTicker) {
  const pairs = Object.entries(rec.prices);
  if (pairs.length < 2) continue;
  const sorted = pairs.slice().sort((a, b) => a[1] - b[1]);
  const cheap = sorted[0], dear = sorted[sorted.length - 1];
  const spread = dear[1] - cheap[1];
  freight[t] = {
    name: rec.name, prices: rec.prices, days: rec.days,
    cheapest: cheap[0], dearest: dear[0], spreadPerUnit: +spread.toFixed(3),
    spreadPct: cheap[1] ? +(spread / cheap[1] * 100).toFixed(2) : null,
    breakEvenUnits: breakEvenUnits(spread),
  };
}
for (const b of board) {
  const f = freight[b.ticker];
  if (!f || !f.prices[b.cx] || !f.prices[f.cheapest]) continue;
  const gap = f.prices[b.cx] - f.prices[f.cheapest];
  b.vsCheapest = +gap.toFixed(3);
  b.vsCheapestPct = f.prices[f.cheapest] ? +(gap / f.prices[f.cheapest] * 100).toFixed(2) : null;
  b.breakEvenUnits = breakEvenUnits(gap);
}
fs.writeFileSync(path.join(SITE, 'freight.json'), JSON.stringify({ generatedAt: new Date().toISOString(), tripCost: TRIP_COST, tripCostSource: TRIP_COST_SOURCE, note: 'breakEvenUnits = 10,000 / (该商品在本所与最低价交易所的单价差)：低于这个量，跑一趟不划算', byTicker: freight }, null, 1));
console.log('freight rows:', Object.keys(freight).length);

// ---- monthly supply/demand model (raylu production flows) ----
const MINEABLE = new Set();
for (const p of PLANETS) for (const r of (p.resources || [])) { const t = r.material_ticker || r.materialTicker; if (t && r.factor > 0) MINEABLE.add(t); }
console.log('mineable materials (planet factor data):', MINEABLE.size);
const rayMonths = Object.keys(RAYLU).sort();
const pm = (t, mk) => { const arr = (priceByMonth.get(t) || new Map()).get(mk); if (!arr || !arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const supplyRows = [];
for (let i = 0; i < rayMonths.length; i++) {
  const m = rayMonths[i], mk = monthKey(m), nxt = rayMonths[i + 1], prev = i > 0 ? rayMonths[i - 1] : null;
  for (const [t, v] of Object.entries(RAYLU[m])) {
    const p = pm(t, mk), pNext = nxt ? pm(t, monthKey(nxt)) : null;
    const pv = prev ? RAYLU[prev][t] : null;
    supplyRows.push({ month: m, t, raw: MINEABLE.has(t), amount: v.amount, consumed: v.consumed, volume: v.volume, profit: v.profit,
      ret: (p && pNext && p > 0) ? Math.log(pNext / p) : null,
      surplus: (v.amount && v.consumed != null) ? (v.amount - v.consumed) / Math.max(v.amount, v.consumed) : null,
      growth: (pv && pv.amount) ? v.amount / pv.amount - 1 : null,
      ppu: v.amount ? v.profit / v.amount : null,
    });
  }
}
function monthlyOls(rowsIn) {
  const X = rowsIn.map(r => [1, r.surplus, r.growth, r.ppu]);
  const y = rowsIn.map(r => r.ret);
  const k = 4;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  for (let i = 0; i < k; i++) XtX[i][i] *= 1.000001;
  const M = XtX.map((r2, i) => r2.concat([Xty[i]]));
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r2 = c + 1; r2 < k; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
    const tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
    if (!M[c][c]) continue;
    for (let r2 = 0; r2 < k; r2++) { if (r2 === c) continue; const f2 = M[r2][c] / M[c][c]; for (let c2 = c; c2 <= k; c2++) M[r2][c2] -= f2 * M[c][c2]; }
  }
  const beta = M.map((row, i) => (row[i] ? row[k] / row[i] : 0));
  let sse = 0, sst = 0;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  for (let i = 0; i < X.length; i++) { const pred = X[i].reduce((a, v, j2) => a + v * beta[j2], 0); sse += (y[i] - pred) ** 2; sst += (y[i] - my) ** 2; }
  return { beta, sigma: Math.sqrt(sse / Math.max(1, X.length - k)), r2: sst ? 1 - sse / sst : 0, n: X.length };
}
const supplyUsable = supplyRows.filter(r => r.ret != null && r.surplus != null && r.growth != null && r.ppu != null);
const supplyFit = supplyUsable.length > 20 ? monthlyOls(supplyUsable) : null;
if (supplyFit) console.log('supply model: r2=' + (supplyFit.r2 * 100).toFixed(1) + '% sigma=' + (supplyFit.sigma * 100).toFixed(1) + '% n=' + supplyFit.n + ' beta=' + supplyFit.beta.map(x => x.toFixed(4)).join(','));
// last-month flows per material + model expectation for the next month
const lastMonth = rayMonths[rayMonths.length - 1];
const supply = {};
for (const [t, v] of Object.entries(RAYLU[lastMonth] || {})) {
  const prev = rayMonths.length > 1 ? (RAYLU[rayMonths[rayMonths.length - 2]] || {})[t] : null;
  const surplus = (v.amount && v.consumed != null) ? (v.amount - v.consumed) / Math.max(v.amount, v.consumed) : null;
  const growth = (prev && prev.amount) ? v.amount / prev.amount - 1 : null;
  const ppu = v.amount ? v.profit / v.amount : null;
  const expected = (supplyFit && surplus != null && growth != null && ppu != null)
    ? +(100 * (supplyFit.beta[0] + supplyFit.beta[1] * surplus + supplyFit.beta[2] * growth + supplyFit.beta[3] * ppu)).toFixed(2) : null;
  supply[t] = { month: lastMonth, name: (feats[t] || {}).name || '', raw: MINEABLE.has(t), amount: v.amount, consumed: v.consumed, volume: v.volume, profit: v.profit, surplus: surplus == null ? null : +(surplus * 100).toFixed(1), supplyGrowthPct: growth == null ? null : +(growth * 100).toFixed(1), profitPerUnit: ppu == null ? null : +ppu.toFixed(2), expectedNextMonthPct: expected };
}
for (const b of board) { const s = supply[b.ticker]; if (s) { b.supplySurplusPct = s.surplus; b.supplyGrowthPct = s.supplyGrowthPct; b.supplyExpectedPct = s.expectedNextMonthPct; b.isRaw = s.raw; } }
fs.writeFileSync(path.join(SITE, 'supply.json'), JSON.stringify({ generatedAt: new Date().toISOString(), month: lastMonth, model: 'next-month log return = a + b1*surplus + b2*supplyGrowth + b3*profitPerUnit + b4*extractionMargin (monthly panel, in-sample)', fit: (globalThis.__supplyModelInfo ? globalThis.__supplyModelInfo.fit4 : supplyFit), fit3: (globalThis.__supplyModelInfo ? globalThis.__supplyModelInfo.fit3 : null), ic: (globalThis.__supplyModelInfo ? globalThis.__supplyModelInfo.ic : null), note: 'surplus = (产量 - 消耗) / max(产量, 消耗)；raw = 不由任何消耗型配方生产的材料（采掘类）', byTicker: supply }, null, 1));
console.log('supply rows:', Object.keys(supply).length, '| raw:', Object.values(supply).filter(x => x.raw).length);

// ---- extraction cost anchor for mined materials ----
const factorByMaterial = new Map();
for (const p of PLANETS) for (const r of (p.resources || [])) {
  const t = r.material_ticker || r.materialTicker; if (!t || !(r.factor > 0)) continue;
  if (!factorByMaterial.has(t)) factorByMaterial.set(t, []);
  factorByMaterial.get(t).push({ planet: p.planet_natural_id, factor: r.factor });
}
const extraction = {};
for (const [t, list] of factorByMaterial) {
  if (!RAW_SET.has(t) && !list.length) continue;
  const sorted = list.slice().sort((a, b2) => b2.factor - a.factor);
  const best = sorted[0];
  const mid = sorted[Math.floor(sorted.length / 2)];
  const latest = (bySeries.get(t + '|NC1') || bySeries.get(t + '|AI1') || bySeries.get(t + '|CI1') || bySeries.get(t + '|IC1') || []);
  const last = latest[latest.length - 1];
  if (!last) continue;
  const priceOf = (mat) => { for (const cx2 of ['NC1', 'AI1', 'CI1', 'IC1']) { const arr2 = bySeries.get(mat + '|' + cx2); if (arr2 && arr2.length) return arr2[arr2.length - 1].c; } return null; };
  const pick = (building) => {
    const b = extractionCostPerUnit(building, best.factor, priceOf) || extractionCostPerUnit(building, mid.factor, priceOf);
    return b;
  };
  const rig = pick('RIG'), ext = pick('EXT'), col = pick('COL');
  const options = [['RIG', rig], ['EXT', ext], ['COL', col]].filter(x => x[1]);
  if (!options.length) continue;
  const bestOpt = options.slice().sort((a, b2) => a[1].perUnit - b2[1].perUnit)[0];
  extraction[t] = { ticker: t, raw: MINEABLE.has(t), price: last.c, planets: sorted.length,
    bestPlanet: best.planet, bestFactor: +best.factor.toFixed(3), midFactor: +mid.factor.toFixed(3),
    building: bestOpt[0], unitsPerDay: +bestOpt[1].unitsPerDay.toFixed(1), labour: +bestOpt[1].labour.toFixed(1), wear: +bestOpt[1].wear.toFixed(1),
    costPerUnit: +bestOpt[1].perUnit.toFixed(2), marginPct: +(((last.c - bestOpt[1].perUnit) / last.c) * 100).toFixed(1),
    costAtMidFactor: +(bestOpt[1].total / (UNITS_PER_DAY_AT_FACTOR_1 * mid.factor)).toFixed(2) };
}
for (const b of board) { const e2 = extraction[b.ticker]; if (e2) { b.extractCost = e2.costPerUnit; b.extractMarginPct = e2.marginPct; b.bestFactor = e2.bestFactor; b.planets = e2.planets; } }
fs.writeFileSync(path.join(SITE, 'extraction.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
  model: 'units/day = 70 x planet factor (calibrated from the account\'s own RIG/EXT extraction orders); daily cost = workforce consumables + building wear',
  buildings: { RIG: '30 pioneers', EXT: '60 pioneers', COL: '50 pioneers' }, byMaterial: extraction }, null, 1));
console.log('extraction anchors:', Object.keys(extraction).length, '| raw with cost:', Object.values(extraction).filter(x => x.raw).length);

// ---- extraction margin as a 4th monthly factor: does "cheap to mine, expensive ore" predict next month? ----
const maxFactor = new Map();
for (const [t, list] of factorByMaterial) { let mf = 0; for (const x of list) if (x.factor > mf) mf = x.factor; maxFactor.set(t, mf); }
for (const row of supplyRows) {
  const mf = maxFactor.get(row.t);
  if (!mf) continue;
  const mk = monthKey(row.month);
  const priceOfMonth = (mat) => pm(mat, mk);
  let best = null;
  for (const bn of ['RIG', 'EXT', 'COL']) { const c = extractionCostPerUnit(bn, mf, priceOfMonth); if (c && (!best || c.perUnit < best.perUnit)) best = c; }
  const price = pm(row.t, mk);
  if (!best || !(price > 0)) continue;
  row.xcost = +best.perUnit.toFixed(3);
  row.xmargin = (price - best.perUnit) / price;
}
const mIC = (fx, fy, subset, fyName) => {
  const ics = [];
  for (const m of rayMonths) {
    const L = supplyRows.filter(r => r.month === m && (!subset || (subset === 'raw' ? r.raw : !r.raw)) && fx(r) != null && fy(r) != null && Number.isFinite(fx(r)) && Number.isFinite(fy(r)));
    if (L.length < 12) continue;
    ics.push(corr(rankify(L.map(fx)), rankify(L.map(fy))));
  }
  const ok = ics.filter(x => x != null);
  return { ic: +(100 * (ok.reduce((a, b) => a + b, 0) / (ok.length || 1))).toFixed(1), months: ok.length, posPct: Math.round(100 * ok.filter(x => x > 0).length / (ok.length || 1)) };
};
console.log('monthly IC (next-month return):');
for (const [lbl, fx] of [['surplus', r => r.surplus], ['supplyGrowth', r => r.growth], ['profitPerUnit', r => r.ppu], ['extractionMargin', r => r.xmargin]]) {
  console.log('  ' + lbl.padEnd(16) + ' all=' + JSON.stringify(mIC(fx, r => r.ret)) + '  raw=' + JSON.stringify(mIC(fx, r => r.ret, 'raw')));
}
const mOls = (rowsIn, useX) => {
  const k = useX ? 5 : 4;
  const X = rowsIn.map(r => useX ? [1, r.surplus, r.growth, r.ppu, r.xmargin] : [1, r.surplus, r.growth, r.ppu]);
  const y = rowsIn.map(r => r.ret);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  for (let i = 0; i < k; i++) XtX[i][i] *= 1.000001;
  const M = XtX.map((r2, i) => r2.concat([Xty[i]]));
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r2 = c + 1; r2 < k; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
    const tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
    if (!M[c][c]) continue;
    for (let r2 = 0; r2 < k; r2++) { if (r2 === c) continue; const f2 = M[r2][c] / M[c][c]; for (let c2 = c; c2 <= k; c2++) M[r2][c2] -= f2 * M[c][c2]; }
  }
  const beta = M.map((row, i) => (row[i] ? row[k] / row[i] : 0));
  let sse = 0, sst = 0;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  for (let i = 0; i < X.length; i++) { const pred = X[i].reduce((a, v, j2) => a + v * beta[j2], 0); sse += (y[i] - pred) ** 2; sst += (y[i] - my) ** 2; }
  return { beta, sigma: Math.sqrt(sse / Math.max(1, X.length - k)), r2: sst ? 1 - sse / sst : 0, n: X.length, k };
};
const fit3 = mOls(supplyRows.filter(r => r.ret != null && r.surplus != null && r.growth != null && r.ppu != null), false);
const fit4 = mOls(supplyRows.filter(r => r.ret != null && r.xmargin != null), true);
console.log('supply model (3 factors): r2=' + (fit3.r2 * 100).toFixed(2) + '% sigma=' + (fit3.sigma * 100).toFixed(2) + '% n=' + fit3.n);
console.log('supply model (4 factors, +extractionMargin): r2=' + (fit4.r2 * 100).toFixed(2) + '% sigma=' + (fit4.sigma * 100).toFixed(2) + '% n=' + fit4.n + ' beta=' + fit4.beta.map(x => x.toFixed(4)).join(','));
// refresh the live expectation with the 4-factor model where the margin is known
for (const [t, s2] of Object.entries(supply)) {
  const rows4 = supplyRows.filter(r => r.t === t && r.month === s2.month && r.xmargin != null);
  if (!rows4.length) continue;
  const r4 = rows4[0];
  s2.extractionMarginPct = +((r4.xmargin) * 100).toFixed(1);
  s2.extractCostMonth = r4.xcost;
  s2.expectedNextMonth4 = +(100 * (fit4.beta[0] + fit4.beta[1] * r4.surplus + fit4.beta[2] * r4.growth + fit4.beta[3] * r4.ppu + fit4.beta[4] * r4.xmargin)).toFixed(2);
}
for (const b of board) { const s3 = supply[b.ticker]; if (s3) { b.extractionMarginPct = s3.extractionMarginPct == null ? null : s3.extractionMarginPct; b.supplyExpectedPct = s3.expectedNextMonthPct; } }

// ---- cross-sectional percentile score (robust alternative to the unstable OLS) ----
const pctRank = (vals) => { const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const out = new Array(vals.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 / Math.max(1, idx.length - 1) * 100; for (let k = i; k <= j; k++) out[idx[k][1]] = avg; i = j + 1; } return out; };
const supplyScoreMap = new Map();   // 'YYYY-MM|TICKER' -> 0..100 (higher = expected higher return)
for (const m of rayMonths) {
  const mk = monthKey(m);
  const list = supplyRows.filter(r => r.month === m);
  const parts = [
    ['surplus', r => (r.surplus == null ? null : -r.surplus)],
    ['growth', r => (r.growth == null ? null : -r.growth)],
    ['ppu', r => (r.ppu == null ? null : -r.ppu)],
    ['xmargin', r => (r.xmargin == null ? null : -r.xmargin)],
  ];
  const ranks = new Map();
  for (const [, fn] of parts) {
    const ok = list.filter(r => fn(r) != null && Number.isFinite(fn(r)));
    if (ok.length < 8) continue;
    const rr = pctRank(ok.map(fn));
    ok.forEach((r, i) => { if (!ranks.has(r.t)) ranks.set(r.t, []); ranks.get(r.t).push(rr[i]); });
  }
  for (const [t, arr] of ranks) supplyScoreMap.set(mk + '|' + t, arr.reduce((a, b2) => a + b2, 0) / arr.length);
}
const scoreFor = (t, d) => {
  // use the row's own month; if that month has no raylu data yet (e.g. the current month),
  // fall back to the most recent month that does (older information is never look-ahead)
  const day = new Date(d); let y = day.getUTCFullYear(), mo = day.getUTCMonth();
  for (let k = 0; k < 4; k++) { const mk = y + '-' + String(mo + 1).padStart(2, '0'); if (supplyScoreMap.has(mk + '|' + t)) return supplyScoreMap.get(mk + '|' + t); mo--; if (mo < 0) { mo = 11; y--; } }
  return null;
};

for (const b of board) { const arr2 = bySeries.get(b.ticker + '|' + b.cx); const last2 = arr2 && arr2[arr2.length - 1]; b.supplyScore = last2 ? scoreFor(b.ticker, last2.d) : null; b.comboScore = (b.supplyScore != null && last2 && last2.sma10) ? (+((( -(last2.c / last2.sma10 - 1)) * 100 + (b.supplyScore - 50))).toFixed(1)) : null; }
console.log('supply scores built for', supplyScoreMap.size, 'month-ticker pairs');
const supplyModelInfo = { fit3: { beta: fit3.beta, sigma: fit3.sigma, r2: fit3.r2, n: fit3.n }, fit4: { beta: fit4.beta, sigma: fit4.sigma, r2: fit4.r2, n: fit4.n }, ic: { surplus: mIC(r => r.surplus, r => r.ret), supplyGrowth: mIC(r => r.growth, r => r.ret), profitPerUnit: mIC(r => r.ppu, r => r.ret), extractionMargin: mIC(r => r.xmargin, r => r.ret), extractionMarginRaw: mIC(r => r.xmargin, r => r.ret, 'raw'), surplusRaw: mIC(r => r.surplus, r => r.ret, 'raw') } };
globalThis.__supplyModelInfo = supplyModelInfo;
// supply.json must be written AFTER the model info exists (it was written earlier in the supply block)
fs.writeFileSync(path.join(SITE, 'supply.json'), JSON.stringify({ generatedAt: new Date().toISOString(), month: lastMonth,
  model: 'next-month log return = a + b1*surplus + b2*supplyGrowth + b3*profitPerUnit + b4*extractionMargin (monthly panel, in-sample)',
  fit: supplyModelInfo.fit4, fit3: supplyModelInfo.fit3, ic: supplyModelInfo.ic,
  note: 'surplus = (产量 - 消耗) / max(产量, 消耗)；raw = 有行星丰度数据的可采掘材料；extractionMargin 单独作因子时 IC 最强（18/18 月为负），但 OLS 系数不稳，期望值仍用三因子模型',
  byTicker: supply }, null, 1));

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

// ---- 2d) rank-average combo test: does merging beat each signal on its own? ----
const comboIc = {};
for (const h of [30, 90]) {
  const tgt = h === 30 ? 'r30' : 'r90';
  const ics = { mr: [], ss: [], combo: [] };
  for (const d of dates) {
    const list = byDate.get(d).filter(r => r[tgt] != null && r.sma10 && scoreFor(r.t, r.d) != null);
    if (list.length < 40) continue;
    const rm = rankify(list.map(r => -(r.c / r.sma10 - 1)));
    const rs = rankify(list.map(r => scoreFor(r.t, r.d)));
    const rc = list.map((_, i) => (rm[i] + rs[i]) / 2);
    const y = rankify(list.map(r => r[tgt]));
    ics.mr.push(corr(rm, y)); ics.ss.push(corr(rs, y)); ics.combo.push(corr(rc, y));
  }
  const mean2 = (a) => a.reduce((x, y2) => x + y2, 0) / a.length;
  comboIc['h' + h] = { meanRev: +(mean2(ics.mr) * 100).toFixed(1), supplyScore: +(mean2(ics.ss) * 100).toFixed(1), combo: +(mean2(ics.combo) * 100).toFixed(1), n: ics.mr.length };
}
console.log('combo IC (rank-average of mean-reversion and supply score):', JSON.stringify(comboIc));
globalThis.__comboIc = comboIc;

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
