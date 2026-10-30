// raylu.mjs - frozen monthly supply/demand snapshot used by the model.
//
// The source of the original snapshot is the community stats site prun.raylu.net.
// GitHub Actions must NOT call that site: the snapshot is committed under data/static/
// and can be refreshed manually with `node tools/pull-raylu.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(ROOT, 'data', 'static', 'raylu-prod.json');
export const BASE_MONTHS = ['mar25','apr25','may25','jun25','jul25','aug25','sep25','oct25','nov25','dec25','jan26','feb26','mar26','apr26','may26','jun26','jul26','aug26','sep26'];
const MM = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
export const monthKey = (m) => '20' + m.slice(3) + '-' + MM[m.slice(0, 3)];

/** Read the committed snapshot. No network access is performed by the daily pipeline. */
export async function loadRaylu() {
  const data = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  if (!data.months || typeof data.months !== 'object') throw new Error('invalid data/static/raylu-prod.json');
  return data.months;
}

/** Manual refresh helper. Never invoked by the scheduled workflow. */
export async function refreshRaylu(outFile = SNAPSHOT) {
  const data = { fetchedAt: new Date().toISOString(), source: 'https://prun.raylu.net/stats/data/prod-data-<month>.json', months: {} };
  for (const m of BASE_MONTHS) {
    const r = await fetch(`https://prun.raylu.net/stats/data/prod-data-${m}.json`, { headers: { 'User-Agent': 'prun-price-fit/1.0 (manual refresh)' } });
    if (r.status === 200) data.months[m] = await r.json();
    else console.warn(`  ${m}: HTTP ${r.status}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  fs.writeFileSync(outFile, JSON.stringify(data));
  return data;
}

/** which materials are raw (not produced by any recipe that consumes inputs) */
export function rawSet(recipes, extractionBuildings = ['RIG', 'EXT', 'COL']) {
  const made = new Set();
  for (const r of recipes) {
    if (!(r.inputs || []).length) continue;
    if (extractionBuildings.includes(r.building_ticker)) continue;
    for (const o of (r.outputs || [])) if (o.material_ticker) made.add(o.material_ticker);
  }
  return made;
}