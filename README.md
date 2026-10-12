# prun-price-fit

A daily, fully automated **price-fitting board** for Prosperous Universe (read-only, public data only).

Idea: switching production in PrUn costs almost nothing, so any publicly visible margin gets arbitraged
away by supply. This project fits **future CX prices** against a feature set built from
(1) a materials cost anchor, (2) a labour cost anchor, (3) production-chain structure, and
(4) market structure - all recomputed from public data every day.

- Board: `site/index.html`
- Per-material page: `site/detail.html?t=TICKER` - game-style candlestick chart + cost-anchor breakdown

## Pipeline

| step | file | what it does |
|---|---|---|
| 1 | `tools/pull-cxpc.mjs` | pulls the whole daily price history (~3.2 years, ~630k rows) from the public PRUNplanner mirror of FIO game data |
| 2 | `tools/build-dataset.mjs` | joins it with `recipes` / `buildings` / `materials`; computes materials cost anchor and labour cost anchor per unit, plus forward returns |
| 3 | `tools/analyze.mjs` | cross-sectional IC study (price target, 30/90 day horizons), today's board, per-material OHLCV payload for the charts |
| 4 | `.github/workflows/daily.yml` | runs 1-3 daily and publishes `site/` to GitHub Pages |

Nothing is written back upstream, no account or API key is used, and the game itself is never touched.

## Cost anchors

- **Materials**: cheapest producing recipe for the same exchange, priced on the same day (covers ~78% of rows).
- **Labour** (`tools/baskets.mjs`): consumption per 100 workers per day, times the building's workforce,
  times the recipe duration, divided by output.
  - Pioneers / Settlers baskets are verified against the official handbook (`wiki/efficiency-factors`).
  - Technicians / Engineers / Scientists baskets are derived from the game's own population-bundle
    recipes (PAC -> TBU/CBU/EBU), divided by 10 to get a day, excluding the polymer input (PE).
  - Depreciation and taxes are **not** included.

## Data sources (public, no auth)

- `https://api.prunplanner.org/data/cxpc/{TICKER}/` - daily OHLCV history (FIO-imported game record)
- `https://api.prunplanner.org/data/recipes/`, `/buildings/`, `/materials/` - game structure
- `https://handbook.apex.prosperousuniverse.com/wiki/efficiency-factors/` - official consumables rates

## Honest caveats

- Only days with trades exist upstream, so thin markets have gappy series (survivorship-like bias).
- Overlapping forward windows inflate t-statistics; treat IC values as exploratory.
- Order-book depth / MM quotes have no history upstream, so they cannot be backtested.
- The board score is a transparent heuristic, not a validated model.
