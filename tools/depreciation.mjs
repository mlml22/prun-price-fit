// depreciation.mjs - building wear, measured from the game itself (read-only capture, 2026-10-12).
//
// The game exposes, per platform: condition (1.0 = new), bookValue, and the repair material bill
// for "now", "+24h" and "+48h". The 24h -> 48h delta is therefore the material a building consumes
// by simply existing for one day - i.e. the daily repair requirement. Measured samples:
//
//   HYF (production): +1 INS, +1 MCG / day
//   BMP: +1 MCG, +1 BBH / day
//   EXT: +1 MCG, +1 BSE / day
//   WPL: +1 MCG / day
//   POL: +1 MCG / day
//
// Habitation / storage / core modules carried an empty repair bill in the capture, and the game
// quantises amounts to whole units, so this is a floor rather than an exact figure. Buildings that
// were not observed use the MCG floor, which appears in every observed production building.
export const REPAIR_PER_DAY = {
  HYF: { INS: 1, MCG: 1 },
  BMP: { MCG: 1, BBH: 1 },
  EXT: { MCG: 1, BSE: 1 },
  WPL: { MCG: 1 },
  POL: { MCG: 1 },
  default: { MCG: 1 },
};
export function repairPerDay(building) {
  return REPAIR_PER_DAY[building] || REPAIR_PER_DAY.default;
}
export const DEPRECIATION_SOURCE = 'in-game platform data (condition / repairMaterials24 / repairMaterials48), captured read-only on 2026-10-12';
