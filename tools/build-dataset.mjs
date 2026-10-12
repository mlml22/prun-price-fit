// build-dataset.mjs - modelling table: daily prices + game structure + materials cost anchor + labour cost.
// Row: [ticker, cx, day, close, volume, traded, matCost, matMargin, matMarginPct, r7, r30, r90, labourCost, totCost, totMarginPct, depreciationCost]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(ROOT, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const UA = { 'User-Agent': 'prun-price-fit/1.0 (read-only)', Accept: 'application/json,*/*' };

import { BASKETS, DAY_MS } from './baskets.mjs';
import { repairPerDay } from './depreciation.mjs';


async function gameData(name, url) {
  const f = path.join(CACHE, name + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* fetch */ }
  const r = await fetch(url, { headers: UA });
  if (r.status !== 200) throw new Error('HTTP ' + r.status + ' ' + url);
  const j = await r.json();
  fs.writeFileSync(f, JSON.stringify(j));
  return j;
}

const [recipes, materials, buildings] = await Promise.all([
  gameData('recipes', 'https://api.prunplanner.org/data/recipes/'),
  gameData('materials', 'https://api.prunplanner.org/data/materials/'),
  gameData('buildings', 'https://api.prunplanner.org/data/buildings/'),
]);

const buildingWorkers = new Map();
for (const b of buildings) {
  buildingWorkers.set(b.building_ticker, {
    pioneers: Number(b.pioneers) || 0, settlers: Number(b.settlers) || 0, technicians: Number(b.technicians) || 0,
    engineers: Number(b.engineers) || 0, scientists: Number(b.scientists) || 0,
  });
}

const names = new Map(materials.map(m => [m.ticker, { name: m.name, category: m.category_name }]));
const recipeConsumers = new Map();
const producers = new Map();
const constrBuildings = new Map();
const popBasket = new Set();

for (const b of buildings) for (const c of (b.costs || [])) {
  const t = c.material_ticker; if (!t) continue;
  if (!constrBuildings.has(t)) constrBuildings.set(t, new Set());
  constrBuildings.get(t).add(b.building_ticker);
}
for (const r of recipes) {
  const ins = (r.inputs || []).map(i => ({ t: i.material_ticker, a: Number(i.material_amount) || 0 }));
  const outs = (r.outputs || []).map(o => ({ t: o.material_ticker, a: Number(o.material_amount) || 0 }));
  if (!outs.length) continue;
  for (const i of ins) {
    if (!recipeConsumers.has(i.t)) recipeConsumers.set(i.t, new Set());
    for (const o of outs) recipeConsumers.get(i.t).add(o.t);
    if (r.building_ticker === 'PAC') popBasket.add(i.t);
  }
  for (const o of outs) {
    if (!producers.has(o.t)) producers.set(o.t, []);
    producers.get(o.t).push({
      building: r.building_ticker,
      timeMs: Number(r.time_ms) || 0,
      outAmount: o.a || 1,
      inputs: ins.map(i => ({ t: i.t, per: o.a ? i.a / o.a : 0 })),
    });
  }
}

const dist = new Map();
let queue = [];
for (const m of materials) if (!(recipeConsumers.get(m.ticker) || new Set()).size) { dist.set(m.ticker, 0); queue.push(m.ticker); }
let guard = 0;
while (queue.length && guard++ < 5000) {
  const next = [];
  for (const t of queue) {
    for (const r of recipes) {
      if ((r.outputs || []).some(o => o.material_ticker === t)) {
        for (const i of (r.inputs || [])) {
          const d = dist.get(t) + 1;
          if (!dist.has(i.material_ticker) || d < dist.get(i.material_ticker)) { dist.set(i.material_ticker, d); next.push(i.material_ticker); }
        }
      }
    }
  }
  queue = next;
}

const fuelLike = new Set(['SF', 'FF']);
const features = {};
for (const [t, v] of names) {
  features[t] = {
    name: v.name, category: v.category,
    recipeDownstream: (recipeConsumers.get(t) || new Set()).size,
    constructionDownstream: (constrBuildings.get(t) || new Set()).size,
    popConsumable: popBasket.has(t) ? 1 : 0,
    fuel: fuelLike.has(t) ? 1 : 0,
    producerRecipes: (producers.get(t) || []).length,
    producerBuildings: new Set((producers.get(t) || []).map(x => x.building)).size,
    distToTerminal: dist.has(t) ? dist.get(t) : -1,
  };
}
fs.writeFileSync(path.join(DATA, 'features.json'), JSON.stringify(features));

