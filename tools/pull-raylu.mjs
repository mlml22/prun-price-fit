// Manual-only refresh of the auxiliary monthly supply snapshot.
// The scheduled daily workflow does not run this script and does not call raylu.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'static', 'raylu-prod.json');
const MONTHS = ['mar25','apr25','may25','jun25','jul25','aug25','sep25','oct25','nov25','dec25','jan26','feb26','mar26','apr26','may26','jun26','jul26','aug26','sep26'];
const data = { fetchedAt: new Date().toISOString(), source: 'https://prun.raylu.net/stats/data/prod-data-<month>.json', months: {} };

for (const m of MONTHS) {
  const r = await fetch(`https://prun.raylu.net/stats/data/prod-data-${m}.json`, {
    headers: { 'User-Agent': 'prun-price-fit/1.0 (manual refresh)' },
  });
  if (r.status === 200) data.months[m] = await r.json();
  else console.warn(`  ${m}: HTTP ${r.status}`);
  await new Promise(resolve => setTimeout(resolve, 1500));
}

fs.writeFileSync(OUT, JSON.stringify(data));
console.log(`raylu snapshot: ${Object.keys(data.months).length} months -> ${OUT}`);