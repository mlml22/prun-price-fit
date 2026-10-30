// Manual-only refresh of the auxiliary monthly supply snapshot.
// The scheduled daily workflow does not run this script.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshRaylu } from './raylu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(ROOT, 'data', 'static', 'raylu-prod.json');
const data = await refreshRaylu(out);
console.log(`raylu snapshot: ${Object.keys(data.months).length} months -> ${out}`);