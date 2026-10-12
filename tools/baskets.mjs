// baskets.mjs - workforce consumables + labour cost, single source of truth.
//
// Consumption per 100 workers per DAY.
// Pioneers/Settlers are verified against the official handbook (wiki/efficiency-factors).
// Technicians/Engineers/Scientists are derived from the game's own population-bundle recipes
// (PAC -> TBU/CBU/EBU, divided by 10 to get a day), leaving out the polymer input (PE),
// which is a production input rather than something a worker consumes.
export const BASKETS = {
  pioneers: { DW: 4, RAT: 4, OVE: 0.5, COF: 0.5, PWO: 0.2 },
  settlers: { DW: 5, RAT: 6, EXO: 0.5, PT: 0.5, KOM: 1, REP: 0.2 },
  technicians: { DW: 7.5, RAT: 7, MED: 0.5, HMS: 0.5, SCN: 0.1, ALE: 1, SC: 0.1, PSS: 0.1 },
  engineers: { DW: 10, FIM: 7, MED: 0.5, HSS: 0.2, PDA: 0.1, GIN: 1, VG: 0.2, PSS: 0.4 },
  scientists: { DW: 10, MEA: 7, MED: 0.5, LC: 0.2, WS: 0.1, WIN: 1, NST: 0.1, PSS: 0.8 },
};
export const DAY_MS = 86400000;

export function workersOf(building) {
  return {
    pioneers: Number(building.pioneers) || 0, settlers: Number(building.settlers) || 0,
    technicians: Number(building.technicians) || 0, engineers: Number(building.engineers) || 0,
    scientists: Number(building.scientists) || 0,
  };
}

/** daily consumable bill for the workforce of one building, given priceOf(mat) -> price|null */
export function dailyWorkforceCost(workers, priceOf) {
  let total = 0;
  const detail = [];
  for (const [tier, w] of Object.entries(workers)) {
    if (!w) continue;
    const basket = BASKETS[tier];
    if (!basket) continue;
    let tierCost = 0, ok = true;
    const items = [];
    for (const [mat, amount] of Object.entries(basket)) {
      const price = priceOf(mat);
      if (price == null) { ok = false; break; }
      tierCost += price * amount;
      items.push({ ticker: mat, amount, price });
    }
    if (!ok) return null;
    const share = (w / 100) * tierCost;
    total += share;
    detail.push({ tier, workers: w, per100PerDay: tierCost, costPerDay: share, items });
  }
  return { totalPerDay: total, detail };
}
