// raylu.mjs - monthly supply/demand flows per material, from the community stats site prun.raylu.net.
//
// Source: https://prun.raylu.net/stats/data/prod-data-<month>.json  (public, no auth)
// Each material: { amount (produced qty), consumed (qty), volume (money), profit }
// Months available: mar25 .. sep26. Monthly data, so it is joined to daily prices by month.
//
// Raw = a material that no input-consuming recipe produces (mining/collection only). Those are the
// goods where supply is "infinite but only a fraction of players dig", which is what the model uses.
import fs from 'node:fs';
import path from 'node:path';

const MONTHS = ['mar25','apr25','may25','jun25','jul25','aug25','sep25','oct25','nov25','dec25','jan26','feb26','mar26','apr26','may26','jun26','jul26','aug26','sep26'];
const MM = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
export const monthKey = (m) => '20' + m.slice(3) + '-' + MM[m.slice(0, 3)];

export async function loadRaylu(cacheDir) {
  const cache = path.join(cacheDir, 'raylu-prod.json');
  let data = null;
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    const ageH = (Date.now() - Date.parse(c.fetchedAt)) / 3600000;
    if (ageH < 20) data = c;
  } catch { /* fetch */ }
  if (!data) {
    data = { fetchedAt: new Date().toISOString(), source: 'https://prun.raylu.net/stats/data/prod-data-<month>.json', months: {} };
    for (const m of MONTHS) {
      try {
        const r = await fetch(`https://prun.raylu.net/stats/data/prod-data-${m}.json`, { headers: { 'User-Agent': 'prun-price-fit/1.0' } });
        if (r.status === 200) data.months[m] = await r.json();
      } catch { /* skip month */ }
    }
    fs.writeFileSync(cache, JSON.stringify(data));
  }
  return data.months;
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
