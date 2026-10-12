// extraction.mjs - cost anchor for mined materials (RIG / EXT / COL).
//
// The rate was calibrated from the account's own extraction orders (read-only, 2026-10-12):
//   EXT on BS-788c (CLI factor 0.40): 14 units / 0.500 nominal days
//   EXT on OZ-189a (HAL factor 0.221): 8 units / 0.518 nominal days
//   EXT on VH-192c (SIO factor 0.583): 21 units / 0.515 nominal days
//   RIG on KW-688c (H2O factor 0.60): 9 units / 0.214 nominal days
//   RIG on FK-794b (H2O factor 0.70): 10 units / 0.204 nominal days
// In every case amount / nominalDays / factor = 70.0, i.e.
//
//     units per day = 70 x planet factor      (at 100% efficiency)
//
// Daily cost = the workforce's consumables (baskets.mjs) plus the building's wear
// (depreciation.mjs, measured from repairMaterials24 -> repairMaterials48).
import { BASKETS, DAY_MS } from './baskets.mjs';

export const UNITS_PER_DAY_AT_FACTOR_1 = 70;

export const EXTRACTION_BUILDINGS = {
  RIG: { workers: { pioneers: 30 }, wear: { MCG: 1 } },
  EXT: { workers: { pioneers: 60 }, wear: { MCG: 1, BSE: 1 } },
  COL: { workers: { pioneers: 50 }, wear: { MCG: 1 } },
};

/** cost of running one extraction building for a day, given priceOf(mat) -> price|null */
export function extractionDailyCost(building, priceOf) {
  const spec = EXTRACTION_BUILDINGS[building];
  if (!spec) return null;
  let labour = 0;
  for (const [tier, workers] of Object.entries(spec.workers)) {
    const basket = BASKETS[tier];
    for (const [mat, amount] of Object.entries(basket)) {
      const price = priceOf(mat);
      if (price == null) return null;
      labour += (workers / 100) * price * amount;
    }
  }
  let wear = 0;
  for (const [mat, amount] of Object.entries(spec.wear)) {
    const price = priceOf(mat);
    if (price == null) return null;
    wear += price * amount;
  }
  return { labour, wear, total: labour + wear };
}

/** unit cost of mining a material at a given planet factor */
export function extractionCostPerUnit(building, factor, priceOf) {
  const daily = extractionDailyCost(building, priceOf);
  if (!daily || !(factor > 0)) return null;
  const unitsPerDay = UNITS_PER_DAY_AT_FACTOR_1 * factor;
  return { ...daily, unitsPerDay, perUnit: daily.total / unitsPerDay };
}