const raw = zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'cxpc-daily.jsonl.gz'))).toString('utf8').split('\n');
const series = new Map();
const priceAt = new Map();
for (const line of raw) {
  if (!line) continue;
  const [ticker, cx, d, o, c, h, l, volume, traded] = JSON.parse(line);
  const close = Number(c); if (!(close > 0)) continue;
  const key = ticker + '|' + cx;
  if (!series.has(key)) { series.set(key, []); priceAt.set(key, new Map()); }
  series.get(key).push({ d, c: close, v: Number(volume) || 0, n: Number(traded) || 0 });
  priceAt.get(key).set(d, close);
}
for (const arr of series.values()) arr.sort((a, b) => a.d - b.d);

const DAY = DAY_MS;
function priceNear(ticker, cx, day) {
  const m = priceAt.get(ticker + '|' + cx);
  if (!m) return null;
  for (let k = 0; k <= 7; k++) { const p = m.get(day - k * DAY); if (p != null) return p; }
  return null;
}
const basketCost = (tier, cx, day) => {
  let sum = 0;
  for (const [mat, amount] of Object.entries(BASKETS[tier])) {
    const p = priceNear(mat, cx, day);
    if (p == null) return null;
    sum += p * amount;
  }
  return sum;
};

let rows = 0, withCost = 0, withLabour = 0;
const matMargins = [], totMargins = [];
await pipeline(async function* () {
  for (const [key, arr] of series) {
    const [ticker, cx] = key.split('|');
    const recs = producers.get(ticker) || [];
    // labour cost per unit = sum over tiers of (workers/100 * daily basket cost) * (duration in days) / output
    // daily wear: the repair materials a building burns by existing for one day, priced here
    const depRecs = recs.map(r => ({
      building: r.building, days: r.timeMs / DAY_MS, outAmount: r.outAmount || 1, wear: repairPerDay(r.building),
    }));
    const labourRecs = recs.map(r => {
      const w = buildingWorkers.get(r.building);
      if (!w) return null;
      const days = r.timeMs / DAY_MS;
      return { building: r.building, days, outAmount: r.outAmount, workers: w };
    }).filter(Boolean);
    for (let i = 0; i < arr.length; i++) {
      const { d, c, v, n } = arr[i];
      let cost = null;
      for (const r of recs) {
        if (!r.inputs.length) continue;
        let sum = 0, ok = true;
        for (const inp of r.inputs) {
          const pr = priceNear(inp.t, cx, d);
          if (pr == null) { ok = false; break; }
          sum += pr * inp.per;
        }
        if (ok && (cost == null || sum < cost)) cost = sum;
      }
      let labour = null;
      for (const lr of labourRecs) {
        let per = 0, ok = true;
        for (const [tier, w] of Object.entries(lr.workers)) {
          if (!w) continue;
          const bc = basketCost(tier, cx, d);
          if (bc == null) { ok = false; break; }
          per += (w / 100) * bc;
        }
        if (!ok) continue;
        const unit = per * lr.days / (lr.outAmount || 1);
        if (labour == null || unit < labour) labour = unit;
      }
      let dep = null;
      for (const dr of depRecs) {
        let perDay = 0, ok = true;
        for (const [mat, amount] of Object.entries(dr.wear)) {
          const pr = priceNear(mat, cx, d);
          if (pr == null) { ok = false; break; }
          perDay += pr * amount;
        }
        if (!ok) continue;
        const unit = perDay * dr.days / dr.outAmount;
        if (dep == null || unit < dep) dep = unit;
      }
      const fwd = (k) => (i + k < arr.length ? Math.log(arr[i + k].c / c) : null);
      const mg = cost != null ? c - cost : null;
      const mgp = cost != null && c > 0 ? mg / c : null;
      const tot = (cost != null) ? cost + (labour || 0) + (dep || 0) : null;
      const tmp = tot != null && c > 0 ? (c - tot) / c : null;
      if (cost != null) { withCost++; matMargins.push(mgp); }
      if (tot != null) { withLabour++; totMargins.push(tmp); }
      rows++;
      yield JSON.stringify([ticker, cx, d, c, v, n, cost, mg, mgp, fwd(7), fwd(30), fwd(90), labour, tot, tmp, dep]) + '\n';
    }
  }
}(), zlib.createGzip({ level: 6 }), fs.createWriteStream(path.join(DATA, 'dataset.jsonl.gz')));

const q = (arr, x) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(x * (s.length - 1))]; };
console.log(JSON.stringify({
  series: series.size, rows, matCostCoverage: +(withCost / rows).toFixed(3), labourCoverage: +(withLabour / rows).toFixed(3),
  materialsMarginPct: { p05: q(matMargins, 0.05), median: q(matMargins, 0.5), p95: q(matMargins, 0.95) },
  afterLabourMarginPct: { p05: q(totMargins, 0.05), median: q(totMargins, 0.5), p95: q(totMargins, 0.95) },
  datasetMB: +(fs.statSync(path.join(DATA, 'dataset.jsonl.gz')).size / 1048576).toFixed(2),
}, null, 1));
