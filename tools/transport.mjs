// transport.mjs - what it costs to move goods between exchanges.
//
// TRIP_COST is a ROUGH estimate supplied by the account owner on 2026-10-12: about 10,000 per one-way trip.
// Sanity check from in-game blueprints (message BLUEPRINT_GET_BLUEPRINTS, read-only): a regular freighter
// carries up to 2,000 FTL fuel (ftlFuelCapacity); at ~30 per unit a full tank is ~60,000, so a 10,000 trip
// is roughly a sixth of a tank - the right order of magnitude for a mid-length FTL run.
//
// The exact per-route figure needs the flight planner (message SHIP_FLIGHT_CALCULATE_MISSION); the payload
// shape is not cracked yet, so a constant is used on purpose.
export const TRIP_COST = 10000;
export const TRIP_COST_SOURCE = 'rough estimate from the account owner (2026-10-12): ~10,000 per one-way trip';

/** units you must move before one trip pays for itself, given a per-unit price gap */
export function breakEvenUnits(spreadPerUnit) {
  if (!(spreadPerUnit > 0)) return null;
  return Math.ceil(TRIP_COST / spreadPerUnit);
}
