// Fail CI before any network request if the polite-fetch policy regresses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fail = (msg) => { console.error(`REQUEST POLICY FAILED: ${msg}`); process.exit(1); };

const workflow = read('.github/workflows/daily.yml');
const crons = [...workflow.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']\s*$/gm)].map(m => m[1]);
if (crons.length !== 1) fail(`expected exactly one cron schedule, found ${crons.length}: ${JSON.stringify(crons)}`);
if (crons[0] !== '8 0 * * *') fail(`expected 08:08 Beijing (8 0 * * *), found ${crons[0]}`);
if ((workflow.match(/node tools\/pull-cxpc\.mjs/g) || []).length !== 1) fail('daily workflow must invoke pull-cxpc.mjs exactly once');

const pull = read('tools/pull-cxpc.mjs');
if ((pull.match(/\bfetch\s*\(/g) || []).length !== 1) fail('pull-cxpc.mjs must have exactly one fetch call site');
if (!pull.includes("BASE + '?days=3'")) fail('daily path must use the bulk ?days=3 request');
if (/cxpc\/\$\{|cxpc\/[^'\"]*\+/.test(pull)) fail('per-ticker cxpc URL construction detected');
if (!pull.includes('request budget exhausted before request')) fail('pre-request budget fuse is missing');
if (!pull.includes('refusing automatic backfill')) fail('automatic backfill guard is missing');

const dailyModules = ['tools/build-dataset.mjs', 'tools/analyze.mjs', 'tools/raylu.mjs'];
for (const rel of dailyModules) {
  if (/\bfetch\s*\(/.test(read(rel))) fail(`${rel} must not perform network fetches in the scheduled pipeline`);
}

console.log(`request policy OK: cron=[${crons[0]}], one workflow pull, one allowed fetch call site, ?days=3 bulk path, budget fuse present`);