// raylu.mjs - frozen monthly supply/demand snapshot used by the model.
//
// Original source: https://prun.raylu.net/stats/data/prod-data-<month>.json
// The scheduled GitHub Actions pipeline only reads the committed snapshot.
// Refresh it manually with `node tools/pull-raylu.mjs` when needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(ROOT, 'data', 'static', 'raylu-prod.json');
const MM = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
export const monthKey = (m) => '20' + m.slice(3) + '-' + MM[m.slice(0, 3)];

/** Read the committed snapshot. No network access is performed by the daily pipeline. */
export async function loadRaylu() {
  const data = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  if (!data.months || typeof data.months !== 'object') throw new Error('invalid data/static/raylu-prod.json');
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