# prun-price-fit

A daily, fully automated **price-fitting board** for Prosperous Universe (read-only, public data only).

Idea: switching production in PrUn costs almost nothing, so any publicly visible margin gets arbitraged
away by supply. This project therefore fits **future CX prices** against a feature set built from
(1) a materials cost anchor, (2) production-chain structure, and (3) market structure - all recomputed
from public data every day.

## Pipeline

| step | file | what it does |
|---|---|---|
| 1 | `tools/pull-cxpc.mjs` | pulls the whole daily price history (~3.2 years, ~630k rows) from the public PRUNplanner mirror of FIO game data |
| 2 | `tools/build-dataset.mjs` | joins it with `recipes` / `buildings` / `materials` and computes the per-unit materials cost anchor and forward returns |
| 3 | `tools/analyze.mjs` | cross-sectional IC study (price target, 30/90 day horizons) + today's board, emitted as JSON for the static site |
| 4 | `.github/workflows/daily.yml` | runs 1-3 daily and publishes `site/` to GitHub Pages |

Nothing is written back upstream, no account or API key is used, and the game itself is never touched.

## Data sources (public, no auth)

- `https://api.prunplanner.org/data/cxpc/{TICKER}/` - daily OHLCV history (FIO-imported game record)
- `https://api.prunplanner.org/data/recipes/`, `/buildings/`, `/materials/` - game structure

## Honest caveats

- Only days with trades exist upstream, so thin markets have gappy series (survivorship-like bias).
- The cost anchor covers ~78% of rows and excludes labour and depreciation; `PE` (polyethylene) dominates
  workforce baskets, so labour is not small.
- Overlapping forward windows inflate t-statistics; treat IC values as exploratory.
- The board score is a transparent heuristic, not a validated model.
